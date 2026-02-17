// =====================================================
// 사업장 정보 조회/수정 API
// GET  /.netlify/functions/company-settings  → 사업장 정보 조회
// PUT  /.netlify/functions/company-settings  → 사업장 정보 수정
// =====================================================

const { verifyToken, handleCors, successResponse, errorResponse } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

exports.handler = async (event) => {
  // CORS
  const cors = handleCors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors.headers, body: '' };

  if (!['GET', 'PUT'].includes(event.httpMethod)) {
    return errorResponse('GET/PUT 메서드만 허용됩니다', 405, cors.headers);
  }

  try {
    // 인증
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const tokenData = verifyToken(authHeader);
    const companyId = tokenData.companyId;

    const supabase = getSupabaseClient();

    // ============================
    // GET: 사업장 정보 조회
    // ============================
    if (event.httpMethod === 'GET') {
      const { data: company, error } = await supabase
        .from('companies')
        .select(`
          id, company_name, representative_name, business_number,
          address, business_phone, business_type, business_category,
          pay_day, subscription_plan, subscription_status, subscribed_at,
          created_at
        `)
        .eq('id', companyId)
        .single();

      if (error) {
        console.error('Company settings fetch error:', error);
        return errorResponse('사업장 정보를 불러올 수 없습니다', 500, cors.headers);
      }

      return {
        statusCode: 200,
        headers: cors.headers,
        body: JSON.stringify({
          success: true,
          data: {
            company: {
              id: company.id,
              companyName: company.company_name,
              representativeName: company.representative_name,
              businessNumber: company.business_number,
              address: company.address,
              businessPhone: company.business_phone,
              businessType: company.business_type,
              businessCategory: company.business_category,
              payDay: company.pay_day,
              subscriptionPlan: company.subscription_plan,
              subscriptionStatus: company.subscription_status,
              subscribedAt: company.subscribed_at,
              createdAt: company.created_at
            }
          }
        })
      };
    }

    // ============================
    // PUT: 사업장 정보 수정
    // ============================
    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body);
      const {
        companyName,
        representativeName,
        businessNumber,
        address,
        businessPhone,
        businessType,
        businessCategory,
        payDay
      } = body;

      // 사업자등록번호 형식 검증 (입력된 경우)
      if (businessNumber) {
        const cleaned = businessNumber.replace(/[^0-9]/g, '');
        if (cleaned.length !== 10) {
          return errorResponse('사업자등록번호는 10자리 숫자입니다', 400, cors.headers);
        }
      }

      // 급여일 범위 검증
      if (payDay !== undefined && (payDay < 1 || payDay > 31)) {
        return errorResponse('급여일은 1~31 사이 값이어야 합니다', 400, cors.headers);
      }

      // 업데이트 데이터 구성 (값이 있는 것만)
      const updateData = {};
      if (companyName !== undefined) updateData.company_name = companyName;
      if (representativeName !== undefined) updateData.representative_name = representativeName;
      if (businessNumber !== undefined) updateData.business_number = businessNumber.replace(/[^0-9]/g, '');
      if (address !== undefined) updateData.address = address;
      if (businessPhone !== undefined) updateData.business_phone = businessPhone;
      if (businessType !== undefined) updateData.business_type = businessType;
      if (businessCategory !== undefined) updateData.business_category = businessCategory;
      if (payDay !== undefined) updateData.pay_day = payDay;

      if (Object.keys(updateData).length === 0) {
        return errorResponse('수정할 항목이 없습니다', 400, cors.headers);
      }

      const { data: updated, error } = await supabase
        .from('companies')
        .update(updateData)
        .eq('id', companyId)
        .select()
        .single();

      if (error) {
        console.error('Company settings update error:', error);
        return errorResponse('사업장 정보 수정 실패: ' + error.message, 500, cors.headers);
      }

      return {
        statusCode: 200,
        headers: cors.headers,
        body: JSON.stringify({
          success: true,
          data: {
            company: {
              id: updated.id,
              companyName: updated.company_name,
              representativeName: updated.representative_name,
              businessNumber: updated.business_number,
              address: updated.address,
              businessPhone: updated.business_phone,
              businessType: updated.business_type,
              businessCategory: updated.business_category,
              payDay: updated.pay_day
            },
            message: '사업장 정보가 수정되었습니다.'
          }
        })
      };
    }

  } catch (error) {
    console.error('Company settings error:', error);
    return errorResponse(error.message || '서버 오류가 발생했습니다', 500, cors.headers);
  }
};
