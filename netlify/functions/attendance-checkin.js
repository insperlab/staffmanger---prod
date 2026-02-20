// netlify/functions/attendance-checkin.js
// M4: 출퇴근 체크인 핵심 API
//
// POST /.netlify/functions/attendance-checkin
// Body: {
//   token: "ATT_xxx",           // QR 코드 토큰 (회사 식별)
//   phoneNumber: "010-1234-5678", // 직원 식별
//   type: "check-in" | "check-out",
//   timestamp: ISO8601,
//   location: { latitude, longitude } | null  // GPS (항상 수집)
// }
//
// 처리 순서:
//  1) 토큰 → companyId 조회
//  2) 전화번호 → 직원 조회
//  3) 직원의 businessId → businesses WiFi 설정 조회
//  4) 서버가 X-Forwarded-For 에서 client_ip 추출 (위조 불가)
//  5) wifi_enabled = true → 등록 IP vs client_ip 비교
//  6) 불일치 → businesses.wifi_ip_mismatch_detected 업데이트
//  7) attendances INSERT (check_method, client_ip, wifi_matched 포함)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*', // QR 체크인은 외부 기기에서 접속 가능하도록 허용
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── 전화번호 정규화: "010-1234-5678" → "01012345678" ────────────
function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

// ── X-Forwarded-For 에서 실제 클라이언트 IP 추출 ──────────────
function extractClientIp(headers) {
  const fwd = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  return fwd.split(',')[0].trim() || 'unknown';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ success: false, error: 'POST만 허용' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { token, phoneNumber, type, timestamp, location } = body;

    // ── 입력값 검증 ───────────────────────────────────────────
    if (!token)       return err400('token 필수');
    if (!phoneNumber) return err400('phoneNumber 필수');
    if (!type || !['check-in', 'check-out'].includes(type)) return err400('type은 check-in 또는 check-out');

    const checkTime = timestamp ? new Date(timestamp) : new Date();
    if (isNaN(checkTime)) return err400('timestamp 형식 오류');

    // ── 1) QR 토큰 → companyId 파싱 ─────────────────────────
    // 토큰 형식: ATT_{companyId}_{timestamp}
    // DB 조회 없이 직접 파싱 (settings.html이 클라이언트에서 생성하는 구조)
    if (!token.startsWith('ATT_')) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: '유효하지 않은 QR코드입니다.' }) };
    }
    // ATT_ 제거 후 첫 번째 UUID (companyId) 추출
    // 형식: ATT_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_1234567890
    const tokenBody = token.slice(4); // "ATT_" 제거
    // UUID는 36자 (8-4-4-4-12)
    const companyId = tokenBody.slice(0, 36);
    if (!companyId || companyId.length !== 36) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: '유효하지 않은 QR코드 형식입니다.' }) };
    }

    // companyId 실존 여부 확인
    const { data: company, error: compErr } = await supabase
      .from('companies')
      .select('id, company_name')
      .eq('id', companyId)
      .single();

    if (compErr || !company) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: '등록되지 않은 회사입니다.' }) };
    }

    // ── 2) 전화번호 → 직원 조회 ──────────────────────────────
    // phone은 employees가 아닌 연결된 users 테이블에 저장됨
    // users → employees (user_id FK) 순서로 조회
    const phoneNormalized = normalizePhone(phoneNumber); // '01012345678'
    const phoneDashed = phoneNormalized.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3'); // '010-1234-5678'

    // Step 1: users 테이블에서 전화번호로 user_id 조회
    const { data: userRows, error: userErr } = await supabase
      .from('users')
      .select('id')
      .in('phone', [phoneNormalized, phoneDashed, phoneNumber]);

    if (userErr || !userRows || userRows.length === 0) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: '등록되지 않은 전화번호입니다.' }) };
    }

    const userIds = userRows.map(u => u.id);

    // Step 2: employees 테이블에서 user_id + company_id 매칭
    const { data: employee, error: empErr } = await supabase
      .from('employees')
      .select('id, business_id, status, users:user_id ( name )')
      .eq('company_id', companyId)
      .in('user_id', userIds)
      .eq('status', 'active')
      .is('deleted_at', null)
      .maybeSingle();

    if (empErr || !employee) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: '등록되지 않은 전화번호입니다.' }) };
    }

    // users 조인에서 이름 추출
    const empUser = Array.isArray(employee.users) ? employee.users[0] : employee.users;
    employee.name = empUser?.name || '직원';

    // ── 3) 사업장 WiFi 설정 조회 ─────────────────────────────
    let bizSettings = null;
    if (employee.business_id) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('id, checkin_method, wifi_enabled, wifi_registered_ip')
        .eq('id', employee.business_id)
        .single();
      bizSettings = biz;
    }

    // ── 4) 서버에서 클라이언트 IP 추출 (위조 불가) ────────────
    const clientIp = extractClientIp(event.headers);

    // ── 5) WiFi IP 매칭 ───────────────────────────────────────
    let wifiMatched = null; // null = WiFi 인증 미사용
    const wifiEnabled = bizSettings?.wifi_enabled === true;
    const registeredIp = bizSettings?.wifi_registered_ip || null;

    if (wifiEnabled && registeredIp) {
      wifiMatched = (clientIp === registeredIp);

      // ── 6) IP 불일치 → 사업장에 알림 플래그 저장 ────────────
      if (!wifiMatched) {
        // 이미 같은 IP로 감지된 경우는 중복 업데이트 방지
        const alreadyFlagged = bizSettings?.wifi_ip_mismatch_detected === clientIp;
        if (!alreadyFlagged) {
          await supabase
            .from('businesses')
            .update({
              wifi_ip_mismatch_detected: clientIp,   // 감지된 새 IP
              wifi_ip_mismatch_at: new Date().toISOString(),
            })
            .eq('id', employee.business_id);
        }
      }
    }

    // ── 7) 출퇴근 기록 저장 ──────────────────────────────────
    const today = checkTime.toISOString().slice(0, 10); // YYYY-MM-DD
    const checkinMethod = bizSettings?.checkin_method || 'qr';

    if (type === 'check-in') {
      // 오늘 이미 출근 기록이 있는지 확인
      const { data: existing } = await supabase
        .from('attendances')
        .select('id, check_in_time')
        .eq('employee_id', employee.id)
        .eq('company_id', companyId)
        .gte('check_in_time', today + 'T00:00:00')
        .lte('check_in_time', today + 'T23:59:59')
        .maybeSingle();

      if (existing) {
        return {
          statusCode: 409,
          headers: CORS,
          body: JSON.stringify({
            success: false,
            error: `오늘 이미 출근 기록이 있습니다. (${new Date(existing.check_in_time).toLocaleTimeString('ko-KR')})`,
          }),
        };
      }

      // 출근 기록 INSERT
      const { data: att, error: attErr } = await supabase
        .from('attendances')
        .insert({
          employee_id:              employee.id,
          company_id:               companyId,
          check_in_time:            checkTime.toISOString(),
          status:                   'in_progress',
          check_method:             checkinMethod,
          client_ip:                clientIp,
          wifi_matched:             wifiMatched,
          registered_ip_snapshot:   registeredIp,
          // GPS 위치 (항상 기록 — 법적 분쟁 대비)
          ...(location?.latitude ? {
            check_in_latitude:  location.latitude,
            check_in_longitude: location.longitude,
          } : {}),
        })
        .select('id, check_in_time')
        .single();

      if (attErr) throw attErr;

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          type: 'check-in',
          employeeName: employee.name,
          checkinTime: att.check_in_time,
          wifiMatched,           // null=미사용, true=일치, false=불일치
          checkinMethod,
          message: `${employee.name}님 출근이 기록되었습니다.`,
        }),
      };

    } else {
      // ── 퇴근 처리 ───────────────────────────────────────────
      // 오늘 출근 기록 조회
      const { data: existing, error: findErr } = await supabase
        .from('attendances')
        .select('id, check_in_time')
        .eq('employee_id', employee.id)
        .eq('company_id', companyId)
        .eq('status', 'in_progress')
        .gte('check_in_time', today + 'T00:00:00')
        .order('check_in_time', { ascending: false })
        .maybeSingle();

      if (!existing) {
        return {
          statusCode: 404,
          headers: CORS,
          body: JSON.stringify({ success: false, error: '오늘 출근 기록을 찾을 수 없습니다.' }),
        };
      }

      // 근무 시간 계산
      const checkIn  = new Date(existing.check_in_time);
      const checkOut = checkTime;
      const workMinutes = Math.max(0, (checkOut - checkIn) / 60000);
      const workHours   = Math.round(workMinutes / 60 * 100) / 100;

      const { data: att, error: upErr } = await supabase
        .from('attendances')
        .update({
          check_out_time: checkOut.toISOString(),
          work_hours:     workHours,
          status:         'completed',
          // 퇴근 시 WiFi/IP 도 기록 (client_ip는 출근 때 이미 저장됨)
          ...(location?.latitude ? {
            check_out_latitude:  location.latitude,
            check_out_longitude: location.longitude,
          } : {}),
        })
        .eq('id', existing.id)
        .select('id, check_out_time, work_hours')
        .single();

      if (upErr) throw upErr;

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          type: 'check-out',
          employeeName: employee.name,
          checkoutTime: att.check_out_time,
          workHours:    att.work_hours,
          wifiMatched,
          checkinMethod,
          message: `${employee.name}님 퇴근이 기록되었습니다. (근무 ${Math.floor(workMinutes/60)}시간 ${Math.floor(workMinutes%60)}분)`,
        }),
      };
    }

  } catch (err) {
    console.error('attendance-checkin 오류:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ success: false, error: '서버 오류: ' + err.message }) };
  }
};

// ── 헬퍼 ─────────────────────────────────────────────────────
function err400(msg) {
  return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: msg }) };
}
