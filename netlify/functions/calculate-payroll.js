const { verifyToken, getCorsHeaders } = require('./lib/auth');
// netlify/functions/calculate-payroll.js
// 급여 계산 API
// ✅ 보안 패치: Bearer 토큰 인증 추가

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// [보안패치] getUserFromToken → verifyToken으로 대체됨

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://staffmanager.io',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method Not Allowed' })
    };
  }

  try {
    // ✅ 인증 확인
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try {
      userInfo = verifyToken(authHeader);
    } catch (error) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: '인증에 실패했습니다. 다시 로그인해주세요.' }),
      };
    }

    const { employeeId, year, month, recalculate } = JSON.parse(event.body || '{}');

    if (!employeeId || !year || !month) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: '필수 정보가 누락되었습니다. (employeeId, year, month)' })
      };
    }

    // 이미 계산된 급여가 있는지 확인
    if (!recalculate) {
      const { data: existing } = await supabase
        .from('payrolls')
        .select('*')
        .eq('employee_id', employeeId)
        .eq('year', year)
        .eq('month', month)
        .single();

      if (existing) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, data: existing, cached: true })
        };
      }
    }

    // 직원 정보 조회
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, company_id')
      .eq('id', employeeId)
      .single();

    if (empError || !employee) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ success: false, error: '직원 정보를 찾을 수 없습니다.' })
      };
    }

    // 해당 월의 출퇴근 기록 조회
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const { data: attendances, error: attError } = await supabase
      .from('attendances')
      .select('*')
      .eq('employee_id', employeeId)
      .gte('check_in_time', startDate.toISOString())
      .lte('check_in_time', endDate.toISOString())
      .eq('status', 'completed');

    if (attError) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, error: '출퇴근 기록 조회 실패' })
      };
    }

    // 최저시급 조회
    const { data: minWage } = await supabase
      .from('minimum_wages')
      .select('*')
      .eq('year', year)
      .single();

    const minimumHourlyWage = minWage?.hourly_wage || 10030;

    // 근무시간 집계
    const totalWorkDays = attendances?.length || 0;
    const totalWorkMinutes = attendances?.reduce((sum, att) => sum + (att.work_duration_minutes || 0), 0) || 0;
    const totalWorkHours = totalWorkMinutes / 60;

    // 연장/야간/휴일 근무시간 계산
    let overtimeHours = 0;
    let nightWorkHours = 0;
    let holidayWorkHours = 0;

    attendances?.forEach(att => {
      const checkIn = new Date(att.check_in_time);
      const checkOut = new Date(att.check_out_time);
      const workHours = (att.work_duration_minutes || 0) / 60;

      // 하루 8시간 초과 시 연장근무
      if (workHours > 8) {
        overtimeHours += workHours - 8;
      }

      // 야간근무 시간 계산 (22:00 ~ 06:00)
      const nightStart = new Date(checkIn);
      nightStart.setHours(22, 0, 0, 0);
      const nightEnd = new Date(checkIn);
      nightEnd.setDate(nightEnd.getDate() + 1);
      nightEnd.setHours(6, 0, 0, 0);

      if (checkOut > nightStart && checkIn < nightEnd) {
        const actualNightStart = checkIn > nightStart ? checkIn : nightStart;
        const actualNightEnd = checkOut < nightEnd ? checkOut : nightEnd;
        const nightMinutes = (actualNightEnd.getTime() - actualNightStart.getTime()) / (1000 * 60);
        if (nightMinutes > 0) {
          nightWorkHours += nightMinutes / 60;
        }
      }

      // 휴일근무 (일요일)
      if (checkIn.getDay() === 0) {
        holidayWorkHours += workHours;
      }
    });

    const regularWorkHours = totalWorkHours - overtimeHours;

    // 급여 유형별 계산
    const salaryType = employee.salary_type || 'hourly';
    const baseSalary = parseFloat(employee.base_salary || '0');
    
    let effectiveHourlyRate = baseSalary;
    if (salaryType === 'monthly' || salaryType === 'annual') {
      const monthlyBase = salaryType === 'annual' ? baseSalary / 12 : baseSalary;
      effectiveHourlyRate = monthlyBase / 209;
    } else if (salaryType === 'daily') {
      effectiveHourlyRate = baseSalary / 8;
    }

    // 최저시급 검증
    if (effectiveHourlyRate < minimumHourlyWage && salaryType === 'hourly') {
      effectiveHourlyRate = minimumHourlyWage;
    }

    // 기본급 계산
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

    // 주휴수당 계산 (시급제, 일당제만 해당)
    let weeklyHolidayPay = 0;
    if (salaryType === 'hourly' || salaryType === 'daily') {
      const weeksInMonth = 4.345;
      const avgDailyHours = totalWorkHours / totalWorkDays || 8;
      weeklyHolidayPay = avgDailyHours * effectiveHourlyRate * weeksInMonth;
    }

    // 연장근무 수당 (1.5배)
    const overtimePay = overtimeHours * effectiveHourlyRate * 1.5;

    // 야간근무 수당 (0.5배 가산)
    const nightWorkPay = nightWorkHours * effectiveHourlyRate * 0.5;

    // 휴일근무 수당 (1.5배)
    const holidayWorkPay = holidayWorkHours * effectiveHourlyRate * 1.5;

    // 총 지급액
    const totalPayment = basicPay + weeklyHolidayPay + overtimePay + nightWorkPay + holidayWorkPay;

    // 4대보험 및 세금 계산
    const nationalPension = Math.min(totalPayment, 5900000) * 0.045;
    const healthInsurance = Math.min(totalPayment, 85500000) * 0.03545;
    const longTermCare = healthInsurance * 0.1295;
    const employmentInsurance = totalPayment * 0.009;

    // 소득세 간이세액표 적용
    let incomeTax = 0;
    const taxableIncome = totalPayment;
    if (taxableIncome <= 1060000) {
      incomeTax = 0;
    } else if (taxableIncome <= 2100000) {
      incomeTax = (taxableIncome - 1060000) * 0.06;
    } else if (taxableIncome <= 3380000) {
      incomeTax = 62400 + (taxableIncome - 2100000) * 0.15;
    } else if (taxableIncome <= 4740000) {
      incomeTax = 254400 + (taxableIncome - 3380000) * 0.24;
    } else if (taxableIncome <= 8330000) {
      incomeTax = 580800 + (taxableIncome - 4740000) * 0.35;
    } else if (taxableIncome <= 16670000) {
      incomeTax = 1837350 + (taxableIncome - 8330000) * 0.38;
    } else {
      incomeTax = 5006270 + (taxableIncome - 16670000) * 0.40;
    }

    const localIncomeTax = incomeTax * 0.1;

    const totalDeductions = nationalPension + healthInsurance + longTermCare + employmentInsurance + incomeTax + localIncomeTax;
    const netPayment = totalPayment - totalDeductions;

    // payrolls 테이블에 저장
    const payrollData = {
      employee_id: employeeId,
      company_id: employee.company_id,
      year,
      month,
      total_work_days: totalWorkDays,
      total_work_hours: parseFloat(totalWorkHours.toFixed(2)),
      regular_work_hours: parseFloat(regularWorkHours.toFixed(2)),
      overtime_hours: parseFloat(overtimeHours.toFixed(2)),
      night_work_hours: parseFloat(nightWorkHours.toFixed(2)),
      holiday_work_hours: parseFloat(holidayWorkHours.toFixed(2)),
      salary_type: salaryType,
      base_salary: baseSalary,
      basic_pay: parseFloat(basicPay.toFixed(2)),
      weekly_holiday_pay: parseFloat(weeklyHolidayPay.toFixed(2)),
      overtime_pay: parseFloat(overtimePay.toFixed(2)),
      night_work_pay: parseFloat(nightWorkPay.toFixed(2)),
      holiday_work_pay: parseFloat(holidayWorkPay.toFixed(2)),
      other_allowances: 0,
      national_pension: parseFloat(nationalPension.toFixed(2)),
      health_insurance: parseFloat(healthInsurance.toFixed(2)),
      long_term_care: parseFloat(longTermCare.toFixed(2)),
      employment_insurance: parseFloat(employmentInsurance.toFixed(2)),
      income_tax: parseFloat(incomeTax.toFixed(2)),
      local_income_tax: parseFloat(localIncomeTax.toFixed(2)),
      other_deductions: 0,
      total_payment: parseFloat(totalPayment.toFixed(2)),
      total_deductions: parseFloat(totalDeductions.toFixed(2)),
      net_payment: parseFloat(netPayment.toFixed(2)),
      status: 'calculated'
    };

    const { data: payroll, error: payrollError } = await supabase
      .from('payrolls')
      .upsert(payrollData, { onConflict: 'employee_id,year,month' })
      .select()
      .single();

    if (payrollError) {
      console.error('급여 저장 오류:', payrollError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, error: '급여 저장 실패', details: payrollError })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data: payroll, cached: false })
    };

  } catch (error) {
    console.error('급여 계산 오류:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: '서버 오류가 발생했습니다.' })
    };
  }
};
