// =====================================================
// UCanSign 웹훅 핸들러 (Enhanced v2)
// POST /.netlify/functions/contracts-webhook
// Phase 6 - 전자계약 서명 완료 후처리
// =====================================================
// 
// UCanSign 웹훅 이벤트 4종:
//   sign_creating       → 서명문서 생성됨
//   signing_canceled     → 서명 취소됨
//   signing_completed    → 개별 참여자 서명 완료
//   signing_completed_all → 전체 서명 완료 (★ 핵심)
//
// 후처리 플로우 (signing_completed_all):
//   1. DB 상태 → completed
//   2. UCanSign API로 PDF URL 조회 → DB 저장
//   3. 감사추적 인증서 URL 조회 → DB 저장
// =====================================================

const { createClient } = require('@supabase/supabase-js');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase 환경변수 미설정');
  return createClient(url, key);
}

// 웹훅은 외부(UCanSign)에서 호출 → CORS 오픈
const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ─── UCanSign API 직접 호출 (웹훅 핸들러용 독립 구현) ───
const UCANSIGN_BASE_URL = 'https://app.ucansign.com/openapi';

async function getUcansignToken() {
  const apiKey = process.env.UCANSIGN_API_KEY;
  if (!apiKey) throw new Error('UCANSIGN_API_KEY 미설정');

  const response = await fetch(`${UCANSIGN_BASE_URL}/user/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'StaffManager/1.0' },
    body: JSON.stringify({ apiKey })
  });

  if (!response.ok) throw new Error('UCanSign 토큰 발급 실패: ' + response.status);
  const result = await response.json();
  if (result.code !== 0) throw new Error('UCanSign 토큰 오류: ' + (result.msg || 'unknown'));
  return result.result.accessToken;
}

async function ucansignApiCall(method, endpoint) {
  const token = await getUcansignToken();
  const isTestMode = process.env.UCANSIGN_TEST_MODE === 'true';

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'StaffManager/1.0'
  };
  if (isTestMode) headers['x-ucansign-test'] = 'true';

  const url = endpoint.startsWith('http') ? endpoint : `${UCANSIGN_BASE_URL}${endpoint}`;
  const response = await fetch(url, { method, headers });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`UCanSign API [${response.status}]: ${errorText.substring(0, 200)}`);
  }

  return response.json();
}

// ─── 계약서 조회 (documentId 또는 requestId로) ───
async function findContract(supabase, payload) {
  const documentId = payload.documentId || payload.document_id || payload.id 
    || (payload.result && payload.result.documentId) 
    || (payload.data && payload.data.documentId);
  const requestId = payload.requestId || payload.signRequestId || payload.request_id
    || (payload.result && payload.result.requestId);

  // 1차: ucansign_document_id로 조회 (가장 정확)
  if (documentId) {
    const { data, error } = await supabase
      .from('contracts')
      .select('id, status, company_id, employee_id, title, signer_name, ucansign_document_id, ucansign_request_id, contract_data')
      .eq('ucansign_document_id', String(documentId))
      .single();
    
    if (data && !error) {
      console.log('[webhook] 계약 찾음 (document_id):', data.id);
      return data;
    }
  }

  // 2차: ucansign_request_id로 조회
  if (requestId) {
    const { data, error } = await supabase
      .from('contracts')
      .select('id, status, company_id, employee_id, title, signer_name, ucansign_document_id, ucansign_request_id, contract_data')
      .eq('ucansign_request_id', String(requestId))
      .single();

    if (data && !error) {
      console.log('[webhook] 계약 찾음 (request_id):', data.id);
      return data;
    }
  }

  console.warn('[webhook] 계약 못찾음. documentId:', documentId, 'requestId:', requestId);
  return null;
}

// ─── 이벤트 타입 판별 ───
function detectEventType(payload) {
  const eventType = payload.event || payload.type || payload.eventType 
    || payload.webhookType || payload.action;
  
  if (eventType) return String(eventType).toLowerCase();

  // event 필드 없으면 status에서 추정
  const status = (payload.status || '').toLowerCase();
  if (status === 'completed' || status === 'signing_completed_all') return 'signing_completed_all';
  if (status === 'signed' || status === 'signing_completed') return 'signing_completed';
  if (status.includes('cancel')) return 'signing_canceled';
  if (status === 'created' || status === 'sent') return 'sign_creating';
  if (status === 'expired') return 'expired';
  if (status === 'rejected' || status === 'declined') return 'rejected';
  return 'unknown';
}

// ─── PDF + 감사추적 URL 조회 ───
async function fetchDocumentFiles(documentId) {
  const result = { pdfUrl: null, auditTrailUrl: null };
  if (!documentId) return result;

  // PDF 다운로드 URL (3분 유효)
  try {
    const pdfResult = await ucansignApiCall('GET', `/documents/${documentId}/file`);
    if (pdfResult && pdfResult.result) {
      result.pdfUrl = pdfResult.result.url || pdfResult.result.file || 
        (typeof pdfResult.result === 'string' ? pdfResult.result : null);
      console.log('[webhook] PDF URL 조회 성공');
    }
  } catch (err) {
    console.warn('[webhook] PDF URL 조회 실패:', err.message);
  }

  // 감사추적 인증서 URL
  try {
    const auditResult = await ucansignApiCall('GET', `/documents/${documentId}/audit-trail`);
    if (auditResult && auditResult.result) {
      result.auditTrailUrl = auditResult.result.url || auditResult.result.file ||
        (typeof auditResult.result === 'string' ? auditResult.result : null);
      console.log('[webhook] 감사추적 URL 조회 성공');
    }
  } catch (err) {
    console.warn('[webhook] 감사추적 URL 조회 실패:', err.message);
  }

  return result;
}

// ─── 메인 핸들러 ───
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405, headers: HEADERS,
      body: JSON.stringify({ success: false, error: 'POST만 허용' })
    };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const eventType = detectEventType(payload);
    
    console.log('=== [contracts-webhook] 수신 ===');
    console.log('[webhook] 이벤트:', eventType);
    console.log('[webhook] 페이로드:', JSON.stringify(payload).substring(0, 500));

    const supabase = getSupabaseClient();

    // 계약서 찾기
    const contract = await findContract(supabase, payload);
    if (!contract) {
      return {
        statusCode: 200, headers: HEADERS,
        body: JSON.stringify({ success: true, message: '해당 계약서 없음, 무시' })
      };
    }

    const now = new Date().toISOString();
    var updateData = { updated_at: now };
    var logMessage = '';

    // ─── 이벤트별 분기 처리 ───
    if (eventType === 'signing_completed_all' || eventType === 'completed') {
      // ★ 전체 서명 완료 (핵심 후처리)
      updateData.status = 'completed';
      updateData.ucansign_status = 'completed';
      updateData.completed_at = now;
      if (!contract.status || contract.status !== 'signed') {
        updateData.signed_at = now;
      }

      // PDF + 감사추적 자동 조회
      var docId = contract.ucansign_document_id;
      if (docId) {
        var files = await fetchDocumentFiles(docId);
        if (files.pdfUrl) updateData.signed_pdf_url = files.pdfUrl;
        if (files.auditTrailUrl) updateData.audit_trail_url = files.auditTrailUrl;
      }

      logMessage = '✅ 전체 서명 완료 → completed (PDF: ' + (updateData.signed_pdf_url ? '✓' : '✗') + ')';

    } else if (eventType === 'signing_completed' || eventType === 'signed') {
      // 개별 참여자 서명 완료
      if (contract.status === 'completed') {
        logMessage = 'ℹ️ 개별 서명 완료 (이미 completed, 무시)';
      } else {
        updateData.status = 'signed';
        updateData.ucansign_status = 'signed';
        updateData.signed_at = now;

        var signerInfo = payload.participant || payload.signer || (payload.data && payload.data.participant);
        if (signerInfo) {
          var existingData = contract.contract_data || {};
          existingData.last_signer = {
            name: signerInfo.name,
            signed_at: now,
            order: signerInfo.signingOrder || signerInfo.order
          };
          updateData.contract_data = existingData;
        }
        logMessage = '📝 개별 서명 완료 → signed';
      }

    } else if (eventType === 'signing_canceled' || eventType === 'cancelled' || eventType === 'canceled') {
      // 서명 취소
      updateData.status = 'rejected';
      updateData.ucansign_status = 'canceled';
      
      var reason = payload.reason || payload.cancelReason || (payload.data && payload.data.reason) || '';
      if (reason) {
        var existData = contract.contract_data || {};
        existData.cancel_reason = reason;
        existData.canceled_at = now;
        updateData.contract_data = existData;
      }
      logMessage = '❌ 서명 취소됨 → rejected';

    } else if (eventType === 'sign_creating' || eventType === 'created') {
      // 서명문서 생성됨
      if (contract.status === 'draft') {
        updateData.status = 'sent';
        updateData.ucansign_status = 'created';
        updateData.sent_at = now;
      }
      logMessage = '📤 서명문서 생성/발송됨';

    } else if (eventType === 'opened' || eventType === 'viewed') {
      // 열람
      if (contract.status === 'sent') {
        updateData.status = 'viewed';
      }
      updateData.ucansign_status = eventType;
      logMessage = '👁️ 수신자 열람';

    } else if (eventType === 'expired') {
      updateData.status = 'expired';
      updateData.ucansign_status = 'expired';
      logMessage = '⏰ 서명 기한 만료';

    } else if (eventType === 'rejected' || eventType === 'declined') {
      updateData.status = 'rejected';
      updateData.ucansign_status = eventType;
      logMessage = '🚫 서명 거절됨';

    } else {
      // 알 수 없는 이벤트
      var rawStatus = payload.status || eventType;
      if (rawStatus) updateData.ucansign_status = rawStatus;
      logMessage = '❓ 알 수 없는 이벤트: ' + eventType;
    }

    // ─── DB 업데이트 ───
    var { error: updateErr } = await supabase
      .from('contracts')
      .update(updateData)
      .eq('id', contract.id);

    if (updateErr) {
      console.error('[webhook] DB 업데이트 실패:', updateErr);
      throw updateErr;
    }

    console.log('[webhook] ' + logMessage + ' | 계약: ' + contract.id + ' | ' + contract.title);

    return {
      statusCode: 200, headers: HEADERS,
      body: JSON.stringify({
        success: true,
        message: logMessage,
        contractId: contract.id,
        newStatus: updateData.status || contract.status
      })
    };

  } catch (error) {
    console.error('[webhook] 처리 오류:', error);
    // 웹훅은 항상 200 반환 (재시도 무한루프 방지)
    return {
      statusCode: 200, headers: HEADERS,
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};
