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
(function injectGlobalScripts() {
  const list = [
    'js/ai.js',
    'js/prompts.builtin.js',
    'js/supervisors.js',
    'js/supervision-core.js',
    'js/masters-data.js',
    'js/knowledge.builtins.js',
    'js/masters-core.js',
    'js/agent-core.js',
    'js/agent-tools.js',
    'js/agent-shell.js',
    'js/memory.js',
    'js/persona-preamble.js',
    'js/client-modal.js',
    'js/xiaojing-panel.js',
    'js/page-hints.js'
  ];
  list.forEach(function (src) {
    // 双重守卫：typeof 检测全局是否已声明（防重复加载 const SyntaxError）
    // + querySelector 检测 <script> 标签是否已显式加载
    // 注意：typeof 对未声明的顶层 const/let 在 Script scope 安全返回 'undefined'
    var guards = {
      'js/ai.js': function () { return typeof AI !== 'undefined'; },
      'js/prompts.builtin.js': function () { return typeof PromptsBuiltin !== 'undefined'; },
      'js/supervisors.js': function () { return typeof Supervisors !== 'undefined'; },
      'js/supervision-core.js': function () { return typeof SupervisionCore !== 'undefined'; },
      'js/masters-data.js': function () { return typeof MASTERS !== 'undefined'; },
      'js/knowledge.builtins.js': function () { return typeof Knowledge !== 'undefined'; },
      'js/masters-core.js': function () { return typeof MastersCore !== 'undefined'; },
      'js/agent-core.js': function () { return typeof AgentCore !== 'undefined'; },
      'js/agent-tools.js': function () { return typeof AgentTools !== 'undefined'; },
      'js/agent-shell.js': function () { return typeof AgentShell !== 'undefined'; },
      'js/memory.js': function () { return typeof Memory !== 'undefined'; },
      'js/persona-preamble.js': function () { return typeof PersonaPreamble !== 'undefined'; },
      'js/client-modal.js': function () { return typeof ClientModal !== 'undefined'; },
      'js/xiaojing-panel.js': function () { return typeof XiaojingPanel !== 'undefined'; },
      'js/page-hints.js': function () { return typeof PageHints !== 'undefined'; }
    };
    if (guards[src] && guards[src]()) return;
    if (document.querySelector('script[src="' + src + '"]')) return;
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    document.head.appendChild(s);
  });
})();

