/**
 * netlify/functions/solapi-send.js
 * SOLAPI 알림 발송 통합 엔드포인트
 * POST /.netlify/functions/solapi-send
 * Phase 9-A: 카카오 알림 플랜 사용량 제한 연동
 */

const { verifyToken } = require('./lib/auth');
const { sendAlimtalk, sendSms } = require('./lib/solapi');
const { createClient } = require('@supabase/supabase-js');
// Phase 9-A: 요금제 한도 체크 미들웨어
const { checkPlanLimit, incrementUsage, FEATURES } = require('./lib/plan-check');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function buildTemplate(type, data) {
  switch (type) {
    case 'payroll':
      return {
        templateId: process.env.SOLAPI_TEMPLATE_PAYROLL || null,
        variables: { '#{이름}': data.employeeName, '#{연월}': data.payMonth, '#{실수령액}': Number(data.netPay).toLocaleString('ko-KR'), '#{링크}': data.link || 'https://staffmanager.io/salary.html' },
        fallbackText: `[StaffManager] ${data.employeeName}님의 ${data.payMonth} 급여명세서가 발송되었습니다.
실수령액: ${Number(data.netPay).toLocaleString('ko-KR')}원
확인: https://staffmanager.io/salary.html`,
        title: `${data.payMonth} 급여명세서`,
        message: `실수령액 ${Number(data.netPay).toLocaleString('ko-KR')}원`,
        linkUrl: data.link || 'https://staffmanager.io/salary.html',
      };
    case 'contract':
      return {
        templateId: process.env.SOLAPI_TEMPLATE_CONTRACT || null,
        variables: { '#{이름}': data.employeeName, '#{계약종류}': data.contractType || '근로계약서', '#{링크}': data.signingUrl || 'https://staffmanager.io/contracts.html' },
        fallbackText: `[StaffManager] ${data.employeeName}님, 서명이 필요한 ${data.contractType || '근로계약서'}가 있습니다.
서명하기: ${data.signingUrl || 'https://staffmanager.io/contracts.html'}`,
        title: `${data.contractType || '근로계약서'} 서명 요청`,
        message: '서명이 필요한 계약서가 있습니다.',
        linkUrl: data.signingUrl || 'https://staffmanager.io/contracts.html',
      };
    case 'attendance':
      return {
        templateId: process.env.SOLAPI_TEMPLATE_ATTENDANCE || null,
        variables: { '#{이름}': data.employeeName, '#{시각}': data.checkInTime, '#{사업장}': data.businessName || '' },
        fallbackText: `[StaffManager] ${data.employeeName}님 출근 확인
시각: ${data.checkInTime}
사업장: ${data.businessName || ''}`,
        title: '출근 확인',
        message: `${data.checkInTime} 출근 처리되었습니다.`,
        linkUrl: 'https://staffmanager.io/attendance.html',
      };
    case 'vacation': {
      const statusText = data.status === 'approved' ? '승인' : '반려';
      return {
        templateId: data.status === 'approved' ? (process.env.SOLAPI_TEMPLATE_VAC_APPROVE || null) : (process.env.SOLAPI_TEMPLATE_VAC_REJECT || null),
        variables: { '#{이름}': data.employeeName, '#{휴가종류}': data.vacationType || '연차', '#{날짜}': data.vacationDate, '#{결과}': statusText, '#{사유}': data.reason || '' },
        fallbackText: `[StaffManager] ${data.employeeName}님의 ${data.vacationType || '연차'} 신청이 ${statusText}되었습니다.
날짜: ${data.vacationDate}`,
        title: `휴가 신청 ${statusText}`,
        message: `${data.vacationDate} ${data.vacationType || '연차'}이 ${statusText}되었습니다.`,
        linkUrl: 'https://staffmanager.io/leaves.html',
      };
    }
    default:
      throw new Error(`알 수 없는 알림 종류: ${type}`);
  }
}

