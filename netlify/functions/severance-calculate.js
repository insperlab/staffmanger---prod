// netlify/functions/severance-calculate.js
// Phase 11: 퇴직금 계산 엔진 메인 API
//
// POST /api/severance-calculate
// Body: { employeeId, retirementDate, severanceType, includeBonus, bonusAnnualAmount, preview }
//
// preview=true  → 계산 결과만 반환 (DB 저장 안 함)
// preview=false → DB 저장 후 결과 반환

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const {
  calculateAverageWage,
  calculateSeverancePay,
  calcServicePeriod,
} = require('./lib/severance-calc');
const {
  calculateSeveranceTax,
  calcIrpTaxBenefit,
} = require('./lib/severance-tax');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const headers = {
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function respond(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method Not Allowed' });

  // ── 인증 ──
  try {
    verifyToken(event.headers.authorization || event.headers.Authorization);
  } catch {
    return respond(401, { success: false, error: '인증에 실패했습니다. 다시 로그인해주세요.' });
  }

  try {
    const {
      employeeId,
      retirementDate,
      severanceType = 'lump_sum', // lump_sum / db / dc
      includeBonus = true,         // 상여금 포함 여부 (사업장 선택)
      bonusAnnualAmount = 0,       // 연간 상여금 총액 (직접 입력)
      irpAccount = '',
      preview = true,              // true=계산만 / false=저장
    } = JSON.parse(event.body || '{}');

    if (!employeeId || !retirementDate) {
      return respond(400, { success: false, error: '직원 ID와 퇴직일은 필수입니다.' });
    }

    // ── 1. 직원 기본 정보 조회 ──
    // users JOIN 대신 employees만 먼저 조회 (RLS + FK 설정에 따라 JOIN 실패 방지)
    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select(`
        id, company_id, user_id, hire_date, salary_type,
        base_salary, monthly_wage, annual_salary,
        work_hours_per_day, work_days_per_week,
        pension_type, irp_account, bonus_annual_amount
      `)
      .eq('id', employeeId)
      .single();

    if (empErr || !emp) {
      console.error('직원 조회 오류:', empErr);
      // 디버그: 에러 상세 내용 응답에 포함
      return respond(404, { 
        success: false, 
        error: '직원 정보를 찾을 수 없습니다.',
        debug: {
          employeeId,
          errCode: empErr?.code,
          errMsg: empErr?.message,
          empNull: !emp
        }
      });
    }

    // 이름은 users 테이블에서 별도 조회
    let employeeName = '직원';
    if (emp.user_id) {
      const { data: userRow } = await supabase
        .from('users')
        .select('name')
        .eq('id', emp.user_id)
        .single();
      if (userRow?.name) employeeName = userRow.name;
    }

    const hireDate = emp.hire_date;
    if (!hireDate) {
      return respond(400, { success: false, error: '입사일 정보가 없습니다. 직원 정보를 먼저 확인해주세요.' });
    }

    // ── 2. 퇴직금 수급 자격 확인 (1년 이상 근무) ──
    const { days: serviceDays, eligible } = calcServicePeriod(hireDate, retirementDate);
    if (!eligible) {
      return respond(400, {
        success: false,
        error: `퇴직금 지급 대상이 아닙니다. 계속 근로 기간이 1년 미만입니다. (현재: ${serviceDays}일)`,
        serviceDays,
      });
    }

    // ── 3. 최근 3개월 payrolls 조회 ──
    // 퇴직일 기준 3개월 전 산정 기간
    const retireDateObj = new Date(retirementDate);
    const threeMonthsAgo = new Date(retireDateObj);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const threeMonthsAgoStr = threeMonthsAgo.toISOString().slice(0, 7); // YYYY-MM

    const { data: payrolls } = await supabase
      .from('payrolls')
      .select(`
        year, month, base_salary, overtime_pay, night_work_pay, holiday_work_pay,
        meal_allowance, transport_allowance, position_allowance, unused_leave_pay
      `)
      .eq('employee_id', employeeId)
      
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(3);

    // payrolls 없으면 기본급으로 추정 계산 (경고 발생)
    const payrollRecords = payrolls || [];
    const hasPayrollData = payrollRecords.length >= 3;

    // payrolls 없을 때 employees 기본급으로 추정 rows 생성
    let effectivePayrolls = payrollRecords;
    if (!hasPayrollData) {
      const estimated = {
        base_salary: emp.monthly_wage || emp.base_salary || 0,
        meal_allowance: 0,
        transport_allowance: 0,
        position_allowance: 0,
        night_work_pay: 0,
        overtime_pay: 0,
        holiday_work_pay: 0,
        unused_leave_pay: 0,
      };
      // 부족한 개월 수만큼 채움
      while (effectivePayrolls.length < 3) {
        effectivePayrolls = [...effectivePayrolls, estimated];
      }
    }

    // ── 4. 대기기간 제외 이력 조회 ──
    const { data: exclusions } = await supabase
      .from('severance_exclusion_periods')
      .select('*')
      .eq('employee_id', employeeId);

    // ── 5. 평균임금 계산 ──
    // 상여금: 직원 테이블의 bonus_annual_amount 또는 직접 입력값 우선
    const effectiveBonusAmount = bonusAnnualAmount > 0
      ? bonusAnnualAmount
      : (emp.bonus_annual_amount || 0);

    const avgResult = calculateAverageWage({
      hireDate,
      retirementDate,
      payrollRecords: effectivePayrolls,
      employee: emp,
      exclusions: exclusions || [],
      includeBonus,
      bonusAnnualAmount: effectiveBonusAmount,
    });

    // ── 6. 퇴직금 계산 ──
    const severancePay = calculateSeverancePay(
      avgResult.appliedDailyWage,
      avgResult.serviceDays
    );

    // ── 7. 퇴직소득세 계산 ──
    const taxResult = calculateSeveranceTax(severancePay, avgResult.serviceYears);

    // ── 8. 실지급액 ──
    const netSeverancePay = severancePay - taxResult.totalTax;

    // ── 9. 지급 기한 (퇴직 후 14일 이내) ──
    const paymentDueDate = new Date(retirementDate);
    paymentDueDate.setDate(paymentDueDate.getDate() + 14);
    const paymentDueDateStr = paymentDueDate.toISOString().slice(0, 10);

    // ── 10. IRP 절세 시뮬레이션 ──
    const irpBenefit = calcIrpTaxBenefit(taxResult.incomeTax);

    // ── 11. 경고 메시지 구성 ──
    const warnings = [];
    if (!hasPayrollData) {
      warnings.push('⚠️ 최근 3개월 급여 데이터가 부족합니다. 등록된 기본급으로 추정 계산했습니다. 정확한 계산을 위해 급여 데이터를 먼저 확인해주세요.');
    }
    if (avgResult.usedOrdinary) {
      warnings.push('ℹ️ 평균임금이 통상임금보다 낮아 통상임금 기준으로 계산했습니다. (근로기준법 제2조 제2항)');
    }
    if (!irpAccount && !emp.irp_account) {
      warnings.push('⚠️ IRP 계좌가 등록되지 않았습니다. 2022.4.14부터 퇴직금은 IRP 계좌로 이전 의무화됩니다.');
    }
    const overdueDays = Math.floor((new Date() - paymentDueDate) / 86400000);
    if (overdueDays > 0) {
      warnings.push(`🚨 지급 기한(${paymentDueDateStr})이 ${overdueDays}일 초과되었습니다. 지연이자(연 20%)가 발생합니다.`);
    }

    // ── 12. 응답 데이터 구성 ──
    const responseData = {
      // 직원 정보
      employeeName: employeeName || '이름 없음',
      employeeId,
      hireDate,
      retirementDate,

      // 재직 정보
      serviceDays: avgResult.serviceDays,
      serviceYears: avgResult.serviceYears,
      serviceYearsDisplay: `${Math.floor(avgResult.serviceYears)}년 ${avgResult.serviceDays % 365}일`,

      // 평균임금 산정
      avgWage: {
        periodStart: avgResult.avgWagePeriodStart,
        periodEnd: avgResult.avgWagePeriodEnd,
        periodDays: avgResult.avgWagePeriodDays,
        basePay3m: avgResult.basePay3m,
        allowance3m: avgResult.allowance3m,
        bonus3m: avgResult.bonus3m,
        bonusIncludeOption: avgResult.bonusIncludeOption,
        unusedLeavePay: avgResult.unusedLeavePay,
        totalWage3m: avgResult.totalWage3m,
        dailyAverageWage: avgResult.dailyAverageWage,
        dailyOrdinaryWage: avgResult.dailyOrdinaryWage,
        appliedDailyWage: avgResult.appliedDailyWage,
        usedOrdinary: avgResult.usedOrdinary,
      },

      // 퇴직금
      severancePay,

      // 퇴직소득세
      tax: {
        serviceYearsDeduction: taxResult.serviceYearsDeduction,
        convertedSalary: taxResult.convertedSalary,
        convertedDeduction: taxResult.convertedDeduction,
        taxBase: taxResult.taxBase,
        incomeTax: taxResult.incomeTax,
        localIncomeTax: taxResult.localIncomeTax,
        totalTax: taxResult.totalTax,
      },

      // 지급 정보
      netSeverancePay,
      paymentDueDate: paymentDueDateStr,
      irpAccount: irpAccount || emp.irp_account || '',

      // IRP 절세 시뮬레이션
      irpBenefit,

      warnings,
      hasPayrollData,
    };

    // ── preview=false 면 DB에 저장 ──
    if (!preview) {
      const saveData = {
        company_id: emp.company_id,
        employee_id: employeeId,
        hire_date: hireDate,
        retirement_date: retirementDate,
        service_days: avgResult.serviceDays,
        service_years_decimal: avgResult.serviceYears,
        severance_type: severanceType,
        avg_wage_period_start: avgResult.avgWagePeriodStart,
        avg_wage_period_end: avgResult.avgWagePeriodEnd,
        avg_wage_period_days: avgResult.avgWagePeriodDays,
        base_pay_3m: avgResult.basePay3m,
        allowance_3m: avgResult.allowance3m,
        bonus_3m: avgResult.bonus3m,
        bonus_include_option: avgResult.bonusIncludeOption,
        unused_leave_pay: avgResult.unusedLeavePay,
        total_wage_3m: avgResult.totalWage3m,
        daily_average_wage: avgResult.dailyAverageWage,
        daily_ordinary_wage: avgResult.dailyOrdinaryWage,
        applied_daily_wage: avgResult.appliedDailyWage,
        severance_pay: severancePay,
        service_years_deduction: taxResult.serviceYearsDeduction,
        converted_salary: taxResult.convertedSalary,
        converted_deduction: taxResult.convertedDeduction,
        tax_base: taxResult.taxBase,
        income_tax: taxResult.incomeTax,
        local_income_tax: taxResult.localIncomeTax,
        total_tax: taxResult.totalTax,
        net_severance_pay: netSeverancePay,
        irp_account: irpAccount || emp.irp_account || null,
        payment_due_date: paymentDueDateStr,
        status: 'pending',
        updated_at: new Date().toISOString(),
      };

      const { data: saved, error: saveErr } = await supabase
        .from('severance_payments')
        .upsert(saveData, { onConflict: 'employee_id' }) // 동일 직원 재계산 시 덮어쓰기
        .select('id')
        .single();

      if (saveErr) {
        console.error('퇴직금 저장 오류:', saveErr);
        return respond(500, { success: false, error: '퇴직금 저장에 실패했습니다. 다시 시도해주세요.' });
      }

      // employees 퇴직일·사유 업데이트
      await supabase
        .from('employees')
        .update({ resignation_date: retirementDate })
        .eq('id', employeeId);

      responseData.savedId = saved.id;
    }

    return respond(200, { success: true, data: responseData });

  } catch (err) {
    console.error('severance-calculate 오류:', err);
    return respond(500, { success: false, error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
};
