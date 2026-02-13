// netlify/functions/annual-leave-calculate.js
// 연차 계산 및 조회

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  // Preflight 요청 처리
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    // GET: 연차 조회
    if (event.httpMethod === 'GET') {
      return await handleGet(event, headers);
    }

    // POST: 연차 재계산 (관리자용)
    if (event.httpMethod === 'POST') {
      return await handlePost(event, headers);
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
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

// GET: 연차 조회
async function handleGet(event, headers) {
  const params = event.queryStringParameters || {};
  const { employee_id, company_id, year } = params;

  const currentYear = new Date().getFullYear();
  const targetYear = year ? parseInt(year) : currentYear;

  // 특정 직원의 연차 조회
  if (employee_id) {
    const { data: annualLeave, error } = await supabase
      .from('annual_leaves')
      .select(`
        *,
        employee:employees(
          id,
          name,
          hire_date
        )
      `)
      .eq('employee_id', employee_id)
      .eq('year', targetYear)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116: 데이터 없음 (정상)
      console.error('Annual leave query error:', error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to fetch annual leave',
          details: error.message,
        }),
      };
    }

    // 연차 정보가 없으면 생성
    if (!annualLeave) {
      const { data: employee } = await supabase
        .from('employees')
        .select('hire_date')
        .eq('id', employee_id)
        .single();

      if (!employee) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Employee not found' }),
        };
      }

      // 연차 계산 함수 호출
      const { data: calculated } = await supabase.rpc('calculate_annual_leave_days', {
        p_hire_date: employee.hire_date,
        p_year: targetYear,
      });

      // 연차 생성
      const { data: newAnnualLeave } = await supabase
        .from('annual_leaves')
        .insert({
          employee_id,
          year: targetYear,
          total_days: calculated || 15,
          used_days: 0,
        })
        .select()
        .single();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          annual_leave: newAnnualLeave,
          created: true,
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        annual_leave: annualLeave,
      }),
    };
  }

  // 회사 전체 직원의 연차 조회
  if (company_id) {
    const { data: employees } = await supabase
      .from('employees')
      .select('id')
      .eq('company_id', company_id);

    if (!employees || employees.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          annual_leaves: [],
          count: 0,
        }),
      };
    }

    const employeeIds = employees.map((e) => e.id);

    const { data: annualLeaves, error } = await supabase
      .from('annual_leaves')
      .select(`
        *,
        employee:employees(
          id,
          name,
          hire_date,
          position
        )
      `)
      .in('employee_id', employeeIds)
      .eq('year', targetYear);

    if (error) {
      console.error('Annual leaves query error:', error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to fetch annual leaves',
          details: error.message,
        }),
      };
    }

    // 통계 계산
    const stats = {
      total_employees: employees.length,
      with_data: annualLeaves.length,
      total_days: 0,
      used_days: 0,
      remaining_days: 0,
    };

    annualLeaves.forEach((al) => {
      stats.total_days += al.total_days;
      stats.used_days += al.used_days;
      stats.remaining_days += al.remaining_days;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        annual_leaves: annualLeaves,
        stats,
        count: annualLeaves.length,
      }),
    };
  }

  return {
    statusCode: 400,
    headers,
    body: JSON.stringify({
      error: 'Missing required parameter: employee_id or company_id',
    }),
  };
}

// POST: 연차 재계산 (관리자용)
async function handlePost(event, headers) {
  const { employee_id, year } = JSON.parse(event.body);

  if (!employee_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing required field: employee_id',
      }),
    };
  }

  const currentYear = new Date().getFullYear();
  const targetYear = year || currentYear;

  // 직원 정보 조회
  const { data: employee, error: empError } = await supabase
    .from('employees')
    .select('hire_date')
    .eq('id', employee_id)
    .single();

  if (empError || !employee) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Employee not found' }),
    };
  }

  // 연차 계산
  const { data: calculatedDays, error: calcError } = await supabase.rpc(
    'calculate_annual_leave_days',
    {
      p_hire_date: employee.hire_date,
      p_year: targetYear,
    }
  );

  if (calcError) {
    console.error('Calculate error:', calcError);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to calculate annual leave',
        details: calcError.message,
      }),
    };
  }

  // 기존 연차 정보 조회
  const { data: existing } = await supabase
    .from('annual_leaves')
    .select('*')
    .eq('employee_id', employee_id)
    .eq('year', targetYear)
    .single();

  let annualLeave;

  if (existing) {
    // 업데이트
    const { data: updated, error: updateError } = await supabase
      .from('annual_leaves')
      .update({
        total_days: calculatedDays,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (updateError) {
      console.error('Update error:', updateError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to update annual leave',
          details: updateError.message,
        }),
      };
    }

    annualLeave = updated;
  } else {
    // 신규 생성
    const { data: created, error: createError } = await supabase
      .from('annual_leaves')
      .insert({
        employee_id,
        year: targetYear,
        total_days: calculatedDays,
        used_days: 0,
      })
      .select()
      .single();

    if (createError) {
      console.error('Create error:', createError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to create annual leave',
          details: createError.message,
        }),
      };
    }

    annualLeave = created;
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      annual_leave: annualLeave,
      calculated_days: calculatedDays,
      message: `${targetYear}년 연차가 재계산되었습니다.`,
    }),
  };
}