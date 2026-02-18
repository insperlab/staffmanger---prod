const { verifyToken, getCorsHeaders } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

function ok(data, code = 200) {
  return { statusCode: code, headers, body: JSON.stringify({ success: true, data }) };
}
function fail(msg, code = 400) {
  return { statusCode: code, headers, body: JSON.stringify({ success: false, error: msg }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const token = verifyToken(event.headers.authorization || event.headers.Authorization);
    if (!token.companyId) return fail('회사 정보가 없습니다.', 401);

    const supabase = getSupabase();
    const method = event.httpMethod;
    const id = event.queryStringParameters?.id;

    if (method === 'GET') {
      let query = supabase.from('businesses').select('*')
        .eq('company_id', token.companyId).is('deleted_at', null)
        .order('is_headquarters', { ascending: false }).order('name', { ascending: true });

      const status = event.queryStringParameters?.status;
      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) { console.error('businesses list error:', error); return fail('사업장 목록 조회 실패', 500); }

      const businessIds = (data || []).map(b => b.id);
      let employeeCounts = {};
      if (businessIds.length > 0) {
        const { data: empData } = await supabase.from('employees').select('business_id')
          .eq('company_id', token.companyId).is('deleted_at', null).eq('status', 'active').in('business_id', businessIds);
        (empData || []).forEach(emp => { employeeCounts[emp.business_id] = (employeeCounts[emp.business_id] || 0) + 1; });
      }

      const { data: unassigned } = await supabase.from('employees').select('id')
        .eq('company_id', token.companyId).is('deleted_at', null).eq('status', 'active').is('business_id', null);

      const result = (data || []).map(b => ({ ...b, employee_count: employeeCounts[b.id] || 0 }));
      return ok({ businesses: result, unassigned_employees: (unassigned || []).length, total: result.length });
    }

    if (method === 'POST') {
      if (!['owner', 'admin'].includes(token.role)) return fail('사업장 등록 권한이 없습니다.', 403);
      const body = JSON.parse(event.body || '{}');
      if (!body.name || !body.name.trim()) return fail('사업장명은 필수입니다.');

      const { data: existing } = await supabase.from('businesses').select('id')
        .eq('company_id', token.companyId).eq('name', body.name.trim()).is('deleted_at', null);
      if (existing && existing.length > 0) return fail('이미 동일한 이름의 사업장이 있습니다.');

      const insertData = {
        company_id: token.companyId, name: body.name.trim(),
        business_number: body.business_number || null, address: body.address || null,
        phone: body.phone || null, manager_name: body.manager_name || null,
        is_headquarters: body.is_headquarters || false, status: 'active'
      };

      if (insertData.is_headquarters) {
        await supabase.from('businesses').update({ is_headquarters: false })
          .eq('company_id', token.companyId).eq('is_headquarters', true);
      }

      const { data, error } = await supabase.from('businesses').insert(insertData).select().single();
      if (error) { console.error('business insert error:', error); return fail('사업장 등록 실패: ' + error.message, 500); }
      return ok(data, 201);
    }

    if (method === 'PUT') {
      if (!id) return fail('사업장 ID가 필요합니다.');
      if (!['owner', 'admin'].includes(token.role)) return fail('사업장 수정 권한이 없습니다.', 403);

      const body = JSON.parse(event.body || '{}');
      const updateData = {};
      if (body.name !== undefined) updateData.name = body.name.trim();
      if (body.business_number !== undefined) updateData.business_number = body.business_number;
      if (body.address !== undefined) updateData.address = body.address;
      if (body.phone !== undefined) updateData.phone = body.phone;
      if (body.manager_name !== undefined) updateData.manager_name = body.manager_name;
      if (body.status !== undefined) updateData.status = body.status;

      if (body.is_headquarters === true) {
        await supabase.from('businesses').update({ is_headquarters: false })
          .eq('company_id', token.companyId).eq('is_headquarters', true);
        updateData.is_headquarters = true;
      } else if (body.is_headquarters === false) {
        updateData.is_headquarters = false;
      }

      if (Object.keys(updateData).length === 0) return fail('수정할 내용이 없습니다.');

      const { data, error } = await supabase.from('businesses').update(updateData)
        .eq('id', id).eq('company_id', token.companyId).select().single();
      if (error) { console.error('business update error:', error); return fail('사업장 수정 실패', 500); }
      return ok(data);
    }

    if (method === 'DELETE') {
      if (!id) return fail('사업장 ID가 필요합니다.');
      if (!['owner', 'admin'].includes(token.role)) return fail('사업장 삭제 권한이 없습니다.', 403);

      const { data: assigned } = await supabase.from('employees').select('id')
        .eq('business_id', id).is('deleted_at', null).eq('status', 'active');
      if (assigned && assigned.length > 0) return fail(assigned.length + '명의 직원이 배정되어 있습니다. 먼저 직원을 이동해주세요.');

      const { error } = await supabase.from('businesses')
        .update({ deleted_at: new Date().toISOString(), status: 'closed' })
        .eq('id', id).eq('company_id', token.companyId);
      if (error) { console.error('business delete error:', error); return fail('사업장 삭제 실패', 500); }
      return ok({ message: '사업장이 삭제되었습니다.' });
    }

    return fail('지원하지 않는 메서드입니다.', 405);
  } catch (error) {
    console.error('businesses-manage error:', error);
    if (error.message?.includes('jwt') || error.message?.includes('token')) return fail('인증 실패', 401);
    return fail('서버 오류: ' + error.message, 500);
  }
};