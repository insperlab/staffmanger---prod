const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const https = require('https');

// Supabase 클라이언트 초기화
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COMPANY_INFO = {
  name: 'StaffManager',
  address: '서울특별시 강남구',
  tel: '02-1234-5678',
  businessNumber: '123-45-67890'
};

function formatCurrency(amount) {
  return new Intl.NumberFormat('ko-KR').format(Math.round(amount)) + '원';
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
}

// 나눔고딕 폰트를 GitHub에서 가져오는 함수
async function loadFont() {
  return new Promise((resolve, reject) => {
    const url = 'https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Regular.ttf';
    https.get(url, (response) => {
      // 리다이렉트 처리
      if (response.statusCode === 302 || response.statusCode === 301) {
        https.get(response.headers.location, (redirectResponse) => {
          const chunks = [];
          redirectResponse.on('data', (chunk) => chunks.push(chunk));
          redirectResponse.on('end', () => resolve(Buffer.concat(chunks)));
          redirectResponse.on('error', reject);
        }).on('error', reject);
      } else {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }
    }).on('error', reject);
  });
}

async function generatePayslipPDF(payrollData, employeeData) {
  return new Promise(async (resolve, reject) => {
    try {
      // 한글 폰트 로드
      let fontBuffer;
      try {
        fontBuffer = await loadFont();
      } catch (fontError) {
        console.error('폰트 로드 실패, 기본 폰트 사용:', fontError);
        fontBuffer = null;
      }

      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 50,
          bottom: 50,
          left: 50,
          right: 50
        }
      });

      // 한글 폰트 등록
      if (fontBuffer) {
        doc.registerFont('NanumGothic', fontBuffer);
      }

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const margin = 50;
      const contentWidth = pageWidth - (margin * 2);

      // 한글 폰트 사용 (없으면 기본 폰트)
      const useFont = (size, bold = false) => {
        if (fontBuffer) {
          doc.fontSize(size).font('NanumGothic');
        } else {
          doc.fontSize(size).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        }
      };

      // 제목
      useFont(24, true);
      doc.text('급여명세서', margin, margin, { align: 'center' });

      let yPos = margin + 50;

      // 발행 정보
      useFont(10);
      doc.text(`발급일: ${formatDate(payrollData.calculated_at)}`, margin, yPos, { align: 'right' });

      yPos += 30;

      // 회사 정보
      useFont(12, true);
      doc.text('회사 정보', margin, yPos);
      
      yPos += 20;
      useFont(10);
      doc.text(`회사명: ${COMPANY_INFO.name}`, margin + 20, yPos);
      
      yPos += 15;
      doc.text(`주소: ${COMPANY_INFO.address}`, margin + 20, yPos);
      
      yPos += 15;
      doc.text(`전화: ${COMPANY_INFO.tel}`, margin + 20, yPos);

      yPos += 30;

      // 직원 정보
      useFont(12, true);
      doc.text('직원 정보', margin, yPos);
      
      yPos += 20;
      useFont(10);
      doc.text(`성명: ${employeeData.name}`, margin + 20, yPos);
      
      yPos += 15;
      doc.text(`부서: ${employeeData.department || '-'}`, margin + 20, yPos);
      
      yPos += 15;
      doc.text(`직급: ${employeeData.position || '-'}`, margin + 20, yPos);

      yPos += 30;

      // 급여 기간
      useFont(12, true);
      doc.text(`급여 기간: ${payrollData.year}년 ${payrollData.month}월`, margin, yPos);

      yPos += 30;

      // 지급 내역 테이블
      useFont(11, true);
      doc.text('지급 내역', margin, yPos);

      yPos += 20;

      // 테이블 헤더
      const tableTop = yPos;
      const col1X = margin + 20;
      const col2X = margin + contentWidth - 150;

      useFont(10, true);
      doc.text('항목', col1X, tableTop);
      doc.text('금액', col2X, tableTop);

      yPos += 20;
      doc.moveTo(margin, yPos).lineTo(pageWidth - margin, yPos).stroke();
      yPos += 10;

      // 지급 항목들
      useFont(10);
      
      if (payrollData.basic_pay > 0) {
        doc.text('기본급', col1X, yPos);
        doc.text(formatCurrency(payrollData.basic_pay), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.weekly_holiday_pay > 0) {
        doc.text('주휴수당', col1X, yPos);
        doc.text(formatCurrency(payrollData.weekly_holiday_pay), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.overtime_pay > 0) {
        doc.text('연장근무수당', col1X, yPos);
        doc.text(formatCurrency(payrollData.overtime_pay), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.night_work_pay > 0) {
        doc.text('야간근무수당', col1X, yPos);
        doc.text(formatCurrency(payrollData.night_work_pay), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.holiday_work_pay > 0) {
        doc.text('휴일근무수당', col1X, yPos);
        doc.text(formatCurrency(payrollData.holiday_work_pay), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.other_allowances > 0) {
        doc.text('기타수당', col1X, yPos);
        doc.text(formatCurrency(payrollData.other_allowances), col2X, yPos);
        yPos += 15;
      }

      yPos += 5;
      doc.moveTo(margin, yPos).lineTo(pageWidth - margin, yPos).stroke();
      yPos += 10;

      // 총 지급액
      useFont(11, true);
      doc.text('총 지급액', col1X, yPos);
      doc.text(formatCurrency(payrollData.total_payment), col2X, yPos);

      yPos += 30;

      // 공제 내역
      useFont(11, true);
      doc.text('공제 내역', margin, yPos);

      yPos += 20;

      // 테이블 헤더
      useFont(10, true);
      doc.text('항목', col1X, yPos);
      doc.text('금액', col2X, yPos);

      yPos += 20;
      doc.moveTo(margin, yPos).lineTo(pageWidth - margin, yPos).stroke();
      yPos += 10;

      // 공제 항목들
      useFont(10);

      if (payrollData.national_pension > 0) {
        doc.text('국민연금', col1X, yPos);
        doc.text(formatCurrency(payrollData.national_pension), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.health_insurance > 0) {
        doc.text('건강보험', col1X, yPos);
        doc.text(formatCurrency(payrollData.health_insurance), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.long_term_care > 0) {
        doc.text('장기요양보험', col1X, yPos);
        doc.text(formatCurrency(payrollData.long_term_care), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.employment_insurance > 0) {
        doc.text('고용보험', col1X, yPos);
        doc.text(formatCurrency(payrollData.employment_insurance), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.income_tax > 0) {
        doc.text('소득세', col1X, yPos);
        doc.text(formatCurrency(payrollData.income_tax), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.local_income_tax > 0) {
        doc.text('지방소득세', col1X, yPos);
        doc.text(formatCurrency(payrollData.local_income_tax), col2X, yPos);
        yPos += 15;
      }

      if (payrollData.other_deductions > 0) {
        doc.text('기타공제', col1X, yPos);
        doc.text(formatCurrency(payrollData.other_deductions), col2X, yPos);
        yPos += 15;
      }

      yPos += 5;
      doc.moveTo(margin, yPos).lineTo(pageWidth - margin, yPos).stroke();
      yPos += 10;

      // 총 공제액
      useFont(11, true);
      doc.text('총 공제액', col1X, yPos);
      doc.text(formatCurrency(payrollData.total_deductions), col2X, yPos);

      yPos += 30;

      // 실수령액 (강조)
      useFont(14, true);
      doc.text('실수령액', col1X, yPos);
      useFont(16, true);
      doc.text(formatCurrency(payrollData.net_payment), col2X, yPos);

      yPos += 50;

      // 푸터
      useFont(9);
      doc.text('이 급여명세서는 정확한 계산의 결과입니다.', margin, yPos, { 
        align: 'center',
        width: contentWidth
      });

      // PDF 생성 완료
      doc.end();

    } catch (error) {
      reject(error);
    }
  });
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method not allowed' })
    };
  }

  try {
    const { payrollId } = JSON.parse(event.body);

    if (!payrollId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'payrollId가 필요합니다' })
      };
    }

    // 급여 데이터 조회
    const { data: payroll, error: payrollError } = await supabase
      .from('payrolls')
      .select('*')
      .eq('id', payrollId)
      .single();

    if (payrollError || !payroll) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ success: false, error: '급여 데이터를 찾을 수 없습니다' })
      };
    }

    // 직원 데이터 조회
    const { data: employee, error: employeeError } = await supabase
      .from('employees')
      .select('name, department, position, phone, email')
      .eq('id', payroll.employee_id)
      .single();

    if (employeeError || !employee) {
      console.error('직원 조회 오류:', employeeError);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: '직원 데이터를 찾을 수 없습니다',
          details: employeeError?.message 
        })
      };
    }

    // PDF 생성
    const pdfBuffer = await generatePayslipPDF(payroll, employee);

    // Base64로 인코딩하여 반환
    const pdfBase64 = pdfBuffer.toString('base64');

    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        pdf: pdfBase64,
        filename: `급여명세서_${employee.name}_${payroll.year}년${payroll.month}월.pdf`,
        employee: {
          name: employee.name,
          email: employee.email || null,
          phone: employee.phone
        }
      })
    };

  } catch (error) {
    console.error('급여명세서 생성 오류:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: '급여명세서 생성 중 오류가 발생했습니다',
        details: error.message
      })
    };
  }
};
