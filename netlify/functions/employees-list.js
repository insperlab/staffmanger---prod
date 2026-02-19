const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'GET만 허용됩니다' }) };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);
    if (!tokenData.companyId) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: '회사 정보가 없습니다.' }) };
    }

    const supabase = getSupabase();
    const params = event.queryStringParameters || {};

    let query = supabase
      .from('employees')
      .select(`
        id, employee_number, department, position, job_title,
        hire_date, resign_date, status, salary_type,
        base_salary, monthly_wage, annual_salary,
        work_start_time, work_end_time, break_time_minutes,
        weekly_holiday, work_location, address, birth_date,
        bank_name, account_number, business_id,
        contract_start_date, contract_end_date, probation_months,
        created_at, updated_at,
        users:user_id ( id, email, name, phone )
      `)
      .eq('company_id', tokenData.companyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    // 사업장 필터
    const bizId = params.businessId || params.business_id || null;
    if (bizId) {
     if (bizId === 'unassigned') {
       query = query.is('business_id', null);
      } else {
        query = query.eq('business_id', bizId);
      }
    }

    // 상태 필터
    if (params.status) {
      query = query.eq('status', params.status);
    }

    // 부서 필터
    if (params.department) {
      query = query.eq('department', params.department);
    }

    const { data, error } = await query;

    if (error) {
      console.error('employees-list error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '직원 목록 조회 실패: ' + error.message }) };
    }

    const employees = (data || []).map(emp => {
      const user = Array.isArray(emp.users) ? emp.users[0] : emp.users;
      return {
        id: emp.id,
        employeeNumber: emp.employee_number,
        name: user?.name || '-',
        email: user?.email || '-',
        phone: user?.phone || '-',
        department: emp.department,
        position: emp.position,
        jobTitle: emp.job_title,
        hireDate: emp.hire_date,
        resignDate: emp.resign_date,
        status: emp.status,
        salaryType: emp.salary_type,
        baseSalary: emp.base_salary,
        monthlyWage: emp.monthly_wage,
        annualSalary: emp.annual_salary,
        workStartTime: emp.work_start_time,
        workEndTime: emp.work_end_time,
        breakTimeMinutes: emp.break_time_minutes,
        weeklyHoliday: emp.weekly_holiday,
        workLocation: emp.work_location,
        address: emp.address,
        birthDate: emp.birth_date,
        bankName: emp.bank_name,
        accountNumber: emp.account_number,
        businessId: emp.business_id,
        contractStartDate: emp.contract_start_date,
        contractEndDate: emp.contract_end_date,
        probationMonths: emp.probation_months,
        createdAt: emp.created_at,
        updatedAt: emp.updated_at
      };
    });

    const departments = [...new Set(employees.map(e => e.department).filter(Boolean))].sort();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          employees,
          departments,
          total: employees.length
        }
      })
    };

  } catch (error) {
    console.error('employees-list error:', error);
    if (error.message?.includes('jwt') || error.message?.includes('token')) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: '인증 실패' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message }) };
  }
};
