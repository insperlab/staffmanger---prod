// ============================================================
// netlify/functions/lib/plan-check.js
// 역할: API 호출 시 "이 회사가 이 기능을 쓸 수 있는지" 확인하는 문지기
// 비유: 놀이공원 입장 체크 — 이용권 확인 후 OK/초과 안내
//
// 사용법:
//   const { checkPlanLimit, incrementUsage } = require('./lib/plan-check');
//
//   // 1) 기능 실행 전: 한도 확인
//   const check = await checkPlanLimit(supabase, companyId, 'e_contract');
//   if (!check.allowed) {
//     return { statusCode: 402, body: JSON.stringify(check) };
//   }
//
//   // 2) 기능 실행 성공 후: 카운터 +1
//   await incrementUsage(supabase, companyId, 'e_contract');
// ============================================================

// 기능 유형 상수 (오타 방지용)
const FEATURES = {
  E_CONTRACT:  'e_contract',   // 전자계약 건수
  KAKAO_ALERT: 'kakao_alert',  // 카카오 알림 건수
  AI_CONSULT:  'ai_consult',   // AI 노무 상담 건수
};

// 업그레이드 안내 (초과 시 표시)
const UPGRADE_INFO = {
  free: { tier: 'Pro',      price: '₩19,900/월', url: 'https://staffmanager.io/plans.html' },
  pro:  { tier: 'Business', price: '₩49,900/월', url: 'https://staffmanager.io/plans.html' },
};

// 기능 한국어 표시명
const FEATURE_LABELS = {
  'e_contract':  '전자계약',
  'kakao_alert': '카카오 알림',
  'ai_consult':  'AI 노무 상담',
};

// subscription_tiers 테이블의 기능별 컬럼명 매핑
const FEATURE_TO_COLUMN = {
  'e_contract':  'contract_limit',
  'kakao_alert': 'kakao_limit',
  'ai_consult':  'ai_limit',
};

/**
 * 이번 달 1일 날짜 반환 (한국 시간 기준)
 * usage_tracking의 period_start 컬럼 키로 사용
 * 예: '2026-02-01'
 */
function getCurrentPeriodStart() {
  // UTC+9 한국 시간 기준
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * 플랜 제한 확인
 *
 * @param {object} supabase      - Supabase 서비스롤 클라이언트
 * @param {string} companyId     - 회사 UUID
 * @param {string} featureType   - FEATURES 상수 중 하나 ('e_contract' 등)
 * @returns {object}
 *   allowed: true  → 사용 가능
 *   allowed: false → 한도 초과, 402 응답에 body로 그대로 반환 가능
 */
async function checkPlanLimit(supabase, companyId, featureType) {
  try {
    // ── 1. 회사 플랜 조회 ──────────────────────────────────
    const { data: company, error: ce } = await supabase
      .from('companies')
      .select('subscription_plan')
      .eq('id', companyId)
      .single();

    if (ce || !company) {
      // DB 오류면 허용 처리 (미들웨어 장애로 서비스 차단 방지)
      console.error('[plan-check] 회사 조회 실패:', ce);
      return { allowed: true };
    }

    const plan = company.subscription_plan || 'free';

    // ── 2. 플랜별 기능 한도 조회 ──────────────────────────
    const limitCol = FEATURE_TO_COLUMN[featureType];
    const { data: tier, error: te } = await supabase
      .from('subscription_tiers')
      .select(`id, ${limitCol}`)
      .eq('id', plan)
      .single();

    if (te || !tier) {
      console.error('[plan-check] 티어 조회 실패:', te);
      return { allowed: true };
    }

    const limit = tier[limitCol];

    // -1 = Business 무제한
    if (limit === -1) {
      return { allowed: true, plan, limit: -1 };
    }

    // ── 3. 이번 달 사용량 조회 ────────────────────────────
    const periodStart = getCurrentPeriodStart();
    const { data: usage } = await supabase
      .from('usage_tracking')
      .select('usage_count')
      .eq('company_id', companyId)
      .eq('feature_type', featureType)
      .eq('period_start', periodStart)
      .single();

    const used = usage?.usage_count ?? 0;

    // ── 4. 한도 초과 판단 ─────────────────────────────────
    if (used >= limit) {
      const up = UPGRADE_INFO[plan];
      return {
        allowed: false,
        plan,
        limit,
        used,
        remaining: 0,
        featureType,
        featureLabel: FEATURE_LABELS[featureType] || featureType,
        message: `이번 달 ${FEATURE_LABELS[featureType]} 한도(${limit}건)를 모두 사용했습니다.`,
        upgrade: up ? `${up.tier} 플랜(${up.price})으로 업그레이드하면 더 사용할 수 있습니다.` : null,
        upgradeUrl: up?.url ?? null,
      };
    }

    // 사용 가능
    return { allowed: true, plan, limit, used, remaining: limit - used };

  } catch (err) {
    // 예외 시 허용 처리 (미들웨어 오류로 핵심 기능 차단 방지)
    console.error('[plan-check] 예외:', err);
    return { allowed: true };
  }
}

/**
 * 사용량 카운터 +1
 * 반드시 기능 실행 성공 후에 호출 (실패 시엔 호출하지 않음)
 *
 * @param {object} supabase    - Supabase 서비스롤 클라이언트
 * @param {string} companyId   - 회사 UUID
 * @param {string} featureType - FEATURES 상수 중 하나
 */
async function incrementUsage(supabase, companyId, featureType) {
  try {
    const periodStart = getCurrentPeriodStart();

    // Supabase RPC로 원자적 +1 (동시 요청도 안전)
    const { error } = await supabase.rpc('increment_usage_count', {
      p_company_id:    companyId,
      p_feature_type:  featureType,
      p_period_start:  periodStart,
    });

    if (error) {
      console.error('[plan-check] RPC increment 실패:', error);
    } else {
      console.log(`[plan-check] 사용량 +1: ${featureType} / ${periodStart}`);
    }
  } catch (err) {
    // 카운터 실패는 치명적이지 않음 — 로그만 남기고 통과
    console.error('[plan-check] incrementUsage 예외 (서비스 계속):', err);
  }
}

/**
 * 사용량 요약 조회 (대시보드 표시용)
 * @returns {{ plan, periodStart, usage: { e_contract, kakao_alert, ai_consult } }}
 */
async function getUsageSummary(supabase, companyId) {
  try {
    const periodStart = getCurrentPeriodStart();

    const [companyRes, usagesRes] = await Promise.all([
      supabase.from('companies').select('subscription_plan').eq('id', companyId).single(),
      supabase.from('usage_tracking').select('feature_type, usage_count')
        .eq('company_id', companyId).eq('period_start', periodStart),
    ]);

    const plan = companyRes.data?.subscription_plan || 'free';

    const { data: tier } = await supabase
      .from('subscription_tiers').select('*').eq('id', plan).single();

    const usageMap = {};
    (usagesRes.data || []).forEach(u => { usageMap[u.feature_type] = u.usage_count; });

    return {
      plan,
      periodStart,
      usage: {
        e_contract:  { used: usageMap['e_contract']  ?? 0, limit: tier?.contract_limit ?? 1  },
        kakao_alert: { used: usageMap['kakao_alert'] ?? 0, limit: tier?.kakao_limit    ?? 30 },
        ai_consult:  { used: usageMap['ai_consult']  ?? 0, limit: tier?.ai_limit       ?? 5  },
      },
    };
  } catch (err) {
    console.error('[plan-check] getUsageSummary 실패:', err);
    return { plan: 'free', usage: {} };
  }
}

module.exports = { checkPlanLimit, incrementUsage, getUsageSummary, FEATURES };