const { verifyToken, getCorsHeaders } = require('./lib/auth');
// netlify/functions/vacations-list.js
// 휴가 목록 조회 (캘린더용)
// ✅ 보안 패치: Bearer 토큰 인증 추가

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// [보안패치] getUserFromToken → verifyToken으로 대체됨

exports.handler = async (event) => {
  // CORS 헤더 (Authorization 포함)
  const headers = {
    'Access-Control-Allow-Origin': 'https://staffmanager.io',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
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

    const params = event.queryStringParameters || {};
    const {
      employee_id,
      start_date,
      end_date,
      vacation_type,
      year,
      month,
    } = params;

    // ✅ company_id는 토큰에서 추출
    const company_id = userInfo.companyId;

    // 쿼리 빌더
    let query = supabase
      .from('vacations')
      .select(`
        *,
        employee:employees(
          id,
          name,
          phone,
          position,
          hire_date
        )
      `)
      .eq('company_id', company_id)
      .order('start_date', { ascending: false });

    // 필터링
    if (employee_id) {
      query = query.eq('employee_id', employee_id);
    }

    if (vacation_type) {
      query = query.eq('vacation_type', vacation_type);
    }

    // 날짜 범위 필터
    if (start_date && end_date) {
      query = query.or(`start_date.gte.${start_date},end_date.lte.${end_date}`);
    } else if (year && month) {
      const monthStr = month.toString().padStart(2, '0');
      const monthStart = `${year}-${monthStr}-01`;
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      const monthEnd = `${year}-${monthStr}-${lastDay}`;
      query = query.gte('start_date', monthStart).lte('start_date', monthEnd);
    } else if (year) {
      query = query.gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`);
    }

    const { data: vacations, error: vacError } = await query;

    if (vacError) {
      console.error('Vacation query error:', vacError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to fetch vacations',
          details: vacError.message,
        }),
      };
    }

    // 캘린더용 데이터 가공
    const calendarData = {};
    vacations.forEach((v) => {
      const start = new Date(v.start_date);
      const end = new Date(v.end_date);

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateKey = d.toISOString().split('T')[0];
        if (!calendarData[dateKey]) {
          calendarData[dateKey] = [];
        }
        calendarData[dateKey].push({
          id: v.id,
          employee_id: v.employee_id,
          employee_name: v.employee?.name || '알 수 없음',
          vacation_type: v.vacation_type,
          reason: v.reason,
        });
      }
    });

    // 통계
    const stats = {
      total: vacations.length,
      byType: {},
      byMonth: {},
    };

    vacations.forEach((v) => {
      stats.byType[v.vacation_type] = (stats.byType[v.vacation_type] || 0) + 1;
      const m = v.start_date.substring(0, 7);
      stats.byMonth[m] = (stats.byMonth[m] || 0) + 1;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        vacations,
        calendar: calendarData,
        stats,
        count: vacations.length,
      }),
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
