// netlify/functions/calculate-payroll-batch.js
// Phase 7: 전 직원 일괄 급여 계산 API
// POST { year, month, recalculate? }

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

function floor10(n) { return Math.floor(n / 10) * 10; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { success: false, error: 'Method Not Allowed' });

  try {
    // ── 인증 ──
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try { userInfo = verifyToken(authHeader); } catch {
      return respond(401, { success: false, error: '인증에 실패했습니다.' });
    }

    const { year, month, recalculate, companyId } = JSON.parse(event.body || '{}');
    if (!year || !month) {
      return respond(400, { success: false, error: '필수 정보가 누락되었습니다. (year, month)' });
    }

    // ── 회사 직원 목록 조회 ──
    let query = supabase.from('employees').select('*').eq('status', 'active');
    if (companyId) query = query.eq('company_id', companyId);

    const { data: employees, error: empError } = await query;
    if (empError || !employees?.length) {
      return respond(404, { success: false, error: '활성 직원이 없습니다.' });
    }

    // ── 룰 엔진 로드 (1회) ──
    const payDate = new Date(year, month - 1, 15);
    const rules = await loadAllPayrollRules(supabase, payDate);

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const results = [];
    const errors = [];
    let totalGross = 0, totalDeductions = 0, totalNet = 0, totalEmployerCost = 0;

    for (const employee of employees) {
      try {
        // 캐시 확인
        if (!recalculate) {
          const { data: existing } = await supabase
            .from('payrolls')
            .select('*')
            .eq('employee_id', employee.id)
            .eq('year', year)
            .eq('month', month)
            .single();
          if (existing) {
            results.push({ ...existing, cached: true });
            totalGross += existing.total_payment || 0;
            totalDeductions += existing.total_deductions || 0;
            totalNet += existing.net_payment || 0;
            continue;
          }
        }

        // 출퇴근 기록
        const { data: attendances } = await supabase
          .from('attendances')
          .select('*')
          .eq('employee_id', employee.id)
          .gte('check_in_time', startDate.toISOString())
          .lte('check_in_time', endDate.toISOString())
          .eq('status', 'completed');

        // 근태 집계
        const totalWorkDays = attendances?.length || 0;
        const totalWorkMinutes = attendances?.reduce((s, a) => s + (a.work_duration_minutes || 0), 0) || 0;
        const totalWorkHours = totalWorkMinutes / 60;

        let overtimeHours = 0, nightWorkHours = 0, holidayWorkHours = 0;
        attendances?.forEach(att => {
          const checkIn = new Date(att.check_in_time);
          const checkOut = new Date(att.check_out_time);
          const wh = (att.work_duration_minutes || 0) / 60;
          if (wh > 8) overtimeHours += wh - 8;
          const ns = new Date(checkIn); ns.setHours(22, 0, 0, 0);
          const ne = new Date(checkIn); ne.setDate(ne.getDate() + 1); ne.setHours(6, 0, 0, 0);
          if (checkOut > ns && checkIn < ne) {
            const s = checkIn > ns ? checkIn : ns;
            const e = checkOut < ne ? checkOut : ne;
            const nm = (e.getTime() - s.getTime()) / 60000;
            if (nm > 0) nightWorkHours += nm / 60;
          }
          if (checkIn.getDay() === 0) holidayWorkHours += wh;
        });
        const regularWorkHours = totalWorkHours - overtimeHours;

        // 급여 계산
        const salaryType = employee.salary_type || employee.pay_type || 'hourly';
        const baseSalary = parseFloat(employee.base_salary || employee.hourly_rate || '0');
        let effectiveHourlyRate = baseSalary;
        if (salaryType === 'monthly') effectiveHourlyRate = baseSalary / 209;
        else if (salaryType === 'annual') effectiveHourlyRate = baseSalary / 12 / 209;
        else if (salaryType === 'daily') effectiveHourlyRate = baseSalary / 8;

        let basicPay = 0;
        if (salaryType === 'hourly') basicPay = regularWorkHours * effectiveHourlyRate;
        else if (salaryType === 'daily') basicPay = totalWorkDays * baseSalary;
        else if (salaryType === 'monthly') basicPay = baseSalary;
        else if (salaryType === 'annual') basicPay = baseSalary / 12;
        else basicPay = baseSalary;

        // 주휴수당 (15시간 체크)
        let weeklyHolidayPay = 0;
        if (salaryType === 'hourly' || salaryType === 'daily') {
          const avgWH = totalWorkDays > 0 ? (totalWorkHours / totalWorkDays) * 5 : 0;
          if (avgWH >= rules.weeklyHoliday.minWeeklyHours) {
            weeklyHolidayPay = Math.floor((totalWorkHours / Math.max(totalWorkDays, 1)) * effectiveHourlyRate * 4.345);
          }
        }

        const overtimePay = Math.floor(overtimeHours * effectiveHourlyRate * rules.overtime.extendedRate);
        const nightWorkPay = Math.floor(nightWorkHours * effectiveHourlyRate * rules.overtime.nightRate);
        const holidayWorkPay = Math.floor(holidayWorkHours * effectiveHourlyRate * rules.overtime.holidayRate);

        const mealAllowance = Math.min(employee.meal_allowance || 0, rules.taxExemption.mealAllowance);
        const carAllowance = Math.min(employee.car_allowance || 0, rules.taxExemption.carAllowance);
        const childcareAllowance = Math.min(employee.childcare_allowance || 0, rules.taxExemption.childcareAllowance);
        const nonTaxableAmount = mealAllowance + carAllowance + childcareAllowance;

        const grossPayment = Math.floor(basicPay) + weeklyHolidayPay + overtimePay + nightWorkPay + holidayWorkPay + nonTaxableAmount;
        const taxableIncome = grossPayment - nonTaxableAmount;

        // 4대보험
        const age = calculateAge(employee.birth_date, payDate);
        let nationalPension = 0, employerNP = 0;
        if (age < rules.nationalPension.exemptionAge) {
          const pb = Math.min(Math.max(taxableIncome, rules.nationalPension.lowerLimit), rules.nationalPension.upperLimit);
          nationalPension = floor10(pb * rules.nationalPension.employeeRate);
          employerNP = floor10(pb * rules.nationalPension.employerRate);
        }
        const healthIns = floor10(taxableIncome * rules.healthInsurance.employeeRate);
        const employerHI = floor10(taxableIncome * rules.healthInsurance.employerRate);
        const ltc = floor10(healthIns * rules.longTermCare.rate);
        const employerLTC = floor10(employerHI * rules.longTermCare.rate);
        let empIns = 0, employerEI = 0;
        if (age < rules.employmentInsurance.exemptionAge) {
          empIns = floor10(taxableIncome * rules.employmentInsurance.employeeRate);
          employerEI = floor10(taxableIncome * rules.employmentInsurance.employerRate);
        }

        const incomeTax = await getIncomeTax(supabase, year, taxableIncome, employee.dependents || 1);
        const localIncomeTax = floor10(incomeTax * rules.incomeTax.localTaxRate);

        const totalDed = nationalPension + healthIns + ltc + empIns + incomeTax + localIncomeTax;
        const netPayment = grossPayment - totalDed;

        // 경고
        const warnings = [];
        if (effectiveHourlyRate < rules.minimumWage.hourly) {
          warnings.push({ type: 'MIN_WAGE', severity: 'critical', message: '최저임금 미달' });
        }
        const avgWkAll = totalWorkDays > 0 ? (totalWorkHours / totalWorkDays) * 5 : 0;
        if (avgWkAll > 52) {
          warnings.push({ type: 'OVERTIME_LIMIT', severity: 'critical', message: `주 52시간 초과 (${avgWkAll.toFixed(1)}h)` });
        }

        const payrollData = {
          employee_id: employee.id,
          company_id: employee.company_id,
          year, month,
          total_work_days: totalWorkDays,
          total_work_hours: parseFloat(totalWorkHours.toFixed(2)),
          regular_work_hours: parseFloat(regularWorkHours.toFixed(2)),
          overtime_hours: parseFloat(overtimeHours.toFixed(2)),
          night_work_hours: parseFloat(nightWorkHours.toFixed(2)),
          holiday_work_hours: parseFloat(holidayWorkHours.toFixed(2)),
          salary_type: salaryType,
          base_salary: baseSalary,
          basic_pay: Math.floor(basicPay),
          weekly_holiday_pay: weeklyHolidayPay,
          overtime_pay: overtimePay,
          night_work_pay: nightWorkPay,
          holiday_work_pay: holidayWorkPay,
          other_allowances: 0,
          meal_allowance: mealAllowance,
          car_allowance: carAllowance,
          childcare_allowance: childcareAllowance,
          non_taxable_amount: nonTaxableAmount,
          taxable_income: taxableIncome,
          national_pension: nationalPension,
          health_insurance: healthIns,
          long_term_care: ltc,
          employment_insurance: empIns,
          income_tax: incomeTax,
          local_income_tax: localIncomeTax,
          other_deductions: 0,
          employer_national_pension: employerNP,
          employer_health_insurance: employerHI,
          employer_long_term_care: employerLTC,
          employer_employment_insurance: employerEI,
          employer_industrial_accident: 0,
          total_payment: grossPayment,
          total_deductions: totalDed,
          net_payment: netPayment,
          dependents: employee.dependents || 1,
          warnings: warnings.length > 0 ? warnings : [],
          status: 'calculated'
        };

        const { data: payroll, error: payrollError } = await supabase
          .from('payrolls')
          .upsert(payrollData, { onConflict: 'employee_id,year,month' })
          .select()
          .single();

        if (payrollError) throw payrollError;

        results.push({ ...payroll, employee_name: employee.name, cached: false });
        totalGross += grossPayment;
        totalDeductions += totalDed;
        totalNet += netPayment;
        totalEmployerCost += employerNP + employerHI + employerLTC + employerEI;

      } catch (err) {
        errors.push({ employeeId: employee.id, name: employee.name, error: err.message });
      }
    }

    return respond(200, {
      success: true,
      summary: {
        totalEmployees: employees.length,
        calculated: results.length,
        failed: errors.length,
        totalGrossPayment: totalGross,
        totalDeductions: totalDeductions,
        totalNetPayment: totalNet,
        totalEmployerCost: totalEmployerCost,
        totalLaborCost: totalGross + totalEmployerCost
      },
      results,
      errors,
      warnings: results.filter(r => r.warnings?.length > 0).map(r => ({
        employee: r.employee_name || r.employee_id,
        warnings: r.warnings
      }))
    });

  } catch (error) {
    console.error('일괄 급여 계산 오류:', error);
    return respond(500, { success: false, error: '서버 오류가 발생했습니다.' });
  }
};
