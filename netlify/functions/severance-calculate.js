// netlify/functions/severance-calculate.js
// 퇴직금 계산 API — 근로기준법 제34조 기준
// GET ?employeeId=xxx&retireDate=2026-02-20(생략 시 오늘)
//
// 계산 순서:
//   1) 직원 기본정보 + 최근 3개월 payrolls 조회
//   2) 평균임금/일 = 최근 3개월 임금 총액 / 최근 3개월 총 일수
//   3) 통상임금/일 = 월 통상임금 / 30 (계약 기준)
//   4) 평균임금 < 통상임금이면 통상임금으로 대체
//   5) 퇴직금 = 확정 평균임금/일 × 30 × (근속일수 / 365)
//   6) 1년 미만 근속 → 퇴직금 없음 (법정)

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const headers = {
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };
  }

  try {
    // ─── 인증 ───────────────────────────────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try { userInfo = verifyToken(authHeader); }
    catch { return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: '인증 실패' }) }; }

    const params = event.queryStringParameters || {};
    const employeeId = params.employeeId;
    if (!employeeId) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'employeeId 필수' }) };
    }

    // 퇴직일: 파라미터로 받거나 오늘 (재직 중 시뮬레이션 지원)
    const retireDate = params.retireDate
      ? new Date(params.retireDate)
      : new Date();
    retireDate.setHours(23, 59, 59, 0); // 퇴직일 말일 처리

    // ─── 직원 조회 ──────────────────────────────────────────
    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select(`
        id, name, hire_date, resign_date,
        salary_type, base_salary, monthly_wage, annual_salary,
        work_start_time, work_end_time, break_time_minutes, work_days,
        company_id
      `)
      .eq('id', employeeId)
      .eq('company_id', userInfo.companyId)
      .single();

    if (empErr || !emp) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: '직원 정보를 찾을 수 없습니다' }) };
    }

    if (!emp.hire_date) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: '입사일 정보가 없습니다' }) };
    }

    const hireDate = new Date(emp.hire_date);
    const servicedays = Math.floor((retireDate - hireDate) / (1000 * 60 * 60 * 24));
    const serviceYears = servicedays / 365;

    // ─── 근속연수 체크 — 1년 미만은 퇴직금 없음 (근로기준법 제34조) ──
    if (servicedays < 365) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          eligible: false,
          reason: `근속일수 ${servicedays}일 — 퇴직금은 1년(365일) 이상 근속 시 발생합니다`,
          employee: { name: emp.name, hireDate: emp.hire_date, servicedays },
        }),
      };
    }

    // ─── 최근 3개월 payrolls 조회 ───────────────────────────
    // 퇴직일 기준 3개월 역산
    const threeMonthsAgo = new Date(retireDate);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const threeMonthsAgoY = threeMonthsAgo.getFullYear();
    const threeMonthsAgoM = threeMonthsAgo.getMonth() + 1; // 1-based

    // 최근 3개월 (year/month 배열 생성)
    const targetMonths = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(retireDate);
      d.setMonth(d.getMonth() - 1 - i);
      targetMonths.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }

    const { data: payrolls } = await supabase
      .from('payrolls')
      .select('year, month, gross_pay, total_pay, net_pay, non_taxable')
      .eq('employee_id', employeeId)
      .gte('year', threeMonthsAgoY)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(6); // 여유있게 가져옴

    // targetMonths 중 payroll 있는 것만 추출
    const recentPayrolls = targetMonths.map(tm => {
      const p = (payrolls || []).find(x => x.year === tm.year && x.month === tm.month);
      return p || null;
    }).filter(Boolean);

    // ─── 평균임금 계산 ───────────────────────────────────────
    // 평균임금/일 = 최근 3개월 임금 총액 ÷ 최근 3개월 총 일수(역일)
    let avgWagePerDay = 0;
    let totalWage3m = 0;
    let usedPayrollMonths = 0;

    if (recentPayrolls.length > 0) {
      // payroll 데이터가 있으면 실제 지급액 기반
      totalWage3m = recentPayrolls.reduce((sum, p) => {
        const gross = p.gross_pay || p.total_pay || 0;
        return sum + gross;
      }, 0);
      usedPayrollMonths = recentPayrolls.length;

      // 3개월 총 일수 계산 (실제 역일)
      let totalDays3m = 0;
      for (let i = 0; i < 3; i++) {
        const d = new Date(retireDate);
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        // 해당 월의 일수
        const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        totalDays3m += daysInMonth;
      }
      avgWagePerDay = totalWage3m / totalDays3m;

    } else {
      // payroll 없으면 계약 급여로 추산
      const monthlyBase = calcMonthlyWageFromContract(emp);
      totalWage3m = monthlyBase * 3;
      avgWagePerDay = totalWage3m / 91; // 3개월 평균 91일
      usedPayrollMonths = 0;
    }

    // ─── 통상임금/일 계산 (법정 최소 보호) ───────────────────
    // 통상임금 = 기본급 + 고정 수당 / 월 소정근로시간
    const monthlyBase = calcMonthlyWageFromContract(emp);
    const normalWagePerDay = monthlyBase / 30;

    // 평균임금 < 통상임금이면 통상임금 사용 (근로기준법 제2조)
    const useNormalWage = avgWagePerDay < normalWagePerDay;
    const finalWagePerDay = useNormalWage ? normalWagePerDay : avgWagePerDay;

    // ─── 퇴직금 계산 ─────────────────────────────────────────
    // 퇴직금 = 평균임금/일 × 30 × (근속일수 / 365)
    const severancePay = Math.round(finalWagePerDay * 30 * serviceYears);

    // ─── 연도별 퇴직금 내역 (근속연수 구간별) ──────────────────
    const yearlyBreakdown = [];
    const fullYears = Math.floor(serviceYears);
    const remainingDays = servicedays - (fullYears * 365);
    for (let y = 1; y <= fullYears; y++) {
      yearlyBreakdown.push({
        year: y,
        pay: Math.round(finalWagePerDay * 30),
        label: `${y}년차`,
      });
    }
    if (remainingDays > 0) {
      yearlyBreakdown.push({
        year: '잔여',
        pay: Math.round(finalWagePerDay * 30 * (remainingDays / 365)),
        label: `잔여 ${remainingDays}일`,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        eligible: true,
        employee: {
          id: emp.id,
          name: emp.name,
          hireDate: emp.hire_date,
          retireDate: retireDate.toISOString().split('T')[0],
          salaryType: emp.salary_type,
        },
        serviceInfo: {
          days: servicedays,
          years: Math.round(serviceYears * 100) / 100,
          fullYears,
          remainingDays,
          displayText: `${fullYears}년 ${remainingDays}일`,
        },
        wageInfo: {
          totalWage3m: Math.round(totalWage3m),    // 3개월 총 임금
          avgWagePerDay: Math.round(avgWagePerDay), // 평균임금/일
          normalWagePerDay: Math.round(normalWagePerDay), // 통상임금/일
          finalWagePerDay: Math.round(finalWagePerDay),   // 적용 임금/일
          usedNormalWage: useNormalWage,                  // 통상임금 적용 여부
          usedPayrollMonths,                              // 실제 payroll 사용 개월
          dataSource: usedPayrollMonths > 0 ? `실지급액 ${usedPayrollMonths}개월 기반` : '계약 급여 기반 추산',
        },
        severancePay,          // 최종 퇴직금
        yearlyBreakdown,       // 연도별 내역
      }),
    };

  } catch (err) {
    console.error('퇴직금 계산 오류:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '서버 오류: ' + err.message }) };
  }
};

