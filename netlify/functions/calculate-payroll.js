// netlify/functions/calculate-payroll.js
// Phase 7: 급여엔진 v2 - 룰 엔진 기반 전면 리팩토링
// 해결된 문제: 4대보험 2026요율, 국민연금 상하한, NTS 간이세액, 주휴수당 15시간,
//             비과세 수당 분리, 사업주 부담분, 연령 면제, 이상탐지 경고

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const { loadAllPayrollRules, getIncomeTax, calculateAge } = require('./lib/payroll-rules');

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

    let overtimeHours = 0;
    let nightWorkHours = 0;
    let holidayWorkHours = 0;

    attendances?.forEach(att => {
      const checkIn = new Date(att.check_in_time);
      const checkOut = new Date(att.check_out_time);
      const workHours = (att.work_duration_minutes || 0) / 60;

      // 하루 8시간 초과 → 연장근무
      if (workHours > 8) overtimeHours += workHours - 8;

      // 야간근무 (22:00 ~ 06:00)
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

      // 휴일근무 (일요일)
      if (checkIn.getDay() === 0) holidayWorkHours += workHours;
    });

    const regularWorkHours = totalWorkHours - overtimeHours;

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
    let basicPay = 0;
    if (salaryType === 'hourly') {
      basicPay = regularWorkHours * effectiveHourlyRate;
    } else if (salaryType === 'daily') {
      basicPay = totalWorkDays * baseSalary;
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

    // 수당 계산 (룰 엔진 가산율 적용)
    const overtimePay = Math.floor(overtimeHours * effectiveHourlyRate * rules.overtime.extendedRate);
    const nightWorkPay = Math.floor(nightWorkHours * effectiveHourlyRate * rules.overtime.nightRate);
    const holidayWorkPay = Math.floor(holidayWorkHours * effectiveHourlyRate * rules.overtime.holidayRate);

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
    let nationalPension = 0;
    let employerNationalPension = 0;
    if (employeeAge < rules.nationalPension.exemptionAge) {
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
