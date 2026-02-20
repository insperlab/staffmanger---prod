// netlify/functions/my-ip.js
// M2: 사장님 현재 공인 IP 조회 (설정 화면 "내 IP 가져오기" 버튼용)
// GET /.netlify/functions/my-ip
// 인증 불필요 — IP만 반환하는 초경량 엔드포인트

const CORS = {
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Netlify/CDN 경유 시 X-Forwarded-For에 실제 클라이언트 IP가 담김
  // 형식: "실제IP, CDN1, CDN2" → 첫 번째가 사용자 IP
  const forwarded = event.headers['x-forwarded-for'] || '';
  const ip = forwarded.split(',')[0].trim() || event.requestContext?.identity?.sourceIp || 'unknown';

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, ip }),
  };
};
