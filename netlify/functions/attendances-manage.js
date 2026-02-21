// netlify/functions/attendances-manage.js
// 수동 출퇴근 등록 / 수정 / 삭제 API
// POST   → 신규 등록
// PUT    → 기존 기록 수정 (body에 id 필수)
// DELETE → 기록 삭제   (?id= 쿼리스트링 필수)

const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('./lib/auth');
// ─────────────────────────────────────────────────────────────
// 야간근로 시간 계산 (근로기준법 제56조)
// 야간근로 구간: 22:00 ~ 익일 06:00
// 반환값: 야간 구간과 겹치는 시간 (소수점 2자리, 단위: 시간)
// ─────────────────────────────────────────────────────────────
function calcNightHours(checkInISO, checkOutISO) {
  if (!checkInISO || !checkOutISO) return 0;

  const inTime  = new Date(checkInISO);
  const outTime = new Date(checkOutISO);
  if (outTime <= inTime) return 0;

  // 하루(24h) 슬라이딩 윈도우로 야간 구간과 교차 계산
  // 날짜가 바뀌어도 처리 가능하도록 루프
  let nightMs = 0;
  
  // 총 구간을 1분 단위로 순회하는 대신 구간 교차 계산
  // 야간 구간: 당일 22:00 ~ 익일 06:00 → 8시간 블록 반복
  const MS_HOUR = 3600 * 1000;
  
  // checkIn 날짜 기준으로 야간 블록을 생성해 교차 확인
  // 최대 3일치 야간 블록만 체크 (실질적으로 연속 근무 최대 24h 가정)
  const startDay = new Date(inTime);
  startDay.setHours(0, 0, 0, 0); // 당일 자정

  for (let d = -1; d <= 2; d++) {
    // 야간 블록 시작: (startDay + d일) 22:00
    const nightStart = new Date(startDay);
    nightStart.setDate(nightStart.getDate() + d);
    nightStart.setHours(22, 0, 0, 0);

    // 야간 블록 끝: 다음날 06:00
    const nightEnd = new Date(nightStart);
    nightEnd.setDate(nightEnd.getDate() + 1);
    nightEnd.setHours(6, 0, 0, 0);

    // 교차 구간 계산
    const overlapStart = Math.max(inTime.getTime(), nightStart.getTime());
    const overlapEnd   = Math.min(outTime.getTime(), nightEnd.getTime());
    if (overlapEnd > overlapStart) {
      nightMs += overlapEnd - overlapStart;
    }
  }

  return Math.max(0, parseFloat((nightMs / MS_HOUR).toFixed(2)));
}



// ✅ 프로젝트 표준 CORS 헤더 (employees-list.js 동일 패턴)
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

function resp(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // ✅ 실제 패턴: authHeader 문자열을 verifyToken에 전달, try/catch로 감싸기
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);

    if (!tokenData.companyId) {
      return resp(401, { success: false, error: '인증 토큰이 유효하지 않습니다' });
    }

    const { companyId, role } = tokenData;

    // owner / manager 만 허용
    if (!['owner', 'manager'].includes(role)) {
      return resp(403, { success: false, error: '권한이 없습니다 (owner/manager만 가능)' });
    }

    const supabase = getSupabase();
    const method = event.httpMethod;

    // ── POST: 신규 등록 ──────────────────────────────────
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { employeeId, workDate, checkInTime, checkOutTime, checkOutDate, notes } = body;

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

      if (existing) return resp(409, { success: false, error: '해당 날짜에 이미 출퇴근 기록이 있습니다' });

      const checkIn  = `${workDate}T${checkInTime}:00`;
      // 야간근무: checkOutDate가 있으면 그 날짜 사용, 없으면 workDate
      const outDate  = checkOutDate || workDate;
      const checkOut = checkOutTime ? `${outDate}T${checkOutTime}:00` : null;

      let workHours = null;
      let nightHours = 0;
      if (checkOut) {
        const diffMs = new Date(checkOut) - new Date(checkIn);
        workHours  = Math.max(0, parseFloat((diffMs / 1000 / 3600).toFixed(2)));
        nightHours = calcNightHours(checkIn, checkOut); // 야간근로 시간 자동 계산
      }

      const { data: record, error: insertErr } = await supabase
        .from('attendances')
        .insert({
          employee_id:    employeeId,
          company_id:     companyId,
          check_in_time:  checkIn,
          check_out_time: checkOut,
          work_hours:     workHours,
          night_hours:    nightHours,  // 야간근로 시간 저장
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
      const { id, workDate, checkInTime, checkOutTime, checkOutDate, notes } = body;

      if (!id)          return resp(400, { success: false, error: '수정할 기록 ID가 필요합니다' });
      if (!workDate)    return resp(400, { success: false, error: '근무일을 입력해주세요' });
      if (!checkInTime) return resp(400, { success: false, error: '출근 시간을 입력해주세요' });

      const { data: target } = await supabase
        .from('attendances')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle();

      if (!target) return resp(404, { success: false, error: '수정할 기록을 찾을 수 없습니다' });

      const checkIn  = `${workDate}T${checkInTime}:00`;
      // 야간근무: checkOutDate가 있으면 그 날짜 사용, 없으면 workDate
      const outDate  = checkOutDate || workDate;
      const checkOut = checkOutTime ? `${outDate}T${checkOutTime}:00` : null;

      let workHours = null;
      let nightHours = 0;
      if (checkOut) {
        const diffMs = new Date(checkOut) - new Date(checkIn);
        workHours  = Math.max(0, parseFloat((diffMs / 1000 / 3600).toFixed(2)));
        nightHours = calcNightHours(checkIn, checkOut); // 야간근로 시간 재계산
      }

      const { data: updated, error: updateErr } = await supabase
        .from('attendances')
        .update({
          check_in_time:  checkIn,
          check_out_time: checkOut,
          work_hours:     workHours,
          night_hours:    nightHours,  // 야간근로 시간 업데이트
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
    // verifyToken이 throw할 때 여기서 잡힘
    console.error('attendances-manage 오류:', err.message);
    if (err.message.includes('인증') || err.message.includes('토큰') || err.message.includes('만료')) {
      return resp(401, { success: false, error: err.message });
    }
    return resp(500, { success: false, error: '서버 오류: ' + err.message });
  }
};
