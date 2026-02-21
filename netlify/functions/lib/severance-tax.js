// netlify/functions/lib/severance-tax.js
// Phase 11: 퇴직소득세 8단계 계산 모듈
//
// [법적 근거] 소득세법 제22조, 소득세법 시행령 제42조의2
// [2026년 기준] 근속연수공제, 환산급여공제, 기본세율 모두 최신 기준

/**
 * [STEP 2] 근속연수공제 계산
 * 
 * 근속연수 5년 이하:  100만원 × 근속연수
 * 5년 초과 10년:    500만원 + 200만원 × (근속연수 - 5)
 * 10년 초과 20년: 1,500만원 + 250만원 × (근속연수 - 10)
 * 20년 초과:      4,000만원 + 300만원 × (근속연수 - 20)
 * 
 * @param {number} serviceYears - 근속연수 소수 (예: 3.14)
 * @returns {number} 근속연수공제액 (원)
 */
function calcServiceYearsDeduction(serviceYears) {
  // 근속연수는 1년 미만 올림 처리 (법적 기준)
  const years = Math.ceil(serviceYears);

  if (years <= 5) {
    return years * 1_000_000;
  } else if (years <= 10) {
    return 5_000_000 + (years - 5) * 2_000_000;
  } else if (years <= 20) {
    return 15_000_000 + (years - 10) * 2_500_000;
  } else {
    return 40_000_000 + (years - 20) * 3_000_000;
  }
}

/**
 * [STEP 3] 환산급여 계산
 * 공식: (퇴직소득금액 - 근속연수공제) × 12 ÷ 근속연수(올림)
 * 
 * @param {number} retirementIncome - 퇴직소득금액
 * @param {number} serviceYearsDeduction - 근속연수공제
 * @param {number} serviceYears - 근속연수 소수
 * @returns {number} 환산급여
 */
function calcConvertedSalary(retirementIncome, serviceYearsDeduction, serviceYears) {
  const years = Math.ceil(serviceYears);
  const base = Math.max(retirementIncome - serviceYearsDeduction, 0);
  return Math.floor((base * 12) / years);
}

/**
 * [STEP 4] 환산급여공제 계산
 * 
 * 800만원 이하:          환산급여 × 100%
 * 800만원~7,000만원:    800만원 + (초과분 × 60%)
 * 7,000만원~1억:      4,520만원 + (초과분 × 55%)
 * 1억~3억:            6,170만원 + (초과분 × 45%)
 * 3억 초과:          15,170만원 + (초과분 × 35%)
 * 
 * @param {number} convertedSalary - 환산급여
 * @returns {number} 환산급여공제액
 */
function calcConvertedDeduction(convertedSalary) {
  if (convertedSalary <= 8_000_000) {
    return convertedSalary; // 100% 공제 → 과세표준 0
  } else if (convertedSalary <= 70_000_000) {
    return 8_000_000 + Math.floor((convertedSalary - 8_000_000) * 0.6);
  } else if (convertedSalary <= 100_000_000) {
    return 45_200_000 + Math.floor((convertedSalary - 70_000_000) * 0.55);
  } else if (convertedSalary <= 300_000_000) {
    return 61_700_000 + Math.floor((convertedSalary - 100_000_000) * 0.45);
  } else {
    return 151_700_000 + Math.floor((convertedSalary - 300_000_000) * 0.35);
  }
}

/**
 * [STEP 5~6] 과세표준에 기본세율 적용 → 환산산출세액
 * 
 * 2026년 소득세 기본세율:
 *   ~1,400만원:  6%
 *   ~5,000만원:  15% (누진공제 126만원)
 *   ~8,800만원:  24% (누진공제 576만원)
 *   ~1.5억:      35% (누진공제 1,544만원)
 *   ~3억:        38% (누진공제 1,994만원)
 *   ~5억:        40% (누진공제 2,594만원)
 *   ~10억:       42% (누진공제 3,594만원)
 *   10억 초과:   45% (누진공제 6,594만원)
 * 
 * @param {number} taxBase - 과세표준
 * @returns {number} 환산산출세액
 */
