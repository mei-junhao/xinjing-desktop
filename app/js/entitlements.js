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
  const FEATURE_MIN_TIER = Object.freeze({
    'manual-core': 'free',
    'basic-assistant': 'free',
    'keyword-search': 'free',
    'ai-notes': 'pro',
    'ai-analyze': 'pro',
    'ai-report': 'pro',
    'ai-detect': 'pro',
    'ai-supervise': 'pro',
    'real-sup-ai': 'pro',
    'ai-mindmap': 'pro',
    'ai-masters': 'pro',
    'transcript-guide': 'pro',
    'ai-growth': 'pro',
    'billing-calendar': 'pro',
    'export-clean': 'pro',
    'premium-skins': 'pro',
    'rag-vector': 'pro',
    'rag-rerank': 'custom',
    'custom-supervisors': 'custom',
    'deep-case-mode': 'custom',
  });
  const RAG_POLICY = Object.freeze({
    free: Object.freeze({ documentLimit: 100, method: 'keyword', contextTokens: 2000, recall: 5, rerank: false }),
    pro: Object.freeze({ documentLimit: 500, method: 'vector', contextTokens: 4000, recall: 20, rerank: false }),
    full: Object.freeze({ documentLimit: 500, method: 'vector', contextTokens: 4000, recall: 20, rerank: false }),
    custom: Object.freeze({ documentLimit: Infinity, method: 'vector-rerank', contextTokens: 16000, recall: 20, rerank: true, finalResults: 5 }),
  });

  function normalizeTier(tier) {
    const value = String(tier || 'free').toLowerCase();
    return Object.prototype.hasOwnProperty.call(TIER_RANK, value) ? value : 'free';
  }

  function effectiveTier(state) {
    const current = state && typeof state === 'object' ? state : {};
    if (current.activated) return normalizeTier(current.tier);
    if (current.mode === 'trial' && current.aiUnlocked) return 'custom';
    return 'free';
  }

  function canUse(feature, state) {
    const minimum = FEATURE_MIN_TIER[feature];
    if (!minimum) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[Entitlements] Unknown feature key:', feature);
      return false;
    }
    return TIER_RANK[effectiveTier(state)] >= TIER_RANK[minimum];
  }

  function minimumTier(feature) {
    return FEATURE_MIN_TIER[feature] || null;
  }

  function tierLabel(tier) {
    return TIER_LABEL[normalizeTier(tier)];
  }

  function featureLabel(feature) {
    const labels = {
      'ai-notes': 'AI 咨询记录',
      'ai-analyze': 'AI 临床分析',
      'ai-report': 'AI 报告',
      'ai-detect': 'AI 逐字稿检测',
      'ai-supervise': 'AI 督导',
      'real-sup-ai': '真人督导 AI 分析',
      'ai-mindmap': 'AI 督导思维导图',
      'ai-masters': '大师会诊',
      'transcript-guide': '逐字稿对话引导',
      'ai-growth': 'AI 成长轨迹',
      'billing-calendar': '账单月历明细',
      'export-clean': '无水印导出',
      'premium-skins': '会员设计语言',
      'rag-vector': '向量语义检索',
      'rag-rerank': 'Rerank 精排',
      'custom-supervisors': '自定义督导师',
      'deep-case-mode': '深度个案模式',
    };
    return labels[feature] || feature;
  }

  function ragPolicy(stateOrTier) {
    const tier = typeof stateOrTier === 'string' ? normalizeTier(stateOrTier) : effectiveTier(stateOrTier);
    return RAG_POLICY[tier];
  }

  return Object.freeze({
    TIER_RANK,
    TIER_LABEL,
    FEATURE_MIN_TIER,
    RAG_POLICY,
    normalizeTier,
    effectiveTier,
    canUse,
    minimumTier,
    tierLabel,
    featureLabel,
    ragPolicy,
  });
});

