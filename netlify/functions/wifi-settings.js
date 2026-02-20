// netlify/functions/wifi-settings.js
// M3: 사업장별 WiFi 출퇴근 설정 조회/수정
//
// GET  /.netlify/functions/wifi-settings?businessId=xxx
//   → 특정 사업장 WiFi 설정 조회
//   → businessId 없으면 회사 전체 사업장 설정 목록 반환
//
// PUT  /.netlify/functions/wifi-settings
//   Body: { businessId, checkinMethod, wifiEnabled, wifiRegisteredIp }
//   → WiFi 설정 저장 + IP 불일치 알림 자동 해제
//
// DELETE /.netlify/functions/wifi-settings?businessId=xxx
//   → WiFi 비활성화 (wifi_enabled=false, 등록 IP 유지)

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// ── 간단한 공인 IP 형식 검증 (IPv4) ────────────────────────────
function isValidIp(ip) {
  if (!ip) return false;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    // ── 인증 확인 (owner/manager만 설정 변경 가능) ─────────────
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let user;
    try { user = verifyToken(authHeader); }
    catch { return { statusCode: 401, headers: CORS, body: JSON.stringify({ success: false, error: '인증 실패' }) }; }

    const companyId = user.companyId;
    const params = event.queryStringParameters || {};

    // ════════════════════════════════════════════════
    // GET: 사업장 WiFi 설정 조회
    // ════════════════════════════════════════════════
    if (event.httpMethod === 'GET') {
      let query = supabase
        .from('businesses')
        .select(`
          id, name, is_headquarters,
          checkin_method,
          wifi_enabled,
          wifi_registered_ip,
          wifi_ip_updated_at,
          wifi_ip_mismatch_detected,
          wifi_ip_mismatch_at
        `)
        .eq('company_id', companyId)
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('is_headquarters', { ascending: false })
        .order('name', { ascending: true });

      // 특정 사업장만 조회
      if (params.businessId) query = query.eq('id', params.businessId);

      const { data, error } = await query;
      if (error) throw error;

      // IP 불일치 알림이 있는 사업장 추출 (대시보드 배너용)
      const alerts = (data || []).filter(b => b.wifi_ip_mismatch_detected);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          data: {
            businesses: data || [],
            alerts: alerts, // 불일치 알림 목록
          },
        }),
      };
    }

    // ════════════════════════════════════════════════
    // PUT: WiFi 설정 저장
    // ════════════════════════════════════════════════
    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { businessId, checkinMethod, wifiEnabled, wifiRegisteredIp } = body;

      if (!businessId) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'businessId 필수' }) };
      }

      // 해당 사업장이 이 회사 소속인지 확인 (타 회사 설정 변경 방지)
      const { data: biz, error: bizErr } = await supabase
        .from('businesses')
        .select('id')
        .eq('id', businessId)
        .eq('company_id', companyId)
        .single();

      if (bizErr || !biz) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ success: false, error: '접근 권한 없음' }) };
      }

      // IP 형식 검증
      if (wifiEnabled && wifiRegisteredIp && !isValidIp(wifiRegisteredIp)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'IP 형식이 올바르지 않습니다 (예: 211.45.67.89)' }) };
      }

      // 업데이트할 필드 구성
      const updates = {};
      if (checkinMethod !== undefined) {
        if (!['qr', 'gps'].includes(checkinMethod))
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'checkinMethod는 qr 또는 gps' }) };
        updates.checkin_method = checkinMethod;
      }
      if (wifiEnabled !== undefined) updates.wifi_enabled = wifiEnabled;
      if (wifiRegisteredIp !== undefined) {
        updates.wifi_registered_ip = wifiRegisteredIp ? wifiRegisteredIp.trim() : null;
        updates.wifi_ip_updated_at = new Date().toISOString();
        // IP 새로 등록/수정 시 불일치 알림 자동 해제
        updates.wifi_ip_mismatch_detected = null;
        updates.wifi_ip_mismatch_at = null;
      }

      if (Object.keys(updates).length === 0) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: '변경할 내용 없음' }) };
      }

      const { data: updated, error: updateErr } = await supabase
        .from('businesses')
        .update(updates)
        .eq('id', businessId)
        .select('id, name, checkin_method, wifi_enabled, wifi_registered_ip, wifi_ip_updated_at')
        .single();

      if (updateErr) throw updateErr;

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, data: updated, message: 'WiFi 설정이 저장되었습니다.' }),
      };
    }

    // ════════════════════════════════════════════════
    // DELETE: WiFi 비활성화
    // ════════════════════════════════════════════════
    if (event.httpMethod === 'DELETE') {
      const businessId = params.businessId;
      if (!businessId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'businessId 필수' }) };

      const { error } = await supabase
        .from('businesses')
        .update({
          wifi_enabled: false,
          wifi_ip_mismatch_detected: null,
          wifi_ip_mismatch_at: null,
        })
        .eq('id', businessId)
        .eq('company_id', companyId);

      if (error) throw error;

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, message: 'WiFi 인증이 비활성화되었습니다.' }),
      };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };

  } catch (err) {
    console.error('wifi-settings 오류:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ success: false, error: '서버 오류: ' + err.message }) };
  }
};
