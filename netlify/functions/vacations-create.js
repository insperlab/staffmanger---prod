const { verifyToken, getCorsHeaders } = require('./lib/auth');
// netlify/functions/vacations-create.js
// 휴가 등록 + 연차 차감 + 카톡 알림 (Phase 5 이후)
// ✅ 보안 패치: Bearer 토큰 인증 추가

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// [보안패치] getUserFromToken → verifyToken으로 대체됨

exports.handler = async (event) => {
  // CORS 헤더 (Authorization 포함)
  const headers = {
    'Access-Control-Allow-Origin': 'https://staffmanager.io',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    // ✅ 인증 확인
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try {
      userInfo = verifyToken(authHeader);
    } catch (error) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: '인증에 실패했습니다. 다시 로그인해주세요.' }),
      };
    }

    const {
      employee_id,
      vacation_type,
      start_date,
      end_date,
      reason,
      created_by,
    } = JSON.parse(event.body);

    // ✅ company_id는 토큰에서 추출
    const company_id = userInfo.companyId;

    if (!employee_id || !vacation_type || !start_date || !end_date) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['employee_id', 'vacation_type', 'start_date', 'end_date'],
        }),
      };
    }

    // 휴가 일수 계산
    const start = new Date(start_date);
    const end = new Date(end_date);
    const timeDiff = end.getTime() - start.getTime();
    let days = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    if (vacation_type === '반차') {
      days = 0.5;
    }

    // 1. 직원 정보 조회
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('name, phone, hire_date')
      .eq('id', employee_id)
      .single();

    if (empError || !employee) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Employee not found' }),
      };
    }

    // 2. 연차 잔여 확인 (연차/반차인 경우만)
    if (vacation_type === '연차' || vacation_type === '반차') {
      const year = new Date(start_date).getFullYear();

      const { data: annualLeave, error: alError } = await supabase
        .from('annual_leaves')
        .select('total_days, used_days, remaining_days')
        .eq('employee_id', employee_id)
        .eq('year', year)
        .single();

      if (alError || !annualLeave) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: `${year}년도 연차 정보가 없습니다.`,
          }),
        };
      }

      if (annualLeave.remaining_days < days) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: '잔여 연차가 부족합니다.',
            available: annualLeave.remaining_days,
            requested: days,
          }),
        };
      }
    }

    // 3. 휴가 등록
    const { data: vacation, error: vacError } = await supabase
      .from('vacations')
      .insert({
        employee_id,
        company_id,
        vacation_type,
        start_date,
        end_date,
        days,
        reason,
        created_by: created_by || userInfo.userId,
      })
      .select()
      .single();

    if (vacError) {
      console.error('Vacation insert error:', vacError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to create vacation',
          details: vacError.message,
        }),
      };
    }

    // 4. 업데이트된 연차 정보 조회
    let updatedAnnualLeave = null;
    if (vacation_type === '연차' || vacation_type === '반차') {
      const year = new Date(start_date).getFullYear();
      const { data: al } = await supabase
        .from('annual_leaves')
        .select('total_days, used_days, remaining_days')
        .eq('employee_id', employee_id)
        .eq('year', year)
        .single();

      updatedAnnualLeave = al;
    }

    // 5. 성공 응답
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        vacation,
        annual_leave: updatedAnnualLeave,
        message: `${employee.name}님의 ${vacation_type}가 등록되었습니다.`,
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message,
      }),
    };
  }
};
