// Sentry 에러 추적 공유 모듈
const Sentry = require('@sentry/node');

// 중복 초기화 방지
if (!Sentry.isInitialized()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: 'production',
    tracesSampleRate: 0.1,
  });
}

function captureError(error, context = {}) {
  Sentry.withScope((scope) => {
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.companyId) scope.setTag('companyId', context.companyId);
    if (context.function) scope.setTag('function', context.function);
    Sentry.captureException(error);
  });
}

module.exports = { Sentry, captureError };