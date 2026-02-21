// netlify/functions/lib/severance-calc.js
// Phase 11: 퇴직금 평균임금 계산 모듈
// 
// [역할] 퇴직 전 3개월 임금 데이터를 받아 1일 평균임금을 계산
// [법적 근거] 퇴직급여보장법 제8조, 근로기준법 제2조 (평균임금 정의)

/**
 * 퇴직 전 3개월 기간을 계산합니다.
 * 예) 퇴직일 2026-02-21 → 산정 기간: 2025-11-22 ~ 2026-02-21
 * 
 * @param {string} retirementDate - 퇴직일 (YYYY-MM-DD)
 * @returns {{ start: Date, end: Date, days: number }}
 */
function getAvgWagePeriod(retirementDate) {
  // 퇴직일 = 마지막 근무일의 다음날이 일반적이나,
  // 실무에서는 퇴직일 당일 포함 3개월 전을 기준으로 함
  const end = new Date(retirementDate);

  // 3개월 전 계산 (월 단위로 정확히)
  const start = new Date(retirementDate);
  start.setMonth(start.getMonth() - 3);
  start.setDate(start.getDate() + 1); // 3개월 전 다음날부터

  // 일수 계산 (시간 오차 방지를 위해 UTC 기준)
  const diffMs = end.getTime() - start.getTime() + 86400000; // +1일 포함
  const days = Math.round(diffMs / 86400000);

  return { start, end, days };
}

/**
 * 대기기간(제외기간)을 차감한 실제 산정 일수와 임금을 반환합니다.
 * 
 * @param {Date} periodStart - 산정 시작일
 * @param {Date} periodEnd - 산정 종료일
 * @param {number} baseDays - 기본 일수
 * @param {Array} exclusions - 제외 기간 목록 [{start_date, end_date, excluded_days, excluded_wage}]
 * @returns {{ adjustedDays: number, excludedWage: number }}
 */
function applyExclusionPeriods(periodStart, periodEnd, baseDays, exclusions = []) {
  let excludedDays = 0;
  let excludedWage = 0;

  for (const ex of exclusions) {
    const exStart = new Date(ex.start_date);
    const exEnd = new Date(ex.end_date);

    // 산정기간과 겹치는 부분만 계산
    const overlapStart = exStart < periodStart ? periodStart : exStart;
    const overlapEnd = exEnd > periodEnd ? periodEnd : exEnd;

    if (overlapStart <= overlapEnd) {
      const overlapDays = Math.round((overlapEnd - overlapStart) / 86400000) + 1;
      excludedDays += overlapDays;
      // 임금은 기간 비율로 안분
      const ratio = overlapDays / ex.excluded_days;
      excludedWage += Math.floor((ex.excluded_wage || 0) * ratio);
    }
  }

  return {
    adjustedDays: Math.max(baseDays - excludedDays, 1), // 최소 1일
    excludedWage,
  };
}

/**
 * payrolls 테이블 데이터에서 3개월 임금 총액을 구성합니다.
 * 
 * @param {Array} payrollRecords - payrolls 테이블 rows (최근 3개월)
 * @param {object} options
 * @param {boolean} options.includeBonus - 상여금 포함 여부 (사업장 선택)
 * @param {number} options.bonusAnnualAmount - 연간 상여금 총액 (직접 입력값)
 * @returns {object} 임금 구성 상세
 */
function buildWageComponents(payrollRecords, options = {}) {
  const { includeBonus = true, bonusAnnualAmount = 0 } = options;

  let basePay3m = 0;      // 기본급 3개월 합계
  let allowance3m = 0;    // 제수당 3개월 합계 (식대·교통비·직책수당 등 고정수당)
  let unusedLeavePay = 0; // 연차미사용수당

  for (const r of payrollRecords) {
    // 기본급 (payrolls 테이블: basic_pay 컬럼)
    basePay3m += Number(r.basic_pay || r.base_salary || 0);

    // 제수당: 야간·연장·휴일수당 + 고정수당 포함
    // payrolls 실제 컬럼: meal_allowance, car_allowance, other_allowances
    allowance3m += Number(r.night_work_pay || 0)
      + Number(r.overtime_pay || 0)
      + Number(r.holiday_work_pay || 0)
      + Number(r.meal_allowance || 0)   // 식대
      + Number(r.car_allowance || 0);   // 교통비(자가운전보조금)

    // 연차미사용수당
    unusedLeavePay += Number(r.unused_leave_pay || 0);
  }

  // 상여금: 연간 상여금의 3/12 (3개월분)
  // ⚠️ 사업장 선택에 따라 포함/제외
  let bonus3m = 0;
  if (includeBonus && bonusAnnualAmount > 0) {
    bonus3m = Math.floor(bonusAnnualAmount * 3 / 12);
  }

  const totalWage3m = basePay3m + allowance3m + bonus3m + unusedLeavePay;

  return {
    basePay3m,
    allowance3m,
    bonus3m,
    bonusIncludeOption: includeBonus,
    unusedLeavePay,
    totalWage3m,
  };
}

/**
 * 1일 통상임금을 계산합니다.
 * 통상임금 = 기본급 + 고정수당 (월 소정근로시간 기준)
 * 
 * @param {object} employee - 직원 정보 (salary_type, base_salary 등)
 * @returns {number} 1일 통상임금
 */
