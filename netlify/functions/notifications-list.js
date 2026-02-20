// =====================================================
// 알림 이력 조회 API
// GET /.netlify/functions/notifications-list
// GET /.netlify/functions/notifications-list?limit=20&offset=0&type=payroll
// =====================================================

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase 환경변수 미설정');
  return createClient(url, key);
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // 인증
  const authHeader = event.headers.authorization || event.headers.Authorization;
  let userInfo;
  try {
    userInfo = verifyToken(authHeader);
  } catch (err) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: '인증 실패: ' + err.message })
    };
  }

  const supabase = getSupabaseClient();
  const params = event.queryStringParameters || {};

  // ── PATCH: 알림 읽음 처리 ──────────────────────────
  if (event.httpMethod === 'PATCH') {
    const body = JSON.parse(event.body || '{}');
    const ids = body.ids; // 읽음 처리할 알림 ID 배열 (없으면 전체)

    let query = supabase
      .from('notifications')
      .update({ read: true, read_at: new Date().toISOString() })
      .eq('company_id', userInfo.companyId);

    if (ids && ids.length > 0) {
      query = query.in('id', ids);
    }

    const { error } = await query;
    if (error) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '읽음 처리 실패: ' + error.message })
      };
    }
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true })
    };
  }

  // ── GET: 알림 목록 조회 ────────────────────────────
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'GET/PATCH만 허용' }) };
  }

  try {
    const limit  = Math.min(parseInt(params.limit)  || 30, 100);
    const offset = parseInt(params.offset) || 0;

    // notifications → users(직원 이름) 조인
    let query = supabase
      .from('notifications')
      .select('*, users:user_id(name)', { count: 'exact' })
      .eq('company_id', userInfo.companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // 타입 필터 (payroll / contract / attendance / vacation)
    if (params.type) {
      query = query.eq('type', params.type);
    }
    // 읽음 여부 필터
    if (params.unread === 'true') {
      query = query.eq('read', false);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('[notifications-list] 조회 오류:', error);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '알림 이력 조회 실패' })
      };
    }

    // 읽지 않은 알림 수 별도 집계
    const { count: unreadCount } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', userInfo.companyId)
      .eq('read', false);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        data: data || [],
        pagination: { total: count || 0, limit, offset },
        unread_count: unreadCount || 0
      })
    };

  } catch (error) {
    console.error('[notifications-list] 서버 오류:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message })
    };
  }
};
