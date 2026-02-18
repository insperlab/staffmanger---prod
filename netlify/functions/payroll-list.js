// netlify/functions/payroll-list.js
// Phase 7: 급여 목록 조회 API (급여대장 페이지용)
// GET ?year=2026&month=2

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
    // 인증
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try { userInfo = verifyToken(authHeader); } catch {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: '인증 실패' }) };
    }

    const params = event.queryStringParameters || {};
    const year = parseInt(params.year);
    const month = parseInt(params.month);

    if (!year || !month) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'year, month 필수' }) };
    }

    // 급여 데이터 + 직원 이름 JOIN
    const { data: payrolls, error } = await supabase
      .from('payrolls')
      .select(`
        *,
        employees!inner(name, bank_name, bank_account)
      `)
      .eq('year', year)
      .eq('month', month)
      .order('employees(name)', { ascending: true });

    if (error) {
      console.error('급여 목록 조회 오류:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '조회 실패' }) };
    }

    // 응답 데이터 정리 (employee_name 플랫하게)
    const results = (payrolls || []).map(p => ({
      ...p,
      employee_name: p.employees?.name || '',
      bank_name: p.employees?.bank_name || '',
      bank_account: p.employees?.bank_account || '',
      employees: undefined // 중첩 제거
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