// ─── 계약 기준 월 통상임금 계산 헬퍼 ──────────────────────────
function calcMonthlyWageFromContract(emp) {
  const salaryType = emp.salary_type || 'monthly';

  if (salaryType === 'monthly' || salaryType === 'contract') {
    return parseFloat(emp.monthly_wage || emp.base_salary || 0);
  }
  if (salaryType === 'annual') {
    return parseFloat(emp.annual_salary || 0) / 12;
  }
  if (salaryType === 'hourly') {
    // 시급 × 월 소정근로시간 계산
    const hourlyRate = parseFloat(emp.base_salary || 0);
    const monthlyHours = calcMonthlyHours(emp);
    return hourlyRate * monthlyHours;
  }
  if (salaryType === 'daily') {
    // 일급 × 월 소정근로일수
    const dailyRate = parseFloat(emp.base_salary || 0);
    const workDaysPerWeek = countWorkDays(emp.work_days);
    const monthlyDays = Math.round(workDaysPerWeek * (365 / 12 / 7));
    return dailyRate * monthlyDays;
  }
  return parseFloat(emp.base_salary || emp.monthly_wage || 0);
}

// 월 소정근로시간 계산 (시급제용)
function calcMonthlyHours(emp) {
  if (!emp.work_start_time || !emp.work_end_time) return 209; // 법정 기본값

  const [sh, sm] = emp.work_start_time.split(':').map(Number);
  const [eh, em] = emp.work_end_time.split(':').map(Number);
  const totalMinutes = (eh * 60 + em) - (sh * 60 + sm);
  const breakMin = parseFloat(emp.break_time_minutes || 0);
  const dailyHours = (totalMinutes - breakMin) / 60;

  const workDaysPerWeek = countWorkDays(emp.work_days);
  // 월 소정근로시간 = 주 소정근로시간 × (365 / 7 / 12)
  const weeklyHours = dailyHours * workDaysPerWeek;
  return Math.round(weeklyHours * (365 / 7 / 12) * 10) / 10;
}

// work_days 문자열(예: "mon,tue,wed,thu,fri")에서 일수 추출
function countWorkDays(workDays) {
  if (!workDays) return 5;
  if (typeof workDays === 'number') return workDays;
  if (typeof workDays === 'string') {
    // "mon,tue,wed,thu,fri" 또는 "5" 형태 모두 처리
    const n = parseInt(workDays);
    if (!isNaN(n)) return n;
    return workDays.split(',').filter(Boolean).length;
  }
  return 5;
}
