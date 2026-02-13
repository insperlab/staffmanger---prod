// netlify/functions/vacations-list.js
// 휴가 목록 조회 (캘린더용)

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  // Preflight 요청 처리
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // GET 요청만 허용
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const {
      company_id,
      employee_id,
      start_date,
      end_date,
      vacation_type,
      year,
      month,
    } = params;

    // company_id 필수
    if (!company_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required parameter: company_id',
        }),
      };
    }

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
      // 지정된 기간과 겹치는 휴가 조회
      query = query.or(`start_date.gte.${start_date},end_date.lte.${end_date}`);
    } else if (year && month) {
      // 특정 년월의 휴가 조회
      const monthStr = month.toString().padStart(2, '0');
      const firstDay = `${year}-${monthStr}-01`;
      const lastDay = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('start_date', firstDay).lte('end_date', lastDay);
    } else if (year) {
      // 특정 년도의 휴가 조회
      query = query.gte('start_date', `${year}-01-01`).lte('end_date', `${year}-12-31`);
    }

    const { data: vacations, error: vacError } = await query;

    if (vacError) {
      console.error('Vacations query error:', vacError);
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
    
    vacations.forEach((vacation) => {
      const start = new Date(vacation.start_date);
      const end = new Date(vacation.end_date);

      // 휴가 기간의 모든 날짜를 순회
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateKey = d.toISOString().split('T')[0];

        if (!calendarData[dateKey]) {
          calendarData[dateKey] = {
            date: dateKey,
            vacations: [],
            count: 0,
          };
        }

        calendarData[dateKey].vacations.push({
          id: vacation.id,
          employee_id: vacation.employee_id,
          employee_name: vacation.employee?.name || '',
          vacation_type: vacation.vacation_type,
          days: vacation.days,
          reason: vacation.reason,
        });

        calendarData[dateKey].count++;
      }
    });

    // 통계 계산
    const stats = {
      total: vacations.length,
      by_type: {},
      by_month: {},
    };

    vacations.forEach((vacation) => {
      // 타입별 통계
      if (!stats.by_type[vacation.vacation_type]) {
        stats.by_type[vacation.vacation_type] = 0;
      }
      stats.by_type[vacation.vacation_type]++;

      // 월별 통계
      const month = vacation.start_date.substring(0, 7); // YYYY-MM
      if (!stats.by_month[month]) {
        stats.by_month[month] = 0;
      }
      stats.by_month[month]++;
    });

    // 성공 응답
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
