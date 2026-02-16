// =====================================================
// 계약서 템플릿 관리 API
// GET  /.netlify/functions/contracts-templates  (목록 조회)
// POST /.netlify/functions/contracts-templates  (매핑 저장)
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
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

    // ========================
    // GET: 템플릿 목록 조회
    // ========================
    if (event.httpMethod === 'GET') {
      // 1) UCanSign에서 템플릿 목록 가져오기
      // 엔드포인트: GET /openapi/templates
      let ucTemplates = [];
      try {
        const ucResult = await ucansignRequest('GET', '/templates');
        if (ucResult && ucResult.result) {
          ucTemplates = Array.isArray(ucResult.result) ? ucResult.result : [ucResult.result];
        }
      } catch (err) {
        console.warn('[contracts-templates] UCanSign 템플릿 조회 실패:', err.message);
      }

      // 2) Supabase에서 사업장별 저장된 템플릿 매핑 가져오기
      const { data: dbTemplates } = await supabase
        .from('contract_templates')
        .select('*')
        .eq('business_id', userInfo.companyId)
        .order('updated_at', { ascending: false });

      // 3) UCanSign 템플릿과 DB 매핑 병합
      const mergedTemplates = ucTemplates.map(uc => {
        const saved = (dbTemplates || []).find(
          db => String(db.ucansign_template_id) === String(uc.documentId || uc.id)
        );
        return {
          ucansign_id: uc.documentId || uc.id,
          name: saved?.template_name || uc.documentName || uc.name,
          contract_type: saved?.contract_type || null,
          field_mapping: saved?.field_mapping || null,
          is_mapped: !!saved,
          ucansign_data: {
            status: uc.status,
            createdAt: uc.createdAt,
            fields: uc.fields || []
          }
        };
      });

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: true,
          data: {
            templates: mergedTemplates,
            ucansign_count: ucTemplates.length,
            mapped_count: mergedTemplates.filter(t => t.is_mapped).length
          }
        })
      };
    }

    // ========================
    // POST: 템플릿 매핑 저장
    // ========================
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { ucansign_template_id, template_name, contract_type, field_mapping } = body;

      if (!ucansign_template_id || !template_name || !contract_type) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: '템플릿ID, 이름, 계약유형은 필수입니다.' })
        };
      }

      // 유효한 계약유형 검증
      const validTypes = ['employment', 'parttime', 'nda', 'freelance', 'custom'];
      if (!validTypes.includes(contract_type)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            success: false,
            error: `유효한 계약유형: ${validTypes.join(', ')}`
          })
        };
      }

      // upsert (business_id + ucansign_template_id 기준)
      const { data, error } = await supabase
        .from('contract_templates')
        .upsert({
          business_id: userInfo.companyId,
          ucansign_template_id: String(ucansign_template_id),
          template_name,
          contract_type,
          field_mapping: field_mapping ? JSON.stringify(field_mapping) : null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'business_id,ucansign_template_id' })
        .select()
        .single();

      if (error) {
        console.error('[contracts-templates] 저장 실패:', error);
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: '템플릿 저장 실패: ' + error.message })
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: true,
          data,
          message: '템플릿 매핑이 저장되었습니다.'
        })
      };
    }

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'GET 또는 POST만 허용' }) };

  } catch (error) {
    console.error('[contracts-templates] 서버 오류:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '서버 오류: ' + error.message }) };
  }
};
