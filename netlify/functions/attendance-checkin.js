/**
 * ====================================
 * StaffManager - 출퇴근 기록 API
 * ====================================
 * 
 * 이 함수는 직원이 QR코드를 찍고 출퇴근 버튼을 눌렀을 때
 * 호출되는 API 엔드포인트입니다.
 * 
 * 주요 기능:
 * 1. QR코드 토큰 검증
 * 2. 전화번호로 직원 식별
 * 3. 중복 출퇴근 방지
 * 4. 출퇴근 기록 저장
 * 5. GPS 위치 정보 저장
 */

const { createClient } = require('@supabase/supabase-js');

// Supabase 클라이언트 초기화
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // 관리자 권한 필요
);

// ====================================
// 메인 핸들러 함수
// ====================================

exports.handler = async (event, context) => {
  /*
   * CORS 헤더 설정
   * 브라우저에서 API를 호출할 수 있도록 허용합니다
   */
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // OPTIONS 요청 처리 (CORS preflight)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POST 요청만 허용
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: 'Method Not Allowed' 
      })
    };
  }

  try {
    // ====================================
    // 1. 요청 데이터 파싱
    // ====================================

    const requestBody = JSON.parse(event.body || '{}');
    const { token, phoneNumber, type, timestamp, location } = requestBody;

    /*
     * 필수 파라미터 검증
     * - token: QR코드에서 받은 회사 식별 토큰
     * - phoneNumber: 직원 전화번호
     * - type: 'check-in' 또는 'check-out'
     * - timestamp: 출퇴근 기록 시각 (ISO 8601 형식)
     */
    if (!token || !phoneNumber || !type || !timestamp) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: '필수 정보가 누락되었습니다.'
        })
      };
    }

    // type 값 검증
    if (type !== 'check-in' && type !== 'check-out') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: '잘못된 출퇴근 유형입니다.'
        })
      };
    }

    console.log(`출퇴근 요청: ${type}, 전화번호: ${phoneNumber}`);

    // ====================================
    // 2. 토큰에서 회사 ID 추출
    // ====================================

    /*
     * 토큰 형식: ATT_{companyId}_{timestamp}
     * 예: ATT_550e8400-e29b-41d4-a716-446655440000_1707750000000
     * 
     * 실제 운영 환경에서는 별도의 tokens 테이블에 저장된
     * 토큰을 조회하여 회사 ID를 가져와야 보안이 더 강화됩니다.
     * 지금은 간단하게 토큰 파싱으로 처리합니다.
     */
    const tokenParts = token.split('_');
    if (tokenParts.length < 2 || tokenParts[0] !== 'ATT') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: '유효하지 않은 QR코드입니다.'
        })
      };
    }

    const companyId = tokenParts[1];

    // 회사 존재 여부 확인
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .single();

    if (companyError || !company) {
      console.error('회사 조회 오류:', companyError);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          error: '등록되지 않은 QR코드입니다.'
        })
      };
    }

    // ====================================
    // 3. 전화번호로 직원 찾기
    // ====================================

    /*
     * 전화번호는 하이픈이 포함된 형식으로 저장되어 있을 수도 있고
     * 하이픈 없이 저장되어 있을 수도 있습니다.
     * 두 가지 형식 모두 검색하기 위해 하이픈을 제거한 번호로도 조회합니다.
     */
    const phoneNumberClean = phoneNumber.replace(/-/g, '');

    const { data: employees, error: employeeError } = await supabase
      .from('employees')
      .select('id, name, phone, company_id')
      .eq('company_id', companyId)
      .or(`phone.eq.${phoneNumber},phone.eq.${phoneNumberClean}`);

    if (employeeError) {
      console.error('직원 조회 오류:', employeeError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: '직원 정보를 조회하는 중 오류가 발생했습니다.'
        })
      };
    }

    if (!employees || employees.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          error: '등록되지 않은 전화번호입니다. 관리자에게 문의하세요.'
        })
      };
    }

    const employee = employees[0];

    // ====================================
    // 4. 출퇴근 처리 분기
    // ====================================

    if (type === 'check-in') {
      return await handleCheckIn(employee, company, timestamp, location, headers);
    } else {
      return await handleCheckOut(employee, company, timestamp, location, headers);
    }

  } catch (error) {
    console.error('출퇴근 기록 처리 오류:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
      })
    };
  }
};

// ====================================
// 출근 처리 함수
// ====================================

