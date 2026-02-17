// =====================================================
// 직원 상세 조회 API - v1
// GET /.netlify/functions/employee-detail?id=xxx
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const { verifyToken, getCorsHeaders } = require('./lib/auth');

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not configured');
  }
  return createClient(supabaseUrl, supabaseKey);
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'GET only' })
    };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let tokenData;
    try {
      tokenData = verifyToken(authHeader);
    } catch (error) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '인증 실패' }) };
    }

    if (!tokenData.companyId) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '회사 정보 없음' }) };
    }

    const employeeId = event.queryStringParameters?.id;
    if (!employeeId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '직원 ID 필요' }) };
    }

    const supabase = getSupabaseClient();

    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select(`
        id, employee_number, department, position, job_title,
        hire_date, resign_date, work_type, base_salary, salary_type,
        monthly_wage, annual_salary, work_start_time, work_end_time,
        break_time_minutes, weekly_holiday, work_location,
        contract_start_date, contract_end_date, probation_months,
        address, birth_date, bank_name, account_number,
        status, created_at, updated_at,
        users:user_id ( id, email, name, phone, role )
      `)
      .eq('id', employeeId)
      .eq('company_id', tokenData.companyId)
      .is('deleted_at', null)
      .single();

    if (empError || !employee) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '직원을 찾을 수 없습니다.' }) };
    }

    const { data: contracts } = await supabase
      .from('contracts')
      .select('id, contract_type, status, ucansign_document_id, signed_at, created_at')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(5);

    const user = Array.isArray(employee.users) ? employee.users[0] : employee.users;

    const result = {
      id: employee.id,
      employeeNumber: employee.employee_number,
      name: user?.name, email: user?.email, phone: user?.phone, role: user?.role,
      department: employee.department, position: employee.position, jobTitle: employee.job_title,
      hireDate: employee.hire_date, resignDate: employee.resign_date,
      workType: employee.work_type, baseSalary: employee.base_salary,
      salaryType: employee.salary_type, monthlyWage: employee.monthly_wage,
      annualSalary: employee.annual_salary,
      workStartTime: employee.work_start_time, workEndTime: employee.work_end_time,
      breakTimeMinutes: employee.break_time_minutes, weeklyHoliday: employee.weekly_holiday,
      workLocation: employee.work_location,
      contractStartDate: employee.contract_start_date, contractEndDate: employee.contract_end_date,
      probationMonths: employee.probation_months,
      address: employee.address, birthDate: employee.birth_date,
      bankName: employee.bank_name, accountNumber: employee.account_number,
      status: employee.status, createdAt: employee.created_at, updatedAt: employee.updated_at,
      contracts: (contracts || []).map(c => ({
        id: c.id, type: c.contract_type, status: c.status,
        documentId: c.ucansign_document_id, signedAt: c.signed_at, createdAt: c.created_at
      }))
    };

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: result }) };

  } catch (error) {
    console.error('Employee detail error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: error.message }) };
  }
};
