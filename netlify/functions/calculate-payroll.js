// netlify/functions/calculate-payroll.js
// Phase 7: 급여엔진 v2 - 룰 엔진 기반 전면 리팩토링
// 해결된 문제: 4대보험 2026요율, 국민연금 상하한, NTS 간이세액, 주휴수당 15시간,
//             비과세 수당 분리, 사업주 부담분, 연령 면제, 이상탐지 경고

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const { loadAllPayrollRules, getIncomeTax, calculateAge, isHoliday } = require('./lib/payroll-rules');

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

function floor10(n) { return Math.floor(n / 10) * 10; } // 10원 미만 절사

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { success: false, error: 'Method Not Allowed' });

  try {
    // ── 인증 ──
    const authHeader = event.headers.authorization || event.headers.Authorization;
    try { verifyToken(authHeader); } catch {
      return respond(401, { success: false, error: '인증에 실패했습니다. 다시 로그인해주세요.' });
    }

    const { employeeId, year, month, recalculate } = JSON.parse(event.body || '{}');
    if (!employeeId || !year || !month) {
      return respond(400, { success: false, error: '필수 정보가 누락되었습니다. (employeeId, year, month)' });
    }

    // ── 캐시 확인 ──
    if (!recalculate) {
      const { data: existing } = await supabase
        .from('payrolls')
        .select('*')
        .eq('employee_id', employeeId)
        .eq('year', year)
        .eq('month', month)
        .single();
      if (existing) return respond(200, { success: true, data: existing, cached: true });
    }

    // ── 직원 정보 조회 ──
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, company_id')
      .eq('id', employeeId)
      .single();
    if (empError || !employee) {
      return respond(404, { success: false, error: '직원 정보를 찾을 수 없습니다.' });
    }

    // ── 룰 엔진 로드 ──
    const payDate = new Date(year, month - 1, 15); // 해당 월 중간일 기준
    const rules = await loadAllPayrollRules(supabase, payDate);

    // ── 출퇴근 기록 조회 ──
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const { data: attendances, error: attError } = await supabase
      .from('attendances')
      .select('*')
      .eq('employee_id', employeeId)
      .gte('check_in_time', startDate.toISOString())
      .lte('check_in_time', endDate.toISOString())
      .eq('status', 'completed');
    if (attError) return respond(500, { success: false, error: '출퇴근 기록 조회 실패' });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 1: 근태 데이터 집계
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const totalWorkDays = attendances?.length || 0;
    const totalWorkMinutes = attendances?.reduce((sum, att) => sum + (att.work_duration_minutes || 0), 0) || 0;
    const totalWorkHours = totalWorkMinutes / 60;

    // ─── [v9.4 FIX] 근태 집계 변수 ───────────────────────────────────
    // Bug Fix: 이전 코드는 일요일 근무를 overtimeHours + holidayWorkHours 양쪽에 중복 계산했음
    // Fix: 휴일/평일을 먼저 분기 후 각각 별도 처리
    let overtimeHours = 0;       // 평일 연장근무 (8h 초과분)
    let nightWorkHours = 0;      // 야간근무 (22:00~06:00, 평일/휴일 무관하게 집계)
    let holidayRegularHours = 0; // 휴일 8h 이내 (×1.5, 근로기준법 제56조 제2항)
    let holidayExtendedHours = 0;// 휴일 8h 초과분 (×2.0, 동조 단서)
    let holidayWorkDays = 0;     // 휴일 출근일수 (일급 계산용)

    attendances?.forEach(att => {
      const checkIn = new Date(att.check_in_time);
      const checkOut = new Date(att.check_out_time);
      const workHours = (att.work_duration_minutes || 0) / 60;

      if (isHoliday(checkIn)) {
        // ── 휴일근무 (일요일 + 법정공휴일) ──────────────────────────
        // 휴일근무는 연장근무와 별도 카테고리 (이중계산 방지)
        // 8h 이내: ×1.5 / 8h 초과분: ×2.0 (근로기준법 제56조 제2항)
        holidayWorkDays++;
        if (workHours <= 8) {
          holidayRegularHours += workHours;         // 전부 ×1.5 구간
        } else {
          holidayRegularHours += 8;                 // 8h까지 ×1.5
          holidayExtendedHours += workHours - 8;    // 8h 초과분 ×2.0
        }
      } else {
        // ── 평일 연장근무 (8h 초과분) ────────────────────────────────
        // 근로기준법 제56조 제1항
        if (workHours > 8) overtimeHours += workHours - 8;
      }

      // ── 야간근무 (22:00~06:00) ────────────────────────────────────
      // 평일/휴일 구분 없이 항상 적용 (제56조 제3항)
      // 야간+연장 동시: overtimePay(×1.5) + nightWorkPay(×0.5) = 실질 ×2.0 자동합산
      // 야간+휴일 동시: holidayPay(×1.5or×2.0) + nightWorkPay(×0.5) 자동합산
      const nightStart = new Date(checkIn);
      nightStart.setHours(22, 0, 0, 0);
      const nightEnd = new Date(checkIn);
      nightEnd.setDate(nightEnd.getDate() + 1);
      nightEnd.setHours(6, 0, 0, 0);
      if (checkOut > nightStart && checkIn < nightEnd) {
        const ns = checkIn > nightStart ? checkIn : nightStart;
        const ne = checkOut < nightEnd ? checkOut : nightEnd;
        const nightMin = (ne.getTime() - ns.getTime()) / (1000 * 60);
        if (nightMin > 0) nightWorkHours += nightMin / 60;
      }
    });

    // 휴일 총 근무시간 합산
    const holidayWorkHours = holidayRegularHours + holidayExtendedHours;
    // 정규 근무시간 = 전체 - 평일연장 - 휴일 (휴일은 별도 수당으로 처리)
    const regularWorkHours = totalWorkHours - overtimeHours - holidayWorkHours;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 2: 총 지급액 계산
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const salaryType = employee.salary_type || employee.pay_type || 'hourly';
    const baseSalary = parseFloat(employee.base_salary || employee.hourly_rate || '0');

    // 시급 환산
    let effectiveHourlyRate = baseSalary;
    if (salaryType === 'monthly') {
      effectiveHourlyRate = baseSalary / 209;
    } else if (salaryType === 'annual') {
      effectiveHourlyRate = baseSalary / 12 / 209;
    } else if (salaryType === 'daily') {
      effectiveHourlyRate = baseSalary / 8;
    }

    // 기본급
    // ※ hourly/daily의 경우 휴일 근무분은 regularWorkHours/weekdayWorkDays에서 제외되어 있음
    //   → 휴일 근무 금액은 아래 holidayWorkPay로 별도 지급
    let basicPay = 0;
    if (salaryType === 'hourly') {
      // 시급제: 휴일 제외 정규 근무시간 × 시급
      basicPay = regularWorkHours * effectiveHourlyRate;
    } else if (salaryType === 'daily') {
      // 일급제: 평일 출근일수(휴일 출근 제외) × 일급
      const weekdayWorkDays = totalWorkDays - holidayWorkDays;
      basicPay = weekdayWorkDays * baseSalary;
    } else if (salaryType === 'monthly') {
      basicPay = baseSalary;
    } else if (salaryType === 'annual') {
      basicPay = baseSalary / 12;
    } else {
      basicPay = baseSalary;
    }

    // [FIX #2] 주휴수당: 주 15시간 이상 근무 시에만 지급
    let weeklyHolidayPay = 0;
    if (salaryType === 'hourly' || salaryType === 'daily') {
      const avgWeeklyHours = totalWorkDays > 0 ? (totalWorkHours / totalWorkDays) * 5 : 0;
      if (avgWeeklyHours >= rules.weeklyHoliday.minWeeklyHours) {
        const weeksInMonth = 4.345;
        const avgDailyHours = totalWorkHours / Math.max(totalWorkDays, 1);
        weeklyHolidayPay = Math.floor(avgDailyHours * effectiveHourlyRate * weeksInMonth);
      }
    }

    // ─── [v9.4 FIX] 수당 계산 (근로기준법 제56조) ──────────────────
    // 연장: 평일 8h 초과 시간 × 시급 × 1.5
    const overtimePay = Math.floor(overtimeHours * effectiveHourlyRate * rules.overtime.extendedRate);
    // 야간: 22:00~06:00 시간 × 시급 × 0.5 (추가분만 지급, 기본급과 합산되어 실질 배수 상승)
    const nightWorkPay = Math.floor(nightWorkHours * effectiveHourlyRate * rules.overtime.nightRate);
    // 휴일 8h 이내: × 1.5 / 휴일 8h 초과: × 2.0 (각각 별도 계산 후 합산)
    const holidayRegularPay  = Math.floor(holidayRegularHours  * effectiveHourlyRate * rules.overtime.holidayRate);
    const holidayExtendedPay = Math.floor(holidayExtendedHours * effectiveHourlyRate * (rules.overtime.holidayExtendedRate || 2.0));
    const holidayWorkPay = holidayRegularPay + holidayExtendedPay;

    // [FIX #5] 비과세 수당 분리
    const mealAllowance = Math.min(employee.meal_allowance || 0, rules.taxExemption.mealAllowance);
    const carAllowance = Math.min(employee.car_allowance || 0, rules.taxExemption.carAllowance);
    const childcareAllowance = Math.min(employee.childcare_allowance || 0, rules.taxExemption.childcareAllowance);
    const nonTaxableAmount = mealAllowance + carAllowance + childcareAllowance;

    // 총 지급액 (과세 + 비과세)
    const grossPayment = Math.floor(basicPay) + weeklyHolidayPay + overtimePay + nightWorkPay + holidayWorkPay + nonTaxableAmount;
    // 과세 소득 (비과세 차감)
    const taxableIncome = grossPayment - nonTaxableAmount;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 3: 공제액 계산 (4대보험 + 소득세)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const employeeAge = calculateAge(employee.birth_date, payDate);

    // [FIX #1, #4] 4대보험 - 룰 엔진 기반, 2026년 요율
    // ── 국민연금 (기준소득월액 상하한 적용, 60세 이상 면제) ──
    // ── 단시간 근로자 예외: 월 60시간 미만이면 국민연금 가입 제외 ──
    // 근거: 국민연금법 시행령 제2조 (1개월 60시간 미만 근로자 적용 제외)
    // 예외: 3개월 이상 계속 근무 + 사용자 동의 시 적용 가능하나, 기본값은 제외
    const isShortTimeWorker = totalWorkHours < 60; // 월 60시간 미만 단시간 근로자 여부
    let nationalPension = 0;
    let employerNationalPension = 0;
    if (employeeAge < rules.nationalPension.exemptionAge && !isShortTimeWorker) {
      // 정규 근로자: 기준소득월액 상하한 적용
      const pensionBase = Math.min(Math.max(taxableIncome, rules.nationalPension.lowerLimit), rules.nationalPension.upperLimit);
      nationalPension = floor10(pensionBase * rules.nationalPension.employeeRate);
      employerNationalPension = floor10(pensionBase * rules.nationalPension.employerRate);
    }


    // ── 건강보험 ──
    const healthInsurance = floor10(taxableIncome * rules.healthInsurance.employeeRate);
    const employerHealthInsurance = floor10(taxableIncome * rules.healthInsurance.employerRate);

    // ── 장기요양보험 (건보료 기준) ──
    const longTermCare = floor10(healthInsurance * rules.longTermCare.rate);
    const employerLongTermCare = floor10(employerHealthInsurance * rules.longTermCare.rate);

    // ── 고용보험 (65세 이상 미적용) ──
    let employmentInsurance = 0;
    let employerEmploymentInsurance = 0;
    if (employeeAge < rules.employmentInsurance.exemptionAge) {
      employmentInsurance = floor10(taxableIncome * rules.employmentInsurance.employeeRate);
      employerEmploymentInsurance = floor10(taxableIncome * rules.employmentInsurance.employerRate);
    }

    // [FIX #3] 소득세 - NTS 간이세액표 DB 조회 (폴백 내장)
    const incomeTax = await getIncomeTax(supabase, year, taxableIncome, employee.dependents || 1);
    const localIncomeTax = floor10(incomeTax * rules.incomeTax.localTaxRate);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 4: 실수령액 확정
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const totalDeductions = nationalPension + healthInsurance + longTermCare + employmentInsurance + incomeTax + localIncomeTax;
    const netPayment = grossPayment - totalDeductions;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 5: 이상탐지 경고
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const warnings = [];

    // 단시간 근로자 국민연금 적용 제외 안내
    // 근거: 국민연금법 시행령 제2조 (1개월 60시간 미만 근로자 적용 제외)
    if (isShortTimeWorker && employeeAge < rules.nationalPension.exemptionAge) {
      warnings.push({
        type: 'SHORT_TIME_WORKER',
        severity: 'info',
        message: `월 ${totalWorkHours.toFixed(1)}시간 근무 — 국민연금 적용 제외 (월 60시간 미만 단시간 근로자)`
      });
    }

    // 최저임금 위반
    if (effectiveHourlyRate < rules.minimumWage.hourly) {
      warnings.push({ type: 'MIN_WAGE', severity: 'critical', message: `최저임금 미달 (시급 ${Math.floor(effectiveHourlyRate).toLocaleString()}원 < ${rules.minimumWage.hourly.toLocaleString()}원)` });
    }

    // 주 52시간 초과 (월 환산)
    const avgWeeklyHoursAll = totalWorkDays > 0 ? (totalWorkHours / totalWorkDays) * 5 : 0;
    if (avgWeeklyHoursAll > 52) {
      warnings.push({ type: 'OVERTIME_LIMIT', severity: 'critical', message: `주 52시간 초과 (주 평균 ${avgWeeklyHoursAll.toFixed(1)}시간)` });
    }

    // 전월 대비 급여 급변 (±30%)
    const { data: prevPayroll } = await supabase
      .from('payrolls')
      .select('total_payment')
      .eq('employee_id', employeeId)
      .eq('year', month === 1 ? year - 1 : year)
      .eq('month', month === 1 ? 12 : month - 1)
      .single();

    if (prevPayroll?.total_payment > 0) {
      const changeRate = Math.abs(grossPayment - prevPayroll.total_payment) / prevPayroll.total_payment;
      if (changeRate > 0.3) {
        warnings.push({ type: 'PAY_CHANGE', severity: 'warning', message: `전월 대비 ${(changeRate * 100).toFixed(0)}% 변동` });
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 6: DB 저장
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const payrollData = {
      employee_id: employeeId,
      company_id: employee.company_id,
      year,
      month,
      // 근태
      total_work_days: totalWorkDays,
      total_work_hours: parseFloat(totalWorkHours.toFixed(2)),
      regular_work_hours: parseFloat(regularWorkHours.toFixed(2)),
      overtime_hours: parseFloat(overtimeHours.toFixed(2)),
      night_work_hours: parseFloat(nightWorkHours.toFixed(2)),
      holiday_work_hours: parseFloat(holidayWorkHours.toFixed(2)),
      holiday_regular_hours: parseFloat(holidayRegularHours.toFixed(2)),   // 8h 이내 (×1.5)
      holiday_extended_hours: parseFloat(holidayExtendedHours.toFixed(2)), // 8h 초과 (×2.0)
      // 급여 기본
      salary_type: salaryType,
      base_salary: baseSalary,
      basic_pay: Math.floor(basicPay),
      weekly_holiday_pay: weeklyHolidayPay,
      overtime_pay: overtimePay,
      night_work_pay: nightWorkPay,
      holiday_work_pay: holidayWorkPay,
      other_allowances: 0,
      // 비과세
      meal_allowance: mealAllowance,
      car_allowance: carAllowance,
      childcare_allowance: childcareAllowance,
      non_taxable_amount: nonTaxableAmount,
      taxable_income: taxableIncome,
      // 근로자 공제
      national_pension: nationalPension,
      health_insurance: healthInsurance,
      long_term_care: longTermCare,
      employment_insurance: employmentInsurance,
      income_tax: incomeTax,
      local_income_tax: localIncomeTax,
      other_deductions: 0,
      // 사업주 부담
      employer_national_pension: employerNationalPension,
      employer_health_insurance: employerHealthInsurance,
      employer_long_term_care: employerLongTermCare,
      employer_employment_insurance: employerEmploymentInsurance,
      employer_industrial_accident: 0, // 업종별 별도 설정 필요
      // 합계
      total_payment: grossPayment,
      total_deductions: totalDeductions,
      net_payment: netPayment,
      // 메타
      dependents: employee.dependents || 1,
      warnings: warnings.length > 0 ? warnings : [],
      status: 'calculated'
    };

    const { data: payroll, error: payrollError } = await supabase
      .from('payrolls')
      .upsert(payrollData, { onConflict: 'employee_id,year,month' })
      .select()
      .single();

    if (payrollError) {
      console.error('급여 저장 오류:', payrollError);
      return respond(500, { success: false, error: '급여 저장 실패', details: payrollError.message });
    }

    return respond(200, { success: true, data: payroll, cached: false, warnings });

  } catch (error) {
    console.error('급여 계산 오류:', error);
    return respond(500, { success: false, error: '서버 오류가 발생했습니다.' });
  }
};