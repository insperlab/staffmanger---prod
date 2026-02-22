// Sentry 에러 추적 공유 모듈
// 모든 Netlify Function에서 import해서 사용

const Sentry = require('@sentry/node');

// Sentry 초기화 (한 번만 실행)
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: 0.1, // 트랜잭션 10%만 추적 (비용 절감)
});

/**
 * 에러를 Sentry에 전송하는 헬퍼 함수
 * @param {Error} error - 발생한 에러
 * @param {Object} context - 추가 컨텍스트 (userId, companyId 등)
 */
function captureError(error, context = {}) {
  Sentry.withScope((scope) => {
    // 컨텍스트 정보 추가 (어느 회사, 어느 유저에서 났는지 추적)
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.companyId) scope.setTag('companyId', context.companyId);
    if (context.function) scope.setTag('function', context.function);
    
    Sentry.captureException(error);
  });
}

module.exports = { Sentry, captureError };