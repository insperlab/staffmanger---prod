/**
 * netlify/functions/payroll-pdf.js
 * 급여명세서 PDF 생성 API
 * GET /.netlify/functions/payroll-pdf?payrollId=xxx
 * - pdf-lib 사용 (한글 완벽 지원)
 * - NotoSansKR 폰트를 Google Fonts CDN에서 런타임 로드
 * - 인증 토큰 필수 (개인정보 보호)
 */

const { verifyToken } = require('./lib/auth');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://staffmanager.io',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ── 한글 폰트 로드 (Google Fonts CDN) ───────────────────────────
// 비유: 한글 도장 — PDF에 한글을 찍으려면 한글 도장(폰트)이 필요
// 런타임에 CDN에서 가져오므로 레포 크기 증가 없음
async function loadKoreanFont() {
  const fontUrl = 'https://fonts.gstatic.com/s/notosanskr/v36/PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.0.woff2';
  const response = await fetch(fontUrl);
  if (!response.ok) throw new Error('한글 폰트 로드 실패');
  return await response.arrayBuffer();
}

// ── 금액 포맷 (1234567 → 1,234,567원) ─────────────────────────
function formatMoney(amount) {
  return Number(amount || 0).toLocaleString('ko-KR') + '원';
}

// ── 날짜 포맷 ─────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// ── PDF 생성 핵심 함수 ─────────────────────────────────────────
async function generatePayslipPDF(payroll, employee, company) {
  // A4 사이즈 PDF 생성
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // 한글 폰트 임베딩
  const koreanFontBytes = await loadKoreanFont();
  const koreanFont = await pdfDoc.embedFont(koreanFontBytes);

  // A4: 595 x 842 pt
  const page = pdfDoc.addPage([595, 842]);
  const { width, height } = page.getSize();

  // ── 색상 팔레트 ──
  const colorPrimary = rgb(0.13, 0.34, 0.82);   // 파란색 (#2156D0)
  const colorDark    = rgb(0.13, 0.13, 0.13);   // 거의 검정
  const colorGray    = rgb(0.45, 0.45, 0.45);   // 회색
  const colorLight   = rgb(0.96, 0.97, 1.0);    // 연한 파란 배경
  const colorWhite   = rgb(1, 1, 1);
  const colorRed     = rgb(0.85, 0.15, 0.15);   // 빨강 (공제)
  const colorBorder  = rgb(0.87, 0.87, 0.87);   // 테두리

  // ── 헤더 배경 ──
  page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: colorPrimary });

  // ── 회사명 ──
  page.drawText(company?.name || '회사명', {
    x: 40, y: height - 40,
    size: 20, font: koreanFont, color: colorWhite,
  });

  // ── 급여명세서 타이틀 ──
  page.drawText('급여명세서', {
    x: 40, y: height - 68,
    size: 13, font: koreanFont, color: rgb(0.8, 0.88, 1.0),
  });

  // ── 발행일 ──
  const issueDate = `발행일: ${new Date().getFullYear()}년 ${new Date().getMonth() + 1}월 ${new Date().getDate()}일`;
  page.drawText(issueDate, {
    x: width - 200, y: height - 55,
    size: 10, font: koreanFont, color: rgb(0.8, 0.88, 1.0),
  });

  let y = height - 110; // 현재 Y 위치 (위에서 아래로)

  // ── 귀속연월 + 직원정보 박스 ──
  page.drawRectangle({ x: 30, y: y - 70, width: width - 60, height: 75, color: colorLight, borderColor: colorBorder, borderWidth: 0.5 });

  page.drawText(`귀속연월: ${payroll.year}년 ${payroll.month}월`, {
    x: 45, y: y - 22, size: 12, font: koreanFont, color: colorDark,
  });
  page.drawText(`성명: ${employee?.name || '-'}`, {
    x: 45, y: y - 42, size: 11, font: koreanFont, color: colorDark,
  });
  page.drawText(`부서: ${employee?.department || '-'}`, {
    x: 200, y: y - 42, size: 11, font: koreanFont, color: colorDark,
  });
  page.drawText(`입사일: ${formatDate(employee?.hire_date)}`, {
    x: 350, y: y - 42, size: 11, font: koreanFont, color: colorDark,
  });
  page.drawText(`계좌: ${employee?.bank_name || ''} ${employee?.bank_account || '-'}`, {
    x: 45, y: y - 60, size: 10, font: koreanFont, color: colorGray,
  });

  y -= 90;

  // ── 섹션 그리기 헬퍼 ──
  function drawSection(title, items, isDeduction = false) {
    // 섹션 제목
    page.drawRectangle({ x: 30, y: y - 24, width: width - 60, height: 24, color: isDeduction ? rgb(0.98, 0.95, 0.95) : colorLight });
    page.drawText(title, { x: 45, y: y - 17, size: 11, font: koreanFont, color: isDeduction ? colorRed : colorPrimary });
    y -= 24;

    // 항목들 (2열 배치)
    const colWidth = (width - 60) / 2;
    items.forEach((item, i) => {
      if (!item) return;
      const col = i % 2;
      const row = Math.floor(i / 2);
      const itemY = y - 18 - row * 22;
      const itemX = 30 + col * colWidth;

      // 행 배경 (홀수 행)
      if (row % 2 === 0) {
        page.drawRectangle({ x: itemX, y: itemY - 6, width: colWidth, height: 22, color: rgb(0.99, 0.99, 0.99) });
      }

      page.drawText(item.label, { x: itemX + 12, y: itemY + 2, size: 10, font: koreanFont, color: colorGray });
      page.drawText(formatMoney(item.value), { x: itemX + colWidth - 100, y: itemY + 2, size: 10, font: koreanFont, color: isDeduction ? colorRed : colorDark });
    });

    const rows = Math.ceil(items.length / 2);
    y -= rows * 22 + 8;
  }

  // ── 지급 항목 ──
  drawSection('지급 내역', [
    { label: '기본급',      value: payroll.basic_pay },
    { label: '주휴수당',    value: payroll.weekly_holiday_pay },
    { label: '연장근무수당', value: payroll.overtime_pay },
    { label: '야간근무수당', value: payroll.night_work_pay },
    { label: '휴일근무수당', value: payroll.holiday_work_pay },
    { label: '식대 (비과세)', value: payroll.meal_allowance },
    { label: '자가운전 (비과세)', value: payroll.car_allowance },
    { label: '보육수당 (비과세)', value: payroll.childcare_allowance },
  ].filter(i => i.value > 0));

  y -= 5;

  // ── 공제 항목 ──
  drawSection('공제 내역', [
    { label: '국민연금',   value: payroll.national_pension },
    { label: '건강보험',   value: payroll.health_insurance },
    { label: '장기요양',   value: payroll.long_term_care },
    { label: '고용보험',   value: payroll.employment_insurance },
    { label: '소득세',     value: payroll.income_tax },
    { label: '지방소득세', value: payroll.local_income_tax },
  ].filter(i => i.value > 0), true);

  y -= 5;

  // ── 근무 정보 ──
  drawSection('근무 정보', [
    { label: '근무일수',    value: `${payroll.total_work_days}일` },
    { label: '총 근무시간', value: `${(payroll.total_work_hours || 0).toFixed(1)}시간` },
    { label: '연장근무',    value: `${(payroll.overtime_hours || 0).toFixed(1)}시간` },
    { label: '야간근무',    value: `${(payroll.night_work_hours || 0).toFixed(1)}시간` },
  ].map(i => ({ ...i, value: 0, _text: i.value })));

  // 근무 정보는 금액 형식이 아니므로 별도 처리
  // (위 drawSection이 formatMoney 쓰므로 아래에서 재작성)
  y += 24 + Math.ceil(4 / 2) * 22 + 8 + 5; // 위에서 그린 섹션 되돌리기

  page.drawRectangle({ x: 30, y: y - 24, width: width - 60, height: 24, color: colorLight });
  page.drawText('근무 정보', { x: 45, y: y - 17, size: 11, font: koreanFont, color: colorPrimary });
  y -= 24;

  const workItems = [
    { label: '근무일수',    value: `${payroll.total_work_days}일` },
    { label: '총 근무시간', value: `${(payroll.total_work_hours || 0).toFixed(1)}시간` },
    { label: '연장근무',    value: `${(payroll.overtime_hours || 0).toFixed(1)}시간` },
    { label: '야간근무',    value: `${(payroll.night_work_hours || 0).toFixed(1)}시간` },
  ];
  const colWidth2 = (width - 60) / 2;
  workItems.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const itemY = y - 18 - row * 22;
    const itemX = 30 + col * colWidth2;
    page.drawText(item.label, { x: itemX + 12, y: itemY + 2, size: 10, font: koreanFont, color: colorGray });
    page.drawText(item.value, { x: itemX + colWidth2 - 80, y: itemY + 2, size: 10, font: koreanFont, color: colorDark });
  });
  y -= Math.ceil(workItems.length / 2) * 22 + 8;

  // ── 최종 합계 박스 ──
  y -= 10;
  page.drawRectangle({ x: 30, y: y - 60, width: width - 60, height: 65, color: colorPrimary });

  // 총 지급액
  page.drawText('총 지급액', { x: 50, y: y - 20, size: 11, font: koreanFont, color: rgb(0.8, 0.88, 1.0) });
  page.drawText(formatMoney(payroll.total_payment), { x: 50, y: y - 40, size: 16, font: koreanFont, color: colorWhite });

  // 총 공제액
  page.drawText('총 공제액', { x: 220, y: y - 20, size: 11, font: koreanFont, color: rgb(0.8, 0.88, 1.0) });
  page.drawText(formatMoney(payroll.total_deductions), { x: 220, y: y - 40, size: 16, font: koreanFont, color: colorWhite });

  // 실수령액 (강조)
  page.drawText('실수령액', { x: 390, y: y - 20, size: 11, font: koreanFont, color: rgb(0.9, 0.95, 1.0) });
  page.drawText(formatMoney(payroll.net_payment), { x: 390, y: y - 42, size: 18, font: koreanFont, color: colorWhite });

  // ── 푸터 ──
  page.drawText('본 명세서는 StaffManager에서 자동 생성되었습니다.', {
    x: 30, y: 25, size: 8, font: koreanFont, color: colorGray,
  });
  page.drawText('staffmanager.io', {
    x: width - 100, y: 25, size: 8, font: koreanFont, color: colorGray,
  });

  return await pdfDoc.save();
}