function calcConvertedTax(taxBase) {
  if (taxBase <= 0) return 0;

  if (taxBase <= 14_000_000) {
    return Math.floor(taxBase * 0.06);
  } else if (taxBase <= 50_000_000) {
    return Math.floor(taxBase * 0.15 - 1_260_000);
  } else if (taxBase <= 88_000_000) {
    return Math.floor(taxBase * 0.24 - 5_760_000);
  } else if (taxBase <= 150_000_000) {
    return Math.floor(taxBase * 0.35 - 15_440_000);
  } else if (taxBase <= 300_000_000) {
    return Math.floor(taxBase * 0.38 - 19_940_000);
  } else if (taxBase <= 500_000_000) {
    return Math.floor(taxBase * 0.40 - 25_940_000);
  } else if (taxBase <= 1_000_000_000) {
    return Math.floor(taxBase * 0.42 - 35_940_000);
  } else {
    return Math.floor(taxBase * 0.45 - 65_940_000);
  }
}

/**
 * [STEP 7] 산출세액 = 환산산출세액 × 근속연수 ÷ 12
 * 
 * @param {number} convertedTax - 환산산출세액
 * @param {number} serviceYears - 근속연수 소수
 * @returns {number} 산출세액
 */
function calcFinalIncomeTax(convertedTax, serviceYears) {
  const years = Math.ceil(serviceYears);
  return Math.floor((convertedTax * years) / 12);
}

/**
 * 메인: 퇴직소득세 8단계 전체 계산
 * 
 * @param {number} severancePay - 퇴직금 (세전)
 * @param {number} serviceYears - 근속연수 소수 (예: 3.1425)
 * @returns {object} 단계별 계산 결과 전체
 */
function calculateSeveranceTax(severancePay, serviceYears) {
  // [STEP 1] 퇴직소득금액 (비과세 퇴직소득 없다고 가정, 소상공인 대상)
  const retirementIncome = severancePay;

  // [STEP 2] 근속연수공제
  const serviceYearsDeduction = calcServiceYearsDeduction(serviceYears);

  // [STEP 3] 환산급여
  const convertedSalary = calcConvertedSalary(retirementIncome, serviceYearsDeduction, serviceYears);

  // [STEP 4] 환산급여공제
  const convertedDeduction = calcConvertedDeduction(convertedSalary);

  // [STEP 5] 과세표준
  const taxBase = Math.max(convertedSalary - convertedDeduction, 0);

  // [STEP 6] 환산산출세액
  const convertedTax = calcConvertedTax(taxBase);

  // [STEP 7] 산출세액
  const incomeTax = calcFinalIncomeTax(convertedTax, serviceYears);

  // [STEP 8] 지방소득세 = 퇴직소득세 × 10%
  const localIncomeTax = Math.floor(incomeTax * 0.1);

  const totalTax = incomeTax + localIncomeTax;

  return {
    retirementIncome,        // 퇴직소득금액
    serviceYearsDeduction,   // 근속연수공제
    convertedSalary,         // 환산급여
    convertedDeduction,      // 환산급여공제
    taxBase,                 // 과세표준
    convertedTax,            // 환산산출세액
    incomeTax,               // 퇴직소득세 (산출세액)
    localIncomeTax,          // 지방소득세
    totalTax,                // 합계 세액
  };
}

/**
 * IRP 연금 수령 시 세제 혜택 시뮬레이션
 * - 10년 이내 연금 수령: 퇴직소득세 × 70%
 * - 10년 초과 연금 수령: 퇴직소득세 × 60%
 * 
 * @param {number} incomeTax - 퇴직소득세
 * @returns {object} 수령 방법별 세액 비교
 */
function calcIrpTaxBenefit(incomeTax) {
  return {
    lumpSum: incomeTax,                       // 일시금 수령
    annuityWithin10: Math.floor(incomeTax * 0.7), // 10년 이내 연금
    annuityOver10: Math.floor(incomeTax * 0.6),   // 10년 초과 연금
    savingWithin10: Math.floor(incomeTax * 0.3),  // 절세액 (10년 이내)
    savingOver10: Math.floor(incomeTax * 0.4),    // 절세액 (10년 초과)
  };
}

module.exports = {
  calculateSeveranceTax,
  calcIrpTaxBenefit,
  calcServiceYearsDeduction,
};
