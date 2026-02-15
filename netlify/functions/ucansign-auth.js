// ====================================
// UCanSign 토큰 관리 함수
// StaffManager Phase 6 - 전자계약
// ====================================

let cachedToken = null;
let tokenExpiresAt = null;
const TOKEN_BUFFER_MS = 5 * 60 * 1000;

const UCANSIGN_BASE_URL = 'https://app.ucansign.com/openapi';

function successResponse(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify({ success: true, data })
  };
}

function errorResponse(message, statusCode = 400) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify({ success: false, error: message })
  };
}

async function fetchNewToken() {
  const apiKey = process.env.UCANSIGN_API_KEY;
  if (!apiKey) throw new Error('UCANSIGN_API_KEY 환경변수가 설정되지 않았습니다');

  console.log('[UCanSign Auth] 새 토큰 발급 요청...');
  const response = await fetch(UCANSIGN_BASE_URL + '/user/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'StaffManager/1.0' },
    body: JSON.stringify({ apiKey })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('토큰 발급 실패: ' + response.status + ' - ' + errorText);
  }

  const result = await response.json();
  if (result.code !== 0 || result.msg !== 'success') {
    throw new Error('토큰 발급 API 오류: ' + (result.msg || 'unknown error'));
  }

  const accessToken = result.result.accessToken;
  cachedToken = accessToken;
  tokenExpiresAt = Date.now() + (30 * 60 * 1000) - TOKEN_BUFFER_MS;
  console.log('[UCanSign Auth] 토큰 발급 성공');
  return accessToken;
}

async function getValidToken() {
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }
  return await fetchNewToken();
}

async function ucansignRequest(method, endpoint, body, retried) {
  body = body || null;
  retried = retried || false;
  const token = await getValidToken();
  const isTestMode = process.env.UCANSIGN_TEST_MODE === 'true';

  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': 'StaffManager/1.0'
  };
  if (isTestMode) headers['x-ucansign-test'] = 'true';

  const options = { method, headers };
  if (body && (method === 'POST' || method === 'PUT')) options.body = JSON.stringify(body);

  const url = endpoint.startsWith('http') ? endpoint : UCANSIGN_BASE_URL + endpoint;
  const response = await fetch(url, options);

  if ((response.status === 401 || response.status === 403) && !retried) {
    cachedToken = null;
    tokenExpiresAt = null;
    return ucansignRequest(method, endpoint, body, true);
  }

  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error('UCanSign API 오류: ' + (result.msg || response.statusText));
  }
  return result;
}

module.exports = { getValidToken, ucansignRequest, UCANSIGN_BASE_URL };

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: '' };
  }

  try {
    if (event.httpMethod === 'GET') {
      const hasToken = !!cachedToken;
      const isValid = hasToken && tokenExpiresAt && Date.now() < tokenExpiresAt;
      const expiresIn = isValid ? Math.round((tokenExpiresAt - Date.now()) / 1000) : 0;
      return successResponse({ status: isValid ? 'valid' : 'expired_or_empty', hasToken, expiresInSeconds: expiresIn, testMode: process.env.UCANSIGN_TEST_MODE === 'true' });
    }

    if (event.httpMethod === 'POST') {
      cachedToken = null;
      tokenExpiresAt = null;
      await getValidToken();
      return successResponse({ message: '토큰이 성공적으로 갱신되었습니다', expiresInSeconds: Math.round((tokenExpiresAt - Date.now()) / 1000), testMode: process.env.UCANSIGN_TEST_MODE === 'true' });
    }

    return errorResponse('GET 또는 POST 메서드만 허용됩니다', 405);
  } catch (error) {
    return errorResponse('토큰 관리 오류: ' + error.message, 500);
  }
};
