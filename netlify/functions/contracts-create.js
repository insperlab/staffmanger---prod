// =====================================================
// 계약서 생성/발송/상태변경 API
// POST /.netlify/functions/contracts-create
// Phase 6 - 전자계약 (UCanSign)
// Phase 9-A - 플랜 사용량 제한 연동
// =====================================================

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const { ucansignRequest, UCANSIGN_BASE_URL } = require('./ucansign-auth');
// Phase 9-A: 요금제 한도 체크 미들웨어 (놀이공원 입장권 확인기)
const { checkPlanLimit, incrementUsage, FEATURES } = require('./lib/plan-check');

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
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let userInfo;
    try {
      userInfo = verifyToken(authHeader);
    } catch (err) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: '인증 실패: ' + err.message })
      });
    }

    const supabase = getSupabaseClient();
    const body = JSON.parse(event.body || '{}');

    if (event.httpMethod === 'DELETE') {
      const { id } = body;
      if (!id) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '계약서 ID가 필요합니다' }) };
      }

      const { data: existing } = await supabase.from('contracts').select('status').eq('id', id).eq('company_id', userInfo.companyId).single();

      if (!existing) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다' }) };
      }

      if (existing.status !== 'draft') {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '작성중인 계약서만 삭제 가능합니다' }) };
      }

      const { error } = await supabase.from('contracts').delete().eq('id', id).eq('company_id', userInfo.companyId);
      if (error) throw error;

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: { message: '계약서가 삭제되었습니다' } }) };
    }

    if (event.httpMethod === 'PUT') {
      const { id, action } = body;
      if (!id || !action) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'id와 action이 필요합니다' }) };
      }

      if (action === 'send') return await sendContract(supabase, id, userInfo.companyId);
      if (action === 'resend') return await resendContract(supabase, id, userInfo.companyId);

      if (action === 'cancel') {
        const { error } = await supabase.from('contracts').update({ status: 'rejected', updated_at: new Date().toISOString() }).eq('id', id).eq('company_id', userInfo.companyId).in('status', ['draft', 'sent', 'viewed']);
        if (error) throw error;
        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: { message: '계약이 취소되었습니다' } }) };
      }

      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '알 수 없는 action: ' + action }) };
    }

    // POST: 새 계약서 생성
    const { employee_id, contract_type = '근로계약서', title, template_id, signer_name, signer_email, signer_phone, contract_data = {}, auto_send = false } = body;

    if (!employee_id) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '직원을 선택해주세요' }) };
    }

    const { data: empData } = await supabase.from('employees').select(`
      id, position, department, base_salary, salary_type,
      monthly_wage, annual_salary,
      work_start_time, work_end_time, break_time_minutes,
      weekly_holiday, work_location, hire_date,
      contract_start_date, contract_end_date, probation_months,
      address, birth_date,
      users:user_id(name, email, phone)
    `).eq('id', employee_id).eq('company_id', userInfo.companyId).single();

    if (!empData) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '직원 정보를 찾을 수 없습니다' }) };
    }

    const empUser = Array.isArray(empData.users) ? empData.users[0] : empData.users;
    const employee = { id: empData.id, name: empUser?.name || '이름없음', email: empUser?.email || '', phone: empUser?.phone || '', position: empData.position, department: empData.department };

    const typeConfig = CONTRACT_TYPES[contract_type] || CONTRACT_TYPES['기타'];
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + typeConfig.expireDays);

    const contractRecord = {
      company_id: userInfo.companyId, employee_id, contract_type,
      title: title || `${employee.name} ${typeConfig.label}`,
      ucansign_template_id: template_id || null,
      signer_name: signer_name || employee.name,
      signer_email: signer_email || employee.email,
      signer_phone: signer_phone || employee.phone,
      status: 'draft', contract_data, expires_at: expiresAt.toISOString()
    };

    const { data: newContract, error: insertError } = await supabase.from('contracts').insert(contractRecord).select().single();
    if (insertError) { console.error('[contracts-create] DB 저장 오류:', insertError); throw insertError; }

    console.log('[contracts-create] 계약서 생성 완료:', newContract.id);

    if (auto_send) return await sendContract(supabase, newContract.id, userInfo.companyId);

    return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: newContract }) };

  } catch (error) {
    console.error('[contracts-create] 서버 오류:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message }) };
  }
};

