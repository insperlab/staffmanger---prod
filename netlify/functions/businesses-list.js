// netlify/functions/businesses-list.js
// 사업장 목록 간단 조회 API (드롭다운 필터용)
// businesses-manage.js와 동일한 패턴으로 수정

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

// CORS 헤더 (businesses-manage.js와 동일한 방식)
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

function ok(data) {
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...data }) };
}
function fail(msg, code = 400) {
  return { statusCode: code, headers, body: JSON.stringify({ success: false, error: msg }) };
}

exports.handler = async (event) => {
  // CORS Preflight 처리
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return fail('GET 메서드만 허용됩니다.', 405);
  }

  try {
    // ✅ 올바른 verifyToken 호출 패턴 (businesses-manage와 동일)
    const token = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!token.companyId) return fail('인증 정보가 없습니다.', 401);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 활성 사업장 목록 조회 (드롭다운용 최소 필드)
    const { data: businesses, error } = await supabase
      .from('businesses')
      .select('id, name, is_headquarters, status')
      .eq('company_id', token.companyId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('is_headquarters', { ascending: false })  // 본점 먼저
      .order('name', { ascending: true });

    if (error) throw error;

    return ok({
      businesses: businesses || [],
      total: (businesses || []).length
    });

  } catch (err) {
    console.error('businesses-list 오류:', err);
    // JWT 오류는 401로 처리
    if (err.message?.includes('jwt') || err.message?.includes('token')) {
      return fail('유효하지 않은 토큰', 401);
    }
    return fail('사업장 목록 조회 오류: ' + err.message, 500);
  }
};