async function saveNotificationLog(supabase, { userId, companyId, type, title, message, templateId, kakaoSent, messageId, linkUrl, errorMsg }) {
  const { error } = await supabase.from('notifications').insert({
    user_id: userId || null,
    company_id: companyId,
    type,
    title: title || type,
    message: errorMsg ? `[오류] ${errorMsg}` : (message || ''),
    kakao_template_code: templateId || null,
    kakao_sent: kakaoSent,
    kakao_sent_at: kakaoSent ? new Date().toISOString() : null,
    kakao_message_id: messageId || null,
    link_url: linkUrl || null,
    read: false,
  });
  if (error) console.warn('notifications 저장 실패:', error.message);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'POST만 허용됩니다.' }) };

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);
    if (!tokenData.companyId) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '인증 토큰이 유효하지 않습니다.' }) };

    const { type, employeeId, data } = JSON.parse(event.body || '{}');
    if (!type || !employeeId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'type, employeeId는 필수입니다.' }) };

    const supabase = getSupabase();

    // ── Phase 9-A: 카카오 알림 플랜 한도 확인 ─────────────────────
    // 비유: 문자 쿠폰 — 이번 달 남은 카카오 발송 횟수 확인
    // Free 30건 / Pro 300건 / Business 무제한
    const planCheck = await checkPlanLimit(supabase, tokenData.companyId, FEATURES.KAKAO_ALERT);
    if (!planCheck.allowed) {
      console.log(`[solapi-send] 플랜 한도 초과: ${planCheck.plan} (${planCheck.used}/${planCheck.limit})`);
      return { statusCode: 402, headers: CORS_HEADERS, body: JSON.stringify({ success: false, ...planCheck }) };
    }
    // ──────────────────────────────────────────────────────────────

    const { data: empData, error: empError } = await supabase
      .from('employees')
      .select('id, user_id, users:user_id(name, phone)')
      .eq('id', employeeId)
      .eq('company_id', tokenData.companyId)
      .single();

    if (empError || !empData) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '직원 정보를 찾을 수 없습니다.' }) };

    const user = Array.isArray(empData.users) ? empData.users[0] : empData.users;
    const phone = (user?.phone || '').replace(/[^0-9]/g, '');

    if (!phone || phone.length < 10) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '직원의 전화번호가 등록되지 않았습니다.' }) };

    const apiKey = process.env.SOLAPI_API_KEY;
    const apiSecret = process.env.SOLAPI_API_SECRET;
    const sender = process.env.SOLAPI_SENDER;
    const pfId = process.env.SOLAPI_PF_ID;

    if (!apiKey || !apiSecret || !sender) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'SOLAPI 환경변수가 설정되지 않았습니다.' }) };

    const enrichedData = { ...data, employeeName: user?.name || '직원' };
    const { templateId, variables, fallbackText, title, message: msgBody, linkUrl } = buildTemplate(type, enrichedData);

    let result, usedChannel;

    if (templateId && pfId) {
      try {
        result = await sendAlimtalk({ to: phone, pfId, templateId, variables, fallbackText, apiKey, apiSecret, sender });
        usedChannel = 'alimtalk';
      } catch (kakaoErr) {
        console.warn('[SOLAPI] 알림톡 실패, SMS 폴백:', kakaoErr.message);
        result = await sendSms({ to: phone, text: fallbackText, apiKey, apiSecret, sender });
        usedChannel = 'sms_fallback';
      }
    } else {
      result = await sendSms({ to: phone, text: fallbackText, apiKey, apiSecret, sender });
      usedChannel = 'sms';
    }

    await saveNotificationLog(supabase, {
      userId: empData.user_id, companyId: tokenData.companyId,
      type, title, message: msgBody, templateId: templateId || null,
      kakaoSent: true,
      messageId: result?.messageId || result?.groupId || null,
      linkUrl,
    });

    // ── Phase 9-A: 발송 성공 → 사용량 +1 ─────────────────────────
    // 성공 후에만 카운트 (실패 시 카운트 안 함)
    await incrementUsage(supabase, tokenData.companyId, FEATURES.KAKAO_ALERT);
    console.log(`[solapi-send] 사용량 +1: ${planCheck.plan} (${planCheck.used + 1}/${planCheck.limit === -1 ? '무제한' : planCheck.limit})`);
    // ──────────────────────────────────────────────────────────────

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, channel: usedChannel, messageId: result?.messageId || result?.groupId }) };

  } catch (error) {
    console.error('[SOLAPI] 예외:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '알림 발송 실패: ' + error.message }) };
  }
};