// =====================================================
// 직원 등록 API
// POST /.netlify/functions/employees-create
// =====================================================

const { verifyToken, handleCors, successResponse, errorResponse } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

exports.handler = async (event) => {
  // CORS
  const cors = handleCors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors.headers, body: '' };

  if (event.httpMethod !== 'POST') {
    return errorResponse('POST 메서드만 허용됩니다', 405, cors.headers);
  }

  try {
    // 1. 인증
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);
    const companyId = tokenData.companyId;

    // 2. 요청 데이터 파싱
    const body = JSON.parse(event.body);
    const {
      // 기본 정보 (필수)
      name,
      phone,
      hireDate,
      salaryType,
      baseSalary,
      // 기본 정보 (선택)
      email,
      employeeNumber,
      department,
      position,
      status = 'active',
      // 근무 조건
      workStartTime = '09:00',
      workEndTime = '18:00',
      breakTimeMinutes = 60,
      weeklyHoliday = '일요일',
      workLocation,
      workDays,
      // 급여 (타입별)
      monthlyWage,
      annualSalary,
      // 계약 정보
      contractStartDate,
      contractEndDate,
      probationMonths = 0,
      // 개인 정보
      address,
      birthDate,
      // 급여 계좌
      bankName,
      accountNumber,
    } = body;

    // 3. 필수값 검증
    if (!name || name.trim().length < 2) {
      return errorResponse('이름은 2자 이상 입력해주세요', 400, cors.headers);
    }
    if (!phone) {
      return errorResponse('전화번호를 입력해주세요', 400, cors.headers);
    }
    if (!hireDate) {
      return errorResponse('입사일을 입력해주세요', 400, cors.headers);
    }
    if (!salaryType) {
      return errorResponse('급여 유형을 선택해주세요', 400, cors.headers);
    }

    const supabase = getSupabaseClient();

    // 4. 이메일 중복 체크 (이메일이 있는 경우)
    const employeeEmail = email && email.trim() ? email.trim() : `${phone.replace(/[^0-9]/g, '')}@temp.staffmanager.io`;
    
    if (email && email.trim()) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', email.trim())
        .single();

      if (existingUser) {
        return errorResponse('이미 등록된 이메일입니다', 400, cors.headers);
      }
    }

    // 5. users 테이블에 직원 계정 생성
    const tempPassword = crypto.randomBytes(8).toString('hex');

    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        email: employeeEmail,
        name: name.trim(),
        phone: phone.trim(),
        password_hash: tempPassword,
        role: 'employee',
        company_id: companyId,
        status: 'active'
      })
      .select()
      .single();

    if (userError) {
      console.error('User creation error:', userError);
      if (userError.message?.includes('duplicate') || userError.code === '23505') {
        return errorResponse('이미 등록된 직원입니다 (이메일 또는 전화번호 중복)', 400, cors.headers);
      }
      return errorResponse('직원 계정 생성 실패: ' + userError.message, 500, cors.headers);
    }

    // 6. 급여 필드 매핑
    let hourlyWage = null;
    let monthlyWageVal = null;
    let annualSalaryVal = null;

    switch (salaryType) {
      case 'hourly':
        hourlyWage = baseSalary;
        break;
      case 'daily':
        hourlyWage = baseSalary; // daily를 hourly_wage에 저장 (기존 호환)
        break;
      case 'monthly':
        monthlyWageVal = monthlyWage || baseSalary;
        break;
      case 'annual':
        annualSalaryVal = annualSalary || baseSalary;
        break;
      default:
        hourlyWage = baseSalary;
    }

    // 7. employees 테이블에 직원 정보 생성
    const employeeData = {
      user_id: newUser.id,
      company_id: companyId,
      employee_number: employeeNumber || null,
      department: department || null,
      position: position || null,
      hire_date: hireDate,
      status: status,
      salary_type: salaryType,
      base_salary: baseSalary,
      hourly_wage: hourlyWage,
      monthly_wage: monthlyWageVal,
      annual_salary: annualSalaryVal,
      work_start_time: workStartTime,
      work_end_time: workEndTime,
      break_time_minutes: breakTimeMinutes,
      weekly_holiday: weeklyHoliday,
      work_location: workLocation || null,
      contract_start_date: contractStartDate || hireDate,
      contract_end_date: contractEndDate || null,
      probation_months: probationMonths,
      address: address || null,
      birth_date: birthDate || null,
      bank_name: bankName || null,
      account_number: accountNumber || null,
    };

    const { data: newEmployee, error: employeeError } = await supabase
      .from('employees')
      .insert(employeeData)
      .select()
      .single();

    if (employeeError) {
      console.error('Employee creation error:', employeeError);
      // 롤백: users 테이블에서 방금 생성한 유저 삭제
      await supabase.from('users').delete().eq('id', newUser.id);
      return errorResponse('직원 정보 저장 실패: ' + employeeError.message, 500, cors.headers);
    }

    // 8. 성공 응답
    return {
      statusCode: 201,
      headers: cors.headers,
      body: JSON.stringify({
        success: true,
        data: {
          employee: {
            id: newEmployee.id,
            userId: newUser.id,
            name: name.trim(),
            email: employeeEmail,
            phone: phone.trim(),
            employeeNumber: employeeNumber || null,
            department: department || null,
            position: position || null,
            hireDate: hireDate,
            salaryType: salaryType,
            baseSalary: baseSalary,
            status: status
          },
          message: '직원이 등록되었습니다.'
        }
      })
    };

  } catch (error) {
    console.error('Create employee error:', error);
    return errorResponse(error.message || '서버 오류가 발생했습니다', 500, cors.headers);
  }
};
