// netlify/functions/attendance-checkin.js
// M4: 출퇴근 체크인 핵심 API
// POST /.netlify/functions/attendance-checkin

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

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

    if (!token)       return err400('token 필수');
    if (!phoneNumber) return err400('phoneNumber 필수');
    if (!type || !['check-in', 'check-out'].includes(type)) return err400('type은 check-in 또는 check-out');

    const checkTime = timestamp ? new Date(timestamp) : new Date();
    if (isNaN(checkTime)) return err400('timestamp 형식 오류');

    // 1) QR 토큰 → 회사 조회
    const { data: company, error: compErr } = await supabase
      .from('companies')
      .select('id, company_name')
      .eq('qr_token', token)
      .eq('status', 'active')
      .single();

    if (compErr || !company) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: '유효하지 않은 QR코드입니다.' }) };
    }
    const companyId = company.id;

    // 2) 전화번호 → 직원 조회
    const phone = normalizePhone(phoneNumber);
    const { data: employee, error: empErr } = await supabase
      .from('employees')
      .select('id, name, business_id, status')
      .eq('company_id', companyId)
      .or(`phone.eq.${phone},phone.eq.${phoneNumber}`)
      .single();

    if (empErr || !employee) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: '등록되지 않은 전화번호입니다.' }) };
    }
    if (employee.status === 'inactive' || employee.status === 'resigned') {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ success: false, error: '재직 중인 직원만 체크인할 수 있습니다.' }) };
    }

    // 3) 사업장 WiFi 설정 조회
    let bizSettings = null;
    if (employee.business_id) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('id, checkin_method, wifi_enabled, wifi_registered_ip, wifi_ip_mismatch_detected')
        .eq('id', employee.business_id)
        .single();
      bizSettings = biz;
    }

    // 4) 서버에서 클라이언트 IP 추출 (위조 불가)
    const clientIp = extractClientIp(event.headers);

    // 5) WiFi IP 매칭
    let wifiMatched = null;
    const wifiEnabled = bizSettings?.wifi_enabled === true;
    const registeredIp = bizSettings?.wifi_registered_ip || null;

    if (wifiEnabled && registeredIp) {
      wifiMatched = (clientIp === registeredIp);

      // 6) IP 불일치 → 사업장 알림 플래그 저장
      if (!wifiMatched) {
        const alreadyFlagged = bizSettings?.wifi_ip_mismatch_detected === clientIp;
        if (!alreadyFlagged) {
          await supabase
            .from('businesses')
            .update({
              wifi_ip_mismatch_detected: clientIp,
              wifi_ip_mismatch_at: new Date().toISOString(),
            })
            .eq('id', employee.business_id);
        }
      }
    }

    // 7) 출퇴근 기록 저장
    const today = checkTime.toISOString().slice(0, 10);
    const checkinMethod = bizSettings?.checkin_method || 'qr';

    if (type === 'check-in') {
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

      const { data: att, error: attErr } = await supabase
        .from('attendances')
        .insert({
          employee_id:            employee.id,
          company_id:             companyId,
          check_in_time:          checkTime.toISOString(),
          status:                 'in_progress',
          check_method:           checkinMethod,
          client_ip:              clientIp,
          wifi_matched:           wifiMatched,
          registered_ip_snapshot: registeredIp,
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
          wifiMatched,
          checkinMethod,
          message: `${employee.name}님 출근이 기록되었습니다.`,
        }),
      };

    } else {
      const { data: existing } = await supabase
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
        });
      }

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

function err400(msg) {
  return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: msg }) };
}