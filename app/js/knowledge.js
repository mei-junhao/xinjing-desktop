/* ============================================================
   心镜 XinJing — 我的资料库页（v3.5.0-UI 复刻）
   单一页面 + 9 视图切换器：
     概览画廊(入口4) / 卡片(02) / 三栏(01) / 属性表(03) /
     沉浸阅读(06) / 搜索(07) / 知识图谱(05) / 资料对话(09) / 统计(10)
   去侧栏；暖色治愈系独立皮肤（CSS 在 knowledge.html）。
   数据源：window.UserDocs（getMeta / getFile / searchDetailed / getContextBlock），
   全部经主进程 fs、仅本机、零出网。
   ============================================================ */
(function () {
  'use strict';

  var esc = (window.App && App.escapeHtml) ? App.escapeHtml : function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // 视图定义（顺序即切换器顺序）；gallery 为入口4默认视图
  var MODES = [
    { key: 'gallery', label: '概览', icon: 'grid' },
    { key: 'cards', label: '卡片', icon: 'box' },
    { key: 'threecol', label: '三栏', icon: 'doc' },
    { key: 'table', label: '属性表', icon: 'bars' },
    { key: 'reading', label: '阅读', icon: 'doc' },
    { key: 'search', label: '搜索', icon: 'search' },
    { key: 'graph', label: '图谱', icon: 'spark' },
    { key: 'chat', label: '对话', icon: 'chat' },
    { key: 'stats', label: '统计', icon: 'bars' },
  ];

  // 分类固定配色；未命中则按 hash 取调色板
  var CAT_COLORS = {
    '温尼科特': '#2F8F83', '技术': '#E08D5B', '依恋': '#5B8DB8', '伦理': '#9B7CB0',
    '临床': '#C76B6B', '精神分析': '#2F8F83', '未分类': '#B0A593'
  };
  var PALETTE = ['#2F8F83', '#E08D5B', '#5B8DB8', '#9B7CB0', '#C76B6B', '#7BA05B', '#C9A24B', '#6B8FB0'];

  var state = {
    meta: null,
    mode: 'gallery',
    activeFile: null,
    activeCat: null,        // 三栏 / 卡片 分类过滤
    cardFilter: '',         // 卡片搜索
    tableSort: { key: 'title', dir: 1 },
    searchQ: '',
    chat: [],
    refsOn: null,           // Set(relPath)，对话侧栏引用开关，默认全选
    graphRAF: 0,
  };

  // 列表视图分页上限：超过此数的列表只渲染前 N 项 + 提示，避免 innerHTML 拼接卡死渲染线程
  var KB_LIST_MAX = 200;
  function capList(arr) {
    if (arr.length <= KB_LIST_MAX) return { items: arr, truncated: 0 };
    return { items: arr.slice(0, KB_LIST_MAX), truncated: arr.length - KB_LIST_MAX };
  }
  function truncationHint(n) {
    return '<div style="padding:10px 14px;margin-top:12px;border-radius:8px;background:var(--kb-bg-soft);color:var(--kb-ink-3);font:12.5px var(--kb-sans);text-align:center">仅显示前 ' + KB_LIST_MAX + ' 份，另有 ' + n + ' 份请用搜索查看</div>';
  }

  var view, stateBox, modesBox, folderLbl;

  // ---------- 工具 ----------
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function catColor(cat) {
    if (CAT_COLORS[cat]) return CAT_COLORS[cat];
    var h = 0; for (var i = 0; i < String(cat).length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function pillStyle(cat) { var c = catColor(cat); return 'background:' + hexA(c, 0.14) + ';color:' + c; }
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function relTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms), now = new Date();
    var day = 86400000;
    var sToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var sFile = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((sToday - sFile) / day);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 30) return diff + ' 天前';
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fileByRel(rel) {
    var fs = state.meta.files;
    for (var i = 0; i < fs.length; i++) if (fs[i].relPath === rel) return fs[i];
    return null;
  }

  // ---------- 入口 ----------
  document.addEventListener('DOMContentLoaded', function () {
    App.initPage({
      title: '我的资料库',
      subtitle: '本地课程资料 · 仅本机读取，数据不出本机',
      noSidebar: true, // 进入资料库不需要左侧侧边栏
      onReady: boot,
    });
  });

  function boot() {
    view = document.getElementById('kb-view');
    stateBox = document.getElementById('kb-state');
    modesBox = document.getElementById('kb-modes');
    folderLbl = document.getElementById('kb-folder');
    renderModes();
    document.getElementById('kb-pick').addEventListener('click', pickFolder);
    document.getElementById('kb-refresh').addEventListener('click', function () { loadMeta(true); });
    loadMeta(false);
    showFirstTimeGuide();
  }

  function showFirstTimeGuide() {
    try {
      var hasFolder = false;
      var cfg = {};
      if (typeof window !== 'undefined' && window.__XJ_API__ && typeof window.__XJ_API__.readUserDocConfig === 'function') {
        cfg = window.__XJ_API__.readUserDocConfig();
        hasFolder = !!(cfg && cfg.folder);
      }
      var guided = localStorage.getItem('kb_guided');
      if (hasFolder || guided) return;
      localStorage.setItem('kb_guided', '1');
      var guide = document.createElement('div');
      guide.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:400px;background:var(--paper-2,#fff);border:1px solid var(--border);border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:1000;text-align:center';
      guide.innerHTML = '<div style="font-size:24px;margin-bottom:12px">📚</div>' +
        '<div style="font-size:16px;font-weight:600;margin-bottom:8px;color:var(--ink)">欢迎使用资料库</div>' +
        '<div style="font-size:13px;color:var(--ink-2);line-height:1.6;margin-bottom:20px">资料库是你的私人知识库，你可以把课程讲义、文献资料放入一个文件夹，心镜会帮你检索和管理这些资料。资料仅在本机读取，不会上传。</div>' +
        '<div style="display:flex;gap:8px;justify-content:center">' +
          '<button style="padding:8px 16px;border:1px solid var(--border);border-radius:8px;font:13px var(--sans);cursor:pointer;background:var(--paper,#fff);color:var(--ink-2)" onclick="this.parentElement.parentElement.remove()">以后再说</button>' +
          '<button style="padding:8px 20px;border:none;border-radius:8px;font:600 13px var(--sans);cursor:pointer;background:var(--accent);color:#fff" onclick="document.getElementById(\'kb-pick\').click();this.parentElement.parentElement.remove()">选择文件夹</button>' +
        '</div>';
      document.body.appendChild(guide);
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.3);z-index:999';
      overlay.onclick = function () { guide.remove(); overlay.remove(); };
      document.body.appendChild(overlay);
    } catch (e) {}
  }

  // ---------- 模式切换器 ----------
  function renderModes() {
    modesBox.innerHTML = MODES.map(function (m) {
      return '<button class="kb-mode' + (m.key === state.mode ? ' active' : '') + '" data-mode="' + m.key + '">' +
        '<span class="mi">' + (App.svgIcon ? App.svgIcon(m.icon) : '') + '</span>' + esc(m.label) + '</button>';
    }).join('');
    Array.prototype.forEach.call(modesBox.querySelectorAll('.kb-mode'), function (b) {
      b.addEventListener('click', function () { switchMode(b.getAttribute('data-mode')); });
    });
  }
  function switchMode(key) {
    if (state.mode === key) return;
    stopGraph();
    hideGraphPop();
    state.mode = key;
    Array.prototype.forEach.call(modesBox.querySelectorAll('.kb-mode'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === key);
    });
    renderView();
  }

  // ---------- 数据加载（含 UserDocs 异步注入重试）----------
  function showState(html) { stateBox.style.display = 'block'; stateBox.innerHTML = html; view.style.display = 'none'; }
  function showView() { stateBox.style.display = 'none'; view.style.display = 'block'; }

  async function loadMeta(force) {
    showState('<div class="kb-spinner"></div><div>正在扫描资料文件夹…</div>');
    var _wEl = document.getElementById('kb-warn'); if (_wEl) _wEl.style.display = 'none';
    // preload 异步注入 userdocs.js：重试等待，避免 no-module 卡死
    var tries = 0;
    while (!(window.UserDocs && UserDocs.getMeta) && tries < 14) { await wait(300); tries++; }
    var meta;
    try {
      if (force && window.UserDocs && UserDocs.invalidateMeta) UserDocs.invalidateMeta();
      meta = await (window.UserDocs ? UserDocs.getMeta(force) : Promise.resolve({ ok: false, reason: 'no-module' }));
    } catch (e) { meta = { ok: false, reason: 'exception' }; }
    state.meta = meta;

    if (!meta || !meta.ok) {
      if (meta && meta.reason === 'no-folder') return renderEmptyNoFolder();
      return showState('<div class="big">无法读取资料</div><div>' + esc((meta && meta.reason) || '未知错误') +
        '</div><button class="kb-btn primary" onclick="document.getElementById(\'kb-pick\').click()">选择资料文件夹</button>');
    }
    folderLbl.textContent = meta.folder || '';
    updateTruncWarn(meta);
    if (!meta.files || !meta.files.length) {
      return showState('<div class="big">资料文件夹为空</div><div>在所选文件夹中放入 .md / .txt / .doc / .docx 课程资料后点「刷新」。</div>' +
        '<div style="margin-top:6px;font-size:12px">当前目录：' + esc(meta.folder || '') + '</div>');
    }
    if (!state.activeFile || !meta.files.some(function (f) { return f.relPath === state.activeFile; })) {
      state.activeFile = meta.files[0].relPath;
    }
    if (!state.refsOn) state.refsOn = new Set(meta.files.map(function (f) { return f.relPath; }));
    showView();
    renderView();
  }

  // 文件数超出性能上限时，在标题栏下方常驻提示（不会静默截断用户资料）
  function updateTruncWarn(meta) {
    var el = document.getElementById('kb-warn');
    if (!el) return;
    if (meta && meta.ok && meta.truncated) {
      var limit = meta.limit || 3000;
      var shown = (meta.stats && meta.stats.fileCount) || 0;
      el.style.display = 'block';
      el.innerHTML = '⚠️ 当前资料文件夹共 <b>' + (meta.totalFound || 0) + '</b> 份文件，受性能上限（' + limit +
        ' 份）约束，已接入前 <b>' + shown + '</b> 份。超出部分暂未纳入检索与 AI 注入，建议将资料拆分到多个子文件夹分别接入。';
    } else {
      el.style.display = 'none';
    }
  }

  function renderEmptyNoFolder() {
    folderLbl.textContent = '';
    showState(
      '<div class="big">还没有设置资料文件夹</div>' +
      '<div>选择一个本地文件夹，把你的课程讲义、笔记（.md / .txt / .doc / .docx）放进去。<br>心镜会在本机读取，用于资料浏览、检索，并在 AI 对话时作为你的私人知识库。<br><b>资料不会上传、不出本机。</b></div>' +
      '<button class="kb-btn primary" onclick="document.getElementById(\'kb-pick\').click()">选择资料文件夹</button>'
    );
  }

  async function pickFolder() {
    try {
      var folder = await window.__XJ_API__.selectUserDocFolder();
      if (!folder) return;
      if (window.UserDocs) { if (UserDocs.invalidateMeta) UserDocs.invalidateMeta(); if (UserDocs.refresh) UserDocs.refresh(); }
      state.activeFile = null; state.activeCat = null; state.refsOn = null;
      await loadMeta(true);
      App.showToast && App.showToast('已设置资料文件夹', 'success');
    } catch (e) { App.showToast && App.showToast('选择失败', 'error'); }
  }

  // ---------- 视图分发 ----------
  function renderView() {
    if (!state.meta || !state.meta.ok || !state.meta.files || !state.meta.files.length) return;
    stopGraph(); hideGraphPop();
    switch (state.mode) {
      case 'gallery': return renderGallery();
      case 'cards': return renderCards();
      case 'threecol': return renderThreeCol();
      case 'table': return renderTable();
      case 'reading': return renderReading();
      case 'search': return renderSearch();
      case 'graph': return renderGraph();
      case 'chat': return renderChat();
      case 'stats': return renderStats();
    }
  }

  /* ============================================================
     视图：概览 / 瀑布画廊（入口4，demo-04）
     ============================================================ */
  function renderGallery() {
    var s = state.meta.stats || {};
    var files = state.meta.files;
    var hero =
      '<div class="kb-gallery-hero">' +
        '<h1>我的资料库</h1>' +
        '<div class="sub">本地课程讲义 · 文献 · 笔记，仅在你的电脑上读取，随时检索并被动注入 AI 对话</div>' +
        '<div class="kb-gallery-stat"><span class="n">' + (s.fileCount || 0) + '</span><span class="l">份资料 · 已接入 AI</span></div>' +
        '<div class="kb-gsearch"><input id="kb-gs" placeholder="在资料库中搜索关键词…" autocomplete="off"><button class="kb-btn primary" id="kb-gs-go">搜索</button></div>' +
      '</div>';
    var capped = capList(files);
    var cards = capped.items.map(function (f) {
      return '<div class="kb-gcard" data-rel="' + esc(f.relPath) + '">' +
        '<div class="gtop"><span class="gt" style="' + pillStyle(f.category) + '">' + esc(f.category) + '</span>' +
        '<span class="badge"><span class="dot"></span>已接入</span></div>' +
        '<div class="ttl">' + esc(f.title) + '</div>' +
        '<div class="sum">' + esc(f.summary || '（无摘要）') + '</div>' +
        '<div class="fmeta"><span class="ftype">' + esc(f.fmt || 'md') + '</span><span>' + esc(f.name) + '</span><span>·</span><span>' + f.chars + ' 字</span></div>' +
        '</div>';
    }).join('') + (capped.truncated > 0 ? truncationHint(capped.truncated) : '');
    view.innerHTML = hero + '<div class="kb-masonry">' + cards + '</div>';
    Array.prototype.forEach.call(view.querySelectorAll('.kb-gcard'), function (c) {
      c.addEventListener('click', function () { state.activeFile = c.getAttribute('data-rel'); switchMode('reading'); });
    });
    var gs = document.getElementById('kb-gs');
    function go() { var v = gs.value.trim(); if (v) { state.searchQ = v; switchMode('search'); } }
    document.getElementById('kb-gs-go').addEventListener('click', go);
    gs.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  /* ============================================================
     视图 02 — 卡片（分类筛选 + 搜索 + 注入徽章，demo-02）
     ============================================================ */
  function filteredCards() {
    var cats = state.activeCat ? [state.activeCat] : null;
    var q = (state.cardFilter || '').trim().toLowerCase();
    return state.meta.files.filter(function (f) {
      if (cats && f.category !== state.activeCat) return false;
      if (q && (f.title + f.summary + f.name + f.category).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function renderCards() {
    var cats = state.meta.categories || [];
    var chips = '<button class="kb-chip' + (state.activeCat == null ? ' active' : '') + '" data-cat="">全部</button>' +
      cats.map(function (c) { return '<button class="kb-chip' + (state.activeCat === c.name ? ' active' : '') + '" data-cat="' + esc(c.name) + '">' + esc(c.name) + '</button>'; }).join('');
    var list = filteredCards();
    var capped = capList(list);
    var cards = capped.items.map(function (f) {
      return '<div class="kb-card" data-rel="' + esc(f.relPath) + '">' +
        '<span class="cat" style="' + pillStyle(f.category) + '">' + esc(f.category) + '</span>' +
        '<div class="t">' + esc(f.title) + '</div>' +
        '<div class="s">' + esc(f.summary || '（无摘要）') + '</div>' +
        '<div class="f"><span>' + esc(f.name) + '</span>' +
        '<span class="injected"><span class="dot"></span>' + f.chars + ' 字 · 已注入</span></div>' +
        '</div>';
    }).join('') || '<div style="color:var(--kb-ink-3);font:13px var(--kb-sans);padding:20px">没有匹配的资料</div>';
    if (capped.truncated > 0) cards += truncationHint(capped.truncated);
    view.innerHTML =
      '<div class="kb-filter">' + chips + '</div>' +
      '<div class="kb-toolrow"><input id="kb-csearch" placeholder="搜索标题 / 摘要 / 正文…" autocomplete="off">' +
      '<button class="kb-btn primary" id="kb-cadd">+ 添加资料</button></div>' +
      '<div class="kb-cards">' + cards + '</div>';
    Array.prototype.forEach.call(view.querySelectorAll('.kb-chip'), function (b) {
      b.addEventListener('click', function () {
        var c = b.getAttribute('data-cat'); state.activeCat = c === '' ? null : c; renderCards();
      });
    });
    document.getElementById('kb-cadd').addEventListener('click', function () { pickFolder(); });
    var cs = document.getElementById('kb-csearch');
    cs.value = state.cardFilter || '';
    cs.addEventListener('input', function () { state.cardFilter = cs.value; renderCards(); });
    Array.prototype.forEach.call(view.querySelectorAll('.kb-card'), function (c) {
      c.addEventListener('click', function () { state.activeFile = c.getAttribute('data-rel'); switchMode('reading'); });
    });
  }

  /* ============================================================
     视图 01 — 三栏（分类树 / 文件列表 / 阅读器 + 注入 badge，demo-01）
     ============================================================ */
  function renderThreeCol() {
    view.innerHTML =
      '<div class="kb-3col">' +
        '<div class="col c-tree" id="kb-tree"></div>' +
        '<div class="col c-list" id="kb-list"></div>' +
        '<div class="col kb-detail" id="kb-detail"></div>' +
      '</div>';
    renderCatTree();
    renderColList();
    renderColDetail();
  }
  function filesInCat() {
    if (state.activeCat == null) return state.meta.files;
    return state.meta.files.filter(function (f) { return f.category === state.activeCat; });
  }
  function renderCatTree() {
    var box = document.getElementById('kb-tree');
    if (!box) return;
    var cats = state.meta.categories || [];
    var html = '<div class="kb-catnode' + (state.activeCat == null ? ' active' : '') + '" data-cat=""><span class="cdot" style="background:var(--kb-ink-3)"></span>全部资料<span class="cnt">' + state.meta.files.length + '</span></div>';
    html += cats.map(function (c) {
      return '<div class="kb-catnode' + (state.activeCat === c.name ? ' active' : '') + '" data-cat="' + esc(c.name) + '">' +
        '<span class="cdot" style="background:' + catColor(c.name) + '"></span>' + esc(c.name) + '<span class="cnt">' + c.count + '</span></div>';
    }).join('');
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.kb-catnode'), function (n) {
      n.addEventListener('click', function () {
        var c = n.getAttribute('data-cat'); state.activeCat = c === '' ? null : c;
        var fl = filesInCat();
        if (fl.length && (!state.activeFile || !fl.some(function (x) { return x.relPath === state.activeFile; }))) state.activeFile = fl[0].relPath;
        renderCatTree(); renderColList(); renderColDetail();
      });
    });
  }
  function renderColList() {
    var box = document.getElementById('kb-list');
    if (!box) return;
    var files = filesInCat();
    if (!files.some(function (f) { return f.relPath === state.activeFile; })) state.activeFile = files.length ? files[0].relPath : null;
    var capped = capList(files);
    box.innerHTML = capped.items.map(function (f) {
      return '<div class="kb-li' + (f.relPath === state.activeFile ? ' active' : '') + '" data-rel="' + esc(f.relPath) + '">' +
        '<div class="t"><span class="bar" style="background:' + catColor(f.category) + '"></span>' + esc(f.title) + '</div>' +
        '<div class="m">' + esc(f.category) + ' · ' + f.chars + ' 字 · ' + f.headingCount + ' 节</div>' +
        '</div>';
    }).join('') || '<div style="color:var(--kb-ink-3);font-size:13px;padding:8px">该分类下无文件</div>';
    if (capped.truncated > 0) box.innerHTML += truncationHint(capped.truncated);
    Array.prototype.forEach.call(box.querySelectorAll('.kb-li'), function (li) {
      li.addEventListener('click', function () { state.activeFile = li.getAttribute('data-rel'); renderColList(); renderColDetail(); });
    });
  }
  async function renderColDetail() {
    var box = document.getElementById('kb-detail');
    if (!box) return;
    var f = fileByRel(state.activeFile);
    if (!f) { box.innerHTML = '<div style="color:var(--kb-ink-3)">选择左侧文件查看</div>'; return; }
    box.innerHTML = '<div class="kb-spinner"></div>';
    var r = await UserDocs.getFile(f.relPath);
    if (!r || !r.ok) { box.innerHTML = '<div style="color:var(--kb-ink-3)">无法读取：' + esc((r && r.reason) || '') + '</div>'; return; }
    box.innerHTML =
      '<h2>' + esc(f.title) + '</h2>' +
      '<div class="kb-inject-badge"><span class="dot"></span>已注入 AI 对话</div>' +
      '<div class="meta"><span>' + esc(f.category) + '</span><span>' + r.chars + ' 字</span><span>' + fmtBytes(r.size) + '</span><span>' + relTime(r.mtime) + '</span></div>' +
      '<div class="kb-md">' + renderMarkdown(r.text) + '</div>' +
      '<div class="footer">本资料已纳入「我的资料库」，将在小镜助手 / AI 督导 / 真人督导 / 大师对话等场景作为上下文自动注入。仅本机读取，不上传。</div>';
  }

  /* ============================================================
     视图 03 — 属性表（Notion 风 + 已注入 + 格式 + 相对时间，demo-03）
     ============================================================ */
  function renderTable() {
    var cols = [
      { key: 'title', label: '标题' }, { key: 'category', label: '分类' },
      { key: 'chars', label: '字数' }, { key: 'headingCount', label: '章节' },
      { key: 'mtime', label: '修改' }, { key: 'injected', label: '已注入' }, { key: 'fmt', label: '格式' },
    ];
    var files = state.meta.files.slice();
    var sk = state.tableSort.key, sd = state.tableSort.dir;
    files.sort(function (a, b) {
      var x = a[sk], y = b[sk];
      if (typeof x === 'string') return x.localeCompare(y, 'zh') * sd;
      return ((x || 0) - (y || 0)) * sd;
    });
    var capped = capList(files);
    var rows = capped.items.map(function (f) {
      return '<tr data-rel="' + esc(f.relPath) + '">' +
        '<td class="tt">' + esc(f.title) + '</td>' +
        '<td><span class="kb-pill" style="' + pillStyle(f.category) + '">' + esc(f.category) + '</span></td>' +
        '<td>' + f.chars + '</td>' +
        '<td>' + f.headingCount + '</td>' +
        '<td class="rel">' + relTime(f.mtime) + '</td>' +
        '<td class="kb-inj' + (f.injected ? '' : ' no') + '">' + (f.injected ? '✓' : '—') + '</td>' +
        '<td><span class="kb-fmt" style="background:' + hexA(f.fmt === 'md' ? '#2F8F83' : '#E08D5B', 0.14) + ';color:' + (f.fmt === 'md' ? '#2F8F83' : '#E08D5B') + '">' + esc(f.fmt || 'md') + '</span></td>' +
        '</tr>';
    }).join('');
    if (capped.truncated > 0) {
      rows += '<tr><td colspan="' + cols.length + '" style="padding:10px 14px;background:var(--kb-bg-soft);color:var(--kb-ink-3);font:12.5px var(--kb-sans);text-align:center">仅显示前 ' + KB_LIST_MAX + ' 份，另有 ' + capped.truncated + ' 份请用搜索查看</td></tr>';
    }
    var s = state.meta.stats || {};
    view.innerHTML =
      '<div class="kb-notionbar"><input id="kb-tsearch" placeholder="筛选资料…" autocomplete="off"><span style="font:12.5px var(--kb-sans);color:var(--kb-ink-3)">属性表</span></div>' +
      '<div class="kb-ntable-wrap"><table class="kb-ntable"><thead><tr>' + cols.map(function (c) {
        var arrow = sk === c.key ? (sd > 0 ? ' ▲' : ' ▼') : '';
        return '<th data-key="' + c.key + '">' + esc(c.label) + arrow + '</th>';
      }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="kb-ntable-sum">共 ' + (s.fileCount || 0) + ' 份 · ' + (s.totalChars || 0).toLocaleString() + ' 字 · ' + (s.categoryCount || 0) + ' 个分类 · 全部已接入 AI</div></div>';
    Array.prototype.forEach.call(view.querySelectorAll('th'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-key');
        if (state.tableSort.key === k) state.tableSort.dir *= -1;
        else { state.tableSort.key = k; state.tableSort.dir = 1; }
        renderTable();
      });
    });
    var ts = document.getElementById('kb-tsearch');
    ts.addEventListener('input', function () {
      var q = ts.value.trim().toLowerCase();
      Array.prototype.forEach.call(view.querySelectorAll('tbody tr'), function (tr) {
        var f = fileByRel(tr.getAttribute('data-rel'));
        tr.style.display = (!q || (f.title + f.category + f.name).toLowerCase().indexOf(q) !== -1) ? '' : 'none';
      });
    });
    Array.prototype.forEach.call(view.querySelectorAll('tbody tr'), function (tr) {
      tr.addEventListener('click', function () { state.activeFile = tr.getAttribute('data-rel'); switchMode('reading'); });
    });
  }

  /* ============================================================
     视图 06 — 沉浸阅读（TOC + 进度条，demo-06）
     ============================================================ */
  async function renderReading() {
    var f = fileByRel(state.activeFile) || state.meta.files[0];
    state.activeFile = f.relPath;
    var cappedOpts = capList(state.meta.files);
    view.innerHTML =
      '<div class="kb-read"><div class="picker"><select id="kb-read-sel">' +
      cappedOpts.items.map(function (x) {
        return '<option value="' + esc(x.relPath) + '"' + (x.relPath === f.relPath ? ' selected' : '') + '>' + esc(x.title) + '　·　' + esc(x.category) + '</option>';
      }).join('') + '</select>' + (cappedOpts.truncated > 0 ? '<span style="font:11px var(--kb-sans);color:var(--kb-ink-3);margin-left:8px">仅前 ' + KB_LIST_MAX + ' 份可在此切换</span>' : '') + '</div>' +
      '<div class="kb-read-inner" style="display:grid;grid-template-columns:210px 1fr;gap:24px;flex:1;min-height:0">' +
      '<div class="toc" id="kb-toc"></div><div class="reader" id="kb-reader"><div class="kb-spinner"></div></div></div></div>';
    document.getElementById('kb-read-sel').addEventListener('change', function (e) {
      state.activeFile = e.target.value; renderReading();
    });
    var r = await UserDocs.getFile(f.relPath);
    var reader = document.getElementById('kb-reader');
    var toc = document.getElementById('kb-toc');
    if (!reader) return;
    if (!r || !r.ok) { reader.innerHTML = '<div style="color:var(--kb-ink-3)">无法读取该文件</div>'; return; }
    reader.innerHTML = '<h1 style="font-family:var(--kb-serif);font-size:25px;margin:0 0 6px">' + esc(f.title) + '</h1>' +
      '<div class="meta" style="font:12px var(--kb-sans);color:var(--kb-ink-3);margin-bottom:20px">' + esc(f.category) + ' · ' + r.chars + ' 字 · ' + relTime(r.mtime) + '</div>' +
      '<div class="kb-md" id="kb-reader-md">' + renderMarkdown(r.text) + '</div>';
    var heads = (r.headings || []).filter(function (h) { return h.level <= 3; });
    toc.innerHTML = '<div class="toc-file">目录</div>' + (heads.length ? heads.map(function (h, i) {
      return '<a class="h' + h.level + '" data-idx="' + i + '">' + esc(h.text) + '</a>';
    }).join('') : '<div style="font:12px var(--kb-sans);color:var(--kb-ink-3)">（无标题）</div>');
    var anchorList = [];
    Array.prototype.forEach.call(reader.querySelectorAll('#kb-reader-md h1,#kb-reader-md h2,#kb-reader-md h3'), function (el) { anchorList.push(el); });
    Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a) {
      a.addEventListener('click', function () {
        var idx = parseInt(a.getAttribute('data-idx'), 10);
        var target = anchorList[idx];
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    var prog = document.getElementById('kb-progress');
    prog.style.display = 'block'; prog.style.width = '0';
    reader.addEventListener('scroll', function () {
      var max = reader.scrollHeight - reader.clientHeight;
      var pct = max > 0 ? Math.min(100, reader.scrollTop / max * 100) : 0;
      prog.style.width = pct + '%';
      var cur = 0;
      for (var i = 0; i < anchorList.length; i++) { if (anchorList[i].offsetTop - reader.scrollTop <= 80) cur = i; }
      Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a, i) { a.classList.toggle('active', i === cur); });
    });
  }

  /* ============================================================
     视图 07 — 搜索（Hero + 提示 chip + 位置高亮，demo-07）
     ============================================================ */
  function renderSearch() {
    var kws = (state.meta.keywords || []).slice(0, 8);
    var init = state.searchQ || '';
    view.innerHTML =
      '<div class="kb-search-hero">' +
        '<h2>检索全部资料</h2>' +
        '<p>在本地资料库的全部 .md / .txt 正文中逐行搜索，结果高亮显示</p>' +
        '<div class="sbar"><input id="kb-q" placeholder="输入关键词，例如「过渡性客体」「抱持」…" autocomplete="off" value="' + esc(init) + '"></div>' +
        (kws.length ? '<div class="kb-chips">' + kws.map(function (k) { return '<span class="c" data-q="' + esc(k.term) + '">' + esc(k.term) + '</span>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<div class="kb-search-stat" id="kb-sstat">输入关键词开始搜索。</div>' +
      '<div id="kb-hits"></div>';
    var input = document.getElementById('kb-q');
    var timer = 0;
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { doSearch(input.value); }, 200); });
    Array.prototype.forEach.call(view.querySelectorAll('.kb-chips .c'), function (c) {
      c.addEventListener('click', function () { input.value = c.getAttribute('data-q'); doSearch(input.value); });
    });
    if (init) doSearch(init);
    input.focus();
  }
  async function doSearch(q) {
    q = (q || '').trim();
    var stat = document.getElementById('kb-sstat');
    var box = document.getElementById('kb-hits');
    if (!stat || !box) return;
    if (!q) { stat.textContent = '输入关键词开始搜索。'; box.innerHTML = ''; return; }
    stat.textContent = '搜索中…';
    var r = await UserDocs.searchDetailed(q, 80);
    if (!stat.isConnected) return;
    if (!r || !r.ok) { stat.textContent = '搜索失败：' + esc((r && r.reason) || ''); return; }
    stat.textContent = '在 ' + r.fileCount + ' 个文件中找到 ' + r.hits.length + ' 处匹配' + (r.hits.length >= 80 ? '（仅显示前 80 条）' : '');
    box.innerHTML = r.hits.map(function (h) {
      return '<div class="kb-hit" data-rel="' + esc(h.relPath) + '">' +
        '<div class="h"><span class="fn">' + esc(h.name) + '</span><span>第 ' + h.lineNo + ' 行</span></div>' +
        '<div class="sn">' + highlight(h.text, q) + '</div></div>';
    }).join('') || '<div style="color:var(--kb-ink-3);font-size:13px;padding:12px">无匹配结果</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.kb-hit'), function (el) {
      el.addEventListener('click', function () { state.activeFile = el.getAttribute('data-rel'); switchMode('reading'); });
    });
  }
  function highlight(text, q) {
    var e = esc(text);
    if (!q) return e;
    try {
      var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      return e.replace(re, '<mark>$1</mark>');
    } catch (err) { return e; }
  }

  /* ============================================================
     视图 05 — 知识图谱（文档 + 概念节点，点击弹面板，demo-05）
     ============================================================ */
  function renderGraph() {
    var cats = state.meta.categories.map(function (c) { return c.name; });
    var files = state.meta.files.slice(0, 140);
    var kwNodes = (state.meta.keywords || []).slice(0, 28);
    view.innerHTML = '<div class="kb-graph"><div class="legend">' +
      '<span class="nd" style="background:#2F8F83"></span>文档　' +
      '<span class="nd" style="background:#E08D5B"></span>概念（高频词）　可拖动 · 单击查看' +
      '</div><svg id="kb-svg" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid meet"></svg></div>';
    var svg = document.getElementById('kb-svg');
    var W = 1000, H = 600;
    var nodes = [], idx = {};
    files.forEach(function (f) { var n = { id: 'f:' + f.relPath, kind: 'doc', label: f.title, rel: f.relPath, cat: f.category, x: W / 2 + (Math.random() - .5) * 500, y: H / 2 + (Math.random() - .5) * 360, vx: 0, vy: 0 }; nodes.push(n); idx[n.id] = n; });
    kwNodes.forEach(function (k) { var n = { id: 'k:' + k.term, kind: 'kw', label: k.term, count: k.count, relPaths: k.relPaths || [], x: W / 2 + (Math.random() - .5) * 300, y: H / 2 + (Math.random() - .5) * 220, vx: 0, vy: 0 }; nodes.push(n); idx[n.id] = n; });
    var links = [];
    kwNodes.forEach(function (k) {
      (k.relPaths || []).slice(0, 6).forEach(function (rp) {
        var dn = idx['f:' + rp];
        if (dn) links.push({ s: dn, t: idx['k:' + k.term] });
      });
    });

    var NS = 'http://www.w3.org/2000/svg';
    var gLink = document.createElementNS(NS, 'g'), gNode = document.createElementNS(NS, 'g');
    svg.appendChild(gLink); svg.appendChild(gNode);
    var lineEls = links.map(function (l) {
      var ln = document.createElementNS(NS, 'line');
      ln.setAttribute('stroke', 'rgba(47,143,131,.18)'); ln.setAttribute('stroke-width', '1');
      gLink.appendChild(ln); return ln;
    });
    var nodeEls = nodes.map(function (n) {
      var g = document.createElementNS(NS, 'g'); g.style.cursor = 'pointer';
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', n.kind === 'doc' ? 7 : 5);
      c.setAttribute('fill', n.kind === 'doc' ? '#2F8F83' : '#E08D5B');
      c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', n.kind === 'doc' ? '2' : '1');
      var t = document.createElementNS(NS, 'text');
      t.textContent = n.label.length > 9 ? n.label.slice(0, 9) + '…' : n.label;
      t.setAttribute('font-size', n.kind === 'doc' ? '10' : '9.5');
      t.setAttribute('fill', n.kind === 'doc' ? '#2E2A26' : '#B5703D');
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('dy', n.kind === 'doc' ? '-11' : '-9');
      g.appendChild(c); g.appendChild(t); gNode.appendChild(g);
      var dragging = false;
      g.addEventListener('pointerdown', function (e) { dragging = true; n.fixed = true; g.setPointerCapture(e.pointerId); });
      g.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var pt = svgPoint(svg, e.clientX, e.clientY); n.x = pt.x; n.y = pt.y; n.vx = 0; n.vy = 0;
      });
      g.addEventListener('pointerup', function (e) { dragging = false; n.fixed = false; g.releasePointerCapture(e.pointerId); });
      g.addEventListener('click', function (e) { e.stopPropagation(); showGraphPop(n); });
      return g;
    });
    svg.addEventListener('click', hideGraphPop);

    var iter = 0, MAX = 280;
    function tick() {
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var a = nodes[i], b = nodes[j];
          var dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01;
          var f = 1400 / d2, dist = Math.sqrt(d2);
          var fx = dx / dist * f, fy = dy / dist * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      links.forEach(function (l) {
        var dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = (dist - 70) * 0.03;
        var fx = dx / dist * f, fy = dy / dist * f;
        l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy;
      });
      nodes.forEach(function (n) {
        n.vx += (W / 2 - n.x) * 0.0016; n.vy += (H / 2 - n.y) * 0.0016;
        n.vx *= 0.86; n.vy *= 0.86;
        if (!n.fixed) { n.x += Math.max(-15, Math.min(15, n.vx)); n.y += Math.max(-15, Math.min(15, n.vy)); }
        n.x = Math.max(24, Math.min(W - 24, n.x)); n.y = Math.max(24, Math.min(H - 24, n.y));
      });
      lineEls.forEach(function (ln, k) { var l = links[k]; ln.setAttribute('x1', l.s.x); ln.setAttribute('y1', l.s.y); ln.setAttribute('x2', l.t.x); ln.setAttribute('y2', l.t.y); });
      nodeEls.forEach(function (g, k) { g.setAttribute('transform', 'translate(' + nodes[k].x + ',' + nodes[k].y + ')'); });
      iter++;
      if (iter < MAX || nodes.some(function (n) { return n.fixed; })) state.graphRAF = requestAnimationFrame(tick);
    }
    state.graphRAF = requestAnimationFrame(tick);
  }
  function hideGraphPop() {
    var p = document.getElementById('kb-gpop');
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }
  function showGraphPop(node) {
    hideGraphPop();
    var host = document.querySelector('.kb-graph');
    if (!host) return;
    var pop = document.createElement('div');
    pop.id = 'kb-gpop'; pop.className = 'kb-gpop';
    if (node.kind === 'doc') {
      var f = fileByRel(node.rel);
      pop.innerHTML = '<div class="pt">' + esc(node.label) + '</div>' +
        '<div class="pd">' + esc((f && f.summary) || '（无摘要）') + '</div>' +
        '<button class="kb-btn primary" id="kb-pop-open">打开阅读</button>';
    } else {
      var docs = node.relPaths.map(fileByRel).filter(Boolean).slice(0, 6);
      pop.innerHTML = '<div class="pt">「' + esc(node.label) + '」出现 ' + (node.count || 0) + ' 次</div>' +
        '<div class="pd">相关文档：</div>' +
        '<ul class="plist">' + docs.map(function (d) { return '<li data-rel="' + esc(d.relPath) + '">' + esc(d.title) + '</li>'; }).join('') + '</ul>';
    }
    var rect = host.getBoundingClientRect();
    var gx = node.x / 1000 * rect.width, gy = node.y / 600 * rect.height;
    pop.style.left = Math.min(gx + 16, rect.width - 290) + 'px';
    pop.style.top = Math.max(gy - 10, 8) + 'px';
    host.appendChild(pop);
    var openBtn = document.getElementById('kb-pop-open');
    if (openBtn) openBtn.addEventListener('click', function () { hideGraphPop(); state.activeFile = node.rel; switchMode('reading'); });
    Array.prototype.forEach.call(pop.querySelectorAll('.plist li'), function (li) {
      li.addEventListener('click', function () { hideGraphPop(); state.activeFile = li.getAttribute('data-rel'); switchMode('reading'); });
    });
  }
  function svgPoint(svg, cx, cy) {
    var pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    var m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : { x: cx, y: cy };
  }
  function stopGraph() { if (state.graphRAF) { cancelAnimationFrame(state.graphRAF); state.graphRAF = 0; } }

  /* ============================================================
     视图 09 — 资料对话（参考资料侧栏 + 引用开关，demo-09）
     ============================================================ */
  function renderChat() {
    if (!(App.aiUnlocked && App.aiUnlocked())) {
      view.innerHTML = '<div class="kb-chat-wrap"><div class="kb-lock" style="grid-column:1/-1">' +
        '资料对话需要激活 AI 功能后使用。<br>你仍可在其他视图浏览、检索全部资料。<br>' +
        '<button class="kb-btn primary" onclick="window.__XJ_API__&&window.__XJ_API__.openActivation&&window.__XJ_API__.openActivation()">输入激活码解锁</button>' +
        '</div></div>';
      return;
    }
    if (!state.refsOn) state.refsOn = new Set(state.meta.files.map(function (f) { return f.relPath; }));
    var cappedRefs = capList(state.meta.files);
    var refs = cappedRefs.items.map(function (f) {
      var on = state.refsOn.has(f.relPath);
      return '<div class="kb-ref' + (on ? ' on' : '') + '" data-rel="' + esc(f.relPath) + '">' +
        '<span class="ck">' + (on ? '✓' : '') + '</span><span class="rn">' + esc(f.title) + '</span></div>';
    }).join('');
    if (cappedRefs.truncated > 0) refs += truncationHint(cappedRefs.truncated);
    view.innerHTML =
      '<div class="kb-chat-wrap">' +
        '<div class="kb-refs"><h4>参考资料</h4>' +
        '<span class="rall" id="kb-ref-all">全选 / 全不选</span>' +
        '<div id="kb-ref-list">' + refs + '</div>' +
        '<div style="font:11px var(--kb-sans);color:var(--kb-ink-3);margin-top:10px;line-height:1.6">勾选的资料会作为上下文注入对话；取消勾选则从本次对话中排除。</div>' +
        '</div>' +
        '<div class="kb-chat"><div class="stream" id="kb-stream"></div>' +
        '<div class="cbar"><input id="kb-cin" placeholder="就你的资料库提问，如：某概念在我的资料里怎么讲的？"><button id="kb-csend">发送</button></div></div>' +
      '</div>';
    if (!state.chat.length) {
      state.chat.push({ role: 'ai', text: '我可以基于「我的资料库」里的全部 ' + state.meta.files.length + ' 份资料回答你的问题，并标注引用来源。问我点什么？' });
    }
    paintChat();
    Array.prototype.forEach.call(view.querySelectorAll('.kb-ref'), function (r) {
      r.addEventListener('click', function () {
        var rel = r.getAttribute('data-rel');
        if (state.refsOn.has(rel)) state.refsOn.delete(rel); else state.refsOn.add(rel);
        r.classList.toggle('on'); r.querySelector('.ck').textContent = state.refsOn.has(rel) ? '✓' : '';
      });
    });
    document.getElementById('kb-ref-all').addEventListener('click', function () {
      var all = state.refsOn.size === state.meta.files.length;
      state.refsOn = all ? new Set() : new Set(state.meta.files.map(function (f) { return f.relPath; }));
      Array.prototype.forEach.call(view.querySelectorAll('.kb-ref'), function (r) {
        var on = state.refsOn.has(r.getAttribute('data-rel'));
        r.classList.toggle('on', on); r.querySelector('.ck').textContent = on ? '✓' : '';
      });
    });
    document.getElementById('kb-csend').addEventListener('click', sendChat);
    document.getElementById('kb-cin').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendChat(); }
    });
  }
  function paintChat() {
    var stream = document.getElementById('kb-stream');
    if (!stream) return;
    stream.innerHTML = state.chat.map(function (m) {
      var cites = (m.cites && m.cites.length) ? '<div class="cites">引用：' + m.cites.map(function (c) { return '<b>' + esc(c) + '</b>'; }).join('、') + '</div>' : '';
      return '<div class="kb-msg ' + (m.role === 'me' ? 'me' : 'ai') + '">' + esc(m.text).replace(/\n/g, '<br>') + cites + '</div>';
    }).join('');
    stream.scrollTop = stream.scrollHeight;
  }
  async function ensureAI() {
    if (window.AI) return true;
    return await new Promise(function (resolve) {
      if (document.querySelector('script[data-kb-ai]')) {
        var wait = setInterval(function () { if (window.AI) { clearInterval(wait); resolve(true); } }, 60);
        setTimeout(function () { clearInterval(wait); resolve(!!window.AI); }, 3000);
        return;
      }
      var s = document.createElement('script'); s.src = 'js/ai.js'; s.setAttribute('data-kb-ai', '1');
      s.onload = function () { resolve(!!window.AI); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }
  async function sendChat() {
    var input = document.getElementById('kb-cin');
    var q = (input.value || '').trim();
    if (!q) return;
    input.value = '';
    state.chat.push({ role: 'me', text: q });
    state.chat.push({ role: 'ai', text: '思考中…' });
    paintChat();
    var ok = await ensureAI();
    if (!ok || !window.AI) {
      state.chat[state.chat.length - 1] = { role: 'ai', text: 'AI 模块未就绪，请稍后重试。' };
      return paintChat();
    }
    var excluded = state.meta.files.filter(function (f) { return !state.refsOn.has(f.relPath); }).map(function (f) { return f.relPath; });
    var ctx = (window.UserDocs && UserDocs.getContextBlock) ? UserDocs.getContextBlock({ excludedRelPaths: excluded }) : '';
    var sys = '你是心镜的资料助手。请优先依据下面用户提供的「我的资料库」内容回答问题，' +
      '并在回答末尾用一行注明你引用了哪些文件（文件名）。若资料中没有相关内容，如实说明并可补充你的通用知识，但要标注哪些属于资料、哪些属于通用知识。\n\n' + (ctx || '（资料库暂无可用内容）');
    var messages = [{ role: 'system', content: sys }];
    state.chat.slice(-8, -1).forEach(function (m) {
      if (m.text === '思考中…') return;
      messages.push({ role: m.role === 'me' ? 'user' : 'assistant', content: m.text });
    });
    messages.push({ role: 'user', content: q });
    try {
      var reply = await AI.send(messages);
      var text = typeof reply === 'string' ? reply : (reply && (reply.content || reply.text)) || '（无回复）';
      state.chat[state.chat.length - 1] = { role: 'ai', text: text, cites: guessCites(text) };
    } catch (e) {
      state.chat[state.chat.length - 1] = { role: 'ai', text: '出错了：' + esc((e && e.message) || '请求失败') };
    }
    paintChat();
  }
  function guessCites(text) {
    if (!text) return [];
    var out = [];
    state.meta.files.forEach(function (f) {
      var base = f.name.replace(/\.(md|txt)$/i, '');
      if (text.indexOf(f.name) !== -1 || (base.length >= 2 && text.indexOf(base) !== -1) || (f.title.length >= 2 && text.indexOf(f.title) !== -1)) {
        if (out.indexOf(f.name) === -1) out.push(f.name);
      }
    });
    return out.slice(0, 6);
  }

  /* ============================================================
     视图 10 — 统计（KPI + 分类条形 + 格式环形图 + 关键词 + 6 处注入，demo-10）
     ============================================================ */
  function renderStats() {
    var s = state.meta.stats || {};
    var cats = state.meta.categories || [];
    var kws = state.meta.keywords || [];
    var maxCat = cats.reduce(function (m, c) { return Math.max(m, c.count); }, 1);
    var html = '';
    html += '<div class="kb-kpis">' +
      kpi(s.fileCount || 0, '资料文件') +
      kpi((s.totalChars || 0).toLocaleString(), '总字数') +
      kpi(s.categoryCount || 0, '分类数') +
      kpi((s.mdCount || 0) + (s.txtCount || 0) ? '6 处' : '0', 'AI 注入场景') +
      '</div>';
    html += '<div class="kb-stat-grid"><div class="kb-cardbox"><h3>分类分布</h3>' + cats.map(function (c) {
      return '<div class="kb-bar"><span class="lb"><span class="cdot" style="background:' + catColor(c.name) + '"></span>' + esc(c.name) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + (c.count / maxCat * 100) + '%;background:' + catColor(c.name) + '"></span></span>' +
        '<span class="vv">' + c.count + '</span></div>';
    }).join('') + '</div>';
    html += '<div class="kb-cardbox"><h3>格式占比</h3>' + donut(s.mdCount || 0, s.txtCount || 0) + '</div></div>';
    if (kws.length) {
      html += '<div class="kb-cardbox" style="margin-bottom:20px"><h3>高频关键词（自动提取）</h3><div class="kb-kw">' +
        kws.slice(0, 30).map(function (k) { return '<span title="出现 ' + k.count + ' 次 · ' + k.docs + ' 篇">' + esc(k.term) + '</span>'; }).join('') +
        '</div></div>';
    }
    html += '<div class="kb-cardbox"><h3>AI 注入覆盖（6 处对话入口）</h3><ul class="kb-cover-list">' +
      coverItem('1', '小镜助手', '首页浮窗的日常咨询与资料检索') +
      coverItem('2', 'AI 督导', '三栏研究台的督导分析上下文') +
      coverItem('3', '真人督导整理', '上传逐字稿后的 AI 整理与提示') +
      coverItem('4', '大师 1v1 对话', '与单一思想者的深度对谈') +
      coverItem('5', '多大师圆桌', '跨思想者比较研讨') +
      coverItem('6', '咨询记录 / 报告', '撰写时的背景资料自动补全') +
      '</ul><div style="font:12px var(--kb-sans);color:var(--kb-ink-3);margin-top:12px;line-height:1.7">当前共 <b>' + (s.fileCount || 0) + '</b> 份资料参与注入，全部仅在本机读取、不上传。</div></div>';
    view.innerHTML = html;
  }
  function coverItem(num, t, d) {
    return '<li><span class="num">' + num + '</span><div><b>' + esc(t) + '</b><br><span style="color:var(--kb-ink-3)">' + esc(d) + '</span></div></li>';
  }
  function donut(md, txt) {
    var total = md + txt || 1;
    var r = 54, c = 2 * Math.PI * r;
    var mdFrac = md / total;
    var mdLen = mdFrac * c;
    return '<div class="kb-donut-wrap"><svg class="kb-donut" width="130" height="130" viewBox="0 0 130 130">' +
      '<circle cx="65" cy="65" r="' + r + '" fill="none" stroke="#F3EEE6" stroke-width="16"></circle>' +
      '<circle cx="65" cy="65" r="' + r + '" fill="none" stroke="#2F8F83" stroke-width="16" stroke-dasharray="' + mdLen + ' ' + (c - mdLen) + '" transform="rotate(-90 65 65)"></circle>' +
      '<text x="65" y="60" text-anchor="middle" font-size="20" font-weight="700" fill="#2E2A26" font-family="var(--kb-serif)">' + Math.round(mdFrac * 100) + '%</text>' +
      '<text x="65" y="80" text-anchor="middle" font-size="11" fill="#9A9089">Markdown</text></svg>' +
      '<div class="kb-donut-legend">' +
      '<div class="row"><span class="cdot" style="background:#2F8F83"></span>Markdown (.md)<span class="vv">' + md + '</span></div>' +
      '<div class="row"><span class="cdot" style="background:#E08D5B"></span>纯文本 (.txt)<span class="vv">' + txt + '</span></div>' +
      '</div></div>';
  }
  function kpi(n, l) { return '<div class="kb-kpi"><div class="n">' + n + '</div><div class="l">' + esc(l) + '</div></div>'; }

  /* ============================================================
     轻量 Markdown 渲染（先转义再解析，安全）
     超大文件（>200KB）截断并提示，避免渲染线程主循环被长时间占满
     ============================================================ */
  var KB_RENDER_MAX_CHARS = 200000; // 单文件渲染字符上限（约 200KB）
  function renderMarkdown(src) {
    var raw = String(src || '');
    var truncated = false;
    if (raw.length > KB_RENDER_MAX_CHARS) { raw = raw.slice(0, KB_RENDER_MAX_CHARS); truncated = true; }
    var lines = raw.split('\n');
    var out = [], i = 0, listType = null;
    function closeList() { if (listType) { out.push('</' + listType + '>'); listType = null; } }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        closeList();
        var buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      var h = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
      if (h) { closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      var bq = /^>\s?(.*)$/.exec(line);
      if (bq) { closeList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); i++; continue; }
      var ul = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push('<li>' + inline(ul[1]) + '</li>'); i++; continue; }
      var ol = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push('<li>' + inline(ol[1]) + '</li>'); i++; continue; }
      if (!line.trim()) { closeList(); i++; continue; }
      closeList();
      var para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    closeList();
    if (truncated) {
      out.push('<div style="padding:12px 16px;margin:16px 0;border-radius:8px;background:var(--kb-bg-soft);color:var(--kb-ink-3);font:12.5px var(--kb-sans);text-align:center">⚠ 文件过大，已截断前 ' + Math.round(KB_RENDER_MAX_CHARS / 1000) + 'KB 渲染。完整内容请用外部编辑器查看。</div>');
    }
    return out.join('\n');

    function inline(t) {
      var s = esc(t);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, text, url) {
        var href = url.trim();
        if (!/^https?:\/\//i.test(href)) href = '#';
        return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
      });
      return s;
    }
  }

})();
