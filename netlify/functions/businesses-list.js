// netlify/functions/businesses-list.js
// 사업장 목록 조회 API — 사업장 필터 드롭다운에서 사용

const { createClient } = require('@supabase/supabase-js');
const { verifyToken, corsHeaders, errorResponse } = require('./lib/auth');

exports.handler = async (event) => {
  // CORS 프리플라이트 처리
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders };
  }

  if (event.httpMethod !== 'GET') {
    return errorResponse(405, '허용되지 않는 메서드입니다');
  }

  // JWT 토큰 검증
  const authResult = verifyToken(event);
  if (!authResult.success) {
    return errorResponse(401, authResult.error);
  }

  const { companyId } = authResult.payload;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 해당 company의 사업장 목록 조회 (활성 사업장만)
    const { data: businesses, error } = await supabase
      .from('businesses')
      .select('id, name, address, phone, is_headquarters, status')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('is_headquarters', { ascending: false }) // 본점 먼저
      .order('name', { ascending: true });

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        businesses: businesses || [],
        total: businesses?.length || 0
      })
    };

  } catch (err) {
    console.error('businesses-list 오류:', err);
    return errorResponse(500, '사업장 목록 조회 실패: ' + err.message);
  }
};