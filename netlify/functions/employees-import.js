// =====================================================
// 직원 일괄 등록 API
// POST /.netlify/functions/employees-import
// Body: { employees: [{ name, phone, ... }, ...] }
// =====================================================

const { verifyToken, handleCors, errorResponse } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

exports.handler = async (event) => {
  const cors = handleCors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors.headers, body: '' };

  if (event.httpMethod !== 'POST') {
    return errorResponse('POST 메서드만 허용됩니다', 405, cors.headers);
  }

  try {
    // 인증
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);
    const companyId = tokenData.companyId;
    const supabase = getSupabaseClient();

    const body = JSON.parse(event.body);
    const { employees } = body;

    if (!Array.isArray(employees) || employees.length === 0) {
      return errorResponse('등록할 직원 데이터가 없습니다', 400, cors.headers);
    }

    if (employees.length > 100) {
      return errorResponse('한 번에 최대 100명까지 등록 가능합니다', 400, cors.headers);
    }

    // 기존 전화번호 목록 (중복 체크)
    const { data: existingUsers } = await supabase
      .from('users')
      .select('phone, email')
      .eq('company_id', companyId);

    const existingPhones = new Set((existingUsers || []).map(u => u.phone?.replace(/[^0-9]/g, '')));
    const existingEmails = new Set((existingUsers || []).map(u => u.email?.toLowerCase()));

    const results = { success: [], failed: [] };

    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      const row = i + 1;

      try {
        // 필수값 체크
        if (!emp.name || emp.name.trim().length < 2) {
          results.failed.push({ row, name: emp.name, error: '이름 2자 이상 필요' });
          continue;
        }
        if (!emp.phone) {
          results.failed.push({ row, name: emp.name, error: '전화번호 필수' });
          continue;
        }

        // 중복 체크
        const cleanPhone = emp.phone.replace(/[^0-9]/g, '');
        if (existingPhones.has(cleanPhone)) {
          results.failed.push({ row, name: emp.name, error: '이미 등록된 전화번호' });
          continue;
        }

        // 이메일 결정
        const email = emp.email && emp.email.trim()
          ? emp.email.trim().toLowerCase()
          : `${cleanPhone}@temp.staffmanager.io`;

        if (existingEmails.has(email) && email !== `${cleanPhone}@temp.staffmanager.io`) {
          results.failed.push({ row, name: emp.name, error: '이미 등록된 이메일' });
          continue;
        }

        // users 생성
        const { data: newUser, error: userErr } = await supabase
          .from('users')
          .insert({
            email: email,
            name: emp.name.trim(),
            phone: emp.phone.trim(),
            password_hash: crypto.randomBytes(8).toString('hex'),
            role: 'employee',
            company_id: companyId,
            status: 'active'
          })
          .select('id')
          .single();

        if (userErr) {
          results.failed.push({ row, name: emp.name, error: 'DB 오류: ' + userErr.message });
          continue;
        }

        // 급여 타입 매핑
        const salaryType = emp.salaryType || emp.급여유형 || 'hourly';
        const baseSalary = parseInt(emp.baseSalary || emp.급여액 || 0);
        let monthlyWage = null, annualSalary = null;
        if (salaryType === 'monthly' || salaryType === '월급') monthlyWage = baseSalary;
        if (salaryType === 'annual' || salaryType === '연봉') annualSalary = baseSalary;

        // employees 생성
        const { error: empErr } = await supabase
          .from('employees')
          .insert({
            user_id: newUser.id,
            company_id: companyId,
            department: emp.department || emp.부서 || null,
            position: emp.position || emp.직위 || null,
            hire_date: emp.hireDate || emp.입사일 || new Date().toISOString().split('T')[0],
            status: 'active',
            salary_type: salaryType === '시급' ? 'hourly' : salaryType === '월급' ? 'monthly' : salaryType === '연봉' ? 'annual' : salaryType,
            base_salary: baseSalary,
            monthly_wage: monthlyWage,
            annual_salary: annualSalary,
            work_start_time: emp.workStartTime || emp.근무시작 || '09:00',
            work_end_time: emp.workEndTime || emp.근무종료 || '18:00',
            break_time_minutes: parseInt(emp.breakTimeMinutes) || 60,
            weekly_holiday: emp.weeklyHoliday || '일요일',
            address: emp.address || emp.주소 || null,
            birth_date: emp.birthDate || emp.생년월일 || null,
            bank_name: emp.bankName || emp.은행 || null,
            account_number: emp.accountNumber || emp.계좌번호 || null,
          });

        if (empErr) {
          // 롤백 user
          await supabase.from('users').delete().eq('id', newUser.id);
          results.failed.push({ row, name: emp.name, error: '직원정보 저장실패: ' + empErr.message });
          continue;
        }

        // 중복 방지용 set에 추가
        existingPhones.add(cleanPhone);
        existingEmails.add(email);
        results.success.push({ row, name: emp.name });

      } catch (err) {
        results.failed.push({ row, name: emp.name || '알수없음', error: err.message });
      }
    }

    return {
      statusCode: 200,
      headers: cors.headers,
      body: JSON.stringify({
        success: true,
        data: {
          total: employees.length,
          successCount: results.success.length,
          failedCount: results.failed.length,
          success: results.success,
          failed: results.failed,
          message: `${results.success.length}명 등록 완료, ${results.failed.length}명 실패`
        }
      })
    };

  } catch (error) {
    console.error('Import employees error:', error);
    return errorResponse(error.message || '서버 오류', 500, cors.headers);
  }
};
