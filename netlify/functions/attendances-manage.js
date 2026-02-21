// netlify/functions/attendances-manage.js
// 수동 출퇴근 등록 / 수정 / 삭제 API
//
// POST   → 신규 등록
// PUT    → 기존 기록 수정 (id 필수)
// DELETE → 기록 삭제   (id 필수)

const { createClient } = require('@supabase/supabase-js');
const { verifyToken, corsHeaders, errorResponse } = require('./lib/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  // CORS preflight
  const cors = corsHeaders(event);
  if (cors.statusCode) return cors;

  // 인증 확인
  const auth = verifyToken(event);
  if (!auth.valid) return errorResponse('인증이 필요합니다', 401, cors.headers);

  const { companyId, role } = auth.payload;

  // owner / manager 만 허용
  if (!['owner', 'manager'].includes(role)) {
    return errorResponse('권한이 없습니다', 403, cors.headers);
  }

  const method = event.httpMethod;

  try {
    // ── POST: 신규 등록 ─────────────────────────────────────
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { employeeId, workDate, checkInTime, checkOutTime, notes } = body;

      if (!employeeId) return errorResponse('직원을 선택해주세요', 400, cors.headers);
      if (!workDate)   return errorResponse('근무일을 입력해주세요', 400, cors.headers);
      if (!checkInTime) return errorResponse('출근 시간을 입력해주세요', 400, cors.headers);

      // 직원이 같은 회사 소속인지 확인
      const { data: emp, error: empErr } = await supabase
        .from('employees')
        .select('id, business_id')
        .eq('id', employeeId)
        .eq('company_id', companyId)
        .single();

      if (empErr || !emp) return errorResponse('등록되지 않은 직원입니다', 404, cors.headers);

      // 같은 날 출근 기록 중복 체크
      const { data: existing } = await supabase
        .from('attendances')
        .select('id')
        .eq('employee_id', employeeId)
        .eq('company_id', companyId)
        .gte('check_in_time', workDate + 'T00:00:00')
        .lte('check_in_time', workDate + 'T23:59:59')
        .maybeSingle();

      if (existing) return errorResponse('해당 날짜에 이미 출퇴근 기록이 존재합니다', 409, cors.headers);

      // 출퇴근 시간 조합 (날짜 + 시간 → ISO)
      const checkIn  = `${workDate}T${checkInTime}:00`;
      const checkOut = checkOutTime ? `${workDate}T${checkOutTime}:00` : null;

      // 근무 시간 계산 (분 → 소수 시간)
      let workHours = null;
      if (checkOut) {
        const diffMs = new Date(checkOut) - new Date(checkIn);
        workHours = Math.max(0, Math.round(diffMs / 1000 / 60) / 60);
      }

      // 출퇴근 상태 결정
      const status = checkOut ? 'completed' : 'in_progress';

      const { data: record, error: insertErr } = await supabase
        .from('attendances')
        .insert({
          employee_id:   employeeId,
          company_id:    companyId,
          check_in_time: checkIn,
          check_out_time: checkOut,
          work_hours:    workHours,
          status,
          check_method:  'manual', // 수동 등록 표시
          notes:         notes || '수동 등록',
        })
        .select()
        .single();

      if (insertErr) {
        console.error('수동 등록 오류:', insertErr);
        return errorResponse('등록에 실패했습니다: ' + insertErr.message, 500, cors.headers);
      }

      return {
        statusCode: 201,
        headers: cors.headers,
        body: JSON.stringify({ success: true, data: record }),
      };
    }

    // ── PUT: 기존 기록 수정 ──────────────────────────────────
    if (method === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { id, workDate, checkInTime, checkOutTime, notes } = body;

      if (!id) return errorResponse('수정할 기록 ID가 필요합니다', 400, cors.headers);
      if (!workDate)   return errorResponse('근무일을 입력해주세요', 400, cors.headers);
      if (!checkInTime) return errorResponse('출근 시간을 입력해주세요', 400, cors.headers);

      // 해당 기록이 같은 회사 소속인지 확인
      const { data: existing, error: findErr } = await supabase
        .from('attendances')
        .select('id, employee_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single();

      if (findErr || !existing) return errorResponse('수정할 기록을 찾을 수 없습니다', 404, cors.headers);

      const checkIn  = `${workDate}T${checkInTime}:00`;
      const checkOut = checkOutTime ? `${workDate}T${checkOutTime}:00` : null;

      let workHours = null;
      if (checkOut) {
        const diffMs = new Date(checkOut) - new Date(checkIn);
        workHours = Math.max(0, Math.round(diffMs / 1000 / 60) / 60);
      }

      const status = checkOut ? 'completed' : 'in_progress';

      const { data: updated, error: updateErr } = await supabase
        .from('attendances')
        .update({
          check_in_time:  checkIn,
          check_out_time: checkOut,
          work_hours:     workHours,
          status,
          notes:          notes || null,
          check_method:   'manual', // 수동 수정 표시
        })
        .eq('id', id)
        .eq('company_id', companyId)
        .select()
        .single();

      if (updateErr) {
        console.error('수정 오류:', updateErr);
        return errorResponse('수정에 실패했습니다: ' + updateErr.message, 500, cors.headers);
      }

      return {
        statusCode: 200,
        headers: cors.headers,
        body: JSON.stringify({ success: true, data: updated }),
      };
    }

    // ── DELETE: 기록 삭제 ────────────────────────────────────
    if (method === 'DELETE') {
      const id = event.queryStringParameters?.id;

      if (!id) return errorResponse('삭제할 기록 ID가 필요합니다', 400, cors.headers);

      // 해당 기록이 같은 회사 소속인지 확인
      const { data: existing } = await supabase
        .from('attendances')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single();

      if (!existing) return errorResponse('삭제할 기록을 찾을 수 없습니다', 404, cors.headers);

      const { error: deleteErr } = await supabase
        .from('attendances')
        .delete()
        .eq('id', id)
        .eq('company_id', companyId);

      if (deleteErr) {
        console.error('삭제 오류:', deleteErr);
        return errorResponse('삭제에 실패했습니다: ' + deleteErr.message, 500, cors.headers);
      }

      return {
        statusCode: 200,
        headers: cors.headers,
        body: JSON.stringify({ success: true, message: '삭제되었습니다' }),
      };
    }

    return errorResponse('허용되지 않는 메서드입니다', 405, cors.headers);

  } catch (err) {
    console.error('attendances-manage 오류:', err);
    return errorResponse('서버 오류: ' + err.message, 500, cors.headers);
  }
};
