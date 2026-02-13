const { createClient } = require('@supabase/supabase-js');
const { randomBytes } = require('crypto');

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
function successResponse(data) {
  return {
    statusCode: 200,
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
// JWT 토큰에서 사용자 정보 추출
// ====================================
function getUserFromToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('인증 토큰이 없습니다');
  }

  const token = authHeader.substring(7);
  
  try {
    // Base64 디코딩 (auth-login.js와 동일한 형식)
    const payload = JSON.parse(
      Buffer.from(token, 'base64').toString('utf-8')
    );

    return {
      userId: payload.userId,
      companyId: payload.companyId
    };
  } catch (error) {
    throw new Error('토큰 파싱에 실패했습니다');
  }
}

// ====================================
// 임시 비밀번호 생성
// ====================================
function generateTemporaryPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  const randomValues = randomBytes(8);
  
  for (let i = 0; i < 8; i++) {
    password += chars[randomValues[i] % chars.length];
  }
  
  return password + '!';
}

// ====================================
// 메인 핸들러
// ====================================
exports.handler = async (event, context) => {
  console.log('=== employees-create 함수 시작 ===');
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
    // 1. 인증 확인
    console.log('1단계: 인증 확인');
    const authHeader = event.headers.authorization || event.headers.Authorization;
    console.log('Authorization 헤더:', authHeader ? '있음' : '없음');
    
    let userInfo;
    try {
      userInfo = getUserFromToken(authHeader);
      console.log('사용자 정보 추출 성공:', userInfo);
    } catch (error) {
      console.error('인증 실패:', error);
      return errorResponse('인증에 실패했습니다. 다시 로그인해주세요.', 401);
    }

    // 2. 요청 데이터 파싱
    console.log('2단계: 요청 데이터 파싱');
    let requestData;
    try {
      console.log('요청 바디:', event.body);
      requestData = JSON.parse(event.body);
      console.log('파싱된 데이터:', requestData);
    } catch (error) {
      console.error('데이터 파싱 실패:', error);
      return errorResponse('잘못된 요청 데이터입니다', 400);
    }

    // 3. 필수 필드 검증 (이름, 전화번호만 필수)
    console.log('3단계: 필수 필드 검증');
    const requiredFields = ['name', 'phone'];
    for (const field of requiredFields) {
      if (!requestData[field]) {
        console.log(`필수 필드 누락: ${field}`);
        return errorResponse(`${field}는 필수 항목입니다`, 400);
      }
    }

    // 4. Supabase 클라이언트 생성
    console.log('4단계: Supabase 클라이언트 생성');
    let supabase;
    try {
      supabase = getSupabaseClient();
      console.log('Supabase 클라이언트 생성 성공');
    } catch (error) {
      console.error('Supabase 클라이언트 생성 실패:', error);
      return errorResponse('데이터베이스 연결에 실패했습니다', 500);
    }

    let newUser = null;
    let temporaryPassword = null;

    // 5. 사용자 계정 생성 (이메일 없어도 생성)
    console.log('5단계: 사용자 계정 생성');
    
    // 이메일이 없으면 자동 생성 (phone@temp.local)
    const userEmail = requestData.email || `${requestData.phone.replace(/-/g, '')}@temp.local`;
    
    // 이메일 중복 확인
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', userEmail)
      .maybeSingle();

    if (existingUser) {
      console.log('이메일 중복:', userEmail);
      return errorResponse('이미 사용 중인 이메일입니다', 400);
    }

    console.log('6단계: users 테이블에 직원 계정 생성');
    temporaryPassword = generateTemporaryPassword();
    console.log('임시 비밀번호 생성 완료');

    const crypto = require('crypto');
    const passwordHash = crypto.createHash('sha256')
      .update(temporaryPassword)
      .digest('hex');

    const { data: userData, error: userError } = await supabase
      .from('users')
      .insert({
        company_id: userInfo.companyId,
        email: userEmail,
        password_hash: passwordHash,
        name: requestData.name,
        role: 'employee',
        phone: requestData.phone
      })
      .select()
      .single();

    if (userError) {
      console.error('사용자 계정 생성 실패:', userError);
      return errorResponse('사용자 계정 생성에 실패했습니다: ' + userError.message, 500);
    }

    newUser = userData;
    console.log('사용자 계정 생성 성공:', newUser.id);

    // 7. 직원 정보 생성
    console.log('7단계: 직원 정보 생성');
    
    // 직원 데이터 구성
    const employeeData = {
      company_id: userInfo.companyId,
      user_id: newUser.id,  // 항상 존재
      employee_number: requestData.employeeNumber || null,
      department: requestData.department || null,
      position: requestData.position || null,
      hire_date: requestData.hireDate || new Date().toISOString().split('T')[0],
      status: requestData.status || 'active',
      salary_type: requestData.salaryType || 'hourly',
      base_salary: requestData.baseSalary ? parseFloat(requestData.baseSalary) : 9860,
      work_start_time: requestData.workStartTime || '09:00',
      work_end_time: requestData.workEndTime || '18:00',
      work_days: requestData.workDays || '월,화,수,목,금'
    };

    console.log('생성할 직원 데이터:', employeeData);

    const { data: newEmployee, error: employeeError } = await supabase
      .from('employees')
      .insert(employeeData)
      .select()
      .single();

    if (employeeError) {
      console.error('직원 정보 생성 실패:', employeeError);
      
      // 롤백: 생성된 사용자 계정이 있다면 삭제
      if (newUser) {
        await supabase.from('users').delete().eq('id', newUser.id);
      }
      
      return errorResponse('직원 정보 생성에 실패했습니다: ' + employeeError.message, 500);
    }

    console.log('직원 정보 생성 성공:', newEmployee);

    // 8. 환영 알림 생성
    console.log('8단계: 환영 알림 생성');
    try {
      await supabase.from('notifications').insert({
        company_id: userInfo.companyId,
        user_id: newUser.id,
        type: 'employee_registered',
        title: '직원 등록 완료',
        message: `${requestData.name}님이 직원으로 등록되었습니다.${requestData.email ? ` 임시 비밀번호: ${temporaryPassword}` : ''}`,
        is_read: false
      });
      console.log('환영 알림 생성 성공');
    } catch (error) {
      console.warn('알림 생성 실패 (무시):', error);
    }

    // 9. 성공 응답
    console.log('9단계: 성공 응답 반환');
    const responseData = {
      employee: {
        id: newEmployee.id,
        userId: newUser.id,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        employeeNumber: newEmployee.employee_number,
        department: newEmployee.department,
        position: newEmployee.position,
        hireDate: newEmployee.hire_date,
        status: newEmployee.status
      },
      message: '직원이 등록되었습니다.'
    };

    // 임시 비밀번호가 있으면 추가 (이메일이 실제로 입력된 경우)
    if (requestData.email && temporaryPassword) {
      responseData.temporaryPassword = temporaryPassword;
    }

    return successResponse(responseData);

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