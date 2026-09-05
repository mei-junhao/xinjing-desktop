/* XinJing v4.0.0 membership entitlements. Keep product access separate from AI compute. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XJEntitlements = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TIER_RANK = Object.freeze({ free: 0, pro: 1, full: 1, custom: 2 });
  const TIER_LABEL = Object.freeze({
    free: '免费版',
    pro: '会员',
    full: '会员（旧版授权）',
    custom: '旗舰版',
  });
  const FEATURE_REGISTRY = Object.freeze({
    'manual-core': Object.freeze({ minimumTier: 'free', trialEligible: false, label: '手工执业核心', owner: 'core' }),
    'basic-assistant': Object.freeze({ minimumTier: 'free', trialEligible: false, label: '基础助手', owner: 'assistant' }),
    'keyword-search': Object.freeze({ minimumTier: 'free', trialEligible: false, label: '关键词检索', owner: 'knowledge' }),
    'ai-notes': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: 'AI 咨询记录', owner: 'clinical' }),
    'ai-analyze': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: 'AI 临床分析', owner: 'clinical' }),
    'ai-report': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: 'AI 报告', owner: 'clinical' }),
    'ai-detect': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: 'AI 逐字稿检测', owner: 'transcript' }),
    'ai-supervise': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: 'AI 督导', owner: 'supervision' }),
    'real-sup-ai': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: '真人督导 AI 分析', owner: 'supervision' }),
    'ai-mindmap': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: 'AI 督导思维导图', owner: 'supervision' }),
    'ai-masters': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: '大师会诊', owner: 'masters' }),
    'transcript-guide': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: '逐字稿对话引导', owner: 'transcript' }),
    'ai-growth': Object.freeze({ minimumTier: 'pro', trialEligible: true, label: 'AI 成长轨迹', owner: 'growth' }),
    'billing-calendar': Object.freeze({ minimumTier: 'pro', trialEligible: false, label: '账单月历明细', owner: 'billing' }),
    'export-clean': Object.freeze({ minimumTier: 'pro', trialEligible: false, label: '无水印导出', owner: 'export' }),
    'premium-skins': Object.freeze({ minimumTier: 'pro', trialEligible: false, label: '会员设计语言', owner: 'appearance' }),
    'rag-vector': Object.freeze({ minimumTier: 'pro', trialEligible: false, label: '向量语义检索', owner: 'knowledge' }),
    'rag-rerank': Object.freeze({ minimumTier: 'custom', trialEligible: false, label: 'Rerank 精排', owner: 'knowledge' }),
    'custom-supervisors': Object.freeze({ minimumTier: 'custom', trialEligible: false, label: '自定义督导师', owner: 'supervision' }),
    'deep-case-mode': Object.freeze({ minimumTier: 'custom', trialEligible: false, label: '深度个案模式', owner: 'clinical' }),
  });
  const FEATURE_MIN_TIER = Object.freeze(Object.keys(FEATURE_REGISTRY).reduce(function (result, key) {
    result[key] = FEATURE_REGISTRY[key].minimumTier;
    return result;
  }, {}));
  const TRIAL_FEATURE_ALLOWLIST = Object.freeze(Object.keys(FEATURE_REGISTRY).filter(function (key) {
    return FEATURE_REGISTRY[key].trialEligible;
  }));
  const RAG_POLICY = Object.freeze({
    free: Object.freeze({ documentLimit: 100, method: 'keyword', contextTokens: 2000, recall: 5, rerank: false }),
    pro: Object.freeze({ documentLimit: 500, method: 'vector', contextTokens: 4000, recall: 20, rerank: false }),
    full: Object.freeze({ documentLimit: 500, method: 'vector', contextTokens: 4000, recall: 20, rerank: false }),
    custom: Object.freeze({ documentLimit: Infinity, method: 'vector-rerank', contextTokens: 16000, recall: 20, rerank: true, finalResults: 5 }),
  });
  const MATERIAL_WORKSPACE_LIMITS = Object.freeze({ free: 20, pro: 100, full: 100, custom: Infinity });
  const COMMERCIAL_BILLING_MODES = Object.freeze(['money-per-request', 'request-count-quota', 'byok', 'trial']);

  function normalizeTier(tier) {
    const value = String(tier || 'free').toLowerCase();
    return Object.prototype.hasOwnProperty.call(TIER_RANK, value) ? value : 'free';
  }

  function effectiveTier(state) {
    const current = state && typeof state === 'object' ? state : {};
    if (current.activated) return normalizeTier(current.tier);
    return 'free';
  }

  function isTrialActive(state) {
    const current = state && typeof state === 'object' ? state : {};
    return !current.activated && current.mode === 'trial' && current.aiUnlocked === true;
  }

  function canUse(feature, state) {
    const entry = FEATURE_REGISTRY[feature];
    if (!entry) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[Entitlements] Unknown feature key:', feature);
      return false;
    }
    if (TIER_RANK[effectiveTier(state)] >= TIER_RANK[entry.minimumTier]) return true;
    return isTrialActive(state) && entry.trialEligible;
  }

  function access(feature, state) {
    const entry = FEATURE_REGISTRY[feature];
    const current = state && typeof state === 'object' ? state : {};
    const eligible = canUse(feature, current);
    const isAiFeature = !!(entry && entry.trialEligible);
    return Object.freeze({
      feature: entry ? feature : null,
      eligible: eligible,
      computeAvailable: !isAiFeature || current.aiUnlocked === true,
      trial: isTrialActive(current),
      effectiveTier: effectiveTier(current),
    });
  }

  function minimumTier(feature) {
    return FEATURE_MIN_TIER[feature] || null;
  }

  function tierLabel(tier) {
    return TIER_LABEL[normalizeTier(tier)];
  }

  function featureLabel(feature) {
    return FEATURE_REGISTRY[feature] ? FEATURE_REGISTRY[feature].label : feature;
  }

  function ragPolicy(stateOrTier) {
    const tier = typeof stateOrTier === 'string' ? normalizeTier(stateOrTier) : effectiveTier(stateOrTier);
    return RAG_POLICY[tier];
  }

  function materialWorkspaceLimit(stateOrTier) {
    const tier = typeof stateOrTier === 'string' ? normalizeTier(stateOrTier) : effectiveTier(stateOrTier);
    return MATERIAL_WORKSPACE_LIMITS[tier];
  }

  // 只校验主进程返回的脱敏投影；权益模块不保存余额，也不决定 billingMode。
  function normalizeCommercialProjection(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const billing = value.billing;
    if (!billing || typeof billing !== 'object' || Array.isArray(billing)) return null;
    const allowedBillingKeys = new Set([
      'billingMode', 'chargeStatus', 'chargedMinor', 'priceMinor', 'currency',
      'catalogRevision', 'remainingBalanceMinor', 'availableBalanceMinor', 'quotaRemaining',
    ]);
    if (Object.keys(billing).some(function (key) { return !allowedBillingKeys.has(key); })) return null;
    if (!COMMERCIAL_BILLING_MODES.includes(billing.billingMode) || typeof billing.chargeStatus !== 'string') return null;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null;
    return Object.freeze({ billing: Object.freeze(Object.assign({}, billing)), revision: value.revision });
  }

  return Object.freeze({
    TIER_RANK,
    TIER_LABEL,
    FEATURE_REGISTRY,
    FEATURE_MIN_TIER,
    TRIAL_FEATURE_ALLOWLIST,
    RAG_POLICY,
    MATERIAL_WORKSPACE_LIMITS,
    COMMERCIAL_BILLING_MODES,
    normalizeTier,
    effectiveTier,
    isTrialActive,
    canUse,
    access,
    minimumTier,
    tierLabel,
    featureLabel,
    ragPolicy,
    materialWorkspaceLimit,
    normalizeCommercialProjection,
  });
});
