// netlify/functions/severance-list.js
// Phase 11: 퇴직금 지급 내역 조회 API
// GET /.netlify/functions/severance-list

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

function respond(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method Not Allowed' });

  // ── 인증 ──
  let companyId;
  try {
    const payload = verifyToken(event.headers.authorization || event.headers.Authorization);
    companyId = payload.companyId;
  } catch {
    return respond(401, { success: false, error: '인증에 실패했습니다.' });
  }

  try {
    // 퇴직금 지급 내역 + 직원 이름 JOIN
    const { data, error } = await supabase
      .from('severance_payments')
      .select(`
        id, employee_id, hire_date, retirement_date,
        service_days, service_years_decimal,
        severance_pay, total_tax, net_severance_pay,
        income_tax, local_income_tax,
        payment_due_date, payment_date, status,
        irp_account, severance_type, notes,
        employees ( user_id, users ( name ) )
      `)
      .eq('company_id', companyId)
      .order('retirement_date', { ascending: false });

    if (error) {
      console.error('severance-list 조회 오류:', error);
      return respond(500, { success: false, error: '데이터 조회에 실패했습니다.' });
    }

    // 이름 평탄화 + 기한 초과 상태 자동 업데이트
    const today = new Date().toISOString().slice(0, 10);
    const rows = (data || []).map(r => ({
      ...r,
      employee_name: r.employees?.users?.name || '이름 없음',
      // 미지급 상태인데 기한 초과된 경우 자동 표시
      status: r.status === 'pending' && r.payment_due_date < today
        ? 'overdue'
        : r.status,
    }));

    return respond(200, { success: true, data: rows });

  } catch (err) {
    console.error('severance-list 오류:', err);
    return respond(500, { success: false, error: '서버 오류가 발생했습니다.' });
  }
};
