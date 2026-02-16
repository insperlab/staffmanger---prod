// =====================================================
// 계약서 목록/상세 조회 API
// GET /.netlify/functions/contracts-list
// GET /.netlify/functions/contracts-list?id=xxx
// Phase 6 - 전자계약 (UCanSign)
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
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'GET만 허용' })
    };
  }

  try {
    // 인증 확인
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

    // 단건 조회
    if (params.id) {
      const { data, error } = await supabase
        .from('contracts')
        .select('*, employees(name, email, phone, position, department)')
        .eq('id', params.id)
        .eq('company_id', userInfo.companyId)
        .single();

      if (error || !data) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다' })
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, data })
      };
    }

    // 목록 조회
    let query = supabase
      .from('contracts')
      .select('*, employees(name, email, phone, position, department)')
      .eq('company_id', userInfo.companyId)
      .order('created_at', { ascending: false });

    // 필터
    if (params.status) {
      query = query.eq('status', params.status);
    }
    if (params.employee_id) {
      query = query.eq('employee_id', params.employee_id);
    }
    if (params.contract_type) {
      query = query.eq('contract_type', params.contract_type);
    }

    // 페이지네이션
    const limit = parseInt(params.limit) || 50;
    const offset = parseInt(params.offset) || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('[contracts-list] 조회 오류:', error);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '계약서 목록 조회 실패' })
      };
    }

    // 상태별 통계
    const { data: stats } = await supabase
      .from('contracts')
      .select('status')
      .eq('company_id', userInfo.companyId);

    const statusCounts = {
      total: (stats || []).length,
      draft: 0, sent: 0, viewed: 0, signed: 0, completed: 0, rejected: 0, expired: 0
    };
    (stats || []).forEach(s => {
      if (statusCounts.hasOwnProperty(s.status)) statusCounts[s.status]++;
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        data: data || [],
        stats: statusCounts,
        pagination: { limit, offset, total: statusCounts.total }
      })
    };

  } catch (error) {
    console.error('[contracts-list] 서버 오류:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message })
    };
  }
};
