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
    'js/masters-core.js',
    'js/agent-core.js',
    'js/agent-tools.js',
    'js/agent-shell.js'
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
      'js/masters-core.js': function () { return typeof MastersCore !== 'undefined'; },
      'js/agent-core.js': function () { return typeof AgentCore !== 'undefined'; },
      'js/agent-tools.js': function () { return typeof AgentTools !== 'undefined'; },
      'js/agent-shell.js': function () { return typeof AgentShell !== 'undefined'; }
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
    { key: 'consultations', label: '咨询记录', icon: 'calendar', href: 'consultations.html' },
    { key: 'clients', label: '来访者', icon: 'clients', href: 'clients.html' },
    { key: 'supervision', label: '督导', icon: 'cap', href: 'supervision.html' },
    { key: 'reports', label: '报告中心', icon: 'bars', href: 'reports.html' },
    { key: 'billing', label: '记账', icon: 'wallet', href: 'billing-shell.html' },
    { key: 'masters', label: '大师对话', icon: 'spark', href: 'masters.html' },
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
      'clients.html': 'clients',
      'client-detail.html': 'clients',
      'session.html': 'clients',
      'supervision.html': 'supervision',
      'reports.html': 'reports',
      'billing-shell.html': 'billing',
      'masters.html': 'masters',
      'settings.html': 'settings',
      'feedback.html': 'feedback',
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

    return `
      <aside class="sidebar">
        <div class="brand">
          <div class="mark">心</div>
          <div>
            <div class="name">心镜</div>
            <div class="en">Xinjing</div>
          </div>
        </div>
        <nav class="nav">${items}</nav>
        <div class="nav-spacer"></div>
        <div class="nav-footer">本地存储 · 数据不出本机</div>
      </aside>`;
  }

  function injectLayout(title, subtitle, headerActions = '') {
    document.getElementById('sidebar-mount').outerHTML = renderSidebar();
    const header = document.getElementById('page-header');
    if (header) {
      header.innerHTML = `
        <div>
          <h1>${title}</h1>
          ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
        </div>
        <div class="header-actions">${headerActions}</div>`;
    }
    document.title = `心镜 · ${title}`;
  }

  // ---------- 页面初始化门控 ----------
  // 统一流程：渲染布局 -> 等待数据从 IndexedDB 载入内存 -> 执行页面逻辑
  // 各页面 JS 通过 App.initPage({ title, subtitle, actions, onReady }) 接入
  async function initPage(opts) {
    opts = opts || {};
    if (opts.title) {
      injectLayout(opts.title, opts.subtitle || '', opts.actions || '');
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

  // ---------- 全局常驻：Agent 入口 FAB + Ctrl+K 命令面板 ----------
  const CMD_COMMANDS = [
    { label: '新建来访者', hint: '创建一位新的咨询来访者', run: function () {
        if (document.getElementById('client-modal')) App.openModal('client-modal');
        else location.href = 'index.html';
      } },
    { label: '记账', hint: '打开记账页面', run: function () { location.href = 'billing.html'; } },
    { label: 'AI 督导', hint: '打开 AI 督导页面', run: function () { location.href = 'supervision.html'; } },
    { label: '大师对话', hint: '打开大师对话页面', run: function () { location.href = 'masters.html'; } },
    { label: '报告', hint: '打开报告中心', run: function () { location.href = 'reports.html'; } },
    { label: '设置', hint: '打开设置页面', run: function () { location.href = 'settings.html'; } },
  ];
  const CMD_FAB_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/></svg>';

  function ensureAgentFab() {
    if (document.getElementById('xj-agent-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'xj-agent-fab';
    fab.className = 'xj-agent-fab';
    fab.type = 'button';
    fab.title = '唤起心镜 Agent（Ctrl+K 打开命令面板）';
    fab.setAttribute('aria-label', 'AI 助手');
    fab.innerHTML = CMD_FAB_SVG;
    fab.addEventListener('click', function () {
      if (typeof window.AgentOpen !== 'function') return;
      window.AgentOpen();
      // 浮窗首次打开时才创建，挂 observer：展开态隐藏 FAB，避免右下角重叠
      let tries = 0;
      const tick = function () {
        const p = document.querySelector('.xj-agent-panel');
        if (p) {
          const sync = function () {
            const hidden = p.classList.contains('xj-agent-visible') && !p.classList.contains('xj-agent-collapsed');
            fab.style.display = hidden ? 'none' : '';
          };
          sync();
          new MutationObserver(sync).observe(p, { attributes: true, attributeFilter: ['class'] });
        } else if (tries++ < 20) {
          setTimeout(tick, 50);
        }
      };
      setTimeout(tick, 60);
    });
    document.body.appendChild(fab);
  }

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
    ensureAgentFab();
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
    Theme,
  };
})();

if (typeof window !== 'undefined') {
  window.App = App;
}
