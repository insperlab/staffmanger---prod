const { verifyToken, getCorsHeaders } = require('./lib/auth');
// =====================================================
// 직원 목록 조회 API
// GET /.netlify/functions/employees-list
// =====================================================

const { createClient } = require('@supabase/supabase-js');

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
      'Access-Control-Allow-Origin': 'https://staffmanager.io',
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
      'Access-Control-Allow-Origin': 'https://staffmanager.io',
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
        'Access-Control-Allow-Origin': 'https://staffmanager.io',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
      },
      body: ''
    };
  }

  // GET 요청만 허용
  if (event.httpMethod !== 'GET') {
    return errorResponse('GET 메서드만 허용됩니다', 405);
  }

  try {
    // 1. 인증 확인
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse('로그인이 필요합니다.', 401);
    }

    // 2. 토큰에서 사용자 정보 추출
    const token = authHeader.substring(7);
    let tokenData;
    try {
      tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
    } catch {
      return errorResponse('유효하지 않은 토큰입니다.', 401);
    }

    if (!tokenData.companyId) {
      return errorResponse('회사 정보가 없습니다.', 401);
    }

    // 3. Supabase 클라이언트 생성
    const supabase = getSupabaseClient();

    // 4. 쿼리 파라미터 추출
    const status = event.queryStringParameters?.status;
    const department = event.queryStringParameters?.department;
    const search = event.queryStringParameters?.search;

    // 5. 직원 목록 조회
    let query = supabase
      .from('employees')
      .select(`
        id,
        employee_number,
        department,
        position,
        job_title,
        hire_date,
        resign_date,
        work_type,
        base_salary,
        salary_type,
        monthly_wage,
        annual_salary,
        work_start_time,
        work_end_time,
        break_time_minutes,
        weekly_holiday,
        work_location,
        contract_start_date,
        contract_end_date,
        probation_months,
        address,
        birth_date,
        bank_name,
        account_number,
        status,
        created_at,
        users:user_id (
          id,
          email,
          name,
          phone,
          role
        )
      `)
      .eq('company_id', tokenData.companyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    // 상태 필터링
    if (status) {
      query = query.eq('status', status);
    }

    // 부서 필터링
    if (department) {
      query = query.eq('department', department);
    }

    // 쿼리 실행
    const { data: employees, error: employeesError } = await query;

    if (employeesError) {
      console.error('Employees list error:', employeesError);
      return errorResponse('직원 목록 조회 중 오류가 발생했습니다.', 500);
    }

    // 6. 검색어가 있으면 클라이언트 측에서 필터링
    let filteredEmployees = employees || [];
    if (search) {
      const searchLower = search.toLowerCase();
      filteredEmployees = employees.filter(emp => {
        const user = Array.isArray(emp.users) ? emp.users[0] : emp.users;
        if (!user) return false;
        
        const nameMatch = user.name?.toLowerCase().includes(searchLower);
        const emailMatch = user.email?.toLowerCase().includes(searchLower);
        const empNumberMatch = emp.employee_number?.toLowerCase().includes(searchLower);
        
        return nameMatch || emailMatch || empNumberMatch;
      });
    }

    // 7. 응답 데이터 정리
    const result = filteredEmployees.map(emp => {
      const user = Array.isArray(emp.users) ? emp.users[0] : emp.users;
      return {
        id: emp.id,
        employeeNumber: emp.employee_number,
        name: user?.name,
        email: user?.email,
        phone: user?.phone,
        department: emp.department,
        position: emp.position,
        jobTitle: emp.job_title,
        hireDate: emp.hire_date,
        resignDate: emp.resign_date,
        workType: emp.work_type,
        baseSalary: emp.base_salary,
        salaryType: emp.salary_type,
        monthlyWage: emp.monthly_wage,
        annualSalary: emp.annual_salary,
        workStartTime: emp.work_start_time,
        workEndTime: emp.work_end_time,
        breakTimeMinutes: emp.break_time_minutes,
        weeklyHoliday: emp.weekly_holiday,
        workLocation: emp.work_location,
        contractStartDate: emp.contract_start_date,
        contractEndDate: emp.contract_end_date,
        probationMonths: emp.probation_months,
        address: emp.address,
        birthDate: emp.birth_date,
        bankName: emp.bank_name,
        accountNumber: emp.account_number,
        status: emp.status,
        createdAt: emp.created_at
      };
    });

    // 8. 통계 정보 추가
    const stats = {
      total: result.length,
      active: result.filter(e => e.status === 'active').length,
      onLeave: result.filter(e => e.status === 'on_leave').length,
      resigned: result.filter(e => e.status === 'resigned').length
    };

    // 9. 성공 응답
    return successResponse({
      employees: result,
      stats,
      message: `${result.length}명의 직원을 조회했습니다.`
    }, 200);

  } catch (error) {
    console.error('List employees error:', error);
    return errorResponse('서버 오류가 발생했습니다: ' + error.message, 500);
  }
};