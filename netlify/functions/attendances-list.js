const { verifyToken, getCorsHeaders } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

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

// [보안패치] getUserFromToken → verifyToken으로 대체됨

// ====================================
// 메인 핸들러
// ====================================
exports.handler = async (event, context) => {
  console.log('=== attendances-list 함수 시작 ===');

  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://staffmanager.io',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, error: 'GET 메서드만 허용됩니다' })
    };
  }

  try {
    // 1. 인증 확인
    console.log('1단계: 인증 확인');
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const userInfo = verifyToken(authHeader);
    console.log('사용자 정보:', userInfo);

    // 2. URL 파라미터 파싱
    const params = event.queryStringParameters || {};
    const startDate = params.startDate; // YYYY-MM-DD
    const endDate = params.endDate; // YYYY-MM-DD
    const employeeId = params.employeeId; // 특정 직원만 조회
    const department = params.department; // 특정 부서만 조회

    console.log('조회 파라미터:', { startDate, endDate, employeeId, department });

    // 3. Supabase 클라이언트 생성
    const supabase = getSupabaseClient();

    // 4. 출퇴근 기록 조회 쿼리 구성
    let query = supabase
      .from('attendances')
      .select(`
        id,
        employee_id,
        company_id,
        check_in_time,
        check_out_time,
        work_hours,
        overtime_hours,
        late_minutes,
        early_leave_minutes,
        status,
        notes,
        employees!inner (
          id,
          name,
          department,
          position,
          phone
        )
      `)
      .eq('company_id', userInfo.companyId)
      .order('check_in_time', { ascending: false });

    // 날짜 범위 필터
    if (startDate) {
      query = query.gte('check_in_time', startDate + 'T00:00:00');
    }
    if (endDate) {
      query = query.lte('check_in_time', endDate + 'T23:59:59');
    }

    // 특정 직원 필터
    if (employeeId) {
      query = query.eq('employee_id', employeeId);
    }

    // 특정 부서 필터
    if (department) {
      query = query.eq('employees.department', department);
    }

    const { data: attendances, error: attendancesError } = await query;

    if (attendancesError) {
      console.error('출퇴근 기록 조회 실패:', attendancesError);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ 
          success: false, 
          error: '출퇴근 기록 조회에 실패했습니다: ' + attendancesError.message 
        })
      };
    }

    console.log('조회된 기록 수:', attendances?.length || 0);

    // 5. 데이터 변환 (직원 정보와 통합)
    const formattedData = (attendances || []).map(record => {
      const employee = Array.isArray(record.employees) ? record.employees[0] : record.employees;

      // work_date 계산 (check_in_time에서 날짜 부분 추출)
      const workDate = record.check_in_time ? record.check_in_time.split('T')[0] : null;

      return {
        id: record.id,
        workDate: workDate,
        checkInTime: record.check_in_time,
        checkOutTime: record.check_out_time,
        workHours: record.work_hours,
        overtimeHours: record.overtime_hours,
        lateMinutes: record.late_minutes,
        earlyLeaveMinutes: record.early_leave_minutes,
        status: record.status,
        notes: record.notes,
        employee: {
          id: employee?.id,
          name: employee?.name,
          phone: employee?.phone,
          department: employee?.department,
          position: employee?.position
        }
      };
    });

    // 6. 통계 계산
    const stats = {
      totalRecords: formattedData.length,
      totalWorkHours: formattedData.reduce((sum, r) => sum + (r.workHours || 0), 0),
      totalOvertimeHours: formattedData.reduce((sum, r) => sum + (r.overtimeHours || 0), 0),
      totalLateCount: formattedData.filter(r => (r.lateMinutes || 0) > 0).length,
      totalEarlyLeaveCount: formattedData.filter(r => (r.earlyLeaveMinutes || 0) > 0).length,
      averageWorkHours: formattedData.length > 0 
        ? Math.round((formattedData.reduce((sum, r) => sum + (r.workHours || 0), 0) / formattedData.length) * 100) / 100
        : 0
    };

    console.log('통계:', stats);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: {
          attendances: formattedData,
          stats: stats,
          filters: {
            startDate,
            endDate,
            employeeId,
            department
          }
        }
      })
    };

  } catch (error) {
    console.error('=== 예상치 못한 오류 발생 ===');
    console.error('에러:', error);
    
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: '서버 오류가 발생했습니다: ' + error.message
      })
    };
  }
};