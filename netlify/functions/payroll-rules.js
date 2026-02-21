// netlify/functions/lib/payroll-rules.js
// 급여 룰 엔진 - 2026년 법정 요율 및 규정 기반
// calculate-payroll.js에서 loadAllPayrollRules, getIncomeTax, calculateAge를 import함


/**
 * 한국 법정공휴일 체크 (연도별 하드코딩)
 * 근거: 관공서의 공휴일에 관한 규정 (대통령령)
 * 설날/추석 연휴는 양력으로 미리 변환하여 입력
 * @param {Date} date - 판단할 날짜
 * @returns {boolean} 법정 휴일(일요일 + 공휴일) 여부
 */
function isHoliday(date) {
  // 일요일 = 법정 주휴일 (근로기준법 제55조)
  if (date.getDay() === 0) return true;

  // 날짜 문자열 생성 (YYYY-MM-DD)
  const year = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const key = `${year}-${mm}-${dd}`;

  // 고정 법정공휴일 (매년 동일)
  const fixedHolidays = new Set([
    `${year}-01-01`, // 신정
    `${year}-03-01`, // 삼일절
    `${year}-05-05`, // 어린이날
    `${year}-06-06`, // 현충일
    `${year}-08-15`, // 광복절
    `${year}-10-03`, // 개천절
    `${year}-10-09`, // 한글날
    `${year}-12-25`, // 성탄절
  ]);
  if (fixedHolidays.has(key)) return true;

  // 음력 연휴 (설날 전후, 추석 전후, 부처님오신날) - 양력 변환
  const lunarHolidays = {
    2024: ['2024-02-09','2024-02-10','2024-02-11','2024-02-12',
           '2024-05-15','2024-09-16','2024-09-17','2024-09-18'],
    2025: ['2025-01-28','2025-01-29','2025-01-30',
           '2025-05-05','2025-10-05','2025-10-06','2025-10-07'],
    2026: ['2026-02-17','2026-02-18','2026-02-19',
           '2026-05-24','2026-09-24','2026-09-25','2026-09-26'],
    2027: ['2027-02-06','2027-02-07','2027-02-08',
           '2027-05-13','2027-10-13','2027-10-14','2027-10-15'],
    2028: ['2028-01-26','2028-01-27','2028-01-28',
           '2028-05-02','2028-10-02','2028-10-03','2028-10-04'],
  };
  const lunarSet = new Set(lunarHolidays[year] || []);
  return lunarSet.has(key);
}

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
  // ✅ BUG FIX: 기본값 전체를 2026년 실제 법정값으로 업데이트
  const defaultRules = {
    // 최저임금 (2026년 기준 — 고용노동부 고시)
    minimumWage: {
      hourly: 10320,       // ✅ 수정: 10030 → 10320원 (2026년 최저임금)
      monthly: 2156880,    // ✅ 수정: 2096270 → 2156880원 (주 40시간, 209시간 기준)
    },

    // 국민연금 (2026년 — 국민연금공단 고시)
    nationalPension: {
      employeeRate: 0.0475,  // ✅ 수정: 0.045(4.5%) → 0.0475(4.75%)
      employerRate: 0.0475,  // ✅ 수정: 0.045(4.5%) → 0.0475(4.75%)
      lowerLimit: 370000,    // ✅ 수정: 390000 → 370000원 (기준소득월액 하한)
      upperLimit: 6370000,   // ✅ 수정: 6170000 → 6370000원 (기준소득월액 상한)
      exemptionAge: 60,      // 60세 이상 납부 면제 (유지)
    },

    // 건강보험 (2026년 — 국민건강보험공단 고시)
    healthInsurance: {
      employeeRate: 0.03595, // ✅ 수정: 0.03545(3.545%) → 0.03595(3.595%)
      employerRate: 0.03595, // ✅ 수정: 0.03545(3.545%) → 0.03595(3.595%)
    },

    // 장기요양보험 (건강보험료의 13.85%)
    longTermCare: {
      rate: 0.1385,          // ✅ 수정: 0.1295(12.95%) → 0.1385(13.85%)
    },

    // 고용보험 (2026년 — 유지)
    employmentInsurance: {
      employeeRate: 0.009,   // 근로자 0.9% (유지)
      employerRate: 0.011,   // 사업주 1.1% 150인 미만 기준 (유지)
      exemptionAge: 65,      // 65세 이상 신규 취득 면제 (유지)
    },

    // 소득세 (유지)
    incomeTax: {
      localTaxRate: 0.1,     // 지방소득세 = 소득세의 10%
    },

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 연장/야간/휴일 수당 가산율 (근로기준법 제56조)
    // [v9.4 FIX] nightRate 1.5→0.5, holidayExtendedRate 2.0 추가
    //
    // 각 rate의 의미 (통상임금에 곱하는 "추가 지급 배수"):
    //   연장: 별도로 시급×1.5 지급
    //   야간: 별도로 시급×0.5 추가 지급 (연장+야간 동시 = ×1.5+×0.5 = ×2.0 자동합산)
    //   휴일 8h 이내: 별도로 시급×1.5 지급 (평일 기본급과 별도 계산)
    //   휴일 8h 초과: 별도로 시급×2.0 지급 (제56조 제2항 단서)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    overtime: {
      extendedRate: 1.5,         // 연장근무: 시급×1.5 (제56조 제1항)
      nightRate: 0.5,            // ✅ FIX 1.5→0.5: 야간 추가분 시급×0.5 (제56조 제3항)
      holidayRate: 1.5,          // 휴일 8h 이내: 시급×1.5 (제56조 제2항)
      holidayExtendedRate: 2.0,  // ✅ NEW: 휴일 8h 초과: 시급×2.0 (제56조 제2항 단서)
    },

    // 주휴수당 (근로기준법 제55조 — 유지)
    weeklyHoliday: {
      minWeeklyHours: 15,    // 주 15시간 이상 근무 시 지급
    },

    // 비과세 수당 한도 (2026년 소득세법 기준 — 유지)
    taxExemption: {
      mealAllowance: 200000,      // 식대 월 20만원 한도
      carAllowance: 200000,       // 자가운전보조금 월 20만원 한도
      childcareAllowance: 100000, // 보육수당 월 10만원 한도
    },
  };

  // DB에서 커스텀 룰 조회 시도 (없으면 기본값 사용)
  try {
    const { data: customRules } = await supabase
      .from('payroll_rules')
      .select('*')
      .lte('valid_from', payDate.toISOString())  // ✅ 수정: effective_from → valid_from
      .or(`valid_to.is.null,valid_to.gte.${payDate.toISOString()}`) // ✅ 수정: effective_to → valid_to
      .order('valid_from', { ascending: false })  // ✅ 수정: effective_from → valid_from
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
      .from('income_tax_brackets')  // ✅ 수정: income_tax_table → income_tax_brackets
      .select('*')
      .eq('year', year)
      .lte('min_salary', taxableIncome)  // ✅ 수정: income_from → min_salary
      .gte('max_salary', taxableIncome)  // ✅ 수정: income_to → max_salary
      .eq('dependents', Math.min(dependents, 11)) // ✅ 수정: dep_1 방식 → dependents 컬럼 직접 조회
      .single();

    if (taxRow) {
      return taxRow.tax_amount || 0; // ✅ 수정: taxRow[depKey] → taxRow.tax_amount
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
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { loadAllPayrollRules, getIncomeTax, calculateAge, isHoliday };
