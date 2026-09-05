/* ============================================================
   心镜 XinJing — 公共模块
   职责：
   - 注入侧边栏导航（根据当前页面高亮）
   - 通用 UI：模态框、Toast、确认对话框
   - 工具函数：日期格式化、HTML 转义、标签渲染
   ============================================================ */

/* ------------------------------------------------------------
   全局脚本注入：确保 ai.js 与 agent 三件套在「每一页」都可用。
   历史问题：ai.js 此前只在 masters/session 页加载，导致督导页等页面
   window.AI 未定义 → supervision-core 调 AI.send 报「AI 模块未就绪」。
   这里在 app.js（每页都加载）顶部统一注入，已显式 <script> 加载过的不再重复。
   ------------------------------------------------------------ */
(function injectWorkbenchAssets() {
  if (!document.querySelector('link[href="css/workbench.css"]')) {
    var style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = 'css/workbench.css';
    document.head.appendChild(style);
  }
  if (!document.querySelector('link[href="css/xj-ui-system.css"]')) {
    var systemStyle = document.createElement('link');
    systemStyle.rel = 'stylesheet';
    systemStyle.href = 'css/xj-ui-system.css';
    document.head.appendChild(systemStyle);
  }
})();

// Shared runtime scripts are loaded statically before app.js on every business page.
// Deterministic ordering prevents duplicate top-level const declarations and race conditions.

