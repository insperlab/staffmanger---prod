// =====================================================
// 직원 정보 수정 API
// PUT /.netlify/functions/employees-update
// Body: { employeeId, ...fields }
// =====================================================

const { verifyToken, handleCors, errorResponse } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

exports.handler = async (event) => {
  const cors = handleCors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors.headers, body: '' };

  if (event.httpMethod !== 'PUT') {
    return errorResponse('PUT 메서드만 허용됩니다', 405, cors.headers);
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);
    const companyId = tokenData.companyId;
    const supabase = getSupabaseClient();

    const body = JSON.parse(event.body);
    const { employeeId } = body;

    if (!employeeId) {
      return errorResponse('employeeId가 필요합니다', 400, cors.headers);
    }

    // 직원 존재 확인
    const { data: emp, error: fetchErr } = await supabase
      .from('employees')
      .select('id, user_id')
      .eq('id', employeeId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !emp) {
      return errorResponse('직원을 찾을 수 없습니다', 404, cors.headers);
    }

    // users 테이블 업데이트 (이름, 전화번호, 이메일)
    const userUpdate = {};
    if (body.name !== undefined) userUpdate.name = body.name.trim();
    if (body.phone !== undefined) userUpdate.phone = body.phone.trim();
    if (body.email !== undefined) userUpdate.email = body.email.trim();

    if (Object.keys(userUpdate).length > 0) {
      const { error: userErr } = await supabase
        .from('users')
        .update(userUpdate)
        .eq('id', emp.user_id);

      if (userErr) {
        if (userErr.code === '23505') {
          return errorResponse('이미 등록된 이메일 또는 전화번호입니다', 400, cors.headers);
        }
        return errorResponse('사용자 정보 수정 실패: ' + userErr.message, 500, cors.headers);
      }
    }

    // employees 테이블 업데이트
    const empUpdate = {};
    if (body.employeeNumber !== undefined) empUpdate.employee_number = body.employeeNumber;
    if (body.department !== undefined) empUpdate.department = body.department;
    if (body.position !== undefined) empUpdate.position = body.position;
    if (body.hireDate !== undefined) empUpdate.hire_date = body.hireDate;
    if (body.resignDate !== undefined) empUpdate.resign_date = body.resignDate;
    if (body.status !== undefined) empUpdate.status = body.status;
    if (body.salaryType !== undefined) empUpdate.salary_type = body.salaryType;
    if (body.baseSalary !== undefined) empUpdate.base_salary = body.baseSalary;
    if (body.monthlyWage !== undefined) empUpdate.monthly_wage = body.monthlyWage;
    if (body.annualSalary !== undefined) empUpdate.annual_salary = body.annualSalary;
    if (body.workStartTime !== undefined) empUpdate.work_start_time = body.workStartTime;
    if (body.workEndTime !== undefined) empUpdate.work_end_time = body.workEndTime;
    if (body.breakTimeMinutes !== undefined) empUpdate.break_time_minutes = body.breakTimeMinutes;
    if (body.weeklyHoliday !== undefined) empUpdate.weekly_holiday = body.weeklyHoliday;
    if (body.workLocation !== undefined) empUpdate.work_location = body.workLocation;
    if (body.contractStartDate !== undefined) empUpdate.contract_start_date = body.contractStartDate;
    if (body.contractEndDate !== undefined) empUpdate.contract_end_date = body.contractEndDate;
    if (body.probationMonths !== undefined) empUpdate.probation_months = body.probationMonths;
    if (body.address !== undefined) empUpdate.address = body.address;
    if (body.birthDate !== undefined) empUpdate.birth_date = body.birthDate;
    if (body.bankName !== undefined) empUpdate.bank_name = body.bankName;
    if (body.accountNumber !== undefined) empUpdate.account_number = body.accountNumber;

    if (Object.keys(empUpdate).length > 0) {
      const { error: empErr } = await supabase
        .from('employees')
        .update(empUpdate)
        .eq('id', employeeId)
        .eq('company_id', companyId);

      if (empErr) {
        return errorResponse('직원 정보 수정 실패: ' + empErr.message, 500, cors.headers);
      }
    }

    if (Object.keys(userUpdate).length === 0 && Object.keys(empUpdate).length === 0) {
      return errorResponse('수정할 항목이 없습니다', 400, cors.headers);
    }

    return {
      statusCode: 200,
      headers: cors.headers,
      body: JSON.stringify({
        success: true,
        data: { message: '직원 정보가 수정되었습니다.' }
      })
    };

  } catch (error) {
    console.error('Update employee error:', error);
    return errorResponse(error.message || '서버 오류', 500, cors.headers);
  }
};
