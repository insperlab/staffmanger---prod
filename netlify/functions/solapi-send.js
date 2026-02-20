/**
 * netlify/functions/solapi-send.js
 * SOLAPI 알림 발송 통합 엔드포인트
 *
 * POST /.netlify/functions/solapi-send
 * Body: {
 *   type: 'payroll',          // 알림 종류 (payroll | contract | attendance | vacation)
 *   employeeId: 'uuid',       // 수신 직원 ID
 *   data: { ... }             // 종류별 템플릿 데이터
 * }
 */

const { verifyToken } = require('./lib/auth');
const { sendAlimtalk, sendSms } = require('./lib/solapi');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* ─────────────────────────────────────────
   알림 종류별 템플릿 빌더
   비유: 우편물 양식 - 종류마다 다른 서식을 채워서 발송
───────────────────────────────────────── */
function buildTemplate(type, data) {
  switch (type) {

    case 'payroll': {
      // 급여명세서 발송 알림
      // 카카오 템플릿 심사 신청용 원문 (아래 텍스트 그대로 SOLAPI에 제출)
      // "[StaffManager] #{이름}님의 #{연월} 급여명세서가 발송되었습니다.\n실수령액: #{실수령액}원\n명세서 확인: #{링크}"
      return {
        templateId: process.env.SOLAPI_TEMPLATE_PAYROLL || null,  // 심사 완료 후 채워짐
        variables: {
          '#{이름}': data.employeeName,
          '#{연월}': data.payMonth,           // 예: 2026년 2월
          '#{실수령액}': Number(data.netPay).toLocaleString('ko-KR'),
          '#{링크}': data.link || 'https://staffmanager.io/salary.html',
        },
        // 알림톡 실패 or 템플릿 미등록 시 SMS로 발송되는 텍스트
        fallbackText:
          `[StaffManager] ${data.employeeName}님의 ${data.payMonth} 급여명세서가 발송되었습니다.\n` +
          `실수령액: ${Number(data.netPay).toLocaleString('ko-KR')}원\n` +
          `확인: https://staffmanager.io/salary.html`,
      };
    }

    case 'contract': {
      // 계약 서명 요청 알림
      return {
        templateId: process.env.SOLAPI_TEMPLATE_CONTRACT || null,
        variables: {
          '#{이름}': data.employeeName,
          '#{계약종류}': data.contractType || '근로계약서',
          '#{링크}': data.signingUrl || 'https://staffmanager.io/contracts.html',
        },
        fallbackText:
          `[StaffManager] ${data.employeeName}님, 서명이 필요한 ${data.contractType || '근로계약서'}가 있습니다.\n` +
          `서명하기: ${data.signingUrl || 'https://staffmanager.io/contracts.html'}`,
      };
    }

    case 'attendance': {
      // 출근 확인 알림
      return {
        templateId: process.env.SOLAPI_TEMPLATE_ATTENDANCE || null,
        variables: {
          '#{이름}': data.employeeName,
          '#{시각}': data.checkInTime,
          '#{사업장}': data.businessName || '',
        },
        fallbackText:
          `[StaffManager] ${data.employeeName}님 출근 확인\n` +
          `시각: ${data.checkInTime}\n사업장: ${data.businessName || ''}`,
      };
    }

    case 'vacation': {
      // 휴가 승인/반려 알림
      const statusText = data.status === 'approved' ? '승인' : '반려';
      return {
        templateId: data.status === 'approved'
          ? (process.env.SOLAPI_TEMPLATE_VAC_APPROVE || null)
          : (process.env.SOLAPI_TEMPLATE_VAC_REJECT || null),
        variables: {
          '#{이름}': data.employeeName,
          '#{휴가종류}': data.vacationType || '연차',
          '#{날짜}': data.vacationDate,
          '#{결과}': statusText,
          '#{사유}': data.reason || '',
        },
        fallbackText:
          `[StaffManager] ${data.employeeName}님의 ${data.vacationType || '연차'} 신청이 ${statusText}되었습니다.\n` +
          `날짜: ${data.vacationDate}`,
      };
    }

    default:
      throw new Error(`알 수 없는 알림 종류: ${type}`);
  }
}

/* ─────────────────────────────────────────
   알림 발송 이력을 notifications 테이블에 저장
───────────────────────────────────────── */
async function saveNotificationLog(supabase, { companyId, employeeId, type, phone, status, messageId, errorMsg }) {
  const { error } = await supabase.from('notifications').insert({
    company_id: companyId,
    employee_id: employeeId,
    type,                                   // 'payroll' | 'contract' | 'attendance' | 'vacation'
    channel: 'kakao',                       // 기본 채널
    recipient_phone: phone,
    status,                                 // 'sent' | 'failed'
    message_id: messageId || null,
    error_message: errorMsg || null,
    sent_at: new Date().toISOString(),
  });

  if (error) {
    // 로그 저장 실패가 알림 발송 성공을 취소하면 안 됨 → 경고만 출력
    console.warn('notifications 저장 실패:', error.message);
  }
}