async function sendContract(supabase, contractId, companyId) {
  const { data: contract, error: fetchErr } = await supabase.from('contracts').select(`
    *,
    employees(
      position, department, base_salary, salary_type,
      monthly_wage, annual_salary,
      work_start_time, work_end_time, break_time_minutes,
      weekly_holiday, work_location, hire_date,
      contract_start_date, contract_end_date, probation_months,
      address, birth_date,
      users:user_id(name, email, phone)
    )
  `).eq('id', contractId).eq('company_id', companyId).single();

  if (fetchErr || !contract) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '계약서를 찾을 수 없습니다' }) };
  }

  if (contract.status !== 'draft') {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '작성중인 계약서만 발송 가능합니다' }) };
  }

  // ── Phase 9-A: 플랜 한도 확인 ─────────────────────────────────
  // Free 1건 / Pro 15건 / Business 무제한 (스탬프 카드 확인)
  const planCheck = await checkPlanLimit(supabase, companyId, FEATURES.E_CONTRACT);
  if (!planCheck.allowed) {
    console.log(`[contracts-create] 플랜 한도 초과: ${planCheck.plan} (${planCheck.used}/${planCheck.limit})`);
    return { statusCode: 402, headers: CORS_HEADERS, body: JSON.stringify({ success: false, ...planCheck }) };
  }
  // ──────────────────────────────────────────────────────────────

  const { data: company } = await supabase.from('companies').select('company_name, representative_name, business_number, address, pay_day, business_phone').eq('id', companyId).single();

  try {
    const templateId = contract.ucansign_template_id;
    if (!templateId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '템플릿 ID가 없습니다. 템플릿을 먼저 지정해주세요.' }) };
    }

    function normalizePhone(raw) {
      if (!raw) return null;
      let phone = raw.replace(/[^0-9]/g, '');
      if (phone.startsWith('82') && phone.length >= 11) phone = '0' + phone.slice(2);
      return /^01[0-9]{8,9}$/.test(phone) ? phone : null;
    }

    const rawPhone = contract.signer_phone || contract.employees?.users?.phone;
    const signerEmail = contract.signer_email || contract.employees?.users?.email;
    const signerPhone = normalizePhone(rawPhone);
    let empMethod = signerPhone ? 'kakao' : 'email';
    let empContact = signerPhone || signerEmail;

    if (!empContact) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '서명자 연락처(전화번호 또는 이메일)가 필요합니다.' }) };
    }

    const { data: ownerData } = await supabase.from('users').select('name, email, phone').eq('company_id', companyId).eq('role', 'owner').single();

    let ownerMethod, ownerContact, ownerName;
    if (ownerData) {
      ownerName = ownerData.name || '대표자';
      const ownerPhone = normalizePhone(ownerData.phone);
      ownerMethod = ownerPhone ? 'kakao' : 'email';
      ownerContact = ownerPhone || ownerData.email;
    } else {
      const { data: companyData } = await supabase.from('companies').select('created_by').eq('id', companyId).single();
      if (companyData?.created_by) {
        const { data: creatorData } = await supabase.from('users').select('name, email, phone').eq('id', companyData.created_by).single();
        if (creatorData) {
          ownerName = creatorData.name || '대표자';
          const ownerPhone = normalizePhone(creatorData.phone);
          ownerMethod = ownerPhone ? 'kakao' : 'email';
          ownerContact = ownerPhone || creatorData.email;
        }
      }
    }

    if (!ownerContact) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '사업주(대표자) 연락처를 찾을 수 없습니다. 설정에서 대표자 정보를 확인해주세요.' }) };
    }

    const signRequestBody = {
      documentName: contract.title, processType: 'PROCEDURE', isSequential: true, isSendMessage: true,
      participants: [
        { name: contract.signer_name, signingMethodType: empMethod, signingContactInfo: empContact, signingOrder: 1 },
        { name: ownerName, signingMethodType: ownerMethod, signingContactInfo: ownerContact, signingOrder: 2 }
      ],
      callbackUrl: 'https://staffmanager.io/.netlify/functions/contracts-webhook',
      customValue: String(companyId), customValue1: String(contract.employee_id || ''), customValue2: contract.contract_type || 'employment'
    };

    const emp = contract.employees || {};
    const empUser = Array.isArray(emp.users) ? emp.users[0] : emp.users;

    function formatWage(e) {
      const fmt = (n) => n ? Number(n).toLocaleString('ko-KR') : '';
      switch (e.salary_type) {
        case 'hourly': return `시급 ${fmt(e.base_salary)}원`;
        case 'monthly': return `월 ${fmt(e.monthly_wage || e.base_salary)}원`;
        case 'annual': return `연봉 ${fmt(e.annual_salary || e.base_salary)}원`;
        default: return `${fmt(e.base_salary)}원`;
      }
    }

    function formatPeriod(e) {
      if (!e.contract_start_date) return '';
      if (!e.contract_end_date) return `${e.contract_start_date} ~ 무기한`;
      return `${e.contract_start_date} ~ ${e.contract_end_date}`;
    }

    const autoFields = {};
    if (company) {
      if (company.company_name) autoFields.company_name = company.company_name;
      if (company.representative_name) autoFields.representative = company.representative_name;
      if (company.business_number) autoFields.business_number = company.business_number;
      if (company.address) autoFields.company_address = company.address;
      if (company.pay_day) autoFields.pay_day = `매월 ${company.pay_day}일`;
      if (company.business_phone) autoFields.company_phone = company.business_phone;
    }
    if (empUser?.name) autoFields.employee_name = empUser.name;
    if (empUser?.phone) autoFields.employee_phone = empUser.phone;
    if (emp.address) autoFields.employee_address = emp.address;
    if (emp.hire_date) autoFields.hire_date = emp.hire_date;
    if (emp.position) autoFields.position = emp.position;
    if (emp.department) autoFields.department = emp.department;
    if (emp.salary_type) autoFields.wage_type = emp.salary_type === 'hourly' ? '시급' : emp.salary_type === 'monthly' ? '월급' : '연봉';
    autoFields.wage_amount = formatWage(emp);
    if (emp.work_start_time && emp.work_end_time) autoFields.work_hours = `${emp.work_start_time} ~ ${emp.work_end_time}`;
    if (emp.break_time_minutes) autoFields.break_time = `${emp.break_time_minutes}분`;
    if (emp.weekly_holiday) autoFields.weekly_holiday = emp.weekly_holiday;
    if (emp.contract_start_date) autoFields.contract_start = emp.contract_start_date;
    if (emp.contract_end_date) autoFields.contract_end = emp.contract_end_date;
    autoFields.contract_period = formatPeriod(emp);

    const mergedFields = { ...autoFields, ...(contract.contract_data || {}) };
    signRequestBody.fields = Object.entries(mergedFields).filter(([_, v]) => v !== null && v !== undefined && v !== '').map(([key, value]) => ({ fieldName: key, value: String(value) }));

    console.log('[contracts-create] 자동매핑 필드:', signRequestBody.fields.length, '개');
    console.log('[contracts-create] UCanSign 요청:', templateId);

    const ucansignResult = await ucansignRequest('POST', `/templates/${templateId}`, signRequestBody);
    console.log('[contracts-create] UCanSign 응답:', JSON.stringify(ucansignResult));

    const ucDoc = ucansignResult.result || {};
    const updateData = {
      status: 'sent', sent_at: new Date().toISOString(),
      ucansign_document_id: String(ucDoc.documentId || ucDoc.id || ''),
      ucansign_request_id: String(ucDoc.documentId || ucDoc.requestId || ucDoc.id || ''),
      ucansign_status: ucDoc.status || 'sent'
    };

    const { data: updated, error: updateErr } = await supabase.from('contracts').update(updateData).eq('id', contractId).select().single();
    if (updateErr) throw updateErr;

    // ── Phase 9-A: 발송 성공 → 사용량 +1 ─────────────────────────
    // 성공 후에만 카운트 (실패 시 카운트 안 함)
    await incrementUsage(supabase, companyId, FEATURES.E_CONTRACT);
    console.log(`[contracts-create] 사용량 +1: ${planCheck.plan} (${planCheck.used + 1}/${planCheck.limit === -1 ? '무제한' : planCheck.limit})`);
    // ──────────────────────────────────────────────────────────────

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: updated, message: '계약서가 발송되었습니다' }) };

  } catch (ucansignError) {
    console.error('[contracts-create] UCanSign 발송 실패:', ucansignError);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'UCanSign 발송 실패: ' + ucansignError.message }) };
  }
}

async function resendContract(supabase, contractId, companyId) {
  await supabase.from('contracts').update({ status: 'draft' }).eq('id', contractId).eq('company_id', companyId).in('status', ['sent', 'viewed']);
  return await sendContract(supabase, contractId, companyId);
}