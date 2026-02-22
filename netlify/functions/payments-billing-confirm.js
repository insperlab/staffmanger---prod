// ============================================================
// payments-billing-confirm.js
// 토스페이먼츠 빌링키 발급 확정 Netlify Function
//
// 흐름:
//   billing.html → 토스 UI에서 카드 등록 → authKey 수신
//   → 이 함수에서 authKey로 billingKey 발급 → Supabase에 저장
// ============================================================

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { authKey, customerKey, plan, customerEmail, customerName } = JSON.parse(event.body || '{}');

        if (!authKey || !customerKey) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'authKey와 customerKey는 필수입니다.' })
            };
        }

        const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!TOSS_SECRET_KEY) {
            console.error('TOSS_SECRET_KEY 환경변수가 설정되지 않았습니다.');
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: '서버 설정 오류입니다. 관리자에게 문의하세요.' })
            };
        }

        // authKey → billingKey 발급 (토스 서버 API 호출)
        const tossResponse = await fetch(
            `https://api.tosspayments.com/v1/billing/authorizations/${authKey}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(TOSS_SECRET_KEY + ':').toString('base64'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ customerKey })
            }
        );

        const tossData = await tossResponse.json();

        if (!tossResponse.ok) {
            console.error('토스 빌링키 발급 실패:', tossData);
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: tossData.message || '빌링키 발급에 실패했습니다.',
                    code: tossData.code
                })
            };
        }

        const { billingKey, card } = tossData;
        console.log('빌링키 발급 성공:', { customerKey, plan, card: card?.number?.slice(-4) });

        // Supabase에 구독 정보 저장
        if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
            try {
                const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

                const planPrices = { free: 0, pro: 19900, business: 49900 };

                const nextPaymentDate = new Date();
                nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);

                const { error: dbError } = await supabase
                    .from('subscriptions')
                    .upsert({
                        customer_key: customerKey,
                        customer_email: customerEmail,
                        customer_name: customerName,
                        billing_key: billingKey,
                        plan: plan,
                        amount: planPrices[plan] || 19900,
                        status: 'active',
                        card_last4: card?.number?.slice(-4) || null,
                        card_company: card?.company || null,
                        next_payment_at: nextPaymentDate.toISOString(),
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'customer_key' });

                if (dbError) {
                    console.error('Supabase 저장 오류 (빌링키는 발급됨):', dbError);
                }
            } catch (dbErr) {
                console.error('DB 저장 중 예외:', dbErr);
            }
        } else {
            console.warn('Supabase 환경변수 없음 - DB 저장 생략');
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                billingKey: billingKey,
                plan: plan,
                customerEmail: customerEmail,
                cardLast4: card?.number?.slice(-4) || null,
                message: '구독이 성공적으로 등록되었습니다.'
            })
        };

    } catch (error) {
        console.error('payments-billing-confirm 오류:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' })
        };
    }
};