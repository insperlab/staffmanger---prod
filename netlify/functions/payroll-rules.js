// netlify/functions/lib/payroll-rules.js
// 급여 룰 엔진 조회 라이브러리
// Phase 7: 급여엔진 v2

/**
 * payroll_rules 테이블에서 특정 카테고리/키의 값을 조회
 * valid_from <= date <= valid_to 조건으로 시점별 조회
 * 
 * @param {Object} supabase - Supabase 클라이언트
 * @param {string} category - 카테고리 (national_pension, health_insurance 등)
 * @param {string} ruleKey - 룰 키 (rate, upper_limit 등)
 * @param {Date} date - 기준일 (기본: 현재)
 * @returns {number|null} 룰 값 (숫자) 또는 null
 */
async function getRule(supabase, category, ruleKey, date = new Date()) {
  const dateStr = date.toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('payroll_rules')
    .select('value')
    .eq('category', category)
    .eq('rule_key', ruleKey)
    .lte('valid_from', dateStr)
    .gte('valid_to', dateStr)
    .order('valid_from', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    console.warn(`[PayrollRules] Rule not found: ${category}/${ruleKey} for ${dateStr}`, error?.message);
    return null;
  }

  const val = data.value;
  const num = parseFloat(val);
  return isNaN(num) ? val : num;
}

/**
 * 복수 룰을 한번에 조회 (네트워크 최적화)
 * 
 * @param {Object} supabase
 * @param {Array} ruleRequests - [{category, ruleKey}] 배열
 * @param {Date} date
 * @returns {Object} { "category/ruleKey": value } 맵
 */
async function getRules(supabase, ruleRequests, date = new Date()) {
  const dateStr = date.toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('payroll_rules')
    .select('category, rule_key, value, valid_from')
    .lte('valid_from', dateStr)
    .gte('valid_to', dateStr)
    .order('valid_from', { ascending: false });

  if (error || !data) {
    console.error('[PayrollRules] Bulk query failed:', error?.message);
    return {};
  }

  const result = {};
  for (const req of ruleRequests) {
    const key = `${req.category}/${req.ruleKey}`;
    const match = data.find(d => d.category === req.category && d.rule_key === req.ruleKey);
    if (match) {
      const num = parseFloat(match.value);
      result[key] = isNaN(num) ? match.value : num;
    }
  }
  return result;
}

/**
 * 급여 계산에 필요한 모든 룰을 한번에 로드
 * 
 * @param {Object} supabase
 * @param {Date} payDate - 급여 기준일
 * @returns {Object} 구조화된 룰 객체
 */
async function loadAllPayrollRules(supabase, payDate = new Date()) {
  const dateStr = payDate.toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('payroll_rules')
    .select('category, rule_key, value, valid_from')
    .lte('valid_from', dateStr)
    .gte('valid_to', dateStr)
    .order('valid_from', { ascending: false });

  if (error || !data || data.length === 0) {
    console.error('[PayrollRules] Failed to load rules, using hardcoded fallback');
    return getFallbackRules();
  }

  // 카테고리별 최신 룰만 추출 (valid_from DESC로 정렬되어 있음)
  const seen = new Set();
  const latestRules = [];
  for (const row of data) {
    const key = `${row.category}/${row.rule_key}`;
    if (!seen.has(key)) {
      seen.add(key);
      latestRules.push(row);
    }
  }

  // 구조화
  const rules = {
    minimumWage: { hourly: 10320, monthly209h: 2156880 },
    nationalPension: { employeeRate: 0.0475, employerRate: 0.0475, upperLimit: 6370000, lowerLimit: 400000, exemptionAge: 60 },
    healthInsurance: { employeeRate: 0.03595, employerRate: 0.03595 },
    longTermCare: { rate: 0.131385 },
    employmentInsurance: { employeeRate: 0.009, employerRate: 0.009, exemptionAge: 65 },
    taxExemption: { mealAllowance: 200000, carAllowance: 200000, childcareAllowance: 200000 },
    incomeTax: { localTaxRate: 0.1 },
    overtime: { extendedRate: 1.5, nightRate: 0.5, holidayRate: 1.5, holidayExtendedRate: 2.0 },
    weeklyHoliday: { minWeeklyHours: 15 }
  };

  // DB 값으로 덮어쓰기
  const ruleMap = {
    'minimum_wage/hourly': (v) => { rules.minimumWage.hourly = v; },
    'minimum_wage/monthly_209h': (v) => { rules.minimumWage.monthly209h = v; },
    'national_pension/employee_rate': (v) => { rules.nationalPension.employeeRate = v; },
    'national_pension/employer_rate': (v) => { rules.nationalPension.employerRate = v; },
    'national_pension/upper_limit': (v) => { rules.nationalPension.upperLimit = v; },
    'national_pension/lower_limit': (v) => { rules.nationalPension.lowerLimit = v; },
    'national_pension/exemption_age': (v) => { rules.nationalPension.exemptionAge = v; },
    'health_insurance/employee_rate': (v) => { rules.healthInsurance.employeeRate = v; },
    'health_insurance/employer_rate': (v) => { rules.healthInsurance.employerRate = v; },
    'long_term_care/rate': (v) => { rules.longTermCare.rate = v; },
    'employment_insurance/employee_rate': (v) => { rules.employmentInsurance.employeeRate = v; },
    'employment_insurance/employer_rate': (v) => { rules.employmentInsurance.employerRate = v; },
    'employment_insurance/exemption_age': (v) => { rules.employmentInsurance.exemptionAge = v; },
    'tax_exemption/meal_allowance': (v) => { rules.taxExemption.mealAllowance = v; },
    'tax_exemption/car_allowance': (v) => { rules.taxExemption.carAllowance = v; },
    'tax_exemption/childcare_allowance': (v) => { rules.taxExemption.childcareAllowance = v; },
    'income_tax/local_tax_rate': (v) => { rules.incomeTax.localTaxRate = v; },
    'overtime/extended_rate': (v) => { rules.overtime.extendedRate = v; },
    'overtime/night_rate': (v) => { rules.overtime.nightRate = v; },
    'overtime/holiday_rate': (v) => { rules.overtime.holidayRate = v; },
    'overtime/holiday_extended_rate': (v) => { rules.overtime.holidayExtendedRate = v; },
    'weekly_holiday/min_weekly_hours': (v) => { rules.weeklyHoliday.minWeeklyHours = v; },
  };

  for (const row of latestRules) {
    const key = `${row.category}/${row.rule_key}`;
    const setter = ruleMap[key];
    if (setter) {
      const num = parseFloat(row.value);
      setter(isNaN(num) ? row.value : num);
    }
  }

  return rules;
}

