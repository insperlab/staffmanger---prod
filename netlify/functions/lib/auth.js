// =====================================================
// 공유 인증 모듈 - HMAC-SHA256 서명 JWT
// netlify/functions/lib/auth.js
// =====================================================

const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = 'https://staffmanager.io';

// ====================================
// CORS 헤더 (staffmanager.io만 허용)
// ====================================
function getCorsHeaders(requestOrigin) {
  // 개발 환경 또는 Netlify 프리뷰 허용
  const allowedOrigins = [
    'https://staffmanager.io',
    'http://localhost:8888',
    'http://localhost:3000'
  ];

  // Netlify 프리뷰 URL 패턴
  const isNetlifyPreview = requestOrigin && requestOrigin.includes('--staff-manager.netlify.app');
  const isAllowed = allowedOrigins.includes(requestOrigin) || isNetlifyPreview;

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': isAllowed ? requestOrigin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}

// ====================================
// JWT 토큰 생성 (HMAC-SHA256 서명)
// ====================================
function signToken(payload) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다');
  }

  // payload에 만료시간 추가
  const tokenPayload = {
    ...payload,
    iat: Date.now(),
    exp: payload.exp || Date.now() + (7 * 24 * 60 * 60 * 1000) // 기본 7일
  };

  // base64url 인코딩
  const payloadB64 = Buffer.from(JSON.stringify(tokenPayload))
    .toString('base64url');

  // HMAC-SHA256 서명
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${signature}`;
}

// ====================================
// JWT 토큰 검증 (서명 + 만료 확인)
// ====================================
function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('인증 토큰이 없습니다');
  }

  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다');
  }

  const token = authHeader.substring(7);

  // 1. 토큰 구조 확인 (payload.signature)
  const parts = token.split('.');

  // ★ 하위 호환: 기존 base64-only 토큰 지원 (마이그레이션 기간)
  if (parts.length === 1) {
    try {
      const payload = JSON.parse(
        Buffer.from(token, 'base64').toString('utf-8')
      );
      // 기존 토큰은 만료 확인만
      if (payload.exp && payload.exp < Date.now()) {
        throw new Error('토큰이 만료되었습니다');
      }
      console.warn('[AUTH] 경고: 서명 없는 레거시 토큰 사용됨 - userId:', payload.userId);
      return {
        userId: payload.userId,
        companyId: payload.companyId,
        email: payload.email || null,
        role: payload.role || null,
        legacy: true
      };
    } catch (e) {
      if (e.message === '토큰이 만료되었습니다') throw e;
      throw new Error('토큰 파싱에 실패했습니다');
    }
  }

  if (parts.length !== 2) {
    throw new Error('잘못된 토큰 형식입니다');
  }

  const [payloadB64, signature] = parts;

  // 2. 서명 검증
  const expectedSignature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payloadB64)
    .digest('base64url');

  if (!crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  )) {
    throw new Error('토큰 서명이 유효하지 않습니다');
  }

  // 3. 페이로드 파싱
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf-8')
    );
  } catch (e) {
    throw new Error('토큰 페이로드 파싱 실패');
  }

  // 4. 만료 확인
  if (payload.exp && payload.exp < Date.now()) {
    throw new Error('토큰이 만료되었습니다');
  }

  // 5. 필수 필드 확인
  if (!payload.userId || !payload.companyId) {
    throw new Error('토큰에 필요한 정보가 없습니다');
  }

  return {
    userId: payload.userId,
    companyId: payload.companyId,
    email: payload.email || null,
    role: payload.role || null,
    legacy: false
  };
}

// ====================================
// 표준 응답 헬퍼
// ====================================
function successResponse(data, statusCode = 200, corsHeaders = null) {
  return {
    statusCode,
    headers: corsHeaders || getCorsHeaders(ALLOWED_ORIGIN),
    body: JSON.stringify({ success: true, data })
  };
}

function errorResponse(message, statusCode = 400, corsHeaders = null) {
  return {
    statusCode,
    headers: corsHeaders || getCorsHeaders(ALLOWED_ORIGIN),
    body: JSON.stringify({ success: false, error: message })
  };
}

// ====================================
// CORS preflight 처리
// ====================================
function handleCors(event) {
  const origin = event.headers.origin || event.headers.Origin || ALLOWED_ORIGIN;
  const headers = getCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  return { headers, origin };
}

module.exports = {
  signToken,
  verifyToken,
  getCorsHeaders,
  successResponse,
  errorResponse,
  handleCors,
  ALLOWED_ORIGIN
};