const App = (() => {
  'use strict';

  // 主题引导：在 App 初始化即应用，避免整页刷新时浅/深色闪烁
  (function bootstrapTheme() {
    try {
      const t = localStorage.getItem('xj_theme');
      const dark = t === 'dark' || (t === null && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', !!dark);
    } catch (e) { /* localStorage 不可用时忽略 */ }
    // 皮肤引导：读取 localStorage 里的皮肤偏好，默认 calm（v1.2.0 静谧留白）
    try {
      const skin = localStorage.getItem('xj_skin') || 'calm';
      document.documentElement.setAttribute('data-skin', skin);
    } catch (e) { document.documentElement.setAttribute('data-skin', 'calm'); }
  })();

  // 皮肤管理（正交于 .dark 明暗切换）：skin=配色族，dark=明暗
  const Theme = {
    getSkin: function () { try { return localStorage.getItem('xj_skin') || 'calm'; } catch (e) { return 'calm'; } },
    setSkin: function (name) {
      try { localStorage.setItem('xj_skin', name); } catch (e) {}
      document.documentElement.setAttribute('data-skin', name);
    },
  };

  // 激活档位 → 侧边栏「心」字 logo 变色（pro / 旧完整版 full = 金，custom 旗舰 = 彩）
  // 注意：preload 暴露的 window.__XJ__ 是初始化快照，激活后不会自动同步；
  // 我们改成通过 __XJ_API__.getState() 拉取权威状态并缓存，各页读 App.aiUnlocked()/App.getLicenseState()。
  let licenseStateCache = (window.__XJ__ && typeof window.__XJ__ === 'object' ? { ...window.__XJ__ } : {});
  const licenseStateCallbacks = [];

  function updateLicenseState(state) {
    if (state && typeof state === 'object') licenseStateCache = state;
    applyTierMark();
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

  function featureGate(kind) {
    if (isPro()) return true;
    if (isTrial() && aiUnlocked()) {
      return true; // 试用期用户默认拥有全部权限（含旗舰功能）
    }
    return false;
  }

  function lockBadge(kind) {
    if (featureGate(kind)) return '';
    if (isTrial()) return '<span class="xj-lock-badge" title="激活会员后解锁">🔒 会员</span>';
    return '<span class="xj-lock-badge" title="试用已过期，请激活">🔒 已过期</span>';
  }

  function membershipBadge() {
    var tier = (licenseStateCache && licenseStateCache.tier) || 'free';
    if (tier === 'custom') return '<span class="xj-tier-badge custom">旗舰版</span>';
    if (tier === 'pro' || tier === 'full') return '<span class="xj-tier-badge pro">会员</span>';
    if (isTrial()) return '<span class="xj-tier-badge custom">旗舰版试用</span>';
    return '';
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
    mark.classList.remove('tier-pro', 'tier-custom', 'tier-full');
    if (tier === 'pro' || tier === 'full') mark.classList.add('tier-pro');
    else if (tier === 'custom') mark.classList.add('tier-custom');
  }

  const NAV_ITEMS = [
    { key: 'dashboard', label: '首页', icon: 'home', href: 'index.html' },
    { key: 'consultations', label: '咨询记录', icon: 'calendar', href: 'consult-notes.html' },
    { key: 'supervision', label: '督导', icon: 'cap', href: 'supervision.html' },
    { key: 'billing', label: '记账', icon: 'wallet', href: 'billing-shell.html' },
    { key: 'masters', label: '大师对话', icon: 'spark', href: 'masters.html' },
    { key: 'knowledge', label: '知识库', icon: 'doc', href: 'knowledge.html' },
    { key: 'settings', label: '设置', icon: 'gear', href: 'settings.html' },
    { key: 'feedback', label: '意见建议', icon: 'chat', href: 'feedback.html' },
  ];

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
  };

  function svgIcon(name) {
    return ICONS[name] || '';
  }

  function getCurrentPageKey() {
    const path = location.pathname.split('/').pop() || 'index.html';
    const map = {
      'index.html': 'dashboard',
      'supervision.html': 'supervision',
      'billing-shell.html': 'billing',
      'masters.html': 'masters',
      'knowledge.html': 'knowledge',
      'settings.html': 'settings',
      'feedback.html': 'feedback',
      'consult-notes.html': 'consultations',
    };
    return map[path] || 'dashboard';
  }

  function renderSidebar() {
    const current = getCurrentPageKey();
    const items = NAV_ITEMS.map((item) => {
      const active = item.key === current ? ' active' : '';
      return `<a class="nav-item${active}" href="${item.href}">
        <span class="icon">${svgIcon(item.icon)}</span>
        <span class="label-text">${item.label}</span>
      </a>`;
    }).join('');
    // 读取折叠状态（默认展开）
    var collapsed = '';
    try { if (localStorage.getItem('xj_sidebar_collapsed') === '1') collapsed = ' collapsed'; } catch(e) {}

    return `
      <aside class="sidebar${collapsed}">
        <div class="brand">
          <div class="mark">心</div>
          <div class="brand-text">
            <div class="name">心镜</div>
            <div class="en">Xinjing</div>
          </div>
        </div>
        <button class="sidebar-toggle" id="sidebar-toggle" title="收起/展开侧栏">◀</button>
        <nav class="nav">${items}</nav>
        <div class="nav-spacer"></div>
        <div class="nav-footer">
          <button class="theme-toggle" id="xj-theme-toggle">
            <span class="tt-icon">${document.documentElement.classList.contains('dark') ? '🌙' : '☀'}</span>
            <span class="tt-label">${document.documentElement.classList.contains('dark') ? '深色模式' : '浅色模式'}</span>
          </button>
          <div class="nav-footer-text" style="margin-top:8px;font-size:11px;color:var(--text-muted)">本地存储 · 数据不出本机</div>
        </div>
      </aside>`;
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
    return `<button class="btn-back" onclick="${onClick}" title="返回上一层" aria-label="返回上一层">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M15 5l-7 7 7 7"/></svg>
      <span class="btn-back-label">返回</span>
    </button>`;
  }

  function injectLayout(title, subtitle, headerActions = '', opts) {
    opts = opts || {};
    if (!opts.noSidebar) {
      var sm = document.getElementById('sidebar-mount');
      if (sm) sm.outerHTML = renderSidebar();
      var st = document.getElementById('sidebar-toggle');
      if (st) st.addEventListener('click', function () {
        var sb = document.querySelector('.sidebar');
        if (!sb) return;
        sb.classList.toggle('collapsed');
        try { localStorage.setItem('xj_sidebar_collapsed', sb.classList.contains('collapsed') ? '1' : '0'); } catch(e) {}
      });
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
    // 绑定暗色切换按钮（侧边栏底部 #7）
    const ttBtn = document.getElementById('xj-theme-toggle');
    if (ttBtn) {
      ttBtn.addEventListener('click', function () {
        const isDark = document.documentElement.classList.toggle('dark');
        try { localStorage.setItem('xj_theme', isDark ? 'dark' : 'light'); } catch (e) {}
        const icon = ttBtn.querySelector('.tt-icon');
        const label = ttBtn.querySelector('.tt-label');
        if (icon) icon.textContent = isDark ? '🌙' : '☀';
        if (label) label.textContent = isDark ? '深色模式' : '浅色模式';
      });
    }
  }

  // ---------- 页面初始化门控 ----------
  // 统一流程：渲染布局 -> 等待数据从 IndexedDB 载入内存 -> 执行页面逻辑
  // 各页面 JS 通过 App.initPage({ title, subtitle, actions, onReady }) 接入
  async function initPage(opts) {
    opts = opts || {};
    if (opts.title) {
      injectLayout(opts.title, opts.subtitle || '', opts.actions || '', opts);
      applyTierMark(); // 侧边栏注入后按当前档位给「心」字 logo 上色（初始快照）
    }
    bindModalClose('confirm-modal');

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
    if (typeof opts.onReady === 'function') opts.onReady();

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

  // L10 修复：统一错误日志——收集到内存环形缓冲，供调试和诊断包导出
  var _errorLog = [];
  var _ERROR_LOG_MAX = 100;
  function logError(module, err, context) {
    var entry = {
      ts: new Date().toISOString(),
      module: module || 'unknown',
      msg: (err && err.message) ? err.message : String(err || ''),
      stack: (err && err.stack) ? String(err.stack).slice(0, 500) : '',
      ctx: context || ''
    };
    _errorLog.push(entry);
    if (_errorLog.length > _ERROR_LOG_MAX) _errorLog.shift();
    if (typeof console !== 'undefined' && console.error) {
      console.error('[' + entry.module + ']', entry.msg, context || '');
    }
  }
  function getErrorLog() { return _errorLog.slice(); }

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
  function openModal(id) {
    const overlay = document.getElementById(id);
    if (overlay) overlay.classList.add('show');
  }

  function closeModal(id) {
    const overlay = document.getElementById(id);
    if (overlay) overlay.classList.remove('show');
  }

  function bindModalClose(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(id);
    });
    const closeBtn = overlay.querySelector('.close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeModal(id));
  }

  // ---------- 确认对话框 ----------
  function confirmDialog(message, onConfirm, danger = false) {
    const overlay = document.getElementById('confirm-modal');
    if (!overlay) return;
    overlay.querySelector('#confirm-message').textContent = message;
    const btn = overlay.querySelector('#confirm-ok');
    btn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      closeModal('confirm-modal');
      onConfirm();
    });
    openModal('confirm-modal');
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
  }
  setupGlobalChrome();

  return {
    NAV_ITEMS,
    renderSidebar,
    injectLayout,
    initPage,
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
    bindModalClose,
    confirmDialog,
    downloadFile,
    aiUnlocked,
    onLicenseStateChange,
    getLicenseState,
    isTrial,
    isPro,
    isCustom,
    featureGate,
    lockBadge,
    membershipBadge,
    Theme,
  };
})();

if (typeof window !== 'undefined') {
  window.App = App;
}

// v3.4.0：顶栏剩余次数（未激活用户可见）
(function injectQuotaBar() {
  function build() {
    if (location.pathname.includes('activation.html')) return;
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
    // 已激活用户不显示
    try {
      if (typeof App !== 'undefined' && App.aiUnlocked && App.aiUnlocked()) {
        var tier = (App.getLicenseState && App.getLicenseState().tier) || '';
        if (tier === 'pro' || tier === 'full' || tier === 'custom') return;
      }
    } catch (e) {}
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.style.paddingTop = '24px';
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(build, 100); });
  } else {
    setTimeout(build, 100);
  }
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
