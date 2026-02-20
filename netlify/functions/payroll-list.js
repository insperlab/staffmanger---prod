// netlify/functions/payroll-list.js
// Phase 7: 급여 목록 조회 API (급여대장 페이지용)
// GET ?year=2026&month=2&business_id=xxx (사업장 필터 지원)
//
// v9.1 수정:
//   1) order('employees(name)') 제거 → Supabase 버전 호환성 문제로 500 에러 발생
//   2) 파라미터명 통일: business_id (camelCase businessId도 폴백 지원)
//   3) 응답 구조 수정: { data: { payrolls: [] } } — payroll-register.html 파싱과 일치
//   4) businesses 조인 추가 → business_name 반환

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const headers = {
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };
  }

  try {
    // ── 인증 ──────────────────────────────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try { userInfo = verifyToken(authHeader); } catch {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: '인증 실패' }) };
    }

    const params = event.queryStringParameters || {};
    const year  = parseInt(params.year);
    const month = parseInt(params.month);

    // business_id / businessId 둘 다 지원 (프론트 파라미터명 혼용 대비)
    const businessId = params.business_id || params.businessId || null;

    if (!year || !month) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'year, month 필수' }) };
    }

    // ── 급여 + 직원 + 사업장 조인 쿼리 ─────────────────────
    // employees!inner → payrolls에 연결된 직원만 (orphan payroll 제외)
    // businesses → 사업장명 가져오기 (없으면 null 허용)
    let query = supabase
      .from('payrolls')
      .select(`
        *,
        employees!inner(
          id, name, bank_name, bank_account,
          business_id, department,
          businesses(id, name)
        )
      `)
      .eq('year', year)
      .eq('month', month);

    // ── 사업장 필터 ─────────────────────────────────────────
    if (businessId && businessId !== 'all') {
      if (businessId === 'unassigned') {
        // 사업장 미배정 직원만
        query = query.is('employees.business_id', null);
      } else {
        // 특정 사업장만
        query = query.eq('employees.business_id', businessId);
      }
    }

    // ── 이름순 정렬은 JS에서 처리 (Supabase 관계 테이블 order 불안정) ──
    const { data: payrolls, error } = await query;

    if (error) {
      console.error('급여 목록 조회 오류:', JSON.stringify(error));
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '조회 실패: ' + error.message }) };
    }

    // ── 결과 정제 + 이름순 정렬 ─────────────────────────────
    const results = (payrolls || [])
      .map(p => ({
        ...p,
        employee_name: p.employees?.name || '',
        bank_name:     p.employees?.bank_name || '',
        bank_account:  p.employees?.bank_account || '',
        business_id:   p.employees?.business_id || null,
        business_name: p.employees?.businesses?.name || '미배정',
        department:    p.employees?.department || '',
        employees: undefined, // 중첩 객체 제거
      }))
      .sort((a, b) => a.employee_name.localeCompare(b.employee_name, 'ko')); // 한글 이름순

    return {
      statusCode: 200,
      headers,
      // payroll-register.html은 data.data.payrolls 구조를 기대함
      body: JSON.stringify({
        success: true,
        data: { payrolls: results },
        count: results.length
      }),
    };

  } catch (err) {
    console.error('급여 목록 서버 오류:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: '서버 오류: ' + err.message }) };
  }
};
