// =====================================================
// 계약서 생성/발송/상태변경 API
// POST /.netlify/functions/contracts-create
// Phase 6 - 전자계약 (UCanSign)
// =====================================================

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const { ucansignRequest, UCANSIGN_BASE_URL } = require('./ucansign-auth');

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
  'Access-Control-Allow-Methods': 'POST, PUT, DELETE, OPTIONS'
};

// 계약서 유형별 기본 설정
const CONTRACT_TYPES = {
  '근로계약서': { label: '근로계약서', expireDays: 7 },
  '연봉계약서': { label: '연봉계약서', expireDays: 7 },
  '비밀유지계약서': { label: '비밀유지계약서(NDA)', expireDays: 14 },
  '겸업금지계약서': { label: '겸업금지계약서', expireDays: 14 },
  '퇴직합의서': { label: '퇴직합의서', expireDays: 3 },
  '기타': { label: '기타 계약서', expireDays: 14 }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!['POST', 'PUT', 'DELETE'].includes(event.httpMethod)) {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'POST/PUT/DELETE만 허용' })
    };
  }

  try {
    // 인증 확인
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try {
      userInfo = verifyToken(authHeader);
    } catch (err) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '인증 실패: ' + err.message })
      };
    }

    const supabase = getSupabaseClient();
    const body = JSON.parse(event.body || '{}');

    // ============================
    // DELETE: 계약서 삭제 (draft만)
    // ============================
    if (event.httpMethod === 'DELETE') {
      const { id } = body;
      if (!id) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: '계약서 ID가 필요합니다' })
        };
      }

      const { data: existing } = await supabase
        .from('contracts')
        .select('status')
        .eq('id', id)
        .eq('company_id', userInfo.companyId)
        .single();

      if (!existing) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다' })
        };
      }

      if (existing.status !== 'draft') {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: '작성중인 계약서만 삭제 가능합니다' })
        };
      }

      const { error } = await supabase
        .from('contracts')
        .delete()
        .eq('id', id)
        .eq('company_id', userInfo.companyId);

      if (error) throw error;

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, data: { message: '계약서가 삭제되었습니다' } })
      };
    }

    // ============================
    // PUT: 계약서 상태 변경 / 재발송
    // ============================
    if (event.httpMethod === 'PUT') {
      const { id, action } = body;
      if (!id || !action) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'id와 action이 필요합니다' })
        };
      }

      // 계약서 발송 (draft → sent)
      if (action === 'send') {
        return await sendContract(supabase, id, userInfo.companyId);
      }

      // 재발송
      if (action === 'resend') {
        return await resendContract(supabase, id, userInfo.companyId);
      }

      // 취소
      if (action === 'cancel') {
        const { error } = await supabase
          .from('contracts')
          .update({ status: 'rejected', updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('company_id', userInfo.companyId)
          .in('status', ['draft', 'sent', 'viewed']);

        if (error) throw error;

        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: true, data: { message: '계약이 취소되었습니다' } })
        };
      }

      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '알 수 없는 action: ' + action })
      };
    }

    // ============================
    // POST: 새 계약서 생성
    // ============================
    const {
      employee_id,
      contract_type = '근로계약서',
      title,
      template_id,
      signer_name,
      signer_email,
      signer_phone,
      contract_data = {},
      auto_send = false
    } = body;

    // 필수값 검증
    if (!employee_id) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '직원을 선택해주세요' })
      };
    }

    // 직원 정보 조회 (users 테이블 JOIN)
    const { data: empData } = await supabase
      .from('employees')
      .select('id, position, department, users:user_id(name, email, phone)')
      .eq('id', employee_id)
      .eq('company_id', userInfo.companyId)
      .single();

    if (!empData) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '직원 정보를 찾을 수 없습니다' })
      };
    }

    const empUser = Array.isArray(empData.users) ? empData.users[0] : empData.users;
    const employee = {
      id: empData.id,
      name: empUser?.name || '이름없음',
      email: empUser?.email || '',
      phone: empUser?.phone || '',
      position: empData.position,
      department: empData.department
    };

    const typeConfig = CONTRACT_TYPES[contract_type] || CONTRACT_TYPES['기타'];
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + typeConfig.expireDays);

    // DB에 계약서 저장
    const contractRecord = {
      company_id: userInfo.companyId,
      employee_id,
      contract_type,
      title: title || `${employee.name} ${typeConfig.label}`,
      ucansign_template_id: template_id || null,
      signer_name: signer_name || employee.name,
      signer_email: signer_email || employee.email,
      signer_phone: signer_phone || employee.phone,
      status: 'draft',
      contract_data,
      expires_at: expiresAt.toISOString()
    };

    const { data: newContract, error: insertError } = await supabase
      .from('contracts')
      .insert(contractRecord)
      .select()
      .single();

    if (insertError) {
      console.error('[contracts-create] DB 저장 오류:', insertError);
      throw insertError;
    }

    console.log('[contracts-create] 계약서 생성 완료:', newContract.id);

    // 자동 발송 옵션
    if (auto_send) {
      const sendResult = await sendContract(supabase, newContract.id, userInfo.companyId);
      return sendResult;
    }

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, data: newContract })
    };

  } catch (error) {
    console.error('[contracts-create] 서버 오류:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message })
    };
  }
};