// ── 핸들러 ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS_HEADERS, body: 'GET만 허용' };

  try {
    // 인증 확인
    const authHeader = event.headers.authorization || event.headers.Authorization;
    let tokenData;
    try { tokenData = verifyToken(authHeader); } catch {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '인증 실패' }) };
    }

    const { payrollId } = event.queryStringParameters || {};
    if (!payrollId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'payrollId 필수' }) };

    const supabase = getSupabase();

    // 급여 데이터 조회 (본인 회사 데이터만)
    const { data: payroll, error: pErr } = await supabase
      .from('payrolls')
      .select('*, employees!inner(name, department, hire_date, bank_name, bank_account)')
      .eq('id', payrollId)
      .eq('company_id', tokenData.companyId)
      .single();

    if (pErr || !payroll) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: '급여 정보 없음' }) };

    // 회사 정보 조회
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', tokenData.companyId)
      .single();

    const employee = Array.isArray(payroll.employees) ? payroll.employees[0] : payroll.employees;

    // PDF 생성
    const pdfBytes = await generatePayslipPDF(payroll, employee, company);

    const filename = `급여명세서_${payroll.year}년${payroll.month}월_${employee?.name || ''}.pdf`;

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/pdf',
        // 브라우저 다운로드 유도
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
      // Netlify Functions: base64로 바이너리 반환
      body: Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true,
    };

  } catch (err) {
    console.error('[payroll-pdf] 오류:', err.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'PDF 생성 실패: ' + err.message }) };
  }
};
