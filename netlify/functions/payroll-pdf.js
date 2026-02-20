/**
 * netlify/functions/payroll-pdf.js
 * 급여명세서 PDF 생성 API
 * GET /.netlify/functions/payroll-pdf?employeeId=xxx&year=2026&month=2
 * - payrollId 대신 employeeId+year+month 로 조회 (company 검증 포함)
 */

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const CORS = {
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// 한글 폰트 CDN 로드
async function loadKoreanFont() {
  const url = 'https://fonts.gstatic.com/s/notosanskr/v36/PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.0.woff2';
  const res = await fetch(url);
  if (!res.ok) throw new Error('폰트 로드 실패: ' + res.status);
  return res.arrayBuffer();
}

function fmt(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  return d.getFullYear() + '년 ' + (d.getMonth()+1) + '월 ' + d.getDate() + '일';
}

async function buildPDF(payroll, emp, company) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = await loadKoreanFont();
  const font = await doc.embedFont(fontBytes);
  const page = doc.addPage([595, 842]);
  const W = 595, H = 842;

  const cBlue  = rgb(0.13, 0.34, 0.82);
  const cDark  = rgb(0.13, 0.13, 0.13);
  const cGray  = rgb(0.45, 0.45, 0.45);
  const cLight = rgb(0.96, 0.97, 1.0);
  const cWhite = rgb(1, 1, 1);
  const cRed   = rgb(0.85, 0.15, 0.15);

  // 헤더
  page.drawRectangle({ x:0, y:H-90, width:W, height:90, color:cBlue });
  page.drawText(company?.name || '회사명', { x:40, y:H-40, size:20, font, color:cWhite });
  page.drawText('급여명세서', { x:40, y:H-65, size:13, font, color:rgb(0.8,0.88,1) });
  const n = new Date();
  page.drawText('발행일: '+n.getFullYear()+'년 '+(n.getMonth()+1)+'월 '+n.getDate()+'일', { x:390, y:H-55, size:9, font, color:rgb(0.8,0.88,1) });

  let y = H - 110;

  // 직원 정보
  page.drawRectangle({ x:30, y:y-70, width:535, height:75, color:cLight });
  page.drawText(payroll.year+'년 '+payroll.month+'월 귀속', { x:45, y:y-22, size:12, font, color:cDark });
  page.drawText('성명: '+(emp?.name||'-'), { x:45, y:y-42, size:11, font, color:cDark });
  page.drawText('부서: '+(emp?.department||'-'), { x:200, y:y-42, size:11, font, color:cDark });
  page.drawText('입사일: '+fmtDate(emp?.hire_date), { x:350, y:y-42, size:11, font, color:cDark });
  page.drawText('계좌: '+(emp?.bank_name||'')+(emp?.bank_account?' '+emp.bank_account:''), { x:45, y:y-60, size:9, font, color:cGray });
  y -= 90;

  function section(title, items, red) {
    const rows = items.filter(i => Number(i.v) > 0);
    if (!rows.length) return;
    page.drawRectangle({ x:30, y:y-24, width:535, height:24, color: red ? rgb(0.99,0.96,0.96) : cLight });
    page.drawText(title, { x:45, y:y-17, size:11, font, color: red ? cRed : cBlue });
    y -= 24;
    rows.forEach((item, i) => {
      const col = i%2, row = Math.floor(i/2);
      const ix = 30+col*267, iy = y-18-row*22;
      page.drawText(item.k, { x:ix+10, y:iy+2, size:10, font, color:cGray });
      page.drawText(fmt(item.v), { x:ix+160, y:iy+2, size:10, font, color: red ? cRed : cDark });
    });
    y -= Math.ceil(rows.length/2)*22+10;
  }

  section('지급 내역', [
    {k:'기본급',          v:payroll.basic_pay},
    {k:'주휴수당',        v:payroll.weekly_holiday_pay},
    {k:'연장근무수당',    v:payroll.overtime_pay},
    {k:'야간근무수당',    v:payroll.night_work_pay},
    {k:'휴일근무수당',    v:payroll.holiday_work_pay},
    {k:'식대(비과세)',    v:payroll.meal_allowance},
    {k:'자가운전(비과세)',v:payroll.car_allowance},
    {k:'보육수당(비과세)',v:payroll.childcare_allowance},
  ], false);

  section('공제 내역', [
    {k:'국민연금',   v:payroll.national_pension},
    {k:'건강보험',   v:payroll.health_insurance},
    {k:'장기요양',   v:payroll.long_term_care},
    {k:'고용보험',   v:payroll.employment_insurance},
    {k:'소득세',     v:payroll.income_tax},
    {k:'지방소득세', v:payroll.local_income_tax},
  ], true);

  // 근무 정보
  page.drawRectangle({ x:30, y:y-24, width:535, height:24, color:cLight });
  page.drawText('근무 정보', { x:45, y:y-17, size:11, font, color:cBlue });
  y -= 24;
  [
    {k:'근무일수',    v:payroll.total_work_days+'일'},
    {k:'총 근무시간', v:Number(payroll.total_work_hours||0).toFixed(1)+'시간'},
    {k:'연장근무',    v:Number(payroll.overtime_hours||0).toFixed(1)+'시간'},
    {k:'야간근무',    v:Number(payroll.night_work_hours||0).toFixed(1)+'시간'},
  ].forEach((item,i) => {
    const col=i%2, row=Math.floor(i/2);
    const ix=30+col*267, iy=y-18-row*22;
    page.drawText(item.k, {x:ix+10, y:iy+2, size:10, font, color:cGray});
    page.drawText(item.v, {x:ix+160, y:iy+2, size:10, font, color:cDark});
  });
  y -= 66;

  // 합계 박스
  page.drawRectangle({ x:30, y:y-65, width:535, height:65, color:cBlue });
  page.drawText('총 지급액', {x:50,  y:y-20, size:10, font, color:rgb(0.8,0.88,1)});
  page.drawText(fmt(payroll.total_payment),    {x:50,  y:y-40, size:14, font, color:cWhite});
  page.drawText('총 공제액', {x:215, y:y-20, size:10, font, color:rgb(0.8,0.88,1)});
  page.drawText(fmt(payroll.total_deductions), {x:215, y:y-40, size:14, font, color:cWhite});
  page.drawText('실수령액',  {x:385, y:y-18, size:10, font, color:rgb(0.9,0.95,1)});
  page.drawText(fmt(payroll.net_payment),      {x:385, y:y-42, size:16, font, color:cWhite});

  // 푸터
  page.drawText('본 명세서는 StaffManager에서 자동 생성되었습니다.', {x:30, y:20, size:8, font, color:cGray});
  page.drawText('staffmanager.io', {x:490, y:20, size:8, font, color:cGray});

  return doc.save();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:CORS, body:'' };
  if (event.httpMethod !== 'GET') return { statusCode:405, headers:CORS, body:'GET만 허용' };

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let tokenData;
    try { tokenData = verifyToken(authHeader); } catch {
      return { statusCode:401, headers:CORS, body: JSON.stringify({success:false, error:'인증 실패'}) };
    }

    const q = event.queryStringParameters || {};
    const { employeeId, year, month, payrollId } = q;

    const supabase = getSupabase();
    let payroll;

    if (employeeId && year && month) {
      // ── 방법 1: employeeId + year + month (신규 방식) ──
      // 직원이 본인 회사 소속인지 먼저 검증
      const { data: emp } = await supabase
        .from('employees')
        .select('id, company_id')
        .eq('id', employeeId)
        .eq('company_id', tokenData.companyId)
        .single();

      if (!emp) return { statusCode:403, headers:CORS, body: JSON.stringify({success:false, error:'접근 권한 없음'}) };

      const { data, error } = await supabase
        .from('payrolls')
        .select('*, employees!inner(name, department, hire_date, bank_name, bank_account)')
        .eq('employee_id', employeeId)
        .eq('year', parseInt(year))
        .eq('month', parseInt(month))
        .single();

      if (error || !data) return { statusCode:404, headers:CORS, body: JSON.stringify({success:false, error:'급여 정보 없음 (계산 먼저 실행해주세요)'}) };
      payroll = data;

    } else if (payrollId) {
      // ── 방법 2: payrollId 직접 조회 (구형 호환) ──
      const { data, error } = await supabase
        .from('payrolls')
        .select('*, employees!inner(name, department, hire_date, bank_name, bank_account, company_id)')
        .eq('id', payrollId)
        .single();

      if (error || !data) return { statusCode:404, headers:CORS, body: JSON.stringify({success:false, error:'급여 정보 없음'}) };

      // 회사 검증 (employees 통해)
      const empCompanyId = Array.isArray(data.employees) ? data.employees[0]?.company_id : data.employees?.company_id;
      if (empCompanyId !== tokenData.companyId) {
        return { statusCode:403, headers:CORS, body: JSON.stringify({success:false, error:'접근 권한 없음'}) };
      }
      payroll = data;

    } else {
      return { statusCode:400, headers:CORS, body: JSON.stringify({success:false, error:'employeeId+year+month 또는 payrollId 필요'}) };
    }

    // 회사 정보
    const { data: company } = await supabase.from('companies').select('name').eq('id', tokenData.companyId).single();
    const emp = Array.isArray(payroll.employees) ? payroll.employees[0] : payroll.employees;

    const pdfBytes = await buildPDF(payroll, emp, company);
    const fname = encodeURIComponent('급여명세서_'+payroll.year+'년'+payroll.month+'월_'+(emp?.name||'')+'.pdf');

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type':'application/pdf', 'Content-Disposition':"attachment; filename*=UTF-8''"+fname },
      body: Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true,
    };

  } catch (err) {
    console.error('[payroll-pdf]', err.message);
    return { statusCode:500, headers:CORS, body: JSON.stringify({success:false, error:'PDF 생성 실패: '+err.message}) };
  }
};
