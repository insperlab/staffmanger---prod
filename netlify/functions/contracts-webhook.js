// =====================================================
// UCanSign 웹훅 핸들러
// POST /.netlify/functions/contracts-webhook
// Phase 6 - 전자계약 서명 상태 콜백
// =====================================================

const { createClient } = require('@supabase/supabase-js');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase 환경변수 미설정');
  return createClient(url, key);
}

// 웹훅은 외부에서 호출하므로 CORS 다르게 설정
const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// UCanSign 상태 → StaffManager 상태 매핑
const STATUS_MAP = {
  'created': 'sent',
  'sent': 'sent',
  'opened': 'viewed',
  'viewed': 'viewed',
  'signed': 'signed',
  'completed': 'completed',
  'rejected': 'rejected',
  'declined': 'rejected',
  'expired': 'expired',
  'canceled': 'rejected',
  'cancelled': 'rejected'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ success: false, error: 'POST만 허용' })
    };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    console.log('[contracts-webhook] 수신:', JSON.stringify(payload));

    // UCanSign 콜백 데이터 파싱
    // UCanSign은 다양한 형식으로 콜백을 보낼 수 있으므로 여러 필드를 체크
    const requestId = payload.requestId || payload.signRequestId || payload.id || payload.result?.requestId;
    const ucansignStatus = payload.status || payload.event || payload.type;
    const pdfUrl = payload.pdfUrl || payload.documentUrl || payload.result?.pdfUrl;

    if (!requestId) {
      console.warn('[contracts-webhook] requestId 없음:', JSON.stringify(payload));
      // 200 반환 (재시도 방지)
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, message: 'requestId 없음, 무시' })
      };
    }

    const supabase = getSupabaseClient();

    // 해당 계약서 찾기
    const { data: contract, error: findErr } = await supabase
      .from('contracts')
      .select('id, status, company_id, employee_id, title, signer_name')
      .eq('ucansign_request_id', requestId)
      .single();

    if (findErr || !contract) {
      console.warn('[contracts-webhook] 계약서 못찾음. requestId:', requestId);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ success: true, message: '해당 계약서 없음' })
      };
    }

    // 상태 매핑
    const newStatus = STATUS_MAP[ucansignStatus] || contract.status;
    const updateData = {
      ucansign_status: ucansignStatus,
      status: newStatus
    };

    // 상태별 추가 처리
    if (newStatus === 'signed' || newStatus === 'completed') {
      updateData.signed_at = new Date().toISOString();
      updateData.completed_at = new Date().toISOString();
      if (pdfUrl) {
        updateData.signed_pdf_url = pdfUrl;
      }
    }

    // DB 업데이트
    const { error: updateErr } = await supabase
      .from('contracts')
      .update(updateData)
      .eq('id', contract.id);

    if (updateErr) {
      console.error('[contracts-webhook] DB 업데이트 실패:', updateErr);
      throw updateErr;
    }

    console.log('[contracts-webhook] 상태 업데이트 완료:', contract.id, ucansignStatus, '→', newStatus);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ success: true, message: '상태 업데이트 완료' })
    };

  } catch (error) {
    console.error('[contracts-webhook] 오류:', error);
    // 웹훅은 항상 200 반환 (재시도 무한루프 방지)
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};
