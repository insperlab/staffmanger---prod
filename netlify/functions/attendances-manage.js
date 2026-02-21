// netlify/functions/attendances-manage.js
// 수동 출퇴근 등록 / 수정 / 삭제 API
// POST   → 신규 등록
// PUT    → 기존 기록 수정 (body에 id 필수)
// DELETE → 기록 삭제   (쿼리스트링 ?id= 필수)

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('./lib/auth');

// ✅ 프로젝트 표준 패턴 — CORS 헤더 직접 선언
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

function resp(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // 인증 확인
  const auth = verifyToken(event);
  if (!auth.valid) return resp(401, { success: false, error: '인증이 필요합니다' });

  const { companyId, role } = auth.payload;

  // owner / manager 만 허용
  if (!['owner', 'manager'].includes(role)) {
    return resp(403, { success: false, error: '권한이 없습니다' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const method = event.httpMethod;

  try {
    // ── POST: 신규 등록 ──────────────────────────────────
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { employeeId, workDate, checkInTime, checkOutTime, notes } = body;

      if (!employeeId)  return resp(400, { success: false, error: '직원을 선택해주세요' });
      if (!workDate)    return resp(400, { success: false, error: '근무일을 입력해주세요' });
      if (!checkInTime) return resp(400, { success: false, error: '출근 시간을 입력해주세요' });

      // 직원이 같은 회사 소속인지 확인
      const { data: emp, error: empErr } = await supabase
        .from('employees')
        .select('id')
        .eq('id', employeeId)
        .eq('company_id', companyId)
        .single();

      if (empErr || !emp) return resp(404, { success: false, error: '등록되지 않은 직원입니다' });

      // 같은 날 출근 기록 중복 체크
      const { data: existing } = await supabase
        .from('attendances')
        .select('id')
        .eq('employee_id', employeeId)
        .eq('company_id', companyId)
        .gte('check_in_time', workDate + 'T00:00:00')
        .lte('check_in_time', workDate + 'T23:59:59')
        .maybeSingle();

      if (existing) return resp(409, { success: false, error: '해당 날짜에 이미 출퇴근 기록이 존재합니다' });

      // 출퇴근 시간 조합
      const checkIn  = `${workDate}T${checkInTime}:00`;
      const checkOut = checkOutTime ? `${workDate}T${checkOutTime}:00` : null;

      // 근무 시간 계산 (시간 단위)
      let workHours = null;
      if (checkOut) {
        const diffMs = new Date(checkOut) - new Date(checkIn);
        workHours = Math.max(0, parseFloat((diffMs / 1000 / 3600).toFixed(2)));
      }

      const { data: record, error: insertErr } = await supabase
        .from('attendances')
        .insert({
          employee_id:    employeeId,
          company_id:     companyId,
          check_in_time:  checkIn,
          check_out_time: checkOut,
          work_hours:     workHours,
          status:         checkOut ? 'completed' : 'in_progress',
          check_method:   'manual',
          notes:          notes || '수동 등록',
        })
        .select()
        .single();

      if (insertErr) {
        console.error('수동 등록 오류:', insertErr);
        return resp(500, { success: false, error: '등록 실패: ' + insertErr.message });
      }

      return resp(201, { success: true, data: record });
    }

    // ── PUT: 기존 기록 수정 ──────────────────────────────
    if (method === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { id, workDate, checkInTime, checkOutTime, notes } = body;

      if (!id)          return resp(400, { success: false, error: '수정할 기록 ID가 필요합니다' });
      if (!workDate)    return resp(400, { success: false, error: '근무일을 입력해주세요' });
      if (!checkInTime) return resp(400, { success: false, error: '출근 시간을 입력해주세요' });

      // 해당 기록이 같은 회사 소속인지 확인
      const { data: target } = await supabase
        .from('attendances')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle();

      if (!target) return resp(404, { success: false, error: '수정할 기록을 찾을 수 없습니다' });

      const checkIn  = `${workDate}T${checkInTime}:00`;
      const checkOut = checkOutTime ? `${workDate}T${checkOutTime}:00` : null;

      let workHours = null;
      if (checkOut) {
        const diffMs = new Date(checkOut) - new Date(checkIn);
        workHours = Math.max(0, parseFloat((diffMs / 1000 / 3600).toFixed(2)));
      }

      const { data: updated, error: updateErr } = await supabase
        .from('attendances')
        .update({
          check_in_time:  checkIn,
          check_out_time: checkOut,
          work_hours:     workHours,
          status:         checkOut ? 'completed' : 'in_progress',
          check_method:   'manual',
          notes:          notes || null,
        })
        .eq('id', id)
        .eq('company_id', companyId)
        .select()
        .single();

      if (updateErr) {
        console.error('수정 오류:', updateErr);
        return resp(500, { success: false, error: '수정 실패: ' + updateErr.message });
      }

      return resp(200, { success: true, data: updated });
    }

    // ── DELETE: 기록 삭제 ────────────────────────────────
    if (method === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return resp(400, { success: false, error: '삭제할 기록 ID가 필요합니다' });

      const { data: target } = await supabase
        .from('attendances')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle();

      if (!target) return resp(404, { success: false, error: '삭제할 기록을 찾을 수 없습니다' });

      const { error: deleteErr } = await supabase
        .from('attendances')
        .delete()
        .eq('id', id)
        .eq('company_id', companyId);

      if (deleteErr) {
        console.error('삭제 오류:', deleteErr);
        return resp(500, { success: false, error: '삭제 실패: ' + deleteErr.message });
      }

      return resp(200, { success: true, message: '삭제되었습니다' });
    }

    return resp(405, { success: false, error: '허용되지 않는 메서드' });

  } catch (err) {
    console.error('attendances-manage 오류:', err);
    return resp(500, { success: false, error: '서버 오류: ' + err.message });
  }
};