/* ─────────────────────────────────────────
   메인 핸들러
───────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'POST만 허용됩니다.' }),
    };
  }

  try {
    // ── 1. 인증 확인 ──
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);
    if (!tokenData.companyId) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '인증 토큰이 유효하지 않습니다.' }),
      };
    }

    // ── 2. 요청 파싱 ──
    const { type, employeeId, data } = JSON.parse(event.body || '{}');
    if (!type || !employeeId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: 'type, employeeId는 필수입니다.' }),
      };
    }

    // ── 3. 직원 전화번호 조회 ──
    const supabase = getSupabase();
    const { data: empData, error: empError } = await supabase
      .from('employees')
      .select('id, users:user_id(name, phone)')
      .eq('id', employeeId)
      .eq('company_id', tokenData.companyId)  // 타사 직원 조회 방지 (보안)
      .single();

    if (empError || !empData) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '직원 정보를 찾을 수 없습니다.' }),
      };
    }

    const user = Array.isArray(empData.users) ? empData.users[0] : empData.users;
    const phone = (user?.phone || '').replace(/[^0-9]/g, ''); // 하이픈 제거

    if (!phone || phone.length < 10) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '직원의 전화번호가 등록되지 않았습니다.' }),
      };
    }

    // ── 4. 환경변수 확인 ──
    const apiKey = process.env.SOLAPI_API_KEY;
    const apiSecret = process.env.SOLAPI_API_SECRET;
    const sender = process.env.SOLAPI_SENDER;
    const pfId = process.env.SOLAPI_PF_ID;

    if (!apiKey || !apiSecret || !sender) {
      console.error('SOLAPI 환경변수 미설정');
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: 'SOLAPI 환경변수가 설정되지 않았습니다.' }),
      };
    }

    // ── 5. 템플릿 빌드 ──
    const enrichedData = { ...data, employeeName: user?.name || '직원' };
    const { templateId, variables, fallbackText } = buildTemplate(type, enrichedData);

    // ── 6. 발송 시도 ──
    let result, usedChannel;

    // 카카오 알림톡 템플릿 ID가 있으면 알림톡 우선 시도
    if (templateId && pfId) {
      try {
        console.log(`[SOLAPI] 알림톡 발송 시도 → ${phone}, 템플릿: ${templateId}`);
        result = await sendAlimtalk({
          to: phone,
          pfId,
          templateId,
          variables,
          fallbackText,  // 알림톡 실패 시 SOLAPI가 자동으로 SMS 폴백
          apiKey,
          apiSecret,
          sender,
        });
        usedChannel = 'alimtalk';
      } catch (kakaoErr) {
        // 알림톡 자체 오류 → SMS로 직접 폴백
        console.warn('[SOLAPI] 알림톡 실패, SMS 폴백:', kakaoErr.message);
        result = await sendSms({ to: phone, text: fallbackText, apiKey, apiSecret, sender });
        usedChannel = 'sms_fallback';
      }
    } else {
      // 템플릿 미등록 상태 → SMS 직접 발송 (오늘 테스트 가능)
      console.log(`[SOLAPI] 템플릿 미등록 → SMS 발송 → ${phone}`);
      result = await sendSms({ to: phone, text: fallbackText, apiKey, apiSecret, sender });
      usedChannel = 'sms';
    }

    // ── 7. 발송 이력 저장 ──
    await saveNotificationLog(supabase, {
      companyId: tokenData.companyId,
      employeeId,
      type,
      phone,
      status: 'sent',
      messageId: result?.messageId || result?.groupId || null,
    });

    console.log(`[SOLAPI] 발송 완료: ${usedChannel} → ${phone}`);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        channel: usedChannel,
        messageId: result?.messageId || result?.groupId,
      }),
    };

  } catch (error) {
    console.error('[SOLAPI] 예외 발생:', error.message);

    // 발송 실패 이력도 저장 (가능하면)
    try {
      const supabase = getSupabase();
      const { type, employeeId } = JSON.parse(event.body || '{}');
      const authHeader = event.headers.authorization || event.headers.Authorization;
      const tokenData = verifyToken(authHeader);
      await saveNotificationLog(supabase, {
        companyId: tokenData.companyId,
        employeeId,
        type,
        phone: null,
        status: 'failed',
        errorMsg: error.message,
      });
    } catch (_) { /* 로그 저장 실패는 무시 */ }

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: '알림 발송 실패: ' + error.message }),
    };
  }
};
