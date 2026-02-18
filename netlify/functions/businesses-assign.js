const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'POST만 허용' }) };
  }

  try {
    const token = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!token.companyId) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: '인증 실패' }) };
    }
    if (!['owner', 'admin'].includes(token.role)) {
      return { statusCode: 403, headers, body: JSON.stringify({ success: false, error: '권한 없음' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const assignments = body.assignments;

    if (!Array.isArray(assignments) || assignments.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: '배정 데이터가 없습니다.' }) };
    }

    const supabase = getSupabase();
    let updated = 0;
    let errors = [];

    for (const item of assignments) {
      const { employeeId, businessId } = item;
      if (!employeeId) continue;

      const { error } = await supabase
        .from('employees')
        .update({ business_id: businessId || null })
        .eq('id', employeeId)
        .eq('company_id', token.companyId);

      if (error) {
        errors.push({ employeeId, error: error.message });
      } else {
        updated++;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          updated,
          errors: errors.length > 0 ? errors : undefined,
          message: updated + '명의 직원이 배정되었습니다.'
        }
      })
    };
  } catch (error) {
    console.error('businesses-assign error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message })
    };
  }
};