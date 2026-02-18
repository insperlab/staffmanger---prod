// netlify/functions/calculate-payroll-batch.js
// Phase 7: 전 직원 일괄 급여 계산 API
// POST { year, month, businessId?, recalculate? }

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { success: false, error: 'Method Not Allowed' });

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try {
      userInfo = verifyToken(authHeader);
    } catch {
      return respond(401, { success: false, error: '인증에 실패했습니다. 다시 로그인해주세요.' });
    }

    const body = JSON.parse(event.body || '{}');
    const { year, month, businessId, recalculate } = body;

    if (!year || !month) {
      return respond(400, { success: false, error: '년도(year)와 월(month)은 필수입니다.' });
    }

    let empQuery = supabase
      .from('employees')
      .select('id, name, status, business_id, salary_type, base_salary')
      .eq('company_id', userInfo.companyId)
      .eq('status', 'active');

    if (businessId && businessId !== 'all') {
      if (businessId === 'unassigned') {
        empQuery = empQuery.is('business_id', null);
      } else {
        empQuery = empQuery.eq('business_id', businessId);
      }
    }

    const { data: employees, error: empError } = await empQuery.order('name');

    if (empError) {
      console.error('직원 목록 조회 오류:', empError);
      return respond(500, { success: false, error: '직원 목록을 가져오지 못했습니다.' });
    }

    if (!employees || employees.length === 0) {
      return respond(200, {
        success: true,
        results: [],
        summary: { total: 0, success: 0, failed: 0, cached: 0, totalPayment: 0, totalDeductions: 0, totalNetPayment: 0 },
        message: '계산할 직원이 없습니다.'
      });
    }

    const baseUrl = process.env.URL || 'https://staffmanager.io';
    const calcUrl = `${baseUrl}/.netlify/functions/calculate-payroll`;

    const BATCH_SIZE = 8;
    const results = [];
    const errors = [];

    for (let i = 0; i < employees.length; i += BATCH_SIZE) {
      const batch = employees.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (emp) => {
          try {
            const res = await fetch(calcUrl, {
              method: 'POST',
              headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                employeeId: emp.id,
                year,
                month,
                recalculate: recalculate || false,
              }),
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '계산 실패');

            return {
              employeeId: emp.id,
              employeeName: emp.name,
              success: true,
              cached: data.cached || false,
              data: data.data,
              warnings: data.warnings || [],
            };
          } catch (err) {
            console.error(`직원 ${emp.name}(${emp.id}) 계산 실패:`, err.message);
            errors.push({ employeeId: emp.id, employeeName: emp.name, error: err.message });
            return {
              employeeId: emp.id,
              employeeName: emp.name,
              success: false,
              error: err.message,
            };
          }
        })
      );

      results.push(...batchResults);
    }

    const successResults = results.filter(r => r.success && r.data);
    const summary = {
      total: employees.length,
      success: successResults.length,
      failed: results.filter(r => !r.success).length,
      cached: results.filter(r => r.cached).length,
      calculated: results.filter(r => r.success && !r.cached).length,
      totalPayment: successResults.reduce((sum, r) => sum + (r.data.total_payment || 0), 0),
      totalDeductions: successResults.reduce((sum, r) => sum + (r.data.total_deductions || 0), 0),
      totalNetPayment: successResults.reduce((sum, r) => sum + (r.data.net_payment || 0), 0),
      totalEmployerCost: successResults.reduce((sum, r) => {
        const d = r.data;
        return sum + (d.employer_national_pension || 0) + (d.employer_health_insurance || 0)
          + (d.employer_long_term_care || 0) + (d.employer_employment_insurance || 0);
      }, 0),
      warningCount: results.filter(r => r.warnings && r.warnings.length > 0).length,
    };

    return respond(200, {
      success: true,
      results,
      errors: errors.length > 0 ? errors : undefined,
      summary,
      year,
      month,
    });

  } catch (error) {
    console.error('일괄 급여 계산 오류:', error);
    return respond(500, { success: false, error: '서버 오류가 발생했습니다.' });
  }
};