const App = (() => {
  'use strict';

  // 主题引导：在 App 初始化即应用，避免整页刷新时浅/深色闪烁
  (function bootstrapTheme() {
    try {
      const t = localStorage.getItem('xj_theme');
      const dark = t === 'dark' || (t === null && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', !!dark);
    } catch (e) { /* localStorage 不可用时忽略 */ }
    // 旧皮肤值统一迁移到 01；XJ-5.1.9-ui-aligned-skin-stage1 起新增 aligned 默认皮肤（02 对齐），
    // 01/04/05 与旧标识行为不变（决策 B1：aligned 新默认，旧皮肤完整保留可切回）。
    try {
      const storedSkin = localStorage.getItem('xj_skin');
      const allowed = ['clinical', 'aligned', 'theatre', 'observatory'];
      const legacySkin = storedSkin === 'calm' || storedSkin === 'xinjing' || storedSkin === 'editorial';
      const skin = !legacySkin && allowed.indexOf(storedSkin) !== -1 ? storedSkin : 'aligned';
      localStorage.setItem('xj_skin', skin);
      document.documentElement.setAttribute('data-skin', skin);
    } catch (e) { document.documentElement.setAttribute('data-skin', 'aligned'); }
  })();

    // 皮肤管理（正交于 .dark 明暗切换）：skin=配色族，dark=明暗
  const Theme = {
    getSkin: function () {
      try {
        var skin = localStorage.getItem('xj_skin') || 'aligned';
        return ['clinical', 'aligned', 'theatre', 'observatory'].indexOf(skin) !== -1 ? skin : 'aligned';
      } catch (e) { return 'aligned'; }
    },
    setSkin: function (name) {
      if (['clinical', 'aligned', 'theatre', 'observatory'].indexOf(name) === -1) name = 'aligned';
      // aligned 为免费默认皮肤，不参与会员门控；theatre/observatory 维持 premium 门控。
      if ((name === 'theatre' || name === 'observatory') && !canUse('premium-skins')) {
        showToast('安静剧场与夜间观测为会员皮肤，可在方案对比中查看权益。', 'warning');
        return false;
      }
      try { localStorage.setItem('xj_skin', name); } catch (e) {}
      document.documentElement.setAttribute('data-skin', name);
      return true;
    },
  };

  // 激活档位 → 侧边栏「心」字 logo 变色（pro / 旧完整版 full = 金，custom 旗舰 = 彩）
  // 注意：preload 暴露的 window.__XJ__ 是初始化快照，激活后不会自动同步；
  // 我们改成通过 __XJ_API__.getState() 拉取权威状态并缓存，各页读 App.aiUnlocked()/App.getLicenseState()。
  let licenseStateCache = (window.__XJ__ && typeof window.__XJ__ === 'object' ? { ...window.__XJ__ } : {});
  const licenseStateCallbacks = [];
  let sidebarEntitlementsDirty = false;

  function updateLicenseState(state) {
    if (state && typeof state === 'object') licenseStateCache = state;
    piMembershipProjectionRevision += 1;
    sidebarEntitlementsDirty = true;
    // 会员门控降级：aligned（免费默认）与 clinical 不参与降级；theatre/observatory 维持降级到 clinical。
    if (!canUse('premium-skins') && Theme.getSkin() !== 'clinical' && Theme.getSkin() !== 'aligned') {
      try { localStorage.setItem('xj_skin', 'clinical'); } catch (e) {}
      document.documentElement.setAttribute('data-skin', 'clinical');
    }
    applyTierMark();
    refreshSidebarChrome();
    licenseStateCallbacks.forEach((cb) => { try { cb(licenseStateCache); } catch (e) {} });
  }

  async function refreshLicenseState() {
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.getState === 'function') {
        const state = await window.__XJ_API__.getState() || {};
        updateLicenseState(state);
      }
    } catch (e) { console.warn('[App] refreshLicenseState failed', e); }
  }

  function aiUnlocked() {
    return !!(licenseStateCache && licenseStateCache.aiUnlocked);
  }

  function hasAICompute() {
    if (aiUnlocked()) return true;
    try {
      return typeof AI !== 'undefined' && typeof AI.getTier === 'function' && AI.getTier() === 'user';
    } catch (e) { return false; }
  }

  function isTrial() {
    return !!(licenseStateCache && licenseStateCache.mode === 'trial');
  }

  function isPro() {
    var tier = (licenseStateCache && licenseStateCache.tier) || 'free';
    return tier === 'pro' || tier === 'full' || tier === 'custom';
  }

  function isCustom() {
    var tier = (licenseStateCache && licenseStateCache.tier) || 'free';
    return tier === 'custom';
  }

  function canUse(kind) {
    if (typeof XJEntitlements === 'undefined' || !XJEntitlements.canUse) {
      console.warn('[App] Entitlements module is not ready:', kind);
      return false;
    }
    return XJEntitlements.canUse(kind, licenseStateCache);
  }

  function featureGate(kind) {
    return canUse(kind);
  }

  function openFeaturePage(href, feature) {
    if (canUse(feature)) {
      location.href = href;
      return true;
    }
    openMembershipGate(feature);
    return false;
  }

  function lockBadge(kind) {
    if (canUse(kind)) return '';
    var minimum = (typeof XJEntitlements !== 'undefined' && XJEntitlements.minimumTier) ? XJEntitlements.minimumTier(kind) : 'pro';
    var label = minimum === 'custom' ? '旗舰' : '会员';
    return '<span class="xj-lock-badge" title="升级' + label + '解锁"><i data-lucide="lock-keyhole"></i>' + label + '</span>';
  }

  function membershipBadge() {
    var tier = (licenseStateCache && licenseStateCache.tier) || 'free';
    if (isTrial() && aiUnlocked()) return '<span class="xj-tier-badge">AI 试用</span>';
    if (tier === 'custom') return '<span class="xj-tier-badge custom">旗舰版</span>';
    if (tier === 'pro' || tier === 'full') return '<span class="xj-tier-badge pro">会员</span>';
    return '<span class="xj-tier-badge">免费版</span>';
  }

  function openPlans() {
    if (window.__XJ_API__ && typeof window.__XJ_API__.openActivation === 'function') window.__XJ_API__.openActivation();
    else location.href = 'activation.html';
  }

  function membershipTierLabel(tier) {
    if (tier === 'custom') return '旗舰版';
    if (tier === 'pro' || tier === 'full') return '会员';
    return '免费版';
  }

  function openMembershipGate(feature) {
    const key = String(feature || '');
    const entitlementsReady = typeof XJEntitlements !== 'undefined'
      && typeof XJEntitlements.featureLabel === 'function'
      && typeof XJEntitlements.minimumTier === 'function';
    const minimumTier = entitlementsReady ? XJEntitlements.minimumTier(key) : '';
    if (!key || !entitlementsReady || !['pro', 'full', 'custom'].includes(minimumTier)) {
      showToast('此功能的会员信息暂不可用，请稍后重试。', 'warning');
      return false;
    }
    if (canUse(key)) return true;

    const existing = document.getElementById('membership-gate-modal');
    if (existing) closeModalElement(existing);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'membership-gate-modal';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<div class="modal" style="max-width:440px" aria-labelledby="membership-gate-title" aria-describedby="membership-gate-summary">' +
      '<div class="modal-header"><h2 id="membership-gate-title">查看会员权益</h2></div>' +
      '<div class="modal-body"><p id="membership-gate-summary"></p><dl class="xj-membership-gate-details">' +
      '<div><dt>当前方案</dt><dd data-gate-current-tier></dd></div>' +
      '<div><dt>所需方案</dt><dd data-gate-required-tier></dd></div>' +
      '</dl><p class="hint" data-gate-preview></p></div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" type="button" data-modal-cancel>暂不查看</button>' +
      '<button class="btn btn-primary" type="button" data-gate-view-plans>查看方案</button></div></div>';
    document.body.appendChild(overlay);

    const label = String(XJEntitlements.featureLabel(key) || '此功能');
    const currentTier = isTrial() && aiUnlocked() ? 'AI 试用' : membershipTierLabel((licenseStateCache && licenseStateCache.tier) || 'free');
    overlay.querySelector('#membership-gate-summary').textContent = '“' + label + '”需要更高的会员权益才能使用。';
    overlay.querySelector('[data-gate-current-tier]').textContent = currentTier;
    overlay.querySelector('[data-gate-required-tier]').textContent = membershipTierLabel(minimumTier);
    overlay.querySelector('[data-gate-preview]').textContent = '查看方案后可比较权益；不会自动升级，也不会自动启用 AI。';
    overlay.querySelector('[data-gate-view-plans]').addEventListener('click', function () {
      closeModalElement(overlay);
      openPlans();
    });
    bindModalClose('membership-gate-modal');
    openModalElement(overlay, { removeOnClose: true, initialFocus: '[data-modal-cancel]' });
    return false;
  }

  function onLicenseStateChange(cb) {
    if (typeof cb === 'function') licenseStateCallbacks.push(cb);
  }

  function getLicenseState() {
    return licenseStateCache;
  }

  function applyTierMark() {
    const mark = document.querySelector('.brand .mark');
    if (!mark) return;
    const tier = licenseStateCache.tier || 'free';
    document.documentElement.setAttribute('data-tier', tier);
    mark.classList.remove('tier-pro', 'tier-custom', 'tier-full');
    if (tier === 'pro' || tier === 'full') mark.classList.add('tier-pro');
    else if (tier === 'custom') mark.classList.add('tier-custom');
  }

  var ACTIVE_CLIENT_CONTEXT_KEY = 'xj_active_client_id';

  function setActiveClientId(clientId) {
    if (!clientId) return;
    try { localStorage.setItem(ACTIVE_CLIENT_CONTEXT_KEY, String(clientId)); } catch (e) {}
  }

  function getActiveClientId() {
    try { return localStorage.getItem(ACTIVE_CLIENT_CONTEXT_KEY) || ''; } catch (e) { return ''; }
  }

  const NAV_ITEMS = [
    { key: 'workbench', label: '工作台', icon: 'home', href: 'index.html', group: 'clinical' },
    { key: 'calendar', label: '咨询日历', icon: 'bars', href: 'session-calendar.html', group: 'clinical' },
    { key: 'clients', label: '文档中心', icon: 'docCenter', href: 'doc-center.html', group: 'clinical' },
    { key: 'clinical', label: '临床材料', icon: 'calendar', href: 'consult-notes.html', group: 'clinical' },
    { key: 'supervision', label: '督导空间', icon: 'cap', href: 'supervision.html', group: 'clinical', feature: 'ai-supervise' },
    { key: 'masters', label: '大师对话', icon: 'spark', href: 'masters.html', group: 'clinical', feature: 'ai-masters' },
    { key: 'knowledge', label: '资料库', icon: 'doc', href: 'knowledge.html', group: 'clinical' },
    { key: 'billing', label: '记账', icon: 'wallet', href: 'billing-shell.html', group: 'management' },
    { key: 'settings', label: '设置', icon: 'gear', href: 'settings.html', group: 'management' },
  ];

  const CLINICAL_MATERIAL_ITEMS = [
    { label: '咨询记录', icon: 'calendar', href: 'consult-notes.html' },
    { label: '逐字稿整理', icon: 'transcript', href: 'transcript.html' },
    { label: '逐字稿引导', icon: 'guide', href: 'transcript-guide.html', feature: 'transcript-guide' },
    { label: '撰写报告', icon: 'report', href: 'report-writing.html' },
  ];

  const SUPERVISION_SPACE_ITEMS = [
    { label: 'AI 督导', icon: 'cap', href: 'supervision.html', feature: 'ai-supervise' },
    { label: '真人督导', icon: 'real', href: 'real-supervision.html' },
    { label: '人工督导分析', icon: 'realAI', href: 'real-supervision-ai.html', feature: 'real-sup-ai' },
    { label: '督导思维导图', icon: 'mindmap', href: 'supervision-mindmap.html', feature: 'ai-mindmap' },
  ];

  const ROUTE_REGISTRY = Object.freeze({
    'index.html': { domain: 'workbench', parent: 'index.html', sidebar: true, feature: 'manual-core' },
    'chat-home.html': { domain: 'workbench', parent: 'index.html', sidebar: true, feature: 'basic-assistant' },
    'session-calendar.html': { domain: 'calendar', parent: 'session-calendar.html', sidebar: true, feature: 'manual-core' },
    'doc-center.html': { domain: 'clients', parent: 'doc-center.html', sidebar: true, feature: 'manual-core' },
    'doc-growth.html': { domain: 'clients', parent: 'doc-center.html', sidebar: true, feature: 'ai-growth' },
    'consult-notes.html': { domain: 'clinical', parent: 'consult-notes.html', sidebar: true, feature: 'manual-core' },
    'transcript.html': { domain: 'clinical', parent: 'consult-notes.html', sidebar: true, feature: 'manual-core' },
    'transcript-guide.html': { domain: 'clinical', parent: 'consult-notes.html', sidebar: true, feature: 'transcript-guide' },
    'report-writing.html': { domain: 'clinical', parent: 'consult-notes.html', sidebar: true, feature: 'manual-core' },
    'supervision.html': { domain: 'supervision', parent: 'supervision.html', sidebar: true, feature: 'ai-supervise' },
    'supervision-mindmap.html': { domain: 'supervision', parent: 'supervision.html', sidebar: true, feature: 'ai-mindmap' },
    'real-supervision.html': { domain: 'supervision', parent: 'supervision.html', sidebar: true, feature: 'manual-core' },
    'real-supervision-ai.html': { domain: 'supervision', parent: 'supervision.html', sidebar: true, feature: 'real-sup-ai' },
    'masters.html': { domain: 'masters', parent: 'masters.html', sidebar: true, feature: 'ai-masters' },
    'knowledge.html': { domain: 'knowledge', parent: 'knowledge.html', sidebar: true, feature: 'manual-core' },
    'billing-shell.html': { domain: 'billing', parent: 'billing-shell.html', sidebar: true, feature: 'manual-core' },
    'billing-calendar.html': { domain: 'billing', parent: 'billing-shell.html', sidebar: true, feature: 'billing-calendar' },
    'settings.html': { domain: 'settings', parent: 'settings.html', sidebar: true, feature: 'manual-core' },
    'feedback.html': { domain: 'settings', parent: 'settings.html', sidebar: true, feature: 'manual-core' },
    'activation.html': { domain: 'settings', parent: 'settings.html', sidebar: false, feature: 'manual-core' },
    'confirm-close.html': { domain: 'settings', parent: 'settings.html', sidebar: false, feature: 'manual-core' },
    'migrate-helper.html': { domain: 'settings', parent: 'settings.html', sidebar: false, feature: 'manual-core' },
  });

  // 内联 SVG 图标集（stroke 1.6，currentColor，统一描边）
  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 4l9 6.5"/><path d="M5.2 9.4V20h13.6V9.4"/></svg>',
    clients: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.6 19a5.4 5.4 0 0 1 10.8 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M16.6 13.4A5.4 5.4 0 0 1 20.4 19"/></svg>',
    cap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-4 9 4-9 4-9-4z"/><path d="M7 11v4c0 1.5 2.2 2.6 5 2.6s5-1.1 5-2.6v-4"/><path d="M21 9v5.5"/></svg>',
    bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19V11"/><path d="M12 19V5"/><path d="M19 19v-8"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5h15a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H3z"/><path d="M3 7.5V5.5a2 2 0 0 1 2-2h11"/><circle cx="17" cy="13" r="1.3"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14-4.6L4 8.5"/><path d="M4 4.5v4h4"/><path d="M4 13a8 8 0 0 0 14 4.6l2-3.1"/><path d="M20 19.5v-4h-4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16v10.5H9.5L5.5 20V16H4z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 16h5"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z"/><path d="M4 7.5 12 11l8-3.5M12 11v9"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10M8 11l4 3 4-3"/><path d="M5 19h14"/></svg>',
    transcript: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M5 12h14M5 17h9"/></svg>',
    report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 16h5"/></svg>',
    real: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/></svg>',
    docCenter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v13H4z"/><path d="M8 4h8v3H8z"/><path d="M8 12h8M8 16h5"/></svg>',
  };

  const LUCIDE_ICONS = {
    home: 'house', clients: 'users-round', cap: 'graduation-cap', bars: 'calendar-days',
    wallet: 'wallet-cards', calendar: 'notebook-pen', sync: 'refresh-cw', gear: 'settings-2',
    chat: 'message-circle', search: 'search', doc: 'library-big', spark: 'sparkles',
    box: 'archive', download: 'download', transcript: 'audio-lines', report: 'file-text',
    real: 'handshake', realAI: 'clipboard-check', guide: 'message-circle',
    mindmap: 'brain-circuit', growth: 'chart-no-axes-combined', docCenter: 'folder-kanban', 'chevron-left': 'chevron-left',
    sun: 'sun', moon: 'moon', panel: 'message-square-text', userPlus: 'user-round-plus'
  };

  function svgIcon(name) {
    const icon = LUCIDE_ICONS[name] || name;
    return '<i data-lucide="' + icon + '" aria-hidden="true"></i>';
  }

  function getCurrentPageKey() {
    const path = location.pathname.split('/').pop() || 'index.html';
    return ROUTE_REGISTRY[path] ? ROUTE_REGISTRY[path].domain : 'workbench';
  }

  function applyPageIdentity() {
    if (!document.body) return;
    document.body.setAttribute('data-xj-page', getCurrentPageKey());
  }

  // 全局模型选择器：目录和价格来自服务端，选择仅持久化模型 ID + 目录版本。
  const modelSelectorState = { catalog: null, promise: null };
  const MODEL_SELECTOR_CACHE_KEY = 'xj_server_model_catalog_v1';
  const MODEL_SELECTOR_CACHE_TTL = 5 * 60 * 1000;
  const CLIENT_PRIMARY_MODEL_IDS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-5.6']);

  function selectedBuiltinModelId() {
    try {
      const settings = Store.getSettings() || {};
      const selection = settings.aiModelSelection;
      return selection && typeof selection.modelId === 'string' && CLIENT_PRIMARY_MODEL_IDS.has(selection.modelId)
        ? selection.modelId : 'deepseek-v4-pro';
    } catch (_) { return 'deepseek-v4-pro'; }
  }

  function modelStaticLabel(modelId) {
    return ({
      'deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek-v4-flash': 'DeepSeek V4 Flash',
      'gpt-5.6': 'GPT Terra',
    })[modelId] || modelId || '模型';
  }

  function modelPriceLabel(entry, catalog) {
    const fx = Number(catalog && catalog.fxRateUsdToCny) || 7;
    const input = (Number(entry.inputPrice) || 0) * fx;
    const output = (Number(entry.outputPrice) || 0) * fx;
    return '输入 ¥' + input.toFixed(2) + ' / 输出 ¥' + output.toFixed(2) + ' / 百万 token';
  }

  function normalizeModelCatalog(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.models) || !value.catalogRevision) return null;
    const models = value.models.filter(function (entry) {
      return entry && typeof entry.modelId === 'string' && CLIENT_PRIMARY_MODEL_IDS.has(entry.modelId) && entry.fallbackOnly !== true;
    }).map(function (entry) {
      return {
        modelId: entry.modelId,
        displayName: entry.displayName || modelStaticLabel(entry.modelId),
        provider: entry.provider || '',
        inputPrice: Number(entry.inputPrice) || 0,
        outputPrice: Number(entry.outputPrice) || 0,
        catalogRevision: entry.catalogRevision || value.catalogRevision,
      };
    });
    return models.length ? {
      catalogRevision: String(value.catalogRevision),
      fxRateUsdToCny: Number(value.fxRateUsdToCny) || 7,
      settlementCurrency: value.settlementCurrency || 'CNY',
      models: models,
    } : null;
  }

  function readCachedModelCatalog() {
    try {
      const cached = JSON.parse(localStorage.getItem(MODEL_SELECTOR_CACHE_KEY) || 'null');
      if (cached && cached.savedAt && Date.now() - cached.savedAt < MODEL_SELECTOR_CACHE_TTL) {
        modelSelectorState.catalog = normalizeModelCatalog(cached.value);
      }
    } catch (_) { /* 缓存损坏时重新拉取 */ }
  }

  function ensureServerModelCatalog(force) {
    if (!force && modelSelectorState.catalog && !modelSelectorState.promise) return Promise.resolve(modelSelectorState.catalog);
    if (!force && modelSelectorState.promise) return modelSelectorState.promise;
    const commercial = window.__XJ_API__ && window.__XJ_API__.commercial;
    if (!commercial || typeof commercial.getServerModelCatalog !== 'function') {
      return Promise.reject(new Error('服务器模型目录接口不可用'));
    }
    modelSelectorState.promise = Promise.resolve(commercial.getServerModelCatalog({})).then(function (result) {
      const value = normalizeModelCatalog(result && result.value);
      if (!result || result.ok !== true || !value) throw new Error('服务器模型目录不可用');
      modelSelectorState.catalog = value;
      try { localStorage.setItem(MODEL_SELECTOR_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), value: value })); } catch (_) {}
      updateModelSelectorChrome();
      return value;
    }).finally(function () { modelSelectorState.promise = null; });
    return modelSelectorState.promise;
  }

  function updateModelSelectorChrome() {
    const id = selectedBuiltinModelId();
    const label = modelSelectorState.catalog && modelSelectorState.catalog.models.find(function (entry) { return entry.modelId === id; });
    document.querySelectorAll('[data-xj-model-label]').forEach(function (node) {
      node.textContent = label ? label.displayName : modelStaticLabel(id);
    });
  }

  function openModelSelector() {
    const existing = document.getElementById('xj-model-selector-modal');
    if (existing) closeModalElement(existing);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'xj-model-selector-modal';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<div class="modal xj-model-selector-dialog" role="dialog" aria-modal="true" aria-labelledby="xj-model-selector-title">' +
      '<div class="modal-header"><h2 id="xj-model-selector-title">选择主力模型</h2></div>' +
      '<div class="modal-body"><p class="hint" data-model-selector-status>正在读取服务器模型目录…</p><div class="xj-model-options" role="listbox" aria-label="服务器可用主力模型"></div><p class="hint xj-model-fallback-note">主力上游失败时由服务器自动切换 Qwen 免费兜底，兜底不扣费。</p></div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" type="button" data-modal-cancel>关闭</button><button class="btn btn-secondary" type="button" data-model-selector-retry>重新读取</button></div></div>';
    document.body.appendChild(overlay);
    const status = overlay.querySelector('[data-model-selector-status]');
    const options = overlay.querySelector('.xj-model-options');
    function renderCatalog(catalog) {
      const selected = selectedBuiltinModelId();
      status.textContent = '价格来自服务器目录 · 版本 ' + catalog.catalogRevision;
      options.innerHTML = catalog.models.map(function (entry) {
        const active = entry.modelId === selected;
        return '<button class="xj-model-option' + (active ? ' is-selected' : '') + '" type="button" role="option" aria-selected="' + String(active) + '" data-model-id="' + escapeHtml(entry.modelId) + '">' +
          '<span class="xj-model-option-main"><strong>' + escapeHtml(entry.displayName) + '</strong><small>' + escapeHtml(entry.provider) + ' · ' + escapeHtml(modelPriceLabel(entry, catalog)) + '</small></span>' +
          '<span class="xj-model-option-check" aria-hidden="true">' + (active ? '当前' : '选择') + '</span></button>';
      }).join('');
      options.querySelectorAll('[data-model-id]').forEach(function (button) {
        button.addEventListener('click', function () {
          const modelId = button.getAttribute('data-model-id');
          button.disabled = true;
          const next = { modelId: modelId, catalogRevision: catalog.catalogRevision, savedAt: new Date().toISOString() };
          Promise.resolve(Store.saveSettingsDurable({ aiModelSelection: next })).then(function (result) {
            if (!result || result.ok !== true) throw new Error('模型选择未保存');
            updateModelSelectorChrome();
            try { window.dispatchEvent(new CustomEvent('xj:model-selection-changed')); } catch (_) {}
            closeModalElement(overlay);
            showToast('已切换到 ' + modelStaticLabel(modelId) + '，后续请求按服务器价格结算。', 'success');
          }).catch(function () {
            button.disabled = false;
            status.textContent = '保存失败，当前模型未改变，请重试。';
          });
        });
      });
    }
    function showError() {
      status.textContent = '无法读取服务器模型目录，请检查网络后重试。';
      options.innerHTML = '';
    }
    overlay.querySelector('[data-model-selector-retry]').addEventListener('click', function () {
      status.textContent = '正在重新读取服务器模型目录…';
      ensureServerModelCatalog(true).then(renderCatalog).catch(showError);
    });
    bindModalClose(overlay.id);
    openModalElement(overlay, { removeOnClose: true, initialFocus: '[data-modal-cancel]' });
    ensureServerModelCatalog(false).then(renderCatalog).catch(showError);
  }

  function renderSidebar() {
    const currentPath = location.pathname.split('/').pop() || 'index.html';
    const renderItem = function (item) {
      const active = item.href === currentPath ? ' active' : '';
      const locked = item.feature && !canUse(item.feature);
      return `<div class="nav-entry${active}">
        <a class="nav-item${active}" href="${item.href}" title="${item.label}">
          <span class="icon">${svgIcon(item.icon)}</span>
          <span class="label-text">${item.label}</span>
        </a>
        ${locked ? `<button class="nav-unlock" type="button" data-unlock-feature="${item.feature}" title="查看并解锁${item.label}" aria-label="查看并解锁${item.label}">${svgIcon('lock-keyhole')}</button>` : ''}
      </div>`;
    };
    const renderDisclosure = function (key, label, icon, entries) {
      const active = entries.some(function (item) { return item.href === currentPath; });
      var collapsed = !active;
      try {
        var saved = localStorage.getItem('xj_sidebar_group_' + key);
        if (saved != null) collapsed = saved === '1' && !active;
      } catch (e) {}
      return '<section class="nav-group nav-disclosure' + (collapsed ? ' is-collapsed' : '') + '">' +
        '<button class="nav-group-toggle" type="button" data-nav-group="' + key + '" aria-expanded="' + String(!collapsed) + '">' +
          '<span class="nav-group-title"><span class="icon">' + svgIcon(icon) + '</span><span class="nav-group-toggle-label">' + label + '</span></span>' +
          '<span class="nav-group-chevron">' + svgIcon('chevron-down') + '</span>' +
        '</button><div class="nav-group-body">' + entries.map(renderItem).join('') + '</div></section>';
    };
    const workspace = NAV_ITEMS.filter((item) => item.key === 'workbench' || item.key === 'calendar' || item.key === 'clients').map(renderItem).join('');
    const clinicalMaterials = CLINICAL_MATERIAL_ITEMS;
    const supervisionSpace = SUPERVISION_SPACE_ITEMS;
    const resources = NAV_ITEMS.filter((item) => item.key === 'masters' || item.key === 'knowledge').map(renderItem).join('') +
      renderItem({ label: '成长轨迹', icon: 'growth', href: 'doc-growth.html', feature: 'ai-growth' });
    const management = NAV_ITEMS.filter((item) => item.group === 'management').map(renderItem).join('');
    const items = '<div class="nav-group"><div class="nav-group-label">工作区</div>' + workspace + '</div>' +
      renderDisclosure('clinical-materials', '临床材料', 'calendar', clinicalMaterials) +
      renderDisclosure('supervision-space', '督导空间', 'cap', supervisionSpace) +
      '<div class="nav-group"><div class="nav-group-label">专业资源</div>' + resources + '</div>' +
      '<div class="nav-group"><div class="nav-group-label">执业管理</div>' + management + '</div>';
    // 读取折叠状态（默认展开）
    var collapsed = '';
    try { if (localStorage.getItem('xj_sidebar_collapsed') === '1') collapsed = ' collapsed'; } catch(e) {}

    return `
      <aside class="sidebar${collapsed}">
        <div class="brand">
          <img class="mark" src="vendor/xinjing-mark.png" alt="心镜">
          <div class="brand-text">
            <div class="name">心镜</div>
            <div class="en">Xinjing</div>
          </div>
        </div>
        <button class="sidebar-toggle" id="sidebar-toggle" aria-label="收起或展开侧栏" aria-expanded="${String(!collapsed)}">${svgIcon('chevron-left')}</button>
        <nav class="nav">${items}</nav>
        <div class="nav-spacer"></div>
        <div class="nav-footer">
          <button class="model-selector" id="xj-model-selector" type="button" title="选择主力模型" aria-label="选择主力模型">
            <span class="tt-icon">${svgIcon('spark')}</span><span class="model-selector-copy"><span class="model-selector-label">主力模型</span><span class="model-selector-current" data-xj-model-label>${escapeHtml(modelStaticLabel(selectedBuiltinModelId()))}</span></span>
          </button>
          <button class="theme-toggle" id="xj-theme-toggle">
            <span class="tt-icon">${svgIcon(document.documentElement.classList.contains('dark') ? 'moon' : 'sun')}</span>
            <span class="tt-label">${document.documentElement.classList.contains('dark') ? '深色模式' : '浅色模式'}</span>
          </button>
          <div class="nav-footer-text">本地存储，数据不出本机</div>
        </div>
      </aside>`;
  }

  function currentRoute() {
    const path = location.pathname.split('/').pop() || 'index.html';
    return ROUTE_REGISTRY[path] || null;
  }

  function ensureBusinessShell() {
    const route = currentRoute();
    if (!document.body || !route || !route.sidebar) return null;
    let mount = document.getElementById('sidebar-mount');
    if (mount || document.querySelector('.sidebar')) return mount;
    let layout = document.querySelector('body > .layout');
    if (layout) {
      mount = document.createElement('div');
      mount.id = 'sidebar-mount';
      layout.insertBefore(mount, layout.firstChild);
      return mount;
    }
    layout = document.createElement('div');
    layout.className = 'layout xj-auto-layout';
    mount = document.createElement('div');
    mount.id = 'sidebar-mount';
    const main = document.createElement('main');
    main.className = 'main xj-auto-main';
    Array.from(document.body.children).forEach(function (node) {
      if (node.tagName !== 'SCRIPT' && node !== layout) main.appendChild(node);
    });
    layout.appendChild(mount);
    layout.appendChild(main);
    document.body.insertBefore(layout, document.body.firstChild);
    return mount;
  }

  function bindSidebarControls() {
    const st = document.getElementById('sidebar-toggle');
    if (st && !st.dataset.bound) {
      st.dataset.bound = '1';
      st.addEventListener('click', function () {
        const sb = document.querySelector('.sidebar');
        if (!sb) return;
        sb.classList.toggle('collapsed');
        st.setAttribute('aria-expanded', String(!sb.classList.contains('collapsed')));
        try { localStorage.setItem('xj_sidebar_collapsed', sb.classList.contains('collapsed') ? '1' : '0'); } catch(e) {}
      });
    }
    const modelButton = document.getElementById('xj-model-selector');
    if (modelButton && !modelButton.dataset.bound) {
      modelButton.dataset.bound = '1';
      modelButton.addEventListener('click', openModelSelector);
    }
    updateModelSelectorChrome();
    document.querySelectorAll('.nav-unlock').forEach(function (button) {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', function () { openMembershipGate(button.dataset.unlockFeature); });
    });
    document.querySelectorAll('.nav-group-toggle').forEach(function (button) {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', function () {
        var group = button.closest('.nav-disclosure');
        if (!group) return;
        var collapsed = group.classList.toggle('is-collapsed');
        button.setAttribute('aria-expanded', String(!collapsed));
        try { localStorage.setItem('xj_sidebar_group_' + button.dataset.navGroup, collapsed ? '1' : '0'); } catch (e) {}
      });
    });
    const ttBtn = document.getElementById('xj-theme-toggle');
    if (ttBtn && !ttBtn.dataset.bound) {
      ttBtn.dataset.bound = '1';
      ttBtn.addEventListener('click', function () {
        const isDark = document.documentElement.classList.toggle('dark');
        try { localStorage.setItem('xj_theme', isDark ? 'dark' : 'light'); } catch (e) {}
        const icon = ttBtn.querySelector('.tt-icon');
        const label = ttBtn.querySelector('.tt-label');
        if (icon) icon.innerHTML = svgIcon(isDark ? 'moon' : 'sun');
        if (label) label.textContent = isDark ? '深色模式' : '浅色模式';
        if (window.IconSystem) window.IconSystem.render(ttBtn);
      });
    }
  }

  function refreshSidebarChrome(options) {
    const route = currentRoute();
    if (!route || !route.sidebar || !document.body) return;
    const mount = ensureBusinessShell();
    const sidebar = document.querySelector('.sidebar');
    const focusedUnlock = sidebar && document.activeElement && document.activeElement.classList.contains('nav-unlock')
      ? String(document.activeElement.dataset.unlockFeature || '') : '';
    // P0#1 修复：不再使用 outerHTML 替换侧栏（破坏焦点、事件绑定、皮肤切换状态）
    // 权益变化时仅更新导航内容，保留侧栏节点、收起状态和其余稳定控件。
    if (!sidebar && mount) {
      mount.innerHTML = renderSidebar();
    } else if (sidebar && sidebarEntitlementsDirty) {
      const nextShell = document.createElement('div');
      nextShell.innerHTML = renderSidebar();
      const nextNav = nextShell.querySelector('.nav');
      const nav = sidebar.querySelector('.nav');
      if (nav && nextNav) nav.innerHTML = nextNav.innerHTML;
    }
    sidebarEntitlementsDirty = false;
    bindSidebarControls();
    applyTierMark();
    if (window.IconSystem) window.IconSystem.render(document.querySelector('.sidebar'));
    if (focusedUnlock) {
      const restoredUnlock = Array.from(document.querySelectorAll('.nav-unlock')).find(function (button) {
        return button.dataset.unlockFeature === focusedUnlock;
      });
      if (restoredUnlock) requestAnimationFrame(function () { restoredUnlock.focus(); });
    }
  }

  function buildBackButton() {
    // 首页（工作台）不显示返回键——它就是顶层
    const path = location.pathname.split('/').pop() || 'index.html';
    if (path === 'index.html' || path === '' || path === '/') return '';
    // 智能判断返回目标：
    // - 如果有同源 referrer 且不是当前页，用 history.back()
    // - 否则回首页 index.html
    const ref = document.referrer;
    let onClick;
    try {
      const refUrl = ref ? new URL(ref, location.origin) : null;
      const sameOrigin = refUrl && refUrl.origin === location.origin && refUrl.pathname !== location.pathname;
      onClick = sameOrigin
        ? 'history.back();'
        : 'location.href="index.html";';
    } catch (e) {
      onClick = 'location.href="index.html";';
    }
    return `<button class="btn-back" onclick="${onClick}" aria-label="返回上一层">
      ${svgIcon('chevron-left')}
      <span class="btn-back-label">返回</span>
    </button>`;
  }

  function injectLayout(title, subtitle, headerActions = '', opts) {
    opts = opts || {};
    const route = currentRoute();
    if (route && route.sidebar) {
      document.body.classList.remove('xj-no-sidebar');
      refreshSidebarChrome();
    } else {
      var sm2 = document.getElementById('sidebar-mount');
      if (sm2) sm2.outerHTML = '';
      document.body.classList.add('xj-no-sidebar');
    }
    const header = document.getElementById('page-header');
    if (header) {
      const backBtn = buildBackButton();
      header.innerHTML = `
        <div>
          ${backBtn ? `<div class="back-row">${backBtn}</div>` : ''}
          <h1>${title}</h1>
          ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
        </div>
        <div class="header-actions">${headerActions}</div>`;
    }
    document.title = `心镜 · ${title}`;
    bindSidebarControls();
    if (window.IconSystem) window.IconSystem.render(document);
  }

  // ---------- 小镜页面上下文 ----------
  var PAGE_CAPABILITIES = {
    'index.html': ['查今日安排', '查欠费明细', '查本月收入', '查看待办', '跳转到各页面'],
    'consult-notes.html': ['记录咨询笔记', '切换笔记模板', '小镜帮你润色', '查询来访者资料'],
    'session-calendar.html': ['查看本月会谈', '按来访者筛选', '点击日跳转会话'],
    'supervision.html': ['生成整体印象', '深化分析', '技术建议', '移情分析', '邀请大师视角'],
    'real-supervision.html': ['整理真人督导记录', 'AI 分析逐字稿'],
    'billing-shell.html': ['查看收入统计', '月结', '预付费管理', '导出账单', '查欠费'],
    'masters.html': ['与大师 1v1 对话', '圆桌多大师讨论', '调节温度/详细度'],
    'knowledge.html': ['搜索资料库', '与资料对话', '管理知识文件'],
    'transcript.html': ['整理逐字稿', 'AI 检测识别错误'],
    'report-writing.html': ['撰写案例报告', 'AI 填充报告步骤', '分析模板结构'],
    'doc-center.html': ['查看来访者档案', '生成成长轨迹', '管理文档'],
    'settings.html': ['配置 AI 密钥', '切换主题', '管理数据备份'],
  };

  function _defaultPageCtx(title, path) {
    var fn = (path || '').split('/').pop() || '';
    var caps = PAGE_CAPABILITIES[fn] || [];
    return {
      title: title || fn.replace('.html', ''),
      path: fn,
      capabilities: caps
    };
  }

  function _fireEntryNotification(title, path) {
    if (typeof window === 'undefined') return;
    if (!window.__XJ_NOTIFY_FIRED__) window.__XJ_NOTIFY_FIRED__ = {};
    var fn = (path || '').split('/').pop() || '';
    if (window.__XJ_NOTIFY_FIRED__[fn]) return;
    window.__XJ_NOTIFY_FIRED__[fn] = true;
    try {
      if (typeof Store === 'undefined') return;
      var sessions = Store.getSessions();
      var clients = Store.getClients();
      var owing = clients.filter(function (c) {
        return Store.getSessionsByClient(c.id).some(function (s) {
          return s.billing && s.billing.fee > 0 && !s.billing.paid;
        });
      });
      var body = '';
      if (owing.length > 0) {
        body = owing.length + ' 位来访者有欠费待收';
      } else {
        var pendingReports = sessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).length;
        if (pendingReports > 0) body = pendingReports + ' 份逐字稿待整理';
      }
      if (body && window.__XJ_API__ && typeof window.__XJ_API__.notify === 'function') {
        window.__XJ_API__.notify('小镜提醒', body);
      }
    } catch (e) { /* ignore */ }
  }

  function _initXiaojingWhenReady(opts) {
    var tries = 0;
    function tryInit() {
      if (typeof XinJingChat !== 'undefined' && XinJingChat.build && typeof PageHints !== 'undefined') {
        try {
          // 双加载检测：若旧 xiaojing-panel.js 仍残留并抢注了全局 XiaojingPanel，
          // 而 XinJingChat 是其别名指向同一 api 对象则无害；若指向不同实现则告警。
          if (typeof XiaojingPanel !== 'undefined' && XiaojingPanel !== XinJingChat) {
            console.error('[xinjing-chat] 检测到旧 xiaojing-panel.js 与新模块并存（XiaojingPanel !== XinJingChat），初始化已统一走 XinJingChat。');
          }
          // 加载自检：校验统一对话面板的 API 表面完整
          if (typeof XinJingChat.selfTest === 'function') {
            var st = XinJingChat.selfTest();
            if (!st.ok) console.error('[xinjing-chat] selfTest 失败，缺失：' + (st.missing || []).join(', '));
          }
          XinJingChat.build();
          var ctx = opts.xjContext || _defaultPageCtx(opts.title, location.pathname);
          if (ctx) {
            window.__XJ_PAGE__ = ctx;
            XinJingChat.updateSub(ctx.title || '工作台助手');
          }
          if (typeof PageHints !== 'undefined' && PageHints.getHints) {
            var h = PageHints.getHints(location.pathname);
            if (h && h.length) XinJingChat.showNewHint();
          }
          _fireEntryNotification(opts.title, location.pathname);
        } catch (e) { console.warn('[xinjing-chat] init fail', e); }
      } else if (tries < 50) {
        tries++;
        setTimeout(tryInit, 50);
      }
    }
    tryInit();
  }

  // ---------- 页面初始化门控 ----------
  // 统一流程：渲染布局 -> 等待数据从 IndexedDB 载入内存 -> 执行页面逻辑
  // 各页面 JS 通过 App.initPage({ title, subtitle, actions, onReady }) 接入
  var piTransportInstalled = false;
  var piStoreProjectionRevision = 0;
  var piMembershipProjectionRevision = 0;
  var PI_SESSION_FIELDS = Object.freeze(['date', 'startTime', 'endTime', 'durationMinutes', 'transcript', 'soap', 'dap', 'reflection', 'summary', 'isConfirmed', 'templateSelection', 'billing', 'tags', 'notes']);
  var PI_SUPERVISION_FIELDS = Object.freeze(['type', 'supervisorName', 'date', 'sessionIds', 'content', 'conclusion', 'status', 'notes']);
  var PI_CLINICAL_REF_FIELDS = Object.freeze(['sourceId', 'sourceVersion', 'sourceContentHash', 'anchorContentHash']);
  var PI_CLINICAL_ENTRY_TYPES = Object.freeze(['transcript', 'soap', 'dap', 'reflection', 'summary', 'notes', 'content', 'conclusion']);

  function piFail(code, message) {
    return { ok: false, code: String(code || 'XJ_PI_DIRECT_WRITE_DENIED'), message: String(message || code || 'Pi durable operation rejected') };
  }

  function piVersionOf(value) {
    var parsed = Date.parse(String(value || ''));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  function piAllowedFields(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    var result = {};
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) {
      if (allowed.indexOf(keys[i]) < 0) return null;
      result[keys[i]] = input[keys[i]];
    }
    return result;
  }

  function piClinicalRefs(input) {
    if (!Array.isArray(input) || !input.length) return null;
    var out = [];
    for (var i = 0; i < input.length; i++) {
      var ref = input[i];
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
      var keys = Object.keys(ref);
      if (keys.length !== PI_CLINICAL_REF_FIELDS.length || keys.some(function (key) { return PI_CLINICAL_REF_FIELDS.indexOf(key) < 0; })) return null;
      if (!ref.sourceId || !String(ref.sourceVersion) || !ref.sourceContentHash || !ref.anchorContentHash) return null;
      out.push({ sourceId: String(ref.sourceId), sourceVersion: String(ref.sourceVersion), sourceContentHash: String(ref.sourceContentHash), anchorContentHash: String(ref.anchorContentHash) });
    }
    return out;
  }

  function piClinicalEntries(record) {
    if (!record || !Array.isArray(record.fields) || !record.fields.length) return null;
    var result = {};
    for (var i = 0; i < record.fields.length; i++) {
      var item = record.fields[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      var entryType = String(item.entryType || 'notes');
      if (PI_CLINICAL_ENTRY_TYPES.indexOf(entryType) < 0) return null;
      var text = String(item.text || item.content || '').trim();
      if (!text) return null;
      var target = entryType === 'content' ? 'notes' : entryType;
      if (target === 'soap' || target === 'dap') {
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          parsed = target === 'soap'
            ? { subjective: text, objective: '', assessment: '', plan: '' }
            : { data: text, assessment: '', plan: '' };
        }
        result[target] = parsed;
      } else {
        result[target] = result[target] ? String(result[target]) + '\n' + text : text;
      }
    }
    return result;
  }

  async function piClinicalDurableWrite(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return piFail('XJ_PI_INVALID_CONTEXT');
    var clientId = String(record.clientId || '');
    var sessionId = String(record.sessionId || '');
    var snapshotHash = String(record.snapshotHash || '');
    var sourceRefs = piClinicalRefs(record.sourceRefs);
    var fields = piClinicalEntries(record);
    if (!clientId || !sessionId || !snapshotHash || !sourceRefs || !fields) return piFail('XJ_PI_SNAPSHOT_MISMATCH');
    var kind = String(record.kind || 'session');
    var id = '';
    var value = null;
    var result = null;
    var versionHint = Date.now();
    var metadata = {
      schemaVersion: 1,
      clinicalActionRunId: String(record.clinicalActionRunId || ''),
      taskId: String(record.taskId || ''),
      clientId: clientId,
      sessionId: sessionId,
      snapshotHash: snapshotHash,
      sourceRefs: sourceRefs,
      generationEntitlement: String(record.generationEntitlement || 'manual'),
      version: versionHint,
      savedAt: versionHint,
    };
    if (!metadata.clinicalActionRunId || !metadata.taskId) return piFail('XJ_PI_INVALID_CONTEXT');
    if (kind === 'session') {
      if (!Store || typeof Store.getSession !== 'function' || typeof Store.saveSessionDurable !== 'function') return piFail('XJ_PI_DIRECT_WRITE_DENIED');
      var session = Store.getSession(sessionId);
      if (!session || String(session.clientId || '') !== clientId) return piFail('XJ_PI_CLIENT_SESSION_MISMATCH');
      value = Object.assign({}, session, fields, { piClinical: metadata });
      id = String(session.id || sessionId);
      result = await Store.saveSessionDurable(value);
    } else if (kind === 'supervision') {
      if (!Store || typeof Store.getSupervision !== 'function' || typeof Store.saveSupervisionDurable !== 'function') return piFail('XJ_PI_DIRECT_WRITE_DENIED');
      var supervision = Store.getSupervision(String(record.supervisionId || sessionId));
      if (!supervision) return piFail('XJ_PI_TASK_NOT_FOUND');
      value = Object.assign({}, supervision, fields, { piClinical: metadata });
      id = String(supervision.id);
      result = await Store.saveSupervisionDurable(value);
    } else {
      return piFail('XJ_PI_UNKNOWN_FIELD', 'unsupported clinical durable kind');
    }
    if (!result || result.ok !== true) return piFail(result && result.error && result.error.code || 'XJ_PI_DIRECT_WRITE_DENIED');
    return { ok: true, savedObjectId: id, version: versionHint, savedAt: versionHint, object: result.value || value };
  }

  function piClinicalDurableRead(payload) {
    var id = String(payload && payload.savedObjectId || '');
    if (!id || !Store) return piFail('XJ_PI_VERIFY_FAILED');
    var object = null;
    try {
      object = typeof Store.getSession === 'function' ? Store.getSession(id) : null;
      if (!object && typeof Store.getSupervision === 'function') object = Store.getSupervision(id);
    } catch (_) { object = null; }
    var meta = object && object.piClinical;
    if (!object || !meta || meta.schemaVersion !== 1) return piFail('XJ_PI_VERIFY_FAILED', 'clinical durable metadata unavailable');
    if (String(meta.clientId || '') !== String(object.clientId || '') && object.clientId != null) return piFail('XJ_PI_VERIFY_FAILED', 'clinical metadata ownership mismatch');
    var expected = payload && payload.expected && typeof payload.expected === 'object' ? payload.expected : null;
    if (expected) {
      if (expected.clientId && String(expected.clientId) !== String(meta.clientId)) return piFail('XJ_PI_VERIFY_FAILED', 'clinical client mismatch');
      if (expected.sessionId && String(expected.sessionId) !== String(meta.sessionId)) return piFail('XJ_PI_VERIFY_FAILED', 'clinical session mismatch');
      if (expected.snapshotHash && String(expected.snapshotHash) !== String(meta.snapshotHash)) return piFail('XJ_PI_VERIFY_FAILED', 'clinical snapshot mismatch');
    }
    return {
      ok: true,
      savedObjectId: id,
      version: Number(meta.version),
      savedAt: Number(meta.savedAt),
      clientId: String(meta.clientId || ''),
      sessionId: String(meta.sessionId || ''),
      snapshotHash: String(meta.snapshotHash || ''),
      sourceRefs: Array.isArray(meta.sourceRefs) ? meta.sourceRefs.map(function (ref) { return Object.assign({}, ref); }) : [],
      object: object,
    };
  }

  async function piDurableWrite(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return piFail('XJ_PI_UNKNOWN_FIELD');
    var kind = String(record.kind || '');
    var fields = null;
    var result = null;
    var value = null;
    var id = '';
    if (kind === 'session') {
      if (!record.clientId || !record.sessionId || !Store || typeof Store.getSession !== 'function' || typeof Store.saveSessionDurable !== 'function') return piFail('XJ_PI_DIRECT_WRITE_DENIED');
      var session = Store.getSession(String(record.sessionId));
      if (!session || String(session.clientId || '') !== String(record.clientId || '')) return piFail('XJ_PI_CLIENT_SESSION_MISMATCH');
      fields = piAllowedFields(record.fields, PI_SESSION_FIELDS);
      if (!fields) return piFail('XJ_PI_UNKNOWN_FIELD');
      value = Object.assign({}, session, fields);
      result = await Store.saveSessionDurable(value);
      id = String(session.id || record.sessionId);
    } else if (kind === 'supervision') {
      if (!Store || typeof Store.getSupervision !== 'function' || typeof Store.saveSupervisionDurable !== 'function') return piFail('XJ_PI_DIRECT_WRITE_DENIED');
      var supervision = Store.getSupervision(String(record.sessionId || record.supervisionId || ''));
      if (!supervision) return piFail('XJ_PI_TASK_NOT_FOUND');
      fields = piAllowedFields(record.fields, PI_SUPERVISION_FIELDS);
      if (!fields) return piFail('XJ_PI_UNKNOWN_FIELD');
      value = Object.assign({}, supervision, fields);
      result = await Store.saveSupervisionDurable(value);
      id = String(supervision.id);
    } else {
      return piFail('XJ_PI_UNKNOWN_FIELD', 'unsupported durable kind');
    }
    if (!result || result.ok !== true) return piFail(result && result.error && result.error.code || 'XJ_PI_DIRECT_WRITE_DENIED');
    var version = piVersionOf(result.version || value.updatedAt);
    if (!version) return piFail('XJ_PI_VERIFY_FAILED', 'durable version missing');
    return {
      ok: true,
      savedObjectId: id,
      version: version,
      object: { snapshotHash: String(record.snapshotHash || ''), version: version, kind: kind, id: id }
    };
  }

  function installPiRendererTransport() {
    if (piTransportInstalled || !window.__XJ_API__ || !window.__XJ_API__.piTransport) return;
    var transport = window.__XJ_API__.piTransport;
    if (typeof transport.onRequest !== 'function' || typeof transport.reply !== 'function') return;
    piTransportInstalled = true;
    transport.onRequest(function (request) {
      Promise.resolve().then(async function () {
        if (request.kind === 'durable-write') {
          if (request.payload && request.payload.clinicalActionRunId) return piClinicalDurableWrite(request.payload);
          return piDurableWrite(request.payload);
        }
        if (request.kind === 'durable-read') return piClinicalDurableRead(request.payload);
        return piFail('XJ_PI_UNKNOWN_EVENT', 'unsupported renderer request');
      }).then(function (response) {
        transport.reply(request.requestId, response && typeof response === 'object' ? response : piFail('XJ_PI_VERIFY_FAILED'));
      }).catch(function () {
        transport.reply(request.requestId, piFail('XJ_PI_DIRECT_WRITE_DENIED'));
      });
    });
    window.XJPiRuntime = Object.freeze({
      publishState: function (state) {
        if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
        return transport.publishState(state);
      },
      publishContext: function (projection, reads) {
        piStoreProjectionRevision += 1;
        return transport.publishState({
          projection: Object.assign({}, projection || {}, {
            storeProjectionVersion: Number.isSafeInteger(projection && projection.storeProjectionVersion)
              ? projection.storeProjectionVersion : piStoreProjectionRevision,
            membershipProjectionVersion: Number.isSafeInteger(projection && projection.membershipProjectionVersion)
              ? projection.membershipProjectionVersion : piMembershipProjectionRevision,
          }),
          reads: reads || {},
        });
      },
      revision: function () { return { store: piStoreProjectionRevision, membership: piMembershipProjectionRevision }; },
    });
  }

  // 页面级 Pi 接线钩子：只发布当前页面明确提供的 ClinicalContext 投影，
  // 不扫描全库、不创建第二套 Store writer。主进程会再次校验字段、会员和发送方。
  function publishPiContext(projection, reads) {
    if (!window.__XJ_API__ || !window.__XJ_API__.piTransport || typeof window.__XJ_API__.piTransport.publishState !== 'function') return false;
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return false;
    var payload = { projection: projection, reads: reads && typeof reads === 'object' && !Array.isArray(reads) ? reads : {} };
    try { return window.__XJ_API__.piTransport.publishState(payload) === true; } catch (_) { return false; }
  }

  function publishDefaultPiContext() {
    if (typeof Store === 'undefined' || typeof Store.getSessionsByClient !== 'function') return false;
    var clientId = getActiveClientId();
    if (!clientId) return false;
    var sessions = [];
    try { sessions = Store.getSessionsByClient(clientId) || []; } catch (_) { return false; }
    if (!sessions.length) return false;
    sessions = sessions.slice().sort(function (a, b) {
      return String(b && (b.updatedAt || b.date) || '').localeCompare(String(a && (a.updatedAt || a.date) || ''));
    });
    var session = sessions[0];
    if (!session || !session.id) return false;
    var refs = Array.isArray(session.sourceRefs) ? session.sourceRefs.map(function (ref) {
      if (!ref || typeof ref !== 'object') return null;
      if (!ref.sourceId || !Number.isSafeInteger(Number(ref.sourceVersion))) return null;
      if (typeof ref.sourceContentHash !== 'string' || typeof ref.anchorContentHash !== 'string') return null;
      return {
        sourceId: String(ref.sourceId),
        sourceVersion: Number(ref.sourceVersion),
        sourceContentHash: ref.sourceContentHash,
        anchorContentHash: ref.anchorContentHash,
      };
    }).filter(Boolean) : [];
    piStoreProjectionRevision += 1;
    return publishPiContext({
      clientId: String(clientId),
      sessionId: String(session.id),
      sourceRefs: refs,
      storeProjectionVersion: piStoreProjectionRevision,
      membershipProjectionVersion: Number.isSafeInteger(piMembershipProjectionRevision) ? piMembershipProjectionRevision : 0,
    }, {});
  }

  async function initPage(opts) {
    opts = opts || {};
    applyPageIdentity();
    if (opts.title) {
      injectLayout(opts.title, opts.subtitle || '', opts.actions || '', opts);
      applyTierMark(); // 侧边栏注入后按当前档位给「心」字 logo 上色（初始快照）
    }
    ensureConfirmModal();

    // 在页面逻辑运行前，通过 IPC 拉取权威授权状态，避免 window.__XJ__ 快照未同步导致 AI 锁误判
    await refreshLicenseState();

    // 确保数据已从 IndexedDB 载入内存缓存（对外仍是同步读写）
    if (window.Store && typeof Store.hydrate === 'function') {
      try {
        await Store.hydrate();
      } catch (e) {
        console.warn('[App] 数据加载失败，将使用空数据', e);
      }
    }
    installPiRendererTransport();
    if (opts.piContext) {
      try {
        var piContext = typeof opts.piContext === 'function' ? opts.piContext() : opts.piContext;
        if (piContext && typeof piContext === 'object') {
          publishPiContext(piContext.projection || piContext, piContext.reads || {});
        }
      } catch (_) { /* 页面未提供合法投影时保持主进程 fail-closed */ }
    } else {
      publishDefaultPiContext();
    }
    // 隐私诊断模块按固定本地顺序加载；页面无需逐一维护脚本标签。
    // 运行时在 Store hydrate 后恢复既有的明确同意状态，未同意时保持关闭。
    try {
      await loadPrivacyObservabilityModules();
      if (window.XJPrivacyObservabilityRuntime && typeof window.XJPrivacyObservabilityRuntime.initialize === 'function') {
        window.XJPrivacyObservabilityRuntime.initialize({ version: '4.2.4' });
      }
    } catch (_) {
      // 诊断能力不可用不应阻塞临床工作台启动，也不输出路径或原始异常。
      try { console.warn('[XJ privacy] 诊断模块未就绪'); } catch (ignored) {}
    }
    if (typeof opts.onReady === 'function') opts.onReady();

    if (window.IconSystem) window.IconSystem.render(document);

    // 小镜面板：页面就绪后自动构建 + 注册页面上下文 + 提示
    if (opts.noXiaojing !== true) {
      _initXiaojingWhenReady(opts);
    }

    // 订阅主进程激活广播，后续状态变化自动刷新缓存并通知各页
    if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
      window.__XJ_API__.onLicenseState((s) => { updateLicenseState(s); });
    }
  }

  // ---------- 工具函数 ----------

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var _privacyLoadPromise = null;
  function loadLocalScript(path) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = path;
      script.async = false;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('privacy-module-load-failed')); };
      (document.head || document.documentElement).appendChild(script);
    });
  }
  function loadPrivacyObservabilityModules() {
    if (typeof window === 'undefined') return Promise.resolve();
    if (window.XJPrivacyObservabilityRuntime) return Promise.resolve();
    if (_privacyLoadPromise) return _privacyLoadPromise;
    _privacyLoadPromise = Promise.resolve()
      .then(function () {
        return window.XJPrivacyObservabilityCore ? null : loadLocalScript('js/privacy-observability-core.js');
      })
      .then(function () {
        return window.XJPrivacyObservabilityBoundary ? null : loadLocalScript('js/privacy-observability-boundary.js');
      })
      .then(function () {
        return window.XJPrivacyObservabilityRuntime ? null : loadLocalScript('js/privacy-observability-runtime.js');
      });
    return _privacyLoadPromise;
  }

  function privacyRuntime() {
    return typeof window !== 'undefined' ? window.XJPrivacyObservabilityRuntime : null;
  }
  var PRIVACY_ERROR_CODES = [
    'UNKNOWN_FAILURE', 'APP_STARTUP_FAILED', 'RENDERER_EVENT_FAILED', 'STORAGE_READ_FAILED',
    'STORAGE_WRITE_FAILED', 'BACKUP_FAILED', 'AI_REQUEST_FAILED', 'NETWORK_REQUEST_FAILED',
    'IPC_REQUEST_FAILED', 'UPDATE_FAILED', 'SHUTDOWN_FAILED'
  ];
  var PRIVACY_STAGES = ['startup', 'renderer', 'storage-read', 'storage-write', 'backup', 'ai', 'network', 'ipc', 'update', 'shutdown'];
  var PRIVACY_RECOVERY_RESULTS = ['not-attempted', 'recovered', 'degraded', 'failed', 'cancelled'];
  function privacyModuleName(module) {
    return typeof module === 'string' ? module.toLowerCase() : '';
  }
  function privacyStage(module) {
    var name = privacyModuleName(module);
    if (name.indexOf('startup') !== -1 || name.indexOf('init') !== -1) return 'startup';
    if (name.indexOf('storage') !== -1 || name.indexOf('store') !== -1) return 'storage-read';
    if (name.indexOf('backup') !== -1 || name.indexOf('restore') !== -1) return 'backup';
    if (name.indexOf('ai') !== -1 || name.indexOf('model') !== -1) return 'ai';
    if (name.indexOf('network') !== -1 || name.indexOf('fetch') !== -1 || name.indexOf('request') !== -1) return 'network';
    if (name.indexOf('ipc') !== -1 || name.indexOf('bridge') !== -1) return 'ipc';
    if (name.indexOf('update') !== -1) return 'update';
    if (name.indexOf('shutdown') !== -1 || name.indexOf('close') !== -1) return 'shutdown';
    return 'renderer';
  }
  function privacyErrorCode(module, error) {
    var candidate = '';
    try { candidate = error && typeof error.code === 'string' ? error.code : ''; } catch (_) {}
    if (PRIVACY_ERROR_CODES.indexOf(candidate) !== -1) return candidate;
    var name = privacyModuleName(module);
    if (name.indexOf('startup') !== -1 || name.indexOf('init') !== -1) return 'APP_STARTUP_FAILED';
    if (name.indexOf('storage') !== -1 || name.indexOf('store') !== -1) return 'STORAGE_READ_FAILED';
    if (name.indexOf('backup') !== -1 || name.indexOf('restore') !== -1) return 'BACKUP_FAILED';
    if (name.indexOf('ai') !== -1 || name.indexOf('model') !== -1) return 'AI_REQUEST_FAILED';
    if (name.indexOf('network') !== -1 || name.indexOf('fetch') !== -1 || name.indexOf('request') !== -1) return 'NETWORK_REQUEST_FAILED';
    if (name.indexOf('ipc') !== -1 || name.indexOf('bridge') !== -1) return 'IPC_REQUEST_FAILED';
    if (name.indexOf('update') !== -1) return 'UPDATE_FAILED';
    if (name.indexOf('shutdown') !== -1 || name.indexOf('close') !== -1) return 'SHUTDOWN_FAILED';
    return 'RENDERER_EVENT_FAILED';
  }
  function privacyRecoveryResult(context) {
    try {
      var candidate = context && typeof context === 'object' ? context.recoveryResult : '';
      return PRIVACY_RECOVERY_RESULTS.indexOf(candidate) !== -1 ? candidate : 'not-attempted';
    } catch (_) { return 'not-attempted'; }
  }

  // 只保留固定匿名诊断枚举；原始 message、stack、context 和路径不再进入应用日志。
  function logError(module, err, context) {
    var errorCode = privacyErrorCode(module, err);
    var stage = privacyStage(module);
    var recoveryResult = privacyRecoveryResult(context);
    var runtimeApi = privacyRuntime();
    if (runtimeApi && typeof runtimeApi.recordError === 'function') {
      try { runtimeApi.recordError({ errorCode: errorCode, stage: stage, recoveryResult: recoveryResult }); } catch (_) {}
    }
    if (typeof console !== 'undefined' && console.error) {
      console.error('[XJ privacy diagnostic]', errorCode);
    }
  }
  function getErrorLog() {
    var runtimeApi = privacyRuntime();
    if (!runtimeApi || typeof runtimeApi.getErrorRecords !== 'function') return [];
    try { return runtimeApi.getErrorRecords(); } catch (_) { return []; }
  }

  function formatDate(isoOrStr, withYear = false) {
    if (!isoOrStr) return '';
    const d = new Date(isoOrStr);
    if (isNaN(d)) return isoOrStr;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    if (withYear) return `${d.getFullYear()}-${mm}-${dd}`;
    return `${mm}-${dd}`;
  }

  function todayStr() {
    return formatDate(new Date(), true);
  }

  function weekdayCN() {
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return days[new Date().getDay()];
  }

  function todayFullCN() {
    const d = new Date();
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${weekdayCN()}`;
  }

  function avatarText(name) {
    if (!name) return '?';
    return name.trim().charAt(0).toUpperCase();
  }

  function tagClassForReport(type) {
    const map = {
      soap: 'tag-soap',
      dap: 'tag-dap',
      reflection: 'tag-reflection',
      supervision: 'tag-supervision',
      transcript: 'tag-transcript',
    };
    return map[type] || 'tag-default';
  }

  function statusLabel(status) {
    return { active: '咨询中', paused: '暂停', ended: '已结束' }[status] || '未知';
  }

  function genderLabel(g) {
    return { male: '男', female: '女', other: '其他', unknown: '未填' }[g] || '未填';
  }

  // ---------- 标签渲染 ----------
  function renderTags(tags) {
    if (!tags || !tags.length) return '';
    return tags
      .map((t) => `<span class="tag tag-default">#${escapeHtml(t)}</span>`)
      .join(' ');
  }

  function renderReportTags(session) {
    const tags = [];
    if (session.hasTranscript) tags.push('<span class="tag tag-transcript">逐字稿</span>');
    if (session.hasSoap) tags.push('<span class="tag tag-soap">SOAP</span>');
    if (session.hasDap) tags.push('<span class="tag tag-dap">DAP</span>');
    if (session.hasReflection) tags.push('<span class="tag tag-reflection">反思</span>');
    if (session.isConfirmed) tags.push('<span class="tag tag-confirmed">✓已确认</span>');
    return tags.join(' ');
  }

  // ---------- Toast ----------
  function showToast(msg, type = '') {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2200);
  }

  // ---------- 模态框 ----------
  const modalStack = [];
  const MODAL_FOCUSABLE = [
    'button:not([disabled])', 'a[href]', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function focusableElements(root) {
    return Array.from(root.querySelectorAll(MODAL_FOCUSABLE)).filter(function (element) {
      return !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0;
    });
  }

  function modalEntry(overlay) {
    for (let index = modalStack.length - 1; index >= 0; index -= 1) {
      if (modalStack[index].overlay === overlay) return modalStack[index];
    }
    return null;
  }

  function openModalElement(overlay, options) {
    if (!overlay) return null;
    options = options || {};
    let entry = modalEntry(overlay);
    if (!entry) {
      const active = document.activeElement;
      entry = {
        overlay,
        returnFocus: active && active !== document.body && typeof active.focus === 'function' ? active : null,
        removeOnClose: options.removeOnClose === true,
        onClose: typeof options.onClose === 'function' ? options.onClose : null,
      };
      modalStack.push(entry);
    } else {
      if (options.removeOnClose === true) entry.removeOnClose = true;
      if (typeof options.onClose === 'function') entry.onClose = options.onClose;
    }
    overlay.setAttribute('role', overlay.getAttribute('role') || 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('show');
    document.body.classList.add('xj-modal-open');
    const preferred = options.initialFocus
      ? overlay.querySelector(options.initialFocus)
      : overlay.querySelector('[data-modal-cancel], .btn-ghost:not([disabled]), .cancel:not([disabled]), .close:not([disabled])');
    const target = preferred || focusableElements(overlay)[0] || overlay;
    if (target === overlay && !overlay.hasAttribute('tabindex')) overlay.setAttribute('tabindex', '-1');
    requestAnimationFrame(function () { try { target.focus(); } catch (error) {} });
    return overlay;
  }

  function closeModalElement(overlay) {
    if (!overlay) return false;
    const entry = modalEntry(overlay);
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    if (entry) modalStack.splice(modalStack.indexOf(entry), 1);
    if (modalStack.length === 0) document.body.classList.remove('xj-modal-open');
    else document.body.classList.add('xj-modal-open');
    const returnFocus = entry && entry.returnFocus;
    const onClose = entry && entry.onClose;
    if (entry && entry.removeOnClose && overlay.isConnected) overlay.remove();
    if (onClose) {
      try { onClose(); } catch (error) { console.error('[Modal] close cleanup failed', error); }
    }
    if (returnFocus) {
      requestAnimationFrame(function () {
        if (!document.contains(returnFocus)) return;
        try { returnFocus.focus(); } catch (error) {}
      });
    }
    return true;
  }

  function openModal(id, options) {
    return openModalElement(document.getElementById(id), options);
  }

  function closeModal(id) {
    return closeModalElement(document.getElementById(id));
  }

  function bindModalClose(id) {
    const overlay = document.getElementById(id);
    if (!overlay || overlay.dataset.xjModalBound === 'true') return;
    overlay.dataset.xjModalBound = 'true';
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closeModalElement(overlay);
    });
    overlay.querySelectorAll('.close, [data-modal-cancel]').forEach(function (button) {
      button.addEventListener('click', function () { closeModalElement(overlay); });
    });
  }

  document.addEventListener('keydown', function (e) {
    const entry = modalStack[modalStack.length - 1];
    if (!entry) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeModalElement(entry.overlay);
      return;
    }
    if (e.key === 'Tab') {
      const items = focusableElements(entry.overlay);
      if (!items.length) { e.preventDefault(); entry.overlay.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !entry.overlay.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  }, true);

  function ensureConfirmModal() {
    let overlay = document.getElementById('confirm-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'confirm-modal';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.innerHTML = '<div class="modal" style="max-width:420px" aria-labelledby="confirm-title" aria-describedby="confirm-message">' +
        '<div class="modal-header"><h2 id="confirm-title">请确认</h2></div>' +
        '<div class="modal-body"><p id="confirm-message"></p></div>' +
        '<div class="modal-footer"><button class="btn btn-ghost" type="button" data-modal-cancel>取消</button>' +
        '<button class="btn btn-primary" id="confirm-ok" type="button">确定</button></div></div>';
      document.body.appendChild(overlay);
    }
    const cancel = overlay.querySelector('.btn-ghost');
    if (cancel) cancel.setAttribute('data-modal-cancel', '');
    bindModalClose('confirm-modal');
    return overlay;
  }

  // ---------- 确认对话框 ----------
  function confirmDialog(message, onConfirm, danger = false) {
    const overlay = ensureConfirmModal();
    const messageNode = overlay.querySelector('#confirm-message');
    messageNode.textContent = String(message || '');
    const oldButton = overlay.querySelector('#confirm-ok');
    const button = oldButton.cloneNode(true);
    oldButton.parentNode.replaceChild(button, oldButton);
    button.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    button.textContent = danger ? '确认操作' : '确定';
    const cancel = overlay.querySelector('[data-modal-cancel]');
    button.addEventListener('click', async function () {
      if (button.disabled) return;
      const idleText = button.textContent;
      button.disabled = true;
      if (cancel) cancel.disabled = true;
      button.textContent = '处理中…';
      try {
        const result = typeof onConfirm === 'function' ? await onConfirm() : true;
        if (result === false) {
          button.disabled = false;
          if (cancel) cancel.disabled = false;
          button.textContent = idleText;
          return;
        }
        closeModalElement(overlay);
      } catch (error) {
        button.disabled = false;
        if (cancel) cancel.disabled = false;
        button.textContent = idleText;
        showToast('操作失败，请恢复后重试', 'error');
      }
    });
    openModalElement(overlay, { initialFocus: '[data-modal-cancel]' });
    return overlay;
  }

  // ---------- 下载 ----------
  function downloadFile(filename, content, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- Word 导出（真 .doc，MHTML 包装，无第三方库） ----------
  function wordDocShell(title, bodyHtml) {
    return '<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
      'xmlns="http://www.w3.org/TR/REC-html40"><head>' +
      '<meta charset="UTF-8">' +
      '<xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml>' +
      '<style>body{font-family:"Microsoft YaHei","SimSun",sans-serif;padding:32px;max-width:760px;line-height:1.9;color:#222}' +
      'h1,h2,h3{font-family:"Microsoft YaHei",serif;color:#5B639A;line-height:1.4}' +
      'h1{font-size:22px;border-bottom:2px solid #8B93C7;padding-bottom:8px}' +
      'h2{font-size:18px;margin-top:24px}h3{font-size:15px}' +
      'ul,ol{margin:8px 0 8px 24px}li{margin:4px 0}' +
      'strong{color:#333}table{border-collapse:collapse;width:100%;margin:10px 0}' +
      'td,th{border:1px solid #BBB;padding:6px 10px;font-size:13px}' +
      'pre{background:#F4F5FA;padding:12px;border-radius:6px;white-space:pre-wrap;font-family:Consolas,monospace;font-size:13px}' +
      'p{margin:8px 0}</style></head><body>' + bodyHtml + '</body></html>';
  }

  function exportWordDoc(filename, bodyHtml) {
    var html = wordDocShell(filename, bodyHtml || '');
    downloadFile(filename, html, 'application/msword');
  }

  // 保存报告到用户选择的路径（经主进程保存对话框），返回真实路径
  function saveReportFile(filename, bodyHtml) {
    var html = wordDocShell(filename, bodyHtml || '');
    return new Promise(function (resolve) {
      try {
        if (window.__XJ_API__ && typeof window.__XJ_API__.saveFileAs === 'function') {
          window.__XJ_API__.saveFileAs({ filename: filename, content: html, mime: 'application/msword' })
            .then(function (r) { resolve(r || { error: '无返回' }); })
            .catch(function (e) { resolve({ error: (e && e.message) || '保存失败' }); });
        } else {
          downloadFile(filename, html, 'application/msword');
          resolve({ path: '下载文件夹', filename: filename });
        }
      } catch (e) {
        try { downloadFile(filename, html, 'application/msword'); } catch (_) {}
        resolve({ path: '下载文件夹', filename: filename });
      }
    });
  }

  // 轻量 Markdown → Word 友好 HTML（# / ## / ###、**粗体** / *斜体* / 列表 / 表格）
  function mdToWordHtml(md) {
    if (!md) return '';
    var lines = String(md).replace(/\r\n/g, '\n').split('\n');
    var html = [];
    var listType = null; // 'ul' | 'ol'
    function closeList() {
      if (listType) { html.push('</' + listType + '>'); listType = null; }
    }
    function inline(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      var m;
      if (/^\|/.test(trimmed) && /\|/.test(trimmed)) {
        // 表格行
        closeList();
        var cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
        if (/^[-: ]+\|/.test(trimmed) || cells.every(function (c) { return /^[-: ]+$/.test(c); })) {
          // 分隔行，跳过
          continue;
        }
        if (html[html.length - 1] !== '<table>') html.push('<table>');
        html.push('<tr>' + cells.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>');
        continue;
      }
      if (html[html.length - 1] === '<table>') { html.push('</table>'); }
      if (m = trimmed.match(/^#\s+(.*)$/)) {
        closeList(); html.push('<h1>' + inline(m[1]) + '</h1>');
      } else if (m = trimmed.match(/^##\s+(.*)$/)) {
        closeList(); html.push('<h2>' + inline(m[1]) + '</h2>');
      } else if (m = trimmed.match(/^###\s+(.*)$/)) {
        closeList(); html.push('<h3>' + inline(m[1]) + '</h3>');
      } else if (m = trimmed.match(/^[-*]\s+(.*)$/)) {
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        html.push('<li>' + inline(m[1]) + '</li>');
      } else if (m = trimmed.match(/^\d+\.\s+(.*)$/)) {
        if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
        html.push('<li>' + inline(m[1]) + '</li>');
      } else if (trimmed === '') {
        closeList();
      } else {
        closeList(); html.push('<p>' + inline(line) + '</p>');
      }
    }
    closeList();
    if (html[html.length - 1] === '<table>') html.push('</table>');
    return html.join('');
  }

  function enableDragDrop(textareaOrSelector, opts) {
    var el = typeof textareaOrSelector === 'string' ? document.querySelector(textareaOrSelector) : textareaOrSelector;
    if (!el) return;
    opts = opts || {};
    var acceptExts = opts.accept || ['.txt', '.md', '.docx'];
    var onFile = opts.onFile || null;

    function isAccepted(file) {
      var name = file.name.toLowerCase();
      return acceptExts.some(function (ext) { return name.endsWith(ext); });
    }

    el.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.items) {
        var hasFile = Array.from(e.dataTransfer.items).some(function (it) { return it.kind === 'file'; });
        if (hasFile) el.classList.add('xj-dragover');
      } else {
        el.classList.add('xj-dragover');
      }
    });

    el.addEventListener('dragleave', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('xj-dragover');
    });

    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('xj-dragover');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var file = files[0];
      if (!isAccepted(file)) {
        App.showToast('不支持的文件格式，仅支持 ' + acceptExts.join(' / '), 'warning');
        return;
      }
      readFileAsText(file, function (text, err) {
        if (err) { App.showToast('文件读取失败：' + err, 'error'); return; }
        if (onFile) { onFile(text, file); return; }
        if (el.tagName === 'TEXTAREA') {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          App.showToast('已加载 ' + file.name, 'success');
        }
      });
    });
  }

  function readFileAsText(file, cb) {
    var name = file.name.toLowerCase();
    var reader = new FileReader();
    if (name.endsWith('.docx')) {
      if (typeof mammoth !== 'undefined') {
        reader.onload = function (ev) {
          mammoth.extractRawText({ arrayBuffer: ev.target.result }).then(function (r) {
            cb(r.value, null);
          }).catch(function () { cb(null, 'docx 解析失败'); });
        };
        reader.readAsArrayBuffer(file);
      } else {
        cb(null, 'docx 解析库未加载');
      }
    } else {
      reader.onload = function (ev) { cb(ev.target.result, null); };
      reader.readAsText(file, 'UTF-8');
    }
  }

  // ---------- 全局常驻：Ctrl+K 命令面板 ----------
  // Agent 呼吸球 (#6) 由 agent-shell.js 统一渲染（可拖动 + 全屏/小屏切换），app.js 不再注入 FAB
  const CMD_COMMANDS = [
    { label: '新建来访者', hint: '创建一位新的咨询来访者', run: function () {
        if (document.getElementById('client-modal')) App.openModal('client-modal');
        else location.href = 'consult-notes.html';
      } },
    { label: '记账', hint: '打开记账页面', run: function () { location.href = 'billing-shell.html'; } },
    { label: 'AI 督导', hint: '打开 AI 督导页面', run: function () { location.href = 'supervision.html'; } },
    { label: '大师对话', hint: '打开大师对话页面', run: function () { location.href = 'masters.html'; } },
    { label: '咨询记录', hint: '打开咨询记录工作区', run: function () { location.href = 'consult-notes.html'; } },
    { label: '设置', hint: '打开设置页面', run: function () { location.href = 'settings.html'; } },
  ];

  function ensureCmdPalette() {
    if (document.getElementById('xj-cmd-palette')) return;
    const root = document.createElement('div');
    root.id = 'xj-cmd-palette';
    root.className = 'xj-cmd-palette hidden';
    root.innerHTML =
      '<div class="xj-cmd-backdrop"></div>' +
      '<div class="xj-cmd-panel" role="dialog" aria-label="命令面板">' +
        '<input id="xj-cmd-input" class="xj-cmd-input" placeholder="输入命令，如：新建来访者、记账、督导…" autocomplete="off" spellcheck="false" />' +
        '<ul id="xj-cmd-list" class="xj-cmd-list"></ul>' +
        '<div class="xj-cmd-foot">↑↓ 选择 · ↵ 执行 · Esc 关闭</div>' +
      '</div>';
    document.body.appendChild(root);
    const input = root.querySelector('#xj-cmd-input');
    const list = root.querySelector('#xj-cmd-list');
    let sel = 0;
    function filterItems(q) {
      q = (q || '').trim().toLowerCase();
      return CMD_COMMANDS.filter(function (c) {
        return !q || c.label.toLowerCase().indexOf(q) !== -1 || (c.hint && c.hint.toLowerCase().indexOf(q) !== -1);
      });
    }
    function render(q) {
      const items = filterItems(q);
      if (sel >= items.length) sel = Math.max(0, items.length - 1);
      list.innerHTML = items.length
        ? items.map(function (c, i) {
            return '<li class="xj-cmd-item' + (i === sel ? ' active' : '') + '" data-i="' + i + '">' +
              '<span class="xj-cmd-dot"></span>' +
              '<span class="xj-cmd-label">' + App.escapeHtml(c.label) + '</span>' +
              '<span class="xj-cmd-hint">' + App.escapeHtml(c.hint) + '</span></li>';
          }).join('')
        : '<li class="xj-cmd-empty">无匹配命令</li>';
    }
    function open() {
      root.classList.remove('hidden');
      sel = 0; input.value = ''; render('');
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
    }
    function close() { root.classList.add('hidden'); }
    function exec() {
      const items = filterItems(input.value);
      if (!items.length) return;
      const cmd = items[sel] || items[0];
      close();
      try { cmd.run(); } catch (e) { /* ignore */ }
    }
    input.addEventListener('keydown', function (e) {
      const items = filterItems(input.value);
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(input.value); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(input.value); }
      else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); exec(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.addEventListener('input', function () { sel = 0; render(input.value); });
    list.addEventListener('click', function (e) {
      const li = e.target.closest('.xj-cmd-item'); if (!li) return;
      sel = parseInt(li.getAttribute('data-i'), 10) || 0; exec();
    });
    root.querySelector('.xj-cmd-backdrop').addEventListener('click', close);
    window.__xjOpenCmd = open;
    window.__xjCloseCmd = close;
  }

  // 启动时自动应用已保存的皮肤
  document.documentElement.setAttribute('data-skin', Theme.getSkin());
  readCachedModelCatalog();

  function setupGlobalChrome() {
    ensureCmdPalette();
    if (window.__xjCmdKeyBound) return;
    window.__xjCmdKeyBound = true;
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (window.__xjOpenCmd) window.__xjOpenCmd();
      }
    });
    document.addEventListener('click', function (e) {
      const link = e.target.closest('a[href]');
      if (!link) return;
      const page = (link.getAttribute('href') || '').split('?')[0];
      const gates = {
        'transcript-guide.html': 'transcript-guide',
        'supervision-mindmap.html': 'ai-mindmap',
        'real-supervision-ai.html': 'real-sup-ai',
        'doc-growth.html': 'ai-growth',
        'billing-calendar.html': 'billing-calendar',
      };
      const feature = gates[page];
      if (!feature || canUse(feature)) return;
      e.preventDefault();
      showToast('此功能需会员及以上方案，正在打开三档权益对比。', 'warning');
      setTimeout(openPlans, 180);
    }, true);
  }
  setupGlobalChrome();
  applyPageIdentity();
  refreshSidebarChrome();
  refreshLicenseState();

  return {
    NAV_ITEMS,
    ROUTE_REGISTRY,
    setActiveClientId,
    getActiveClientId,
    renderSidebar,
    injectLayout,
    refreshSidebarChrome,
    bindSidebarControls,
    initPage,
    loadPrivacyObservabilityModules,
    getPrivacyObservabilityState: function () {
      var runtimeApi = privacyRuntime();
      return runtimeApi && typeof runtimeApi.getState === 'function' ? runtimeApi.getState() : { ok: false, errorCode: 'not-initialized', value: null };
    },
    grantPrivacyConsent: function () {
      var runtimeApi = privacyRuntime();
      return runtimeApi && typeof runtimeApi.grantConsent === 'function' ? runtimeApi.grantConsent() : Promise.resolve({ ok: false, errorCode: 'not-initialized', value: null });
    },
    revokePrivacyConsent: function () {
      var runtimeApi = privacyRuntime();
      return runtimeApi && typeof runtimeApi.revokeConsent === 'function' ? runtimeApi.revokeConsent() : Promise.resolve({ ok: false, errorCode: 'not-initialized', value: null });
    },
    clearPrivacyDiagnostics: function () {
      var runtimeApi = privacyRuntime();
      return runtimeApi && typeof runtimeApi.clear === 'function' ? runtimeApi.clear() : { ok: false, errorCode: 'not-initialized', value: null };
    },
    exportPrivacyDiagnostics: function () {
      var runtimeApi = privacyRuntime();
      return runtimeApi && typeof runtimeApi.exportSupportReport === 'function' ? runtimeApi.exportSupportReport() : { ok: false, errorCode: 'not-initialized', value: null };
    },
    escapeHtml,
    logError,
    getErrorLog,
    formatDate,
    todayStr,
    todayFullCN,
    avatarText,
    svgIcon,
    tagClassForReport,
    statusLabel,
    genderLabel,
    renderTags,
    renderReportTags,
    showToast,
    openModal,
    closeModal,
    openModalElement,
    closeModalElement,
    bindModalClose,
    confirmDialog,
    downloadFile,
    exportWordDoc,
    saveReportFile,
    mdToWordHtml,
    enableDragDrop,
    readFileAsText,
    aiUnlocked,
    hasAICompute,
    canUse,
    featureGate,
    openFeaturePage,
    refreshLicenseState,
    publishPiContext,
    onLicenseStateChange,
    getLicenseState,
    isTrial,
    isPro,
    isCustom,
    lockBadge,
    membershipBadge,
    openPlans,
    openMembershipGate,
    Theme,
  };
})();

