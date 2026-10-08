'use strict';
/* Pure session-template boundary. It never reads Store, IPC, network, or clinical content. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SessionTemplateViewModel = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var TIERS = Object.freeze({ FREE: 'Free', PRO: 'Pro', FLAGSHIP: 'Flagship' });
  var TIER_RANK = Object.freeze({ Free: 0, Pro: 1, Flagship: 2 });
  var LICENSE_RANK = Object.freeze({ free: 0, pro: 1, full: 1, custom: 2 });
  var CUSTOM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  var CONTEXTS = Object.freeze({ INDIVIDUAL: 'individual', SUPERVISION: 'supervision' });
  // feature：绑定 entitlements 注册表的功能键。权益判定（含试用期 allowlist）
  // 一律由调用方注入的 featureAllows 回调裁决，本模块不直接引用 XJEntitlements，
  // 以维持「纯边界、不读 Store/IPC/network」的既有约束。
  var TEMPLATES = Object.freeze([
    Object.freeze({ id: 'manual-session-v1', tier: 'Free', feature: 'manual-core', contexts: ['individual'], title: '基础手动记录', entries: ['主题', '观察', '下一步'], outline: '保留手动记录的主题、观察与下一步。' }),
    Object.freeze({ id: 'ai-session-v1', tier: 'Pro', feature: 'ai-notes', contexts: ['individual', 'supervision'], title: 'AI 辅助记录', entries: ['主题', '观察', '待核对'], outline: '提供有边界的 AI 辅助记录骨架；不会在此处调用模型。' }),
    Object.freeze({ id: 'flagship-session-v1', tier: 'Flagship', feature: 'custom-supervisors', contexts: ['individual', 'supervision'], title: '定制记录模板', entries: ['主题', '观察', '下一步', '品牌输出'], outline: '使用稳定的定制模板标识；模板正文和品牌资源不进入选择快照。' })
  ]);

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { freeze(value[key]); });
    return Object.freeze(value);
  }

  function tier(value) {
    if (value === 'Full') return 'Pro';
    if (value === 'custom' || value === 'Custom') return 'Flagship';
    return TIER_RANK[value] === undefined ? '' : value;
  }

  function fail(code, extra) { return freeze(Object.assign({ ok: false, code: code }, extra || {})); }

  function nowMs(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      var parsed = Date.parse(value);
      return isFinite(parsed) ? parsed : NaN;
    }
    return Date.now();
  }

  function expiryReason(state, now) {
    var value = state.expiresAt;
    if (value == null || value === '') value = state.expiry || state.validUntil;
    if (value == null || value === '') return '';
    var expiry = nowMs(value);
    if (!isFinite(expiry)) return 'malformed-license';
    return expiry <= now ? 'expired-license' : '';
  }

  function isRevoked(state) {
    return state.revoked === true || state.active === false || state.status === 'revoked' ||
      state.licenseStatus === 'revoked' || state.mode === 'revoked';
  }

  function normalizeLicenseState(state, at) {
    var current = state && typeof state === 'object' ? state : {};
    var now = nowMs(at);
    var trial = current.activated !== true && current.mode === 'trial' && current.aiUnlocked === true;
    var raw = typeof current.tier === 'string' ? current.tier.trim().toLowerCase() : '';
    var reason = '';
    var canonical = '';

    if (trial) {
      reason = 'trial-preview-only';
    } else if (current.activated !== true) {
      reason = Object.keys(current).length ? 'inactive-license' : 'missing-license';
    } else if (isRevoked(current)) {
      reason = 'revoked-license';
    } else if (current.mode === 'expired' || current.licenseStatus === 'expired') {
      reason = 'expired-license';
    } else if ((reason = expiryReason(current, now))) {
      // Fail closed for malformed or expired activation evidence.
    } else if (!Object.prototype.hasOwnProperty.call(LICENSE_RANK, raw)) {
      reason = 'unknown-tier';
    } else {
      canonical = raw === 'custom' ? 'Flagship' : (raw === 'pro' || raw === 'full' ? 'Pro' : 'Free');
    }

    return freeze({
      ok: true,
      tier: canonical || 'Free',
      effectiveTier: canonical || 'Free',
      trial: trial,
      preview: trial,
      activated: current.activated === true && !reason,
      valid: !reason || reason === 'trial-preview-only' ? (!reason || trial) : false,
      reason: reason || 'active-license',
      sourceTier: raw || 'free',
    });
  }

  function accessFor(options) {
    options = options || {};
    var hasState = Object.prototype.hasOwnProperty.call(options, 'licenseState') ||
      Object.prototype.hasOwnProperty.call(options, 'license') ||
      Object.prototype.hasOwnProperty.call(options, 'state');
    if (hasState) {
      var state = options.licenseState || options.license || options.state;
      return normalizeLicenseState(state, options.now);
    }
    if (Object.prototype.hasOwnProperty.call(options, 'tier')) {
      var legacy = tier(options.tier);
      if (!legacy) return freeze({ ok: false, code: 'unknown-tier' });
      return freeze({ ok: true, tier: legacy, effectiveTier: legacy, trial: false, preview: false, activated: true, valid: true, reason: 'legacy-tier', sourceTier: String(options.tier) });
    }
    return normalizeLicenseState({}, options.now);
  }

  function accessRank(access) {
    return access && TIER_RANK[access.effectiveTier] !== undefined ? TIER_RANK[access.effectiveTier] : 0;
  }

  function contextOf(value) {
    return value === 'supervision' ? 'supervision' : 'individual';
  }

  function requiredReason(item, access) {
    if (access && access.trial && item.tier !== 'Free') return 'trial-preview-only';
    if (item.tier === 'Flagship') return 'requires-flagship';
    if (item.tier === 'Pro') return 'requires-pro';
    return '';
  }

  // 试用期权益：由调用方注入的 featureAllows(featureKey) 裁决（通常绑定 App.canUse）。
  // 目的：试用期模板权益必须与 FEATURE_REGISTRY 的 trialEligible allowlist 完全一致，
  // 不能出现「模板说需会员、功能实际已解锁」的双体系分歧。
  // 回调缺失、抛错或返回非布尔时一律按不可用处理（fail-closed）。
  function trialFeatureAllows(item, options) {
    var allows = options && options.featureAllows;
    if (typeof allows !== 'function' || !item || !item.feature) return false;
    try {
      return allows(item.feature) === true;
    } catch (e) {
      return false;
    }
  }

  function list(options) {
    options = options || {};
    var access = accessFor(options);
    var current = access.ok ? access.effectiveTier : '';
    if (Object.prototype.hasOwnProperty.call(options, 'tier')) current = tier(options.tier);
    if (!current) return fail('unknown-tier');
    if (!access.ok) access = freeze({ ok: true, tier: current, effectiveTier: current, trial: false, preview: false, activated: true, valid: true, reason: 'legacy-tier', sourceTier: String(options.tier) });
    var context = contextOf(options.context);
    var includeLocked = options.includeLocked === true;
    var rows = TEMPLATES.filter(function (item) { return item.contexts.indexOf(context) >= 0; }).map(function (item) {
      var trialAllowed = !!(access.trial && trialFeatureAllows(item, options));
      var eligible = item.tier === 'Free' || trialAllowed || (!access.trial && accessRank(access) >= TIER_RANK[item.tier]);
      // 试用期仅在「权益已放行」时不显示预览锁定；未放行者仍按试用预览提示。
      var preview = !!(access.trial && item.tier !== 'Free' && !trialAllowed);
      var locked = !eligible;
      return Object.assign({}, item, {
        requiredTier: item.tier,
        eligible: eligible,
        locked: locked,
        preview: preview,
        trialAllowed: trialAllowed,
        lockedReason: locked ? requiredReason(item, access) : '',
      });
    });
    if (!includeLocked) rows = rows.filter(function (item) { return item.eligible; });
    return freeze({ ok: true, templates: rows, access: access, context: context });
  }

  function findTemplate(id, context) {
    return TEMPLATES.find(function (item) { return item.id === id && item.contexts.indexOf(context) >= 0; }) || null;
  }

  function select(id, options) {
    options = options || {};
    var available = list(Object.assign({}, options, { includeLocked: false }));
    if (!available.ok) return available;
    var item = available.templates.find(function (candidate) { return candidate.id === id; });
    function selectedItem(item) {
      return item ? freeze({ ok: true, template: item }) : fail('template-unavailable');
    }
    var picked = selectedItem(item);
    if (!picked.ok) return picked;
    return freeze({ ok: true, template: picked.template, access: available.access, context: available.context });
  }

  function normalizeCustomId(value) {
    if (value == null || value === '') return { ok: true, value: '' };
    if (typeof value !== 'string') return { ok: false };
    var trimmed = value.trim();
    return { ok: trimmed === '' || CUSTOM_ID_RE.test(trimmed), value: trimmed };
  }

  function normalizeSelection(value) {
    if (!value || typeof value !== 'object') return fail('selection-required');
    var templateId = typeof value.templateId === 'string' ? value.templateId.trim() : '';
    var template = TEMPLATES.find(function (item) { return item.id === templateId; });
    var tierAtSelection = tier(typeof value.tierAtSelection === 'string' ? value.tierAtSelection.trim() : '');
    var context = contextOf(value.context);
    if (!template || (value.context !== 'individual' && value.context !== 'supervision') || !tierAtSelection) return fail('selection-invalid');
    if (TIER_RANK[tierAtSelection] < TIER_RANK[template.tier]) return fail('selection-tier-mismatch');
    if (value.version && value.version !== 'session-template-selection-v1') return fail('selection-version-invalid');
    var custom = normalizeCustomId(value.customTemplateId);
    if (!custom.ok || (custom.value && templateId !== 'flagship-session-v1')) return fail('custom-template-invalid');
    return freeze({
      ok: true,
      selection: {
        version: 'session-template-selection-v1',
        templateId: templateId,
        tierAtSelection: tierAtSelection,
        context: context,
        appliedAt: typeof value.appliedAt === 'string' && value.appliedAt.trim() ? value.appliedAt.trim() : new Date().toISOString(),
        customTemplateId: custom.value,
      },
      template: template,
    });
  }

  function createSelection(id, options) {
    options = options || {};
    var picked = select(id, options);
    if (!picked.ok) return picked;
    var custom = normalizeCustomId(options.customTemplateId);
    if (!custom.ok || (custom.value && picked.template.id !== 'flagship-session-v1')) return fail('custom-template-invalid');
    return freeze({
      ok: true,
      selection: {
        version: 'session-template-selection-v1',
        templateId: picked.template.id,
        tierAtSelection: picked.template.tier,
        context: picked.context,
        appliedAt: typeof options.appliedAt === 'string' && options.appliedAt.trim() ? options.appliedAt.trim() : new Date().toISOString(),
        customTemplateId: custom.value,
      },
      template: picked.template,
      access: picked.access,
    });
  }

  function describeSelection(value, options) {
    var normalized = normalizeSelection(value);
    if (!normalized.ok) return normalized;
    var current = accessFor(options || {});
    if (!current.ok) return current;
    // 试用期权益同样交由注入的 featureAllows 裁决，与 list() 保持同一口径。
    var trialAllowed = !!(current.trial && trialFeatureAllows(normalized.template, options || {}));
    var eligible = trialAllowed || (!current.trial && accessRank(current) >= TIER_RANK[normalized.template.tier]);
    return freeze({
      ok: true,
      selection: normalized.selection,
      template: normalized.template,
      access: current,
      eligible: eligible,
      historical: !eligible,
      lockedReason: eligible ? '' : (current.trial ? 'trial-preview-only' : 'historical-license-unavailable'),
    });
  }

  function apply(template, sessionId) {
    if (!template || typeof template.id !== 'string') return fail('template-required');
    if (typeof sessionId !== 'string' || !sessionId.trim()) return fail('session-required');
    var entries = Array.isArray(template.entries) ? template.entries : [];
    if (!entries.length) return fail('template-empty');
    return freeze({ ok: true, draft: {
      version: 'session-template-draft-v1',
      templateId: template.id,
      sessionId: sessionId.trim(),
      entries: entries.map(function (label, index) { return { id: template.id + '-' + index, label: label, value: '' }; })
    } });
  }

  return {
    TIERS: TIERS,
    CONTEXTS: CONTEXTS,
    list: list,
    select: select,
    createSelection: createSelection,
    buildSelection: createSelection,
    normalizeSelection: normalizeSelection,
    describeSelection: describeSelection,
    normalizeLicenseState: normalizeLicenseState,
    apply: apply,
    PERSISTENCE_STATUS: 'PERSISTED',
  };
});
