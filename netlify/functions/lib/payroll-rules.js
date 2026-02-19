// netlify/functions/lib/payroll-rules.js
// 급여 룰 엔진 - 2026년 법정 요율 및 규정 기반
// calculate-payroll.js에서 loadAllPayrollRules, getIncomeTax, calculateAge를 import함

/**
 * 나이 계산 함수
 * @param {string} birthDate - 생년월일 (YYYY-MM-DD)
 * @param {Date} referenceDate - 기준일
 * @returns {number} 만 나이
 */
function calculateAge(birthDate, referenceDate = new Date()) {
  if (!birthDate) return 30; // 기본값
  const birth = new Date(birthDate);
  let age = referenceDate.getFullYear() - birth.getFullYear();
  const monthDiff = referenceDate.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

/**
 * 2026년 기준 법정 급여 룰 로드
 * DB에서 커스텀 룰이 있으면 적용, 없으면 법정 기본값 사용
 * @param {object} supabase - Supabase 클라이언트
 * @param {Date} payDate - 급여 기준일
 * @returns {object} 룰 엔진 객체
 */
async function loadAllPayrollRules(supabase, payDate = new Date()) {
  // ── 기본 법정 요율 (2026년 기준) ──
  const defaultRules = {
    // 최저임금 (2026년 기준)
    minimumWage: {
      hourly: 10030,       // 시급 최저임금
      monthly: 2096270,    // 월급 환산 (주 40시간, 209시간)
    },

    // 국민연금 (2026년)
    nationalPension: {
      employeeRate: 0.045,   // 근로자 4.5%
      employerRate: 0.045,   // 사업주 4.5%
      lowerLimit: 390000,    // 기준소득월액 하한
      upperLimit: 6170000,   // 기준소득월액 상한
      exemptionAge: 60,      // 60세 이상 납부 면제
    },

    // 건강보험 (2026년)
    healthInsurance: {
      employeeRate: 0.03545, // 근로자 3.545%
      employerRate: 0.03545, // 사업주 3.545%
    },

    // 장기요양보험 (건강보험료의 12.95%)
    longTermCare: {
      rate: 0.1295,          // 건강보험료 대비 비율
    },

    // 고용보험 (2026년)
    employmentInsurance: {
      employeeRate: 0.009,   // 근로자 0.9%
      employerRate: 0.011,   // 사업주 1.1% (150인 미만 기준)
      exemptionAge: 65,      // 65세 이상 신규 취득 면제
    },

    // 소득세
    incomeTax: {
      localTaxRate: 0.1,     // 지방소득세 = 소득세의 10%
    },

    // 연장/야간/휴일 수당 가산율 (근로기준법 제56조)
    overtime: {
      extendedRate: 1.5,     // 연장근무 통상임금 50% 가산
      nightRate: 1.5,        // 야간근무 통상임금 50% 가산
      holidayRate: 1.5,      // 휴일근무 통상임금 50% 가산
    },

    // 주휴수당 (근로기준법 제55조)
    weeklyHoliday: {
      minWeeklyHours: 15,    // 주 15시간 이상 근무 시 지급
    },

    // 비과세 수당 한도 (2026년 소득세법 기준)
    taxExemption: {
      mealAllowance: 200000,      // 식대 월 20만원 한도
      carAllowance: 200000,       // 자가운전보조금 월 20만원 한도
      childcareAllowance: 100000, // 보육수당 월 10만원 한도
    },
  };

  // DB에서 커스텀 룰 조회 시도 (없으면 기본값 사용)
  try {
    const { data: customRules } = await supabase
      .from('''payroll_rules''')
      .select('''*''')
      .lte('''effective_from''', payDate.toISOString())
      .or(`effective_to.is.null,effective_to.gte.${payDate.toISOString()}`)
      .order('''effective_from''', { ascending: false })
      .limit(1)
      .single();

    if (customRules) {
      // DB 커스텀 룰로 오버라이드
      return deepMerge(defaultRules, customRules.rules || {});
    }
  } catch (e) {
    // payroll_rules 테이블 없거나 데이터 없으면 기본값 사용 (정상)
  }

  return defaultRules;
}

/**
 * 국세청 간이세액표 기반 소득세 조회
 * DB에 간이세액표가 있으면 사용, 없으면 누진세율 직접 계산
 * @param {object} supabase - Supabase 클라이언트
 * @param {number} year - 귀속 연도
 * @param {number} taxableIncome - 과세 소득 (월)
 * @param {number} dependents - 부양가족 수 (본인 포함)
 * @returns {number} 소득세 (10원 미만 절사)
 */
async function getIncomeTax(supabase, year, taxableIncome, dependents = 1) {
  if (!taxableIncome || taxableIncome <= 0) return 0;

  // DB 간이세액표 조회 시도
  try {
    const { data: taxRow } = await supabase
      .from('''income_tax_table''')
      .select('''*''')
      .eq('''year''', year)
      .lte('''income_from''', taxableIncome)
      .gte('''income_to''', taxableIncome)
      .single();

    if (taxRow) {
      const depKey = `dep_${Math.min(dependents, 11)}`;
      return taxRow[depKey] || taxRow.dep_1 || 0;
    }
  } catch (e) {
    // 간이세액표 없으면 직접 계산
  }

  // ── 폴백: 연간 소득 환산 후 누진세율 적용 ──
  return calculateIncomeTaxDirect(taxableIncome, dependents);
}

/**
 * 소득세 직접 계산 (간이세액표 없을 때 폴백)
 * 2026년 소득세법 기준 누진세율 적용
 * @param {number} monthlyIncome - 월 과세 소득
 * @param {number} dependents - 부양가족 수
 * @returns {number} 월 소득세 (10원 미만 절사)
 */
function calculateIncomeTaxDirect(monthlyIncome, dependents = 1) {
  const annualIncome = monthlyIncome * 12;

  // 인적공제: 본인 포함 1인당 150만원
  const personalDeduction = dependents * 1500000;
  const taxableAnnual = Math.max(0, annualIncome - personalDeduction);

  // 2026년 소득세 누진세율 (소득세법 제55조)
  let annualTax = 0;
  if (taxableAnnual <= 14000000) {
    annualTax = taxableAnnual * 0.06;
  } else if (taxableAnnual <= 50000000) {
    annualTax = 840000 + (taxableAnnual - 14000000) * 0.15;
  } else if (taxableAnnual <= 88000000) {
    annualTax = 6240000 + (taxableAnnual - 50000000) * 0.24;
  } else if (taxableAnnual <= 150000000) {
    annualTax = 15360000 + (taxableAnnual - 88000000) * 0.35;
  } else if (taxableAnnual <= 300000000) {
    annualTax = 37060000 + (taxableAnnual - 150000000) * 0.38;
  } else if (taxableAnnual <= 500000000) {
    annualTax = 94060000 + (taxableAnnual - 300000000) * 0.40;
  } else if (taxableAnnual <= 1000000000) {
    annualTax = 174060000 + (taxableAnnual - 500000000) * 0.42;
  } else {
    annualTax = 384060000 + (taxableAnnual - 1000000000) * 0.45;
  }

  const monthlyTax = annualTax / 12;
  return Math.floor(monthlyTax / 10) * 10; // 10원 미만 절사
}

/**
 * 객체 깊은 병합 (커스텀 룰 오버라이드용)
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === '''object''' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { loadAllPayrollRules, getIncomeTax, calculateAge };