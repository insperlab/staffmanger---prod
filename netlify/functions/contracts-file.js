// =====================================================
// 계약서 PDF 파일 다운로드 URL 조회
// GET /.netlify/functions/contracts-file?contract_id=xxx&type=pdf|audit
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
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'GET만 허용' }) };
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
    const params = event.queryStringParameters || {};
    const { contract_id, type } = params; // type: 'pdf' (기본) | 'audit'

    if (!contract_id) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'contract_id는 필수입니다.' }) };
    }

    // 계약 정보 조회
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, ucansign_document_id, company_id, status, title')
      .eq('id', contract_id)
      .eq('company_id', userInfo.companyId)
      .single();

    if (error || !contract) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다.' }) };
    }

    if (!contract.ucansign_document_id) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'UCanSign 문서 ID가 없습니다. 계약서 발송 후 이용 가능합니다.' }) };
    }

    const docId = contract.ucansign_document_id;
    let fileUrl = null;
    let auditUrl = null;

    // PDF 파일 URL 조회
    // 엔드포인트: GET /openapi/documents/:documentId/file
    if (!type || type === 'pdf') {
      try {
        const pdfResult = await ucansignRequest('GET', `/documents/${docId}/file`);
        if (pdfResult && pdfResult.result) {
          fileUrl = pdfResult.result.url || pdfResult.result.file || pdfResult.result;
        }
      } catch (err) {
        console.warn('[contracts-file] PDF URL 조회 실패:', err.message);
        // 서명 완료 전이면 PDF가 없을 수 있음
        if (contract.status !== 'completed' && contract.status !== 'signed') {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: '서명 완료 후 PDF 다운로드가 가능합니다. 현재 상태: ' + contract.status })
          };
        }
      }
    }

    // 감사추적 인증서 URL 조회
    // 엔드포인트: GET /openapi/documents/:documentId/audit-trail
    if (type === 'audit' || type === 'all') {
      try {
        const auditResult = await ucansignRequest('GET', `/documents/${docId}/audit-trail`);
        if (auditResult && auditResult.result) {
          auditUrl = auditResult.result.url || auditResult.result.file || auditResult.result;
        }
      } catch (err) {
        console.warn('[contracts-file] 감사추적 URL 조회 실패:', err.message);
      }
    }

    if (!fileUrl && !auditUrl) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '파일을 찾을 수 없습니다. 서명 진행 상태를 확인해주세요.' })
      };
    }

    // DB에 URL 캐시 업데이트
    const cacheUpdate = { updated_at: new Date().toISOString() };
    if (fileUrl) cacheUpdate.pdf_url = fileUrl;
    if (auditUrl) cacheUpdate.audit_trail_url = auditUrl;
    await supabase.from('contracts').update(cacheUpdate).eq('id', contract_id);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        data: {
          contract_id,
          title: contract.title,
          pdf_url: fileUrl || null,
          audit_trail_url: auditUrl || null,
          note: 'URL은 약 3분간 유효합니다.'
        }
      })
    };

  } catch (error) {
    console.error('[contracts-file] 서버 오류:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message }) };
  }
};
