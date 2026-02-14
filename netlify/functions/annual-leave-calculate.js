const { verifyToken, getCorsHeaders } = require('./lib/auth');
// netlify/functions/annual-leave-calculate.js
// 연차 계산 및 조회
// ✅ 보안 패치: Bearer 토큰 인증 추가

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// [보안패치] getUserFromToken → verifyToken으로 대체됨

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://staffmanager.io',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    // ✅ 인증 확인
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try {
      userInfo = verifyToken(authHeader);
    } catch (error) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: '인증에 실패했습니다. 다시 로그인해주세요.' }),
      };
    }

    if (event.httpMethod === 'GET') {
      return await handleGet(event, headers, userInfo);
    }

    if (event.httpMethod === 'POST') {
      return await handlePost(event, headers, userInfo);
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
async function handleGet(event, headers, userInfo) {
  const params = event.queryStringParameters || {};
  const { employee_id, year } = params;

  // ✅ company_id는 토큰에서 추출
  const company_id = userInfo.companyId;

  const currentYear = new Date().getFullYear();
  const targetYear = year ? parseInt(year) : currentYear;

  // 특정 직원 조회
  if (employee_id) {
    const { data: annualLeave, error } = await supabase
      .from('annual_leaves')
      .select(`
        *,
        employee:employees(
          id,
          name,
          phone,
          hire_date,
          position
        )
      `)
      .eq('employee_id', employee_id)
      .eq('year', targetYear)
      .single();

    if (error || !annualLeave) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: `${targetYear}년도 연차 정보가 없습니다.`,
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

  // 회사 전체 직원 연차 조회
  const { data: annualLeaves, error } = await supabase
    .from('annual_leaves')
    .select(`
      *,
      employee:employees(
        id,
        name,
        phone,
        hire_date,
        position
      )
    `)
    .eq('year', targetYear)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Annual leave query error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to fetch annual leaves',
        details: error.message,
      }),
    };
  }

  // 회사 소속 직원만 필터링
  const { data: companyEmployees } = await supabase
    .from('employees')
    .select('id')
    .eq('company_id', company_id);

  const companyEmployeeIds = new Set((companyEmployees || []).map(e => e.id));
  const filteredLeaves = (annualLeaves || []).filter(al => companyEmployeeIds.has(al.employee_id));

  // 통계
  const stats = {
    totalEmployees: filteredLeaves.length,
    totalDays: filteredLeaves.reduce((sum, al) => sum + (al.total_days || 0), 0),
    usedDays: filteredLeaves.reduce((sum, al) => sum + (al.used_days || 0), 0),
    remainingDays: filteredLeaves.reduce((sum, al) => sum + (al.remaining_days || 0), 0),
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      annual_leaves: filteredLeaves,
      stats,
      year: targetYear,
    }),
  };
}

// POST: 연차 재계산 (관리자용)
async function handlePost(event, headers, userInfo) {
  const { employee_id, year } = JSON.parse(event.body || '{}');

  if (!employee_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'employee_id is required' }),
    };
  }

  const currentYear = new Date().getFullYear();
  const targetYear = year || currentYear;

  // 직원 입사일 조회
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

  // 연차 계산 (근로기준법)
  const hireDate = new Date(employee.hire_date);
  const yearStart = new Date(targetYear, 0, 1);
  const diffMs = yearStart.getTime() - hireDate.getTime();
  const diffYears = diffMs / (1000 * 60 * 60 * 24 * 365.25);

  let calculatedDays;
  if (diffYears < 1) {
    // 1년 미만: 월 1일씩 (최대 11일)
    const monthsWorked = Math.floor(diffYears * 12);
    calculatedDays = Math.min(monthsWorked, 11);
  } else {
    // 1년 이상: 15일 기본 + 2년마다 1일 추가 (최대 25일)
    const additionalDays = Math.floor((diffYears - 1) / 2);
    calculatedDays = Math.min(15 + additionalDays, 25);
  }

  // 기존 연차 레코드 확인
  const { data: existing } = await supabase
    .from('annual_leaves')
    .select('id, used_days')
    .eq('employee_id', employee_id)
    .eq('year', targetYear)
    .single();

  let annualLeave;

  if (existing) {
    // 기존 레코드 업데이트
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
