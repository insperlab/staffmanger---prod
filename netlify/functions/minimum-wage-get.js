const { createClient } = require('@supabase/supabase-js');

// Supabase 클라이언트 생성
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify({
      success: false,
      error: message
    })
  };
}

// ====================================
// 메인 핸들러
// ====================================
exports.handler = async (event, context) => {
  console.log('=== minimum-wage-get 함수 시작 ===');
  console.log('요청 메서드:', event.httpMethod);

  // CORS preflight 처리
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: ''
    };
  }

  // GET과 POST 메서드 모두 허용
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    console.log('잘못된 메서드:', event.httpMethod);
    return errorResponse('GET 또는 POST 메서드만 허용됩니다', 405);
  }

  try {
    // 연도 파라미터 추출
    let year;
    
    if (event.httpMethod === 'GET') {
      // GET 요청: 쿼리 파라미터에서 연도 추출
      year = event.queryStringParameters?.year;
    } else {
      // POST 요청: 요청 본문에서 연도 추출
      const body = JSON.parse(event.body || '{}');
      year = body.year;
    }

    // 연도가 없으면 현재 연도 사용
    if (!year) {
      year = new Date().getFullYear();
      console.log('연도 미지정, 현재 연도 사용:', year);
    }

    // 연도 숫자 변환
    const yearNumber = parseInt(year);
    if (isNaN(yearNumber)) {
      return errorResponse('유효하지 않은 연도입니다', 400);
    }

    console.log('조회 연도:', yearNumber);

    // 데이터베이스에서 최저시급 조회
    const { data: minWage, error: dbError } = await supabase
      .from('minimum_wages')
      .select('*')
      .eq('year', yearNumber)
      .single();

    if (dbError) {
      console.error('데이터베이스 조회 오류:', dbError);
      
      // 데이터가 없는 경우 기본값 반환
      if (dbError.code === 'PGRST116') {
        console.log('해당 연도 데이터 없음, 기본값 반환');
        return successResponse({
          year: yearNumber,
          hourly_wage: 10030,  // 2025년 기준 기본값
          daily_wage: 80240,
          monthly_wage: 2096270,
          message: `${yearNumber}년 최저시급 데이터가 없어 기본값을 반환합니다.`
        });
      }
      
      return errorResponse('데이터베이스 조회 중 오류가 발생했습니다', 500);
    }

    if (!minWage) {
      console.log('해당 연도 데이터 없음');
      return successResponse({
        year: yearNumber,
        hourly_wage: 10030,  // 2025년 기준 기본값
        daily_wage: 80240,
        monthly_wage: 2096270,
        message: `${yearNumber}년 최저시급 데이터가 없어 기본값을 반환합니다.`
      });
    }

    console.log('최저시급 조회 성공:', minWage);

    // 성공 응답
    return successResponse({
      year: minWage.year,
      hourly_wage: minWage.hourly_wage,
      daily_wage: minWage.daily_wage,
      monthly_wage: minWage.monthly_wage,
      effective_from: minWage.effective_from,
      effective_to: minWage.effective_to
    });

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
