// =====================================================
// 회원가입 API
// POST /.netlify/functions/auth-register
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

// Supabase 클라이언트 생성
function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not configured');
  }
  
  return createClient(supabaseUrl, supabaseKey);
}

// 에러 응답 헬퍼
function errorResponse(message, statusCode = 400) {
  return {
    statusCode,
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

// 성공 응답 헬퍼
function successResponse(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    },
    body: JSON.stringify({
      success: true,
      data
    })
  };
}

exports.handler = async (event, context) => {
  // CORS Preflight 처리
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

  // POST 요청만 허용
  if (event.httpMethod !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    // 요청 본문 파싱
    const body = JSON.parse(event.body);
    const { email, password, name, phone, companyName, businessNumber, ceoName } = body;

    // 필수 필드 검증
    if (!email || !password || !name || !companyName) {
      return errorResponse('필수 항목을 모두 입력해주세요.', 400);
    }

    // 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return errorResponse('올바른 이메일 형식이 아닙니다.', 400);
    }

    // 비밀번호 강도 검증 (최소 6자)
    if (password.length < 6) {
      return errorResponse('비밀번호는 최소 6자 이상이어야 합니다.', 400);
    }

    // Supabase 클라이언트 생성
    const supabase = getSupabaseClient();

    // 1. 이메일 중복 확인
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return errorResponse('이미 사용 중인 이메일입니다.', 409);
    }

    // 2. 비밀번호 해싱
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 3. 회사 생성
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .insert({
        name: companyName,
        business_number: businessNumber || null,
        ceo_name: ceoName || name,
        subscription_plan: 'basic',
        subscription_status: 'active'
      })
      .select()
      .single();

    if (companyError) {
      console.error('Company creation error:', companyError);
      return errorResponse('회사 등록 중 오류가 발생했습니다.', 500);
    }

    // 4. 사용자 생성 (회사 소유자)
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        company_id: company.id,
        email,
        password_hash: passwordHash,
        name,
        phone: phone || null,
        role: 'owner',
        status: 'active'
      })
      .select('id, email, name, role, company_id')
      .single();

    if (userError) {
      console.error('User creation error:', userError);
      
      // 회사 삭제 (롤백)
      await supabase
        .from('companies')
        .delete()
        .eq('id', company.id);
      
      return errorResponse('사용자 등록 중 오류가 발생했습니다.', 500);
    }

    // 5. companies 테이블의 owner_id 업데이트
    await supabase
      .from('companies')
      .update({ owner_id: user.id })
      .eq('id', company.id);

    // 6. JWT 토큰 생성 (간단한 Base64 토큰)
    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.company_id,
      exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7일 후 만료
    };
    
    const token = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');

    // 7. 성공 응답
    return successResponse({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        companyId: user.company_id
      },
      company: {
        id: company.id,
        name: company.name
      },
      token,
      message: '회원가입이 완료되었습니다!'
    }, 201);

  } catch (error) {
    console.error('Register error:', error);
    return errorResponse('서버 오류가 발생했습니다.', 500);
  }
};