if (typeof window !== 'undefined') {
  window.App = App;
}

// v3.4.0：顶栏剩余次数（未激活用户可见）
// v3.7.2：修复已激活用户仍显示"激活会员"——build 前先拉权威授权状态，
//         并订阅授权变化，激活后自动移除配额条。
(function injectQuotaBar() {
  function isUnlocked() {
    try {
      if (typeof App === 'undefined') return false;
      // aiUnlocked 覆盖已激活会员 + 试用期解锁；tier 为付费档同样隐藏
      if (App.aiUnlocked && App.aiUnlocked()) return true;
      var tier = (App.getLicenseState && App.getLicenseState().tier) || '';
      return tier === 'pro' || tier === 'full' || tier === 'custom';
    } catch (e) { return false; }
  }

  function removeBar() {
    var old = document.getElementById('xj-quota-bar');
    if (old) old.remove();
    document.body.style.paddingTop = '';
    document.documentElement.style.removeProperty('--xj-top-offset');
  }

  function render() {
    if (location.pathname.includes('activation.html')) return;
    var showQuota = !isUnlocked();
    removeBar();
    document.documentElement.classList.toggle('xj-quota-reserved', showQuota);
    if (!showQuota) return; // 已激活/已解锁：不显示
    var bar = document.createElement('div');
    bar.id = 'xj-quota-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;height:24px;background:var(--accent-soft,#ECEEF9);display:flex;align-items:center;justify-content:center;font:11px var(--sans);color:var(--accent);gap:12px;border-bottom:1px solid var(--accent-line,#B5BDE0)';
    try {
      var q = (typeof AI !== 'undefined' && AI.getQuota) ? AI.getQuota() : null;
      if (q && q.percent != null) {
        bar.innerHTML = '今日剩余 <b>' + q.percent + '%</b> 额度 · <a href="activation.html" style="color:var(--accent);text-decoration:underline">激活后解锁全部</a>';
      } else {
        bar.innerHTML = '试用中 · <a href="activation.html" style="color:var(--accent);text-decoration:underline">激活会员</a>';
      }
    } catch (e) {
      bar.innerHTML = '试用中 · <a href="activation.html" style="color:var(--accent);text-decoration:underline">激活会员</a>';
    }
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.style.paddingTop = '24px';
    document.documentElement.style.setProperty('--xj-top-offset', '24px');
  }

  function build() {
    // The quota bar changes document geometry. Render its cached state while this
    // parser-blocking script still owns first paint, then reconcile asynchronously.
    render();
    try {
      if (typeof App !== 'undefined' && App.onLicenseStateChange) App.onLicenseStateChange(render);
      if (typeof App !== 'undefined' && App.refreshLicenseState) {
        Promise.resolve(App.refreshLicenseState()).then(render).catch(function () {});
      }
    } catch (e) {}
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build, { once: true });
})();

// v3.4.0：全局"＋新建来访"注入（所有页面的来访者下拉统一加）
(function injectNewClientOption() {
  var DROPDOWN_IDS = ['tp-client','sup-client','rs-client','rpt-client','sel-client','dc-client','bill-client'];
  function tryInject() {
    for (var i = 0; i < DROPDOWN_IDS.length; i++) {
      var el = document.getElementById(DROPDOWN_IDS[i]);
      if (el && !el.__xj_new_client_injected) {
        el.__xj_new_client_injected = true;
        if (typeof ClientModal !== 'undefined' && ClientModal.injectIntoDropdown) {
          ClientModal.injectIntoDropdown(el, function (client) {
            if (typeof App !== 'undefined' && App.showToast) App.showToast('已新增来访者「' + client.name + '」', 'success');
          });
        }
      }
    }
    // 首页"新建来访"按钮已由 index.html 顶栏提供（小镜旁边），此处不再重复注入
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInject, 500); });
  } else {
    setTimeout(tryInject, 500);
  }
})();
