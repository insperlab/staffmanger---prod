const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { signToken, handleCors, errorResponse } = require('./lib/auth');

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase 환경 변수 없음');
  return createClient(supabaseUrl, supabaseKey);
}

exports.handler = async (event) => {
  const cors = handleCors(event);
  if (cors.statusCode) return cors;
  const headers = cors.headers;
  if (event.httpMethod !== 'POST') return errorResponse('POST only', 405, headers);
  try {
    let body;
    try { body = JSON.parse(event.body); } catch (e) { return errorResponse('잘못된 요청 데이터입니다', 400, headers); }
    const { email, password, name, phone, companyName, businessNumber, ceoName } = body;
    if (!email || !password || !name || !phone || !companyName || !businessNumber || !ceoName)
      return errorResponse('모든 필수 항목을 입력해주세요.', 400, headers);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return errorResponse('올바른 이메일 형식이 아닙니다.', 400, headers);
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
      return errorResponse('비밀번호는 8자 이상, 영문과 숫자를 포함해야 합니다.', 400, headers);
    if (!/^\d{3}-\d{2}-\d{5}$/.test(businessNumber))
      return errorResponse('올바른 사업자등록번호 형식이 아닙니다.', 400, headers);
    let supabase;
    try { supabase = getSupabaseClient(); } catch (e) { return errorResponse('DB 연결 실패', 500, headers); }
    const { data: existingUser } = await supabase.from('users').select('id').eq('email', email).is('deleted_at', null).maybeSingle();
    if (existingUser) return errorResponse('이미 사용 중인 이메일입니다.', 409, headers);
    const { data: existingCo } = await supabase.from('companies').select('id').eq('business_number', businessNumber).is('deleted_at', null).maybeSingle();
    if (existingCo) return errorResponse('이미 등록된 사업자등록번호입니다.', 409, headers);
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const { data: newCompany, error: companyError } = await supabase
      .from('companies')
      .insert({ name: companyName, business_number: businessNumber, ceo_name: ceoName, subscription_plan: 'free', subscription_status: 'active', created_at: now, updated_at: now })
      .select('id, name, subscription_plan, subscription_status')
      .single();
    if (companyError || !newCompany)
      return errorResponse('회사 등록 실패: ' + (companyError ? companyError.message : '오류'), 500, headers);
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({ email: email, password_hash: passwordHash, name: name, phone: phone, role: 'owner', status: 'active', company_id: newCompany.id, login_count: 0, created_at: now, updated_at: now })
      .select('id, email, name, role, company_id')
      .single();
    if (userError || !newUser) {
      await supabase.from('companies').delete().eq('id', newCompany.id);
      return errorResponse('사용자 등록 실패: ' + (userError ? userError.message : '오류'), 500, headers);
    }
    const token = signToken({ userId: newUser.id, email: newUser.email, role: newUser.role, companyId: newCompany.id });
    return {
      statusCode: 201,
      headers: headers,
      body: JSON.stringify({
        success: true,
        data: {
          user: { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role, companyId: newCompany.id, companyName: newCompany.name },
          company: { id: newCompany.id, name: newCompany.name, plan: newCompany.subscription_plan, status: newCompany.subscription_status },
          token: token,
          message: '회원가입이 완료되었습니다.'
        }
      })
    };
  } catch (error) {
    return errorResponse('서버 오류: ' + error.message, 500, headers);
  }
};