/**
 * NTS 간이세액표에서 소득세 조회
 * 
 * @param {Object} supabase
 * @param {number} year - 년도
 * @param {number} monthlySalary - 과세 월급여
 * @param {number} dependents - 부양가족 수 (본인 포함)
 * @returns {number} 소득세 (원)
 */
async function getIncomeTax(supabase, year, monthlySalary, dependents = 1) {
  const deps = Math.max(1, Math.min(dependents, 11));
  
  const { data, error } = await supabase
    .from('income_tax_brackets')
    .select('tax_amount')
    .eq('year', year)
    .eq('dependents', deps)
    .lte('min_salary', monthlySalary)
    .gt('max_salary', monthlySalary)
    .limit(1)
    .single();

  if (error || !data) {
    // 해당 부양가족 수 데이터 없으면 1명으로 재시도
    if (deps > 1) {
      return getIncomeTax(supabase, year, monthlySalary, 1);
    }
    // 그래도 없으면 폴백 계산
    console.warn(`[IncomeTax] Bracket not found for ${year}/${monthlySalary}/${deps}, using fallback`);
    return calculateIncomeTaxFallback(monthlySalary);
  }

  return data.tax_amount;
}

/**
 * 폴백: 간이세액 구간표 (DB 미적재 시)
 * 기존 calculate-payroll.js의 7구간 로직 유지
 */
function calculateIncomeTaxFallback(taxableIncome) {
  if (taxableIncome <= 1060000) return 0;
  if (taxableIncome <= 1500000) return Math.floor((taxableIncome - 1060000) * 0.06);
  if (taxableIncome <= 2100000) return Math.floor(26400 + (taxableIncome - 1500000) * 0.15);
  if (taxableIncome <= 3380000) return Math.floor(116400 + (taxableIncome - 2100000) * 0.15);
  if (taxableIncome <= 4740000) return Math.floor(308400 + (taxableIncome - 3380000) * 0.24);
  if (taxableIncome <= 8330000) return Math.floor(634800 + (taxableIncome - 4740000) * 0.35);
  if (taxableIncome <= 16670000) return Math.floor(1891300 + (taxableIncome - 8330000) * 0.38);
  return Math.floor(5060500 + (taxableIncome - 16670000) * 0.40);
}

/**
 * DB 룰 로드 실패 시 하드코딩 폴백
 */
function getFallbackRules() {
  console.warn('[PayrollRules] Using hardcoded fallback rules (2026)');
  return {
    minimumWage: { hourly: 10320, monthly209h: 2156880 },
    nationalPension: { employeeRate: 0.0475, employerRate: 0.0475, upperLimit: 6370000, lowerLimit: 400000, exemptionAge: 60 },
    healthInsurance: { employeeRate: 0.03595, employerRate: 0.03595 },
    longTermCare: { rate: 0.131385 },
    employmentInsurance: { employeeRate: 0.009, employerRate: 0.009, exemptionAge: 65 },
    taxExemption: { mealAllowance: 200000, carAllowance: 200000, childcareAllowance: 200000 },
    incomeTax: { localTaxRate: 0.1 },
    overtime: { extendedRate: 1.5, nightRate: 0.5, holidayRate: 1.5, holidayExtendedRate: 2.0 },
    weeklyHoliday: { minWeeklyHours: 15 }
  };
}

/**
 * 나이 계산 (한국식 만나이)
 */
function calculateAge(birthDate, referenceDate = new Date()) {
  if (!birthDate) return 0;
  const birth = new Date(birthDate);
  const ref = new Date(referenceDate);
  let age = ref.getFullYear() - birth.getFullYear();
  const monthDiff = ref.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && ref.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

module.exports = {
  getRule,
  getRules,
  loadAllPayrollRules,
  getIncomeTax,
  calculateIncomeTaxFallback,
  getFallbackRules,
  calculateAge
};