function calcDailyOrdinaryWage(employee) {
  const {
    salary_type,
    base_salary,        // 시급
    monthly_wage,       // 월급
    work_hours_per_day = 8,
    work_days_per_week = 5,
  } = employee;

  // 월 소정근로시간 = (주 근로시간 + 주휴 1시간) × 365/7/12
  const weeklyHours = work_hours_per_day * work_days_per_week;
  const monthlyHours = Math.round((weeklyHours + work_hours_per_day) * 365 / 7 / 12);
  // 일반적으로 주 40시간 → 월 209시간

  if (salary_type === 'hourly') {
    // 시급 기준: 시급 × 월 소정근로시간 / 30
    return Math.floor((Number(base_salary) * monthlyHours) / 30);
  } else if (salary_type === 'monthly') {
    // 월급 기준: 월급 / 30
    return Math.floor(Number(monthly_wage) / 30);
  } else if (salary_type === 'daily') {
    // 일급 기준: 일급 (그대로)
    return Number(base_salary);
  }

  return 0;
}

/**
 * 재직일수를 계산합니다.
 * 입사일부터 퇴직일까지의 일수 (퇴직일 포함)
 * 
 * @param {string} hireDate - 입사일 (YYYY-MM-DD)
 * @param {string} retirementDate - 퇴직일 (YYYY-MM-DD)
 * @returns {{ days: number, years: number, eligible: boolean }}
 */
function calcServicePeriod(hireDate, retirementDate) {
  const hire = new Date(hireDate);
  const retire = new Date(retirementDate);

  // 재직일수 (퇴직일 포함)
  const days = Math.round((retire - hire) / 86400000) + 1;

  // 근속연수 (소수)
  const years = days / 365;

  // 퇴직금 수급 자격: 1년(365일) 이상
  const eligible = days >= 365;

  return { days, years, eligible };
}

/**
 * 메인: 1일 평균임금을 계산하고 통상임금과 비교합니다.
 * 
 * @param {object} params
 * @param {string} params.hireDate
 * @param {string} params.retirementDate
 * @param {Array}  params.payrollRecords   - 최근 3개월 payrolls 데이터
 * @param {object} params.employee         - 직원 기본 정보
 * @param {Array}  params.exclusions       - 대기기간 제외 목록
 * @param {boolean} params.includeBonus    - 상여금 포함 여부
 * @param {number}  params.bonusAnnualAmount - 연간 상여금 총액
 * @returns {object} 평균임금 계산 전체 결과
 */
function calculateAverageWage(params) {
  const {
    hireDate,
    retirementDate,
    payrollRecords = [],
    employee = {},
    exclusions = [],
    includeBonus = true,
    bonusAnnualAmount = 0,
  } = params;

  // 1) 재직 기간
  const { days: serviceDays, years: serviceYears, eligible } = calcServicePeriod(hireDate, retirementDate);

  // 2) 평균임금 산정 기간 (퇴직 전 3개월)
  const { start: periodStart, end: periodEnd, days: basePeriodDays } = getAvgWagePeriod(retirementDate);

  // 3) 대기기간 제외 처리
  const { adjustedDays, excludedWage } = applyExclusionPeriods(
    periodStart, periodEnd, basePeriodDays, exclusions
  );

  // 4) 3개월 임금 구성
  const wages = buildWageComponents(payrollRecords, { includeBonus, bonusAnnualAmount });

  // 대기기간 임금 차감
  const totalWageAdjusted = Math.max(wages.totalWage3m - excludedWage, 0);

  // 5) 1일 평균임금
  const dailyAverageWage = totalWageAdjusted > 0
    ? Math.floor(totalWageAdjusted / adjustedDays)
    : 0;

  // 6) 1일 통상임금 (비교용)
  const dailyOrdinaryWage = calcDailyOrdinaryWage(employee);

  // 7) 적용 일급: 높은 쪽 선택 (법적 보장)
  const appliedDailyWage = Math.max(dailyAverageWage, dailyOrdinaryWage);

  return {
    // 재직 정보
    serviceDays,
    serviceYears: Math.round(serviceYears * 10000) / 10000,
    eligible,

    // 산정 기간
    avgWagePeriodStart: periodStart.toISOString().slice(0, 10),
    avgWagePeriodEnd: periodEnd.toISOString().slice(0, 10),
    avgWagePeriodDays: adjustedDays,

    // 임금 구성
    ...wages,

    // 일급
    dailyAverageWage,
    dailyOrdinaryWage,
    appliedDailyWage,
    usedOrdinary: dailyOrdinaryWage > dailyAverageWage, // 통상임금 적용 여부
  };
}

/**
 * 퇴직금을 계산합니다.
 * 공식: 1일 평균임금 × 30 × (재직일수 / 365)
 * 
 * @param {number} appliedDailyWage - 적용 일급
 * @param {number} serviceDays - 총 재직일수
 * @returns {number} 퇴직금 (원 단위, 원 미만 절사)
 */
function calculateSeverancePay(appliedDailyWage, serviceDays) {
  return Math.floor(appliedDailyWage * 30 * (serviceDays / 365));
}

/**
 * DC형 연간 부담금을 계산합니다.
 * 공식: 연간 임금 총액 / 12 (최소)
 * 
 * @param {Array} annualPayrolls - 해당 연도 1~12월 payrolls
 * @returns {number} 연간 부담금
 */
function calculateDcContribution(annualPayrolls) {
  let annualTotal = 0;
  for (const r of annualPayrolls) {
    annualTotal += Number(r.base_salary || 0)
      + Number(r.meal_allowance || 0)
      + Number(r.transport_allowance || 0)
      + Number(r.position_allowance || 0)
      + Number(r.night_work_pay || 0)
      + Number(r.overtime_pay || 0)
      + Number(r.holiday_work_pay || 0);
  }
  return Math.ceil(annualTotal / 12); // 연임금/12 이상 (올림)
}

module.exports = {
  calculateAverageWage,
  calculateSeverancePay,
  calculateDcContribution,
  calcServicePeriod,
  getAvgWagePeriod,
};