async function handleCheckIn(employee, company, timestamp, location, headers) {
  /*
   * 오늘 이미 출근 기록이 있는지 확인
   * 같은 날 중복 출근을 방지합니다.
   */
  const today = new Date(timestamp);
  const startOfDay = new Date(today.setHours(0, 0, 0, 0)).toISOString();
  const endOfDay = new Date(today.setHours(23, 59, 59, 999)).toISOString();

  const { data: existingRecords, error: checkError } = await supabase
    .from('attendances')
    .select('id, check_in_time')
    .eq('employee_id', employee.id)
    .gte('check_in_time', startOfDay)
    .lte('check_in_time', endOfDay);

  if (checkError) {
    console.error('출근 기록 조회 오류:', checkError);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: '출근 기록을 확인하는 중 오류가 발생했습니다.'
      })
    };
  }

  // 이미 오늘 출근 기록이 있으면 거부
  if (existingRecords && existingRecords.length > 0) {
    const existingTime = new Date(existingRecords[0].check_in_time);
    const timeStr = `${String(existingTime.getHours()).padStart(2, '0')}:${String(existingTime.getMinutes()).padStart(2, '0')}`;
    
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        success: false,
        error: `오늘 이미 출근하셨습니다. (${timeStr})`
      })
    };
  }

  // 새 출근 기록 생성
  const { data: newRecord, error: insertError } = await supabase
    .from('attendances')
    .insert({
      employee_id: employee.id,
      company_id: company.id,
      check_in_time: timestamp,
      check_in_latitude: location?.latitude || null,
      check_in_longitude: location?.longitude || null,
      status: 'working'
    })
    .select()
    .single();

  if (insertError) {
    console.error('출근 기록 저장 오류:', insertError);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: '출근 기록 저장에 실패했습니다.'
      })
    };
  }

  console.log(`출근 기록 성공: ${employee.name} (${employee.id})`);

  // TODO: 여기서 카카오톡 알림 전송 로직 추가
  // n8n 워크플로우 트리거하거나 솔라피 API 직접 호출

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      data: {
        id: newRecord.id,
        employeeName: employee.name,
        checkInTime: timestamp,
        message: '출근이 기록되었습니다.'
      }
    })
  };
}

// ====================================
// 퇴근 처리 함수
// ====================================

async function handleCheckOut(employee, company, timestamp, location, headers) {
  /*
   * 오늘 출근 기록이 있는지 확인
   * 출근하지 않고 퇴근만 할 수는 없습니다.
   */
  const today = new Date(timestamp);
  const startOfDay = new Date(today.setHours(0, 0, 0, 0)).toISOString();
  const endOfDay = new Date(today.setHours(23, 59, 59, 999)).toISOString();

  const { data: todayRecords, error: checkError } = await supabase
    .from('attendances')
    .select('*')
    .eq('employee_id', employee.id)
    .gte('check_in_time', startOfDay)
    .lte('check_in_time', endOfDay)
    .eq('status', 'working')
    .order('check_in_time', { ascending: false })
    .limit(1);

  if (checkError) {
    console.error('출근 기록 조회 오류:', checkError);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: '출근 기록을 확인하는 중 오류가 발생했습니다.'
      })
    };
  }

  // 오늘 출근 기록이 없으면 거부
  if (!todayRecords || todayRecords.length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        success: false,
        error: '오늘 출근 기록이 없습니다. 먼저 출근을 기록해주세요.'
      })
    };
  }

  const checkInRecord = todayRecords[0];

  /*
   * 퇴근 시각이 출근 시각보다 이른지 검증
   * 시스템 시각 오류나 악의적인 조작을 방지합니다.
   */
  const checkInTime = new Date(checkInRecord.check_in_time);
  const checkOutTime = new Date(timestamp);
  
  if (checkOutTime <= checkInTime) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        success: false,
        error: '퇴근 시각이 출근 시각보다 빠를 수 없습니다.'
      })
    };
  }

  // 출근 기록에 퇴근 시각 추가 (트리거가 자동으로 근무시간 계산)
  const { data: updatedRecord, error: updateError } = await supabase
    .from('attendances')
    .update({
      check_out_time: timestamp,
      check_out_latitude: location?.latitude || null,
      check_out_longitude: location?.longitude || null,
      // status는 트리거에서 자동으로 'completed'로 변경됨
    })
    .eq('id', checkInRecord.id)
    .select()
    .single();

  if (updateError) {
    console.error('퇴근 기록 저장 오류:', updateError);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: '퇴근 기록 저장에 실패했습니다.'
      })
    };
  }

  console.log(`퇴근 기록 성공: ${employee.name} (${employee.id})`);

  // TODO: 여기서 카카오톡 알림 전송 로직 추가

  /*
   * 근무시간은 데이터베이스 트리거가 자동 계산하므로
   * 클라이언트에 보낼 때는 별도 계산 필요
   */
  const workDurationMinutes = Math.floor(
    (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60)
  );
  const workHours = Math.floor(workDurationMinutes / 60);
  const workMinutes = workDurationMinutes % 60;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      data: {
        id: updatedRecord.id,
        employeeName: employee.name,
        checkOutTime: timestamp,
        workDuration: `${workHours}시간 ${workMinutes}분`,
        message: '퇴근이 기록되었습니다. 수고하셨습니다!'
      }
    })
  };
}
