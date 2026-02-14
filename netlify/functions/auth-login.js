// =====================================================
// 로그인 API - HMAC-SHA256 서명 JWT 발급
// POST /.netlify/functions/auth-login
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { signToken, handleCors, successResponse, errorResponse } = require('./lib/auth');

// ====================================
// Supabase 클라이언트 생성
// ====================================
function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase 환경 변수가 설정되지 않았습니다');
  }

  return createClient(supabaseUrl, supabaseKey);
}

// ====================================
// 메인 핸들러
// ====================================
exports.handler = async (event, context) => {
  console.log('=== auth-login 함수 시작 ===');

  // CORS 처리
  const cors = handleCors(event);
  if (cors.statusCode) return cors; // OPTIONS 응답
  const headers = cors.headers;

  // POST 메서드만 허용
  if (event.httpMethod !== 'POST') {
    return errorResponse('POST 메서드만 허용됩니다', 405, headers);
  }

  try {
    // 1. 요청 데이터 파싱
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (error) {
      return errorResponse('잘못된 요청 데이터입니다', 400, headers);
    }

    const { email, password } = body;

    // 2. 필수 필드 검증
    if (!email || !password) {
      return errorResponse('이메일과 비밀번호를 모두 입력해주세요.', 400, headers);
    }

    // 3. Supabase 클라이언트 생성
    let supabase;
    try {
      supabase = getSupabaseClient();
    } catch (error) {
      console.error('Supabase 클라이언트 생성 실패:', error);
      return errorResponse('데이터베이스 연결에 실패했습니다', 500, headers);
    }

    // 4. 데이터베이스에서 사용자 찾기
    const { data: user, error: userError } = await supabase
      .from('users')
      .select(`
        id,
        email,
        name,
        password_hash,
        role,
        status,
        company_id,
        login_count,
        companies:company_id (
          id,
          name,
          subscription_plan,
          subscription_status
        )
      `)
      .eq('email', email)
      .is('deleted_at', null)
      .single();

    if (userError || !user) {
      return errorResponse('이메일 또는 비밀번호가 올바르지 않습니다.', 401, headers);
    }

    // 5. 계정 상태 확인
    if (user.status !== 'active') {
      return errorResponse('계정이 비활성화되었습니다. 관리자에게 문의하세요.', 403, headers);
    }

    // 6. 비밀번호 검증
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return errorResponse('이메일 또는 비밀번호가 올바르지 않습니다.', 401, headers);
    }

    // 7. 구독 상태 확인
    const company = Array.isArray(user.companies) ? user.companies[0] : user.companies;
    
    if (company && company.subscription_status !== 'active') {
      return errorResponse('구독이 만료되었습니다. 결제 정보를 확인해주세요.', 403, headers);
    }

    // 8. 마지막 로그인 시간 업데이트
    try {
      await supabase
        .from('users')
        .update({
          last_login_at: new Date().toISOString(),
          login_count: (user.login_count || 0) + 1
        })
        .eq('id', user.id);
    } catch (error) {
      console.warn('로그인 정보 업데이트 실패 (무시):', error);
    }

    // 9. HMAC-SHA256 서명된 JWT 토큰 생성
    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.company_id
    });

    console.log('로그인 성공:', user.email);

    // 10. 성공 응답
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            companyId: user.company_id,
            companyName: company?.name || null
          },
          company: company ? {
            id: company.id,
            name: company.name,
            plan: company.subscription_plan,
            status: company.subscription_status
          } : null,
          token,
          message: '로그인되었습니다.'
        }
      })
    };

  } catch (error) {
    console.error('로그인 오류:', error.message);
    return errorResponse('서버 오류가 발생했습니다: ' + error.message, 500, headers);
  }
};
