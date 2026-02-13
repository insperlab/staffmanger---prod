const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

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
// 표준 응답 포맷
// ====================================
function successResponse(data, statusCode = 200) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    },
    body: JSON.stringify({
      success: true,
      data: data
    })
  };
}

function errorResponse(message, statusCode = 400) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    },
    body: JSON.stringify({
      success: false,
      error: message
    })
  };
}

// ====================================
// 비밀번호 검증 함수
// ====================================
async function verifyPassword(inputPassword, storedHash) {
  // bcrypt로 검증 (회원가입 시 사용한 방식과 동일)
  return await bcrypt.compare(inputPassword, storedHash);
}

// ====================================
// 메인 핸들러
// ====================================
exports.handler = async (event, context) => {
  console.log('=== auth-login 함수 시작 ===');
  console.log('요청 메서드:', event.httpMethod);

  // CORS preflight 처리
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
      },
      body: ''
    };
  }

  // POST 메서드만 허용
  if (event.httpMethod !== 'POST') {
    console.log('잘못된 메서드:', event.httpMethod);
    return errorResponse('POST 메서드만 허용됩니다', 405);
  }

  try {
    // 1. 요청 데이터 파싱
    console.log('1단계: 요청 데이터 파싱');
    let body;
    try {
      console.log('요청 바디:', event.body);
      body = JSON.parse(event.body);
      console.log('파싱된 데이터:', body);
    } catch (error) {
      console.error('데이터 파싱 실패:', error);
      return errorResponse('잘못된 요청 데이터입니다', 400);
    }

    const { email, password } = body;

    // 2. 필수 필드 검증
    console.log('2단계: 필수 필드 검증');
    if (!email || !password) {
      return errorResponse('이메일과 비밀번호를 모두 입력해주세요.', 400);
    }

    // 3. Supabase 클라이언트 생성
    console.log('3단계: Supabase 클라이언트 생성');
    let supabase;
    try {
      supabase = getSupabaseClient();
      console.log('Supabase 클라이언트 생성 성공');
    } catch (error) {
      console.error('Supabase 클라이언트 생성 실패:', error);
      return errorResponse('데이터베이스 연결에 실패했습니다', 500);
    }

    // 4. 데이터베이스에서 사용자 찾기
    console.log('4단계: 사용자 조회', email);
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

    // 사용자를 찾지 못한 경우
    if (userError || !user) {
      console.log('사용자 조회 실패:', userError);
      return errorResponse('이메일 또는 비밀번호가 올바르지 않습니다.', 401);
    }

    console.log('사용자 조회 성공:', user.id);

    // 5. 계정 상태 확인
    console.log('5단계: 계정 상태 확인');
    if (user.status !== 'active') {
      console.log('계정 비활성 상태:', user.status);
      return errorResponse('계정이 비활성화되었습니다. 관리자에게 문의하세요.', 403);
    }

    // 6. 비밀번호 검증
    console.log('6단계: 비밀번호 검증');
    const isPasswordValid = await verifyPassword(password, user.password_hash);

    if (!isPasswordValid) {
      console.log('비밀번호 불일치');
      return errorResponse('이메일 또는 비밀번호가 올바르지 않습니다.', 401);
    }

    console.log('비밀번호 검증 성공');

    // 7. 구독 상태 확인
    console.log('7단계: 구독 상태 확인');
    const company = Array.isArray(user.companies) ? user.companies[0] : user.companies;
    
    if (company && company.subscription_status !== 'active') {
      console.log('구독 만료:', company.subscription_status);
      return errorResponse('구독이 만료되었습니다. 결제 정보를 확인해주세요.', 403);
    }

    // 8. 마지막 로그인 시간 업데이트
    console.log('8단계: 로그인 정보 업데이트');
    try {
      await supabase
        .from('users')
        .update({
          last_login_at: new Date().toISOString(),
          login_count: (user.login_count || 0) + 1
        })
        .eq('id', user.id);
      console.log('로그인 정보 업데이트 성공');
    } catch (error) {
      // 업데이트 실패는 치명적이지 않으므로 로그만 남기고 계속 진행
      console.warn('로그인 정보 업데이트 실패 (무시):', error);
    }

    // 9. JWT 토큰 생성
    console.log('9단계: JWT 토큰 생성');
    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.company_id,
      exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7일 후 만료
    };
    
    const token = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');
    console.log('JWT 토큰 생성 완료');

    // 10. 성공 응답
    console.log('10단계: 성공 응답 반환');
    return successResponse({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      },
      company: company ? {
        id: company.id,
        name: company.name,
        plan: company.subscription_plan,
        status: company.subscription_status
      } : null,
      token,
      message: '로그인되었습니다.'
    }, 200);

  } catch (error) {
    console.error('=== 예상치 못한 오류 발생 ===');
    console.error('에러 메시지:', error.message);
    console.error('에러 스택:', error.stack);
    
    return errorResponse(
      '서버 오류가 발생했습니다: ' + error.message,
      500
    );
  }
};