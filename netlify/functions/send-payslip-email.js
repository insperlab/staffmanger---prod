const { createClient } = require('@supabase/supabase-js');

// Supabase 클라이언트 초기화
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Resend API 키 (환경 변수에서 가져옴)
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sendEmail(to, subject, html, pdfBase64, filename) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'StaffManager <onboarding@resend.dev>', // 추후 실제 도메인으로 변경
      to: [to],
      subject: subject,
      html: html,
      attachments: [
        {
          filename: filename,
          content: pdfBase64
        }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`이메일 발송 실패: ${error}`);
  }

  return await response.json();
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
    const { payrollId, recipientEmail, pdfBase64, filename } = JSON.parse(event.body);

    if (!payrollId || !recipientEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'payrollId와 recipientEmail이 필요합니다' 
        })
      };
    }

    // 급여 데이터 조회 (이메일 내용 구성용)
    const { data: payroll, error: payrollError } = await supabase
      .from('payrolls')
      .select(`
        *,
        employees!inner(name, department, position)
      `)
      .eq('id', payrollId)
      .single();

    if (payrollError || !payroll) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ success: false, error: '급여 데이터를 찾을 수 없습니다' })
      };
    }

    const employee = payroll.employees;
    const year = payroll.year;
    const month = payroll.month;
    const netPayment = new Intl.NumberFormat('ko-KR').format(Math.round(payroll.net_payment)) + '원';

    // 이메일 HTML 내용
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 10px;
      text-align: center;
      margin-bottom: 30px;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
    }
    .content {
      background: #f9f9f9;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 20px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #e0e0e0;
    }
    .info-label {
      font-weight: bold;
      color: #666;
    }
    .info-value {
      color: #333;
    }
    .highlight {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      border-radius: 10px;
      text-align: center;
      margin: 20px 0;
    }
    .highlight-amount {
      font-size: 32px;
      font-weight: bold;
      margin: 10px 0;
    }
    .footer {
      text-align: center;
      color: #999;
      font-size: 12px;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
    }
    .button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 12px 30px;
      text-decoration: none;
      border-radius: 5px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>💰 급여명세서</h1>
    <p>${year}년 ${month}월</p>
  </div>
  
  <div class="content">
    <h2>안녕하세요, ${employee.name}님</h2>
    <p>${year}년 ${month}월 급여명세서를 보내드립니다.</p>
    
    <div class="info-row">
      <span class="info-label">부서</span>
      <span class="info-value">${employee.department || '-'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">직급</span>
      <span class="info-value">${employee.position || '-'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">급여 기간</span>
      <span class="info-value">${year}년 ${month}월</span>
    </div>
  </div>
  
  <div class="highlight">
    <p style="margin: 0; font-size: 16px;">실수령액</p>
    <div class="highlight-amount">${netPayment}</div>
  </div>
  
  <div class="content">
    <p>📎 첨부된 PDF 파일에서 상세 내역을 확인하실 수 있습니다.</p>
    <p>문의사항이 있으시면 인사팀으로 연락 주시기 바랍니다.</p>
  </div>
  
  <div class="footer">
    <p>이 이메일은 StaffManager 시스템에서 자동으로 발송되었습니다.</p>
    <p>© ${new Date().getFullYear()} StaffManager. All rights reserved.</p>
  </div>
</body>
</html>
    `;

    // 이메일 발송
    const result = await sendEmail(
      recipientEmail,
      `[StaffManager] ${year}년 ${month}월 급여명세서 - ${employee.name}`,
      emailHtml,
      pdfBase64,
      filename
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '급여명세서가 이메일로 발송되었습니다',
        emailId: result.id,
        recipient: recipientEmail
      })
    };

  } catch (error) {
    console.error('이메일 발송 오류:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: '이메일 발송 중 오류가 발생했습니다',
        details: error.message
      })
    };
  }
};
