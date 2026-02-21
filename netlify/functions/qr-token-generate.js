// netlify/functions/qr-token-generate.js
// QR 토큰 서버 발급 API
//
// GET  /.netlify/functions/qr-token-generate
//   → 현재 유효한 QR 토큰 조회 (재발급 없음)
//   Response: { success, token, expiresAt, qrUrl } or { success, token: null }
//
// POST /.netlify/functions/qr-token-generate
//   → 새 QR 토큰 발급 (기존 토큰 자동 폐기)
//   Response: { token, expiresAt, qrUrl }
//
// DELETE /.netlify/functions/qr-token-generate
//   → 현재 유효 토큰 즉시 폐기 (QR 분실 시)
//   Response: { success, revokedCount }

const { createClient } = require('@supabase/supabase-js');
const { verifyToken }  = require('./lib/auth');
const crypto           = require('crypto');

const corsHeaders = {
  'Access-Control-Allow-Origin':  'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// QR 토큰 유효 기간: 기본 365일
const TOKEN_EXPIRE_DAYS = 365;

function resp(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  // CORS 프리플라이트
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (!['GET', 'POST', 'DELETE'].includes(event.httpMethod)) {
    return resp(405, { success: false, error: '허용되지 않는 메서드' });
  }

  try {
    // ── 인증 (관리자만 QR 토큰 발급/조회 가능) ───────────────
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const userInfo   = verifyToken(authHeader);
    const { companyId, userId, role } = userInfo;

    if (!['owner', 'manager'].includes(role)) {
      return resp(403, { success: false, error: '관리자만 QR 토큰을 관리할 수 있습니다.' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ── GET: 현재 유효 토큰 조회 (재발급 없음) ────────────────
    // 비유: 금고 안에 이미 QR이 있으면 그냥 꺼내서 보여줌 (새로 인쇄 X)
    if (event.httpMethod === 'GET') {
      const now = new Date().toISOString();
      const { data: existing, error } = await supabase
        .from('qr_tokens')
        .select('id, token, expires_at')
        .eq('company_id', companyId)
        .is('revoked_at', null)          // 폐기 안 된 것
        .gt('expires_at', now)           // 만료 안 된 것
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();                  // 없으면 null (에러 아님)

      if (error) throw error;

      if (existing) {
        // 유효한 토큰 존재 → 그대로 반환
        const qrUrl = `https://staffmanager.io/attendance-checkin.html?token=${existing.token}`;
        return resp(200, {
          success:   true,
          token:     existing.token,
          expiresAt: existing.expires_at,
          qrUrl,
          isExisting: true,  // 기존 토큰임을 표시 (신규 발급 아님)
        });
      } else {
        // 유효 토큰 없음 → null 반환 (프론트에서 신규 발급 유도)
        return resp(200, {
          success: true,
          token:   null,
          message: '유효한 QR 토큰이 없습니다. 새로 발급해주세요.',
        });
      }
    }

    // ── DELETE: 토큰 즉시 폐기 (QR 분실 대응) ─────────────────
    if (event.httpMethod === 'DELETE') {
      const { data, error } = await supabase
        .from('qr_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .is('revoked_at', null)
        .select('id');

      if (error) throw error;

      return resp(200, {
        success:      true,
        revokedCount: data?.length || 0,
        message:      `QR 토큰 ${data?.length || 0}개가 폐기되었습니다. 새 QR을 발급해주세요.`,
      });
    }

    // ── POST: 새 QR 토큰 발급 (명시적 재발급 시에만 호출) ──────
    // 1) 기존 유효 토큰 모두 폐기
    await supabase
      .from('qr_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .is('revoked_at', null);

    // 2) 새 토큰 생성 — 256비트 암호학적 난수
    const randomPart = crypto.randomBytes(32).toString('hex');
    const newToken   = `QRT_${randomPart}`;

    // 3) 만료일 계산
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TOKEN_EXPIRE_DAYS);

    // 4) DB 저장
    const { data: tokenRecord, error: insertErr } = await supabase
      .from('qr_tokens')
      .insert({
        company_id: companyId,
        token:      newToken,
        expires_at: expiresAt.toISOString(),
        created_by: userId,
      })
      .select('id, token, expires_at')
      .single();

    if (insertErr) throw insertErr;

    // 5) QR URL 생성
    const qrUrl = `https://staffmanager.io/attendance-checkin.html?token=${newToken}`;

    return resp(200, {
      success:   true,
      token:     tokenRecord.token,
      expiresAt: tokenRecord.expires_at,
      qrUrl,
      isExisting: false,
      message:   `새 QR 토큰이 발급되었습니다. (${TOKEN_EXPIRE_DAYS}일 유효)`,
    });

  } catch (err) {
    if (err.message?.includes('token') || err.message?.includes('인증')) {
      return resp(401, { success: false, error: '인증이 필요합니다.' });
    }
    console.error('qr-token-generate 오류:', err);
    return resp(500, { success: false, error: '서버 오류: ' + err.message });
  }
};
