// netlify/functions/payroll-list.js
// Phase 7: 급여 목록 조회 API (급여대장 페이지용)
// GET ?year=2026&month=2&businessId=xxx (사업장 필터 지원)

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
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try { userInfo = verifyToken(authHeader); } catch {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: '인증 실패' }) };
    }

    const params = event.queryStringParameters || {};
    const year = parseInt(params.year);
    const month = parseInt(params.month);
    const businessId = params.businessId || null;

    if (!year || !month) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'year, month 필수' }) };
    }

    // 기본 쿼리: 급여 + 직원 정보 조인
    let query = supabase
      .from('payrolls')
      .select(`
        *,
        employees!inner(name, bank_name, bank_account, business_id, department)
      `)
      .eq('year', year)
      .eq('month', month);

    // 사업장 필터 적용
    if (businessId) {
      if (businessId === 'unassigned') {
        // 미배정 직원만 조회
        query = query.is('employees.business_id', null);
      } else {
        // 특정 사업장 직원만 조회
        query = query.eq('employees.business_id', businessId);
      }
    }

    query = query.order('employees(name)', { ascending: true });

    const { data: payrolls, error } = await query;

    if (error) {
      console.error('급여 목록 조회 오류:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '조회 실패' }) };
    }

    const results = (payrolls || []).map(p => ({
      ...p,
      employee_name: p.employees?.name || '',
      bank_name: p.employees?.bank_name || '',
      bank_account: p.employees?.bank_account || '',
      business_id: p.employees?.business_id || null,
      department: p.employees?.department || '',
      employees: undefined
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data: results, count: results.length })
    };

  } catch (error) {
    console.error('급여 목록 오류:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '서버 오류' }) };
  }
};
