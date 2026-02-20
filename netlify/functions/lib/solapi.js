/**
 * lib/solapi.js
 * SOLAPI REST API 공통 클라이언트
 * - npm 패키지 없이 Node.js 내장 crypto + fetch 사용
 * - 카카오 알림톡 우선, 실패 시 SMS 자동 폴백
 */

const crypto = require('crypto');

/* ─────────────────────────────────────────
   SOLAPI HMAC-SHA256 인증 헤더 생성
   비유: 은행 OTP처럼 매 요청마다 새 서명을 만들어서 보냄
───────────────────────────────────────── */
function makeAuthHeader(apiKey, apiSecret) {
  const date = new Date().toISOString();          // 현재 시각 (ISO 8601)
  const salt = crypto.randomBytes(16).toString('hex'); // 랜덤 salt 32자

  // 서명 대상: "날짜 + salt"를 apiSecret으로 서명
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(date + salt)
    .digest('hex');

  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

/* ─────────────────────────────────────────
   카카오 알림톡 발송
   templateId: SOLAPI 콘솔에서 템플릿 등록 후 발급받은 ID
   variables: 템플릿 변수 (예: { '#{이름}': '홍길동' })
───────────────────────────────────────── */
async function sendAlimtalk({ to, pfId, templateId, variables, fallbackText, apiKey, apiSecret, sender }) {
  const url = 'https://api.solapi.com/messages/v4/send';

  // 메시지 본문 구성
  const message = {
    to,                         // 수신번호 (하이픈 없이, 예: 01012345678)
    from: sender,               // 발신번호
    kakaoOptions: {
      pfId,                     // 카카오 채널 PF ID
      templateId,               // 알림톡 템플릿 ID
      variables: variables || {},
      disableSms: false,        // 알림톡 실패 시 SMS 자동 폴백 허용
    },
  };

  // 폴백 SMS 내용 (알림톡 실패 시 사용)
  if (fallbackText) {
    message.text = fallbackText;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': makeAuthHeader(apiKey, apiSecret),
    },
    body: JSON.stringify({ message }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`SOLAPI 오류: ${result.errorMessage || JSON.stringify(result)}`);
  }

  return result;
}

/* ─────────────────────────────────────────
   SMS 단독 발송 (알림톡 템플릿 심사 전 테스트용)
───────────────────────────────────────── */
async function sendSms({ to, text, apiKey, apiSecret, sender }) {
  const url = 'https://api.solapi.com/messages/v4/send';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': makeAuthHeader(apiKey, apiSecret),
    },
    body: JSON.stringify({
      message: {
        to,
        from: sender,
        text,
      },
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`SOLAPI SMS 오류: ${result.errorMessage || JSON.stringify(result)}`);
  }

  return result;
}

module.exports = { sendAlimtalk, sendSms };
