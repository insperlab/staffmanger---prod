// =====================================================
// 계약서 상세 조회 + UCanSign 실시간 상태 동기화
// GET /.netlify/functions/contracts-detail?contract_id=xxx
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

// UCanSign 상태 → StaffManager 상태 매핑
function mapUcansignStatus(ucStatus, participants) {
  if (!ucStatus) return 'unknown';
  const s = ucStatus.toLowerCase();
  if (s === 'completed' || s === 'signing_completed_all') return 'completed';
  if (s === 'canceled' || s === 'cancelled' || s.includes('cancel')) return 'cancelled';
  if (s === 'expired') return 'expired';
  if (s === 'rejected' || s === 'declined') return 'rejected';
  // 참여자 상태 확인
  if (participants && participants.length > 0) {
    const allCompleted = participants.every(p => 
      p.status === 'completed' || p.status === 'signing_completed'
    );
    if (allCompleted) return 'completed';
    const hasViewed = participants.some(p => p.status === 'viewed' || p.status === 'opened');
    if (hasViewed) return 'viewed';
  }
  return 'sent';
}

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
    const { contract_id } = params;

    if (!contract_id) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'contract_id는 필수입니다.' }) };
    }

    // Supabase에서 계약 조회
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('*, employees(position, department, users:user_id(name, email, phone))')
      .eq('id', contract_id)
      .eq('company_id', userInfo.companyId)
      .single();

    if (error || !contract) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다.' }) };
    }

    // Flatten employees → users
    if (contract.employees) {
      const u = Array.isArray(contract.employees.users) ? contract.employees.users[0] : contract.employees.users;
      contract.employee_info = {
        name: u?.name, email: u?.email, phone: u?.phone,
        position: contract.employees.position, department: contract.employees.department
      };
      delete contract.employees;
    }

    // UCanSign에서 최신 상태 동기화
    // 엔드포인트: GET /openapi/documents/:documentId
    let ucansignDetail = null;
    if (contract.ucansign_document_id) {
      try {
        const ucResult = await ucansignRequest('GET', `/documents/${contract.ucansign_document_id}`);
        if (ucResult && ucResult.result) {
          ucansignDetail = ucResult.result;
          const newStatus = mapUcansignStatus(ucResult.result.status, ucResult.result.participants);

          // DB 상태 업데이트 (변경된 경우만)
          if (newStatus !== contract.status) {
            console.log(`[contracts-detail] 상태 변경: ${contract.status} → ${newStatus}`);
            const updateData = {
              status: newStatus,
              ucansign_status: ucResult.result.status,
              updated_at: new Date().toISOString()
            };
            if (newStatus === 'completed') {
              updateData.completed_at = new Date().toISOString();
            }

            await supabase.from('contracts').update(updateData).eq('id', contract_id);
            contract.status = newStatus;
          }
        }
      } catch (ucErr) {
        console.warn('[contracts-detail] UCanSign 상태 동기화 실패 (DB 데이터 반환):', ucErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        data: contract,
        ucansign: ucansignDetail
      })
    };

  } catch (error) {
    console.error('[contracts-detail] 서버 오류:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message }) };
  }
};
