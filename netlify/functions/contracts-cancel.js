// =====================================================
// 계약서 취소 API
// POST /.netlify/functions/contracts-cancel
// Body: { contract_id, reason }
// Phase 6 - 전자계약 (UCanSign)
// =====================================================

const { verifyToken } = require('./lib/auth');
const { ucansignRequest } = require('./ucansign-auth');
const { createClient } = require('@supabase/supabase-js');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase 환경변수 미설정');
  return createClient(url, key);
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'POST만 허용' }) };
  }

  try {
    // 인증 확인
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try {
      userInfo = verifyToken(authHeader);
    } catch (err) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '인증 실패: ' + err.message }) };
    }

    const supabase = getSupabaseClient();
    const body = JSON.parse(event.body || '{}');
    const { contract_id, reason } = body;

    if (!contract_id) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'contract_id는 필수입니다.' }) };
    }

    // 계약 조회
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, ucansign_document_id, status, company_id, title, contract_data')
      .eq('id', contract_id)
      .eq('company_id', userInfo.companyId)
      .single();

    if (error || !contract) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다.' }) };
    }

    // 상태 검증
    if (contract.status === 'completed' || contract.status === 'signed') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '이미 서명 완료된 계약은 취소할 수 없습니다.' }) };
    }
    if (contract.status === 'cancelled') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '이미 취소된 계약입니다.' }) };
    }

    // UCanSign에서 문서 취소
    // 엔드포인트: DELETE /openapi/documents/:documentId
    let ucansignCancelled = false;
    if (contract.ucansign_document_id) {
      try {
        await ucansignRequest('DELETE', `/documents/${contract.ucansign_document_id}`);
        ucansignCancelled = true;
        console.log('[contracts-cancel] UCanSign 문서 취소 완료:', contract.ucansign_document_id);
      } catch (ucErr) {
        console.warn('[contracts-cancel] UCanSign 취소 실패 (DB만 업데이트):', ucErr.message);
        // UCanSign 취소 실패해도 DB는 업데이트 (이미 만료/취소된 경우 등)
      }
    }

    // DB 상태 업데이트
    const existingData = contract.contract_data
      ? (typeof contract.contract_data === 'string' ? JSON.parse(contract.contract_data) : contract.contract_data)
      : {};

    const { data: updated, error: updateError } = await supabase
      .from('contracts')
      .update({
        status: 'cancelled',
        ucansign_status: 'cancelled',
        contract_data: JSON.stringify({
          ...existingData,
          cancel_reason: reason || '사업주 취소',
          cancelled_at: new Date().toISOString(),
          ucansign_cancelled: ucansignCancelled
        }),
        updated_at: new Date().toISOString()
      })
      .eq('id', contract_id)
      .select()
      .single();

    if (updateError) {
      console.error('[contracts-cancel] DB 업데이트 실패:', updateError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '계약 취소 처리 실패' }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        data: updated,
        message: '계약이 취소되었습니다.',
        ucansign_cancelled: ucansignCancelled
      })
    };

  } catch (error) {
    console.error('[contracts-cancel] 서버 오류:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message }) };
  }
};
