// netlify/functions/vacations-create.js
// 휴가 등록 + 연차 차감 + 카톡 알림 (Phase 5 이후)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  // CORS 헤더
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Preflight 요청 처리
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // POST 요청만 허용
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const {
      employee_id,
      company_id,
      vacation_type, // '연차', '반차', '병가', '경조사'
      start_date,
      end_date,
      reason,
      created_by, // 점장 user_id
    } = JSON.parse(event.body);

    // 필수 필드 검증
    if (!employee_id || !company_id || !vacation_type || !start_date || !end_date) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['employee_id', 'company_id', 'vacation_type', 'start_date', 'end_date'],
        }),
      };
    }

    // 휴가 일수 계산
    const start = new Date(start_date);
    const end = new Date(end_date);
    const timeDiff = end.getTime() - start.getTime();
    let days = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1; // 시작일 포함

    // 반차 처리
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

      // 잔여 연차 부족 체크
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
        created_by,
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

    // 5. 점장 정보 조회 (카톡 발송용)
    const { data: owner } = await supabase
      .from('users')
      .select('phone')
      .eq('id', created_by)
      .single();

    // 6. 회사 정보 조회 (카톡 발송용)
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', company_id)
      .single();

    // 7. 카카오톡 알림 발송 (TODO: Phase 5 완료 후 활성화)
    // if (process.env.SOLAPI_API_KEY) {
    //   try {
    //     // 점장에게 알림
    //     if (owner && owner.phone) {
    //       await sendKakaoNotification({
    //         to: owner.phone,
    //         templateCode: 'vacation_registered_owner',
    //         variables: {
    //           직원명: employee.name,
    //           시작일: start_date,
    //           종료일: end_date,
    //           휴가종류: vacation_type,
    //           잔여일수: updatedAnnualLeave?.remaining_days || 0,
    //           총일수: updatedAnnualLeave?.total_days || 0,
    //         },
    //       });
    //     }
    //
    //     // 직원에게 알림
    //     if (employee.phone) {
    //       await sendKakaoNotification({
    //         to: employee.phone,
    //         templateCode: 'vacation_registered_employee',
    //         variables: {
    //           매장명: company?.name || 'StaffManager',
    //           직원명: employee.name,
    //           시작일: start_date,
    //           종료일: end_date,
    //           휴가종류: vacation_type,
    //           잔여일수: updatedAnnualLeave?.remaining_days || 0,
    //           총일수: updatedAnnualLeave?.total_days || 0,
    //         },
    //       });
    //     }
    //   } catch (kakaoError) {
    //     console.error('Kakao notification error:', kakaoError);
    //     // 알림 실패해도 휴가 등록은 성공으로 처리
    //   }
    // }

    // 성공 응답
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

// 카카오톡 알림 발송 함수 (Phase 5 이후 구현)
// async function sendKakaoNotification({ to, templateCode, variables }) {
//   // TODO: 솔라피 API 연동
//   console.log('Kakao notification:', { to, templateCode, variables });
// }
