// netlify/functions/qr-token-generate.js
// QR 토큰 서버 발급 API
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

// Netlify Functions는 Node.js 환경 — crypto 기본 내장

const corsHeaders = {
  'Access-Control-Allow-Origin':  'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// QR 토큰 유효 기간: 기본 365일
// 소상공인 특성상 QR 인쇄 후 오래 쓰는 경우가 많음
// 필요 시 재발급(regenerate)으로 즉시 교체 가능
const TOKEN_EXPIRE_DAYS = 365;

function resp(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  // CORS 프리플라이트
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // POST / DELETE 만 허용
  if (!['POST', 'DELETE'].includes(event.httpMethod)) {
    return resp(405, { success: false, error: '허용되지 않는 메서드' });
  }

  try {
    // ── 인증 (관리자만 QR 토큰 발급 가능) ────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const userInfo   = verifyToken(authHeader); // 실패 시 throw
    const { companyId, userId, role } = userInfo;

    // role 값: 'owner' (사업주), 'manager' (관리자), 'employee' (직원)
    if (!['owner', 'manager'].includes(role)) {
      return resp(403, { success: false, error: '관리자만 QR 토큰을 발급할 수 있습니다.' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ── DELETE: 토큰 즉시 폐기 (QR 분실 대응) ─────────────────
    if (event.httpMethod === 'DELETE') {
      const { data, error } = await supabase
        .from('qr_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .is('revoked_at', null)  // 아직 폐기되지 않은 것만
        .select('id');

      if (error) throw error;

      return resp(200, {
        success:      true,
        revokedCount: data?.length || 0,
        message:      `QR 토큰 ${data?.length || 0}개가 폐기되었습니다. 새 QR을 발급해주세요.`,
      });
    }

    // ── POST: 새 QR 토큰 발급 ─────────────────────────────────

    // 1) 기존 유효 토큰 모두 폐기 (재발급 시 기존 QR 무효화)
    await supabase
      .from('qr_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .is('revoked_at', null);

    // 2) 새 토큰 생성 — 서버에서 암호학적 난수 생성
    // crypto.randomBytes(32) = 256비트 랜덤 → hex 64자
    // 기존 ATT_{companyId}_{timestamp} 패턴 제거 → 예측 불가 토큰
    const randomPart = crypto.randomBytes(32).toString('hex');
    const newToken   = `QRT_${randomPart}`; // QRT_ = QR Token 식별자

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

    // 5) QR 코드에 담을 URL 생성
    const qrUrl = `https://staffmanager.io/attendance-checkin.html?token=${newToken}`;

    return resp(200, {
      success:   true,
      token:     tokenRecord.token,
      expiresAt: tokenRecord.expires_at,
      qrUrl,
      message:   `새 QR 토큰이 발급되었습니다. (${TOKEN_EXPIRE_DAYS}일 유효)`,
    });

  } catch (err) {
    // verifyToken 실패 시 401
    if (err.message?.includes('token') || err.message?.includes('인증')) {
      return resp(401, { success: false, error: '인증이 필요합니다.' });
    }
    console.error('qr-token-generate 오류:', err);
    return resp(500, { success: false, error: '서버 오류: ' + err.message });
  }
};