// ============================
// UCanSign으로 계약서 발송
// ============================
async function sendContract(supabase, contractId, companyId) {
  // 계약서 조회
  const { data: contract, error: fetchErr } = await supabase
    .from('contracts')
    .select('*, employees(position, department, users:user_id(name, email, phone))')
    .eq('id', contractId)
    .eq('company_id', companyId)
    .single();

  if (fetchErr || !contract) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다' })
    };
  }

  if (contract.status !== 'draft') {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: '작성중인 계약서만 발송 가능합니다' })
    };
  }

  try {
    // UCanSign API - 템플릿 기반 서명문서 생성
    // 엔드포인트: POST /openapi/templates/:documentId
    const templateId = contract.ucansign_template_id;
    if (!templateId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '템플릿 ID가 없습니다. 템플릿을 먼저 지정해주세요.' })
      };
    }

    // 서명자 연락처 결정 (카카오톡 우선, 없으면 이메일)
    const rawPhone = contract.signer_phone || contract.employees?.users?.phone;
    const signerEmail = contract.signer_email || contract.employees?.users?.email;
    
    // 전화번호 정규화: 하이픈, 공백, 괄호 등 제거 → 숫자만
    let signerPhone = rawPhone ? rawPhone.replace(/[^0-9]/g, '') : null;
    
    // +82 국제번호 → 0으로 변환 (821012345678 → 01012345678)
    if (signerPhone && signerPhone.startsWith('82') && signerPhone.length >= 11) {
      signerPhone = '0' + signerPhone.slice(2);
    }
    
    const signingMethod = signerPhone ? 'kakao' : 'email';
    const signingContact = signerPhone || signerEmail;

    console.log('[contracts-create] 서명방식:', signingMethod, '연락처:', signingContact);

    if (!signingContact) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '서명자 연락처(전화번호 또는 이메일)가 필요합니다.' })
      };
    }

    // 카카오 서명인데 전화번호가 유효하지 않으면 이메일로 fallback
    let finalMethod = signingMethod;
    let finalContact = signingContact;
    if (finalMethod === 'kakao' && signerPhone) {
      // 한국 휴대폰 번호 형식 체크 (010으로 시작, 10~11자리)
      if (!/^01[0-9]{8,9}$/.test(signerPhone)) {
        console.warn('[contracts-create] 전화번호 형식 이상:', signerPhone, '→ 이메일로 전환');
        if (signerEmail) {
          finalMethod = 'email';
          finalContact = signerEmail;
        }
      }
    }

    const signRequestBody = {
      documentName: contract.title,
      processType: 'PROCEDURE',
      isSequential: true,
      isSendMessage: true,
      participants: [
        {
          name: contract.signer_name,
          signingMethodType: finalMethod,
          signingContactInfo: finalContact,
          signingOrder: 1
        }
      ],
      callbackUrl: 'https://staffmanager.io/.netlify/functions/contracts-webhook',
      customValue: String(companyId),
      customValue1: String(contract.employee_id || ''),
      customValue2: contract.contract_type || 'employment'
    };

    // 템플릿 변수 매핑
    if (contract.contract_data && Object.keys(contract.contract_data).length > 0) {
      signRequestBody.fields = Object.entries(contract.contract_data).map(([key, value]) => ({
        fieldName: key,
        value: String(value)
      }));
    }

    console.log('[contracts-create] UCanSign 템플릿 서명문서 생성:', templateId);
    console.log('[contracts-create] 요청 body:', JSON.stringify(signRequestBody));

    // ✅ 수정: /sign-request/create → /templates/:documentId
    const ucansignResult = await ucansignRequest('POST', `/templates/${templateId}`, signRequestBody);

    console.log('[contracts-create] UCanSign 응답:', JSON.stringify(ucansignResult));

    // DB 업데이트 - UCanSign 응답 필드 매핑
    const ucDoc = ucansignResult.result || {};
    const updateData = {
      status: 'sent',
      sent_at: new Date().toISOString(),
      ucansign_document_id: String(ucDoc.documentId || ucDoc.id || ''),
      ucansign_request_id: String(ucDoc.documentId || ucDoc.requestId || ucDoc.id || ''),
      ucansign_status: ucDoc.status || 'sent'
    };

    const { data: updated, error: updateErr } = await supabase
      .from('contracts')
      .update(updateData)
      .eq('id', contractId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        data: updated,
        message: '계약서가 발송되었습니다'
      })
    };

  } catch (ucansignError) {
    console.error('[contracts-create] UCanSign 발송 실패:', ucansignError);

    // UCanSign 실패해도 DB 상태는 유지 (재발송 가능)
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: 'UCanSign 발송 실패: ' + ucansignError.message
      })
    };
  }
}

// ============================
// 계약서 재발송
// ============================
async function resendContract(supabase, contractId, companyId) {
  // 상태를 draft로 되돌린 후 재발송
  await supabase
    .from('contracts')
    .update({ status: 'draft' })
    .eq('id', contractId)
    .eq('company_id', companyId)
    .in('status', ['sent', 'viewed']);

  return await sendContract(supabase, contractId, companyId);
}
