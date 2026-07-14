/* ============================================================
   心镜 XinJing — 我的资料库页（v3.5.0-UI）
   单页 + 8 视图切换器：三栏 / 卡片 / 属性表 / 图谱 / 沉浸阅读 / 搜索 / 对话 / 统计
   数据源：window.UserDocs（getMeta / getFile / searchDetailed），全部经主进程 fs、仅本机、零出网。
   ============================================================ */
(function () {
  'use strict';

  var esc = (window.App && App.escapeHtml) ? App.escapeHtml : function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // 视图定义（顺序即切换器顺序）
  var MODES = [
    { key: 'cards', label: '卡片', icon: 'box' },
    { key: 'threecol', label: '三栏', icon: 'doc' },
    { key: 'table', label: '属性表', icon: 'bars' },
    { key: 'reading', label: '沉浸阅读', icon: 'doc' },
    { key: 'search', label: '搜索', icon: 'search' },
    { key: 'graph', label: '知识图谱', icon: 'spark' },
    { key: 'chat', label: '资料对话', icon: 'chat' },
    { key: 'stats', label: '统计', icon: 'bars' },
  ];

  var state = {
    meta: null,          // readUserDocMeta 结果
    mode: 'cards',
    activeFile: null,    // relPath
    activeTreeDir: null, // 三栏选中的目录（分类过滤）
    tableSort: { key: 'title', dir: 1 },
    chat: [],            // {role, text, cites}
    graphRAF: 0,
  };

  var view, stateBox, modesBox, folderLbl;

  // ---------- 入口 ----------
  document.addEventListener('DOMContentLoaded', function () {
    App.initPage({
      title: '我的资料库',
      subtitle: '本地课程资料 · 仅本机读取，数据不出本机',
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
    state.mode = key;
    Array.prototype.forEach.call(modesBox.querySelectorAll('.kb-mode'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === key);
    });
    renderView();
  }

  // ---------- 数据加载 ----------
  function showState(html) {
    stateBox.style.display = 'block';
    stateBox.innerHTML = html;
    view.style.display = 'none';
  }
  function showView() {
    stateBox.style.display = 'none';
    view.style.display = 'block';
  }

  async function loadMeta(force) {
    showState('<div class="kb-spinner"></div><div>正在扫描资料文件夹…</div>');
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
    if (!meta.files || !meta.files.length) {
      return showState('<div class="big">资料文件夹为空</div><div>在所选文件夹中放入 .md / .txt 课程资料后点「刷新」。</div>' +
        '<div style="margin-top:6px;font-size:12px">当前目录：' + esc(meta.folder || '') + '</div>');
    }
    // 默认选中第一个文件
    if (!state.activeFile || !meta.files.some(function (f) { return f.relPath === state.activeFile; })) {
      state.activeFile = meta.files[0].relPath;
    }
    showView();
    renderView();
  }

  function renderEmptyNoFolder() {
    folderLbl.textContent = '';
    showState(
      '<div class="big">还没有设置资料文件夹</div>' +
      '<div>选择一个本地文件夹，把你的课程讲义、笔记（.md / .txt）放进去。<br>心镜会在本机读取，用于资料浏览、检索，并在 AI 对话时作为你的私人知识库。<br><b>资料不会上传、不出本机。</b></div>' +
      '<button class="kb-btn primary" onclick="document.getElementById(\'kb-pick\').click()">选择资料文件夹</button>'
    );
  }

  async function pickFolder() {
    try {
      var folder = await window.__XJ_API__.selectUserDocFolder();
      if (!folder) return;
      if (window.UserDocs) { if (UserDocs.invalidateMeta) UserDocs.invalidateMeta(); if (UserDocs.refresh) UserDocs.refresh(); }
      state.activeFile = null;
      await loadMeta(true);
      App.showToast && App.showToast('已设置资料文件夹', 'success');
    } catch (e) { App.showToast && App.showToast('选择失败', 'error'); }
  }

  // ---------- 视图分发 ----------
  function renderView() {
    if (!state.meta || !state.meta.ok || !state.meta.files || !state.meta.files.length) return;
    stopGraph();
    switch (state.mode) {
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

  function fileByRel(rel) {
    var fs = state.meta.files;
    for (var i = 0; i < fs.length; i++) if (fs[i].relPath === rel) return fs[i];
    return null;
  }
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtDate(ms) {
    if (!ms) return '';
    var d = new Date(ms), p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* ============================================================
     视图 02 — 卡片
     ============================================================ */
  function renderCards() {
    var html = '<div class="kb-cards">' + state.meta.files.map(function (f) {
      return '<div class="kb-card" data-rel="' + esc(f.relPath) + '">' +
        '<span class="cat">' + esc(f.category) + '</span>' +
        '<div class="t">' + esc(f.title) + '</div>' +
        '<div class="s">' + esc(f.summary || '（无摘要）') + '</div>' +
        '<div class="f"><span>' + esc(f.name) + '</span><span>' + f.chars + ' 字</span></div>' +
        '</div>';
    }).join('') + '</div>';
    view.innerHTML = html;
    Array.prototype.forEach.call(view.querySelectorAll('.kb-card'), function (c) {
      c.addEventListener('click', function () { state.activeFile = c.getAttribute('data-rel'); switchMode('reading'); });
    });
  }

  /* ============================================================
     视图 01 — 三栏（目录树 / 文件列表 / 详情）
     ============================================================ */
  function renderThreeCol() {
    view.innerHTML =
      '<div class="kb-3col">' +
        '<div class="col c-tree" id="kb-tree"></div>' +
        '<div class="col c-list" id="kb-list"></div>' +
        '<div class="col kb-detail" id="kb-detail"></div>' +
      '</div>';
    renderTree();
    renderList();
    renderDetail();
  }

  function renderTree() {
    var box = document.getElementById('kb-tree');
    if (!box) return;
    var html = '<div class="kb-tree-node dir' + (state.activeTreeDir == null ? ' active' : '') + '" data-dir="">全部（' + state.meta.files.length + '）</div>';
    html += renderTreeNodes(state.meta.tree, '');
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.kb-tree-node'), function (n) {
      n.addEventListener('click', function (e) {
        e.stopPropagation();
        if (n.getAttribute('data-file')) {
          state.activeFile = n.getAttribute('data-file');
          renderList(); renderDetail(); markActive(box, n);
        } else {
          state.activeTreeDir = n.getAttribute('data-dir') || null;
          renderTree(); renderList();
        }
      });
    });
  }
  function renderTreeNodes(nodes, prefix) {
    return (nodes || []).map(function (n) {
      if (n.type === 'dir') {
        var dp = prefix ? prefix + '/' + n.name : n.name;
        return '<div class="kb-tree-node dir" data-dir="' + esc(dp) + '">▸ ' + esc(n.name) + '</div>' +
          '<div class="kb-tree-children">' + renderTreeNodes(n.children, dp) + '</div>';
      }
      return '<div class="kb-tree-node" data-file="' + esc(n.relPath) + '">' + esc(n.name) + '</div>';
    }).join('');
  }
  function markActive(box, node) {
    Array.prototype.forEach.call(box.querySelectorAll('.kb-tree-node'), function (x) { x.classList.remove('active'); });
    node.classList.add('active');
  }

  function filesInDir() {
    if (state.activeTreeDir == null) return state.meta.files;
    var d = state.activeTreeDir + '/';
    return state.meta.files.filter(function (f) { return f.relPath === state.activeTreeDir || f.relPath.indexOf(d) === 0; });
  }

  function renderList() {
    var box = document.getElementById('kb-list');
    if (!box) return;
    var files = filesInDir();
    box.innerHTML = files.map(function (f) {
      return '<div class="kb-li' + (f.relPath === state.activeFile ? ' active' : '') + '" data-rel="' + esc(f.relPath) + '">' +
        '<div class="t">' + esc(f.title) + '</div>' +
        '<div class="m">' + esc(f.category) + ' · ' + f.chars + ' 字 · ' + f.headingCount + ' 节</div>' +
        '</div>';
    }).join('') || '<div style="color:var(--ink-3);font-size:13px;padding:8px">该分类下无文件</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.kb-li'), function (li) {
      li.addEventListener('click', function () { state.activeFile = li.getAttribute('data-rel'); renderList(); renderDetail(); });
    });
  }

  async function renderDetail() {
    var box = document.getElementById('kb-detail');
    if (!box) return;
    var f = fileByRel(state.activeFile);
    if (!f) { box.innerHTML = '<div style="color:var(--ink-3)">选择左侧文件查看</div>'; return; }
    box.innerHTML = '<div class="kb-spinner"></div>';
    var r = await UserDocs.getFile(f.relPath);
    if (!r || !r.ok) { box.innerHTML = '<div style="color:var(--ink-3)">无法读取：' + esc((r && r.reason) || '') + '</div>'; return; }
    box.innerHTML =
      '<h2>' + esc(f.title) + '</h2>' +
      '<div class="meta"><span>' + esc(f.category) + '</span><span>' + r.chars + ' 字</span><span>' + fmtBytes(r.size) + '</span><span>' + fmtDate(r.mtime) + '</span></div>' +
      '<div class="kb-md">' + renderMarkdown(r.text) + '</div>';
  }

  /* ============================================================
     视图 03 — 属性表（可排序）
     ============================================================ */
  function renderTable() {
    var cols = [
      { key: 'title', label: '标题' },
      { key: 'category', label: '分类' },
      { key: 'chars', label: '字数' },
      { key: 'headingCount', label: '章节' },
      { key: 'size', label: '大小' },
      { key: 'mtime', label: '修改时间' },
    ];
    var files = state.meta.files.slice();
    var sk = state.tableSort.key, sd = state.tableSort.dir;
    files.sort(function (a, b) {
      var x = a[sk], y = b[sk];
      if (typeof x === 'string') return x.localeCompare(y, 'zh') * sd;
      return ((x || 0) - (y || 0)) * sd;
    });
    var html = '<table class="kb-table"><thead><tr>' + cols.map(function (c) {
      var arrow = sk === c.key ? (sd > 0 ? ' ▲' : ' ▼') : '';
      return '<th data-key="' + c.key + '">' + esc(c.label) + arrow + '</th>';
    }).join('') + '</tr></thead><tbody>' + files.map(function (f) {
      return '<tr data-rel="' + esc(f.relPath) + '">' +
        '<td class="tt">' + esc(f.title) + '</td>' +
        '<td><span class="kb-pill">' + esc(f.category) + '</span></td>' +
        '<td>' + f.chars + '</td>' +
        '<td>' + f.headingCount + '</td>' +
        '<td>' + fmtBytes(f.size) + '</td>' +
        '<td>' + fmtDate(f.mtime) + '</td>' +
        '</tr>';
    }).join('') + '</tbody></table>';
    view.innerHTML = html;
    Array.prototype.forEach.call(view.querySelectorAll('th'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-key');
        if (state.tableSort.key === k) state.tableSort.dir *= -1;
        else { state.tableSort.key = k; state.tableSort.dir = 1; }
        renderTable();
      });
    });
    Array.prototype.forEach.call(view.querySelectorAll('tbody tr'), function (tr) {
      tr.addEventListener('click', function () { state.activeFile = tr.getAttribute('data-rel'); switchMode('reading'); });
    });
  }

  /* ============================================================
     视图 06 — 沉浸阅读（TOC + 进度条）
     ============================================================ */
  async function renderReading() {
    var f = fileByRel(state.activeFile) || state.meta.files[0];
    state.activeFile = f.relPath;
    view.innerHTML =
      '<div class="picker" style="margin-bottom:16px"><select id="kb-read-sel">' +
      state.meta.files.map(function (x) {
        return '<option value="' + esc(x.relPath) + '"' + (x.relPath === f.relPath ? ' selected' : '') + '>' + esc(x.title) + '　·　' + esc(x.category) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="kb-read"><div class="toc" id="kb-toc"></div><div class="reader" id="kb-reader"><div class="kb-spinner"></div></div></div>';
    document.getElementById('kb-read-sel').addEventListener('change', function (e) {
      state.activeFile = e.target.value; renderReading();
    });
    var r = await UserDocs.getFile(f.relPath);
    var reader = document.getElementById('kb-reader');
    var toc = document.getElementById('kb-toc');
    if (!reader) return; // 已切走
    if (!r || !r.ok) { reader.innerHTML = '<div style="color:var(--ink-3)">无法读取该文件</div>'; return; }
    reader.innerHTML = '<h1 style="font-family:var(--serif);font-size:24px;margin:0 0 6px">' + esc(f.title) + '</h1>' +
      '<div class="meta" style="font:12px var(--sans);color:var(--ink-3);margin-bottom:20px">' + esc(f.category) + ' · ' + r.chars + ' 字 · ' + fmtDate(r.mtime) + '</div>' +
      '<div class="kb-md" id="kb-reader-md">' + renderMarkdown(r.text) + '</div>';
    // TOC
    var heads = (r.headings || []).filter(function (h) { return h.level <= 3; });
    toc.innerHTML = '<div class="toc-file">目录</div>' + (heads.length ? heads.map(function (h, i) {
      return '<a class="h' + h.level + '" data-idx="' + i + '">' + esc(h.text) + '</a>';
    }).join('') : '<div style="font:12px var(--sans);color:var(--ink-3)">（无标题）</div>');
    // 锚点：按渲染后的标题顺序绑定
    var mdHeads = reader.querySelectorAll('h1,h2,h3,h4');
    // 过滤掉封面 h1（第一个），对齐 headings 列表
    var anchorList = [];
    Array.prototype.forEach.call(reader.querySelectorAll('#kb-reader-md h1,#kb-reader-md h2,#kb-reader-md h3'), function (el) { anchorList.push(el); });
    Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a) {
      a.addEventListener('click', function () {
        var idx = parseInt(a.getAttribute('data-idx'), 10);
        var target = anchorList[idx];
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    // 进度条 + TOC 高亮
    var prog = document.getElementById('kb-progress');
    prog.style.display = 'block'; prog.style.width = '0';
    reader.addEventListener('scroll', function () {
      var max = reader.scrollHeight - reader.clientHeight;
      var pct = max > 0 ? Math.min(100, reader.scrollTop / max * 100) : 0;
      prog.style.width = pct + '%';
      // 高亮当前
      var cur = 0;
      for (var i = 0; i < anchorList.length; i++) { if (anchorList[i].offsetTop - reader.scrollTop <= 80) cur = i; }
      Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a, i) { a.classList.toggle('active', i === cur); });
    });
  }

  /* ============================================================
     视图 07 — 搜索（防抖 + 高亮）
     ============================================================ */
  function renderSearch() {
    view.innerHTML =
      '<div class="kb-search">' +
        '<div class="sbar"><input id="kb-q" placeholder="搜索全部资料内容…（回车或输入即搜）" autocomplete="off"></div>' +
        '<div class="stat" id="kb-sstat">输入关键词开始搜索。搜索范围：文件夹内全部 .md / .txt 正文。</div>' +
        '<div id="kb-hits"></div>' +
      '</div>';
    var input = document.getElementById('kb-q');
    var timer = 0;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { doSearch(input.value); }, 200);
    });
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
    }).join('') || '<div style="color:var(--ink-3);font-size:13px;padding:12px">无匹配结果</div>';
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
     视图 05 — 知识图谱（自实现力导 SVG）
     ============================================================ */
  function renderGraph() {
    var cats = state.meta.categories.map(function (c) { return c.name; });
    var files = state.meta.files.slice(0, 150); // 上限，避免节点过多卡顿
    view.innerHTML = '<div class="kb-graph"><div class="legend">● 分类　· 文件（连线=归属）　可拖动节点</div>' +
      '<svg id="kb-svg" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid meet"></svg></div>';
    var svg = document.getElementById('kb-svg');
    var W = 1000, H = 600;
    var nodes = [], idx = {};
    cats.forEach(function (c) { var n = { id: 'c:' + c, label: c, cat: true, x: W / 2 + (Math.random() - .5) * 200, y: H / 2 + (Math.random() - .5) * 200, vx: 0, vy: 0 }; nodes.push(n); idx[n.id] = n; });
    files.forEach(function (f) { var n = { id: 'f:' + f.relPath, label: f.title, cat: false, rel: f.relPath, x: W / 2 + (Math.random() - .5) * 400, y: H / 2 + (Math.random() - .5) * 300, vx: 0, vy: 0 }; nodes.push(n); idx[n.id] = n; });
    var links = files.map(function (f) { return { s: idx['f:' + f.relPath], t: idx['c:' + f.category] }; }).filter(function (l) { return l.s && l.t; });

    // 预建 SVG 元素
    var NS = 'http://www.w3.org/2000/svg';
    var gLink = document.createElementNS(NS, 'g'), gNode = document.createElementNS(NS, 'g');
    svg.appendChild(gLink); svg.appendChild(gNode);
    var lineEls = links.map(function (l) {
      var ln = document.createElementNS(NS, 'line');
      ln.setAttribute('stroke', 'var(--border,#d9cbb8)'); ln.setAttribute('stroke-width', '1');
      gLink.appendChild(ln); return ln;
    });
    var nodeEls = nodes.map(function (n) {
      var g = document.createElementNS(NS, 'g'); g.style.cursor = 'grab';
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', n.cat ? 14 : 5);
      c.setAttribute('fill', n.cat ? 'var(--accent,#8a6d55)' : 'var(--a-hover,#b79b7e)');
      c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', n.cat ? '2' : '1');
      var t = document.createElementNS(NS, 'text');
      t.textContent = n.cat ? n.label : (n.label.length > 10 ? n.label.slice(0, 10) + '…' : n.label);
      t.setAttribute('font-size', n.cat ? '13' : '10');
      t.setAttribute('fill', n.cat ? 'var(--ink,#3a2e22)' : 'var(--ink-3,#9a8c7c)');
      t.setAttribute('font-weight', n.cat ? '700' : '400');
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('dy', n.cat ? '-18' : '-9');
      g.appendChild(c); g.appendChild(t);
      gNode.appendChild(g);
      // 拖动
      var dragging = false;
      g.addEventListener('pointerdown', function (e) { dragging = true; n.fixed = true; g.setPointerCapture(e.pointerId); g.style.cursor = 'grabbing'; });
      g.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var pt = svgPoint(svg, e.clientX, e.clientY); n.x = pt.x; n.y = pt.y; n.vx = 0; n.vy = 0;
      });
      g.addEventListener('pointerup', function (e) { dragging = false; n.fixed = false; g.releasePointerCapture(e.pointerId); g.style.cursor = 'grab'; });
      if (!n.cat) g.addEventListener('dblclick', function () { state.activeFile = n.rel; switchMode('reading'); });
      return g;
    });

    var iter = 0, MAX = 260;
    function tick() {
      // 斥力
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var a = nodes[i], b = nodes[j];
          var dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01;
          var f = 900 / d2, dist = Math.sqrt(d2);
          var fx = dx / dist * f, fy = dy / dist * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      // 弹簧（连线）
      links.forEach(function (l) {
        var dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = (dist - 90) * 0.02;
        var fx = dx / dist * f, fy = dy / dist * f;
        l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy;
      });
      // 向心 + 阻尼 + 位移
      nodes.forEach(function (n) {
        n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002;
        n.vx *= 0.85; n.vy *= 0.85;
        if (!n.fixed) { n.x += Math.max(-15, Math.min(15, n.vx)); n.y += Math.max(-15, Math.min(15, n.vy)); }
        n.x = Math.max(20, Math.min(W - 20, n.x)); n.y = Math.max(20, Math.min(H - 20, n.y));
      });
      // 绘制
      lineEls.forEach(function (ln, k) { var l = links[k]; ln.setAttribute('x1', l.s.x); ln.setAttribute('y1', l.s.y); ln.setAttribute('x2', l.t.x); ln.setAttribute('y2', l.t.y); });
      nodeEls.forEach(function (g, k) { g.setAttribute('transform', 'translate(' + nodes[k].x + ',' + nodes[k].y + ')'); });
      iter++;
      if (iter < MAX || nodes.some(function (n) { return n.fixed; })) state.graphRAF = requestAnimationFrame(tick);
    }
    state.graphRAF = requestAnimationFrame(tick);
  }
  function svgPoint(svg, cx, cy) {
    var pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    var m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : { x: cx, y: cy };
  }
  function stopGraph() { if (state.graphRAF) { cancelAnimationFrame(state.graphRAF); state.graphRAF = 0; } }

  /* ============================================================
     视图 09 — 资料对话（AI + getContextBlock + 引用来源）
     ============================================================ */
  function renderChat() {
    if (!(App.aiUnlocked && App.aiUnlocked())) {
      view.innerHTML = '<div class="kb-chat"><div class="kb-lock">' +
        '资料对话需要激活 AI 功能后使用。<br>你仍可在其他视图浏览、检索全部资料。<br>' +
        '<button class="kb-btn primary" style="margin-top:16px" onclick="window.__XJ_API__&&window.__XJ_API__.openActivation&&window.__XJ_API__.openActivation()">输入激活码解锁</button>' +
        '</div></div>';
      return;
    }
    view.innerHTML =
      '<div class="kb-chat">' +
        '<div class="stream" id="kb-stream"></div>' +
        '<div class="cbar"><input id="kb-cin" placeholder="就你的资料库提问，如：某概念在我的资料里怎么讲的？"><button id="kb-csend">发送</button></div>' +
      '</div>';
    var stream = document.getElementById('kb-stream');
    if (!state.chat.length) {
      state.chat.push({ role: 'ai', text: '我可以基于「我的资料库」里的全部 ' + state.meta.files.length + ' 份资料回答你的问题，并标注引用来源。问我点什么？' });
    }
    paintChat();
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
    // preload 已全页注入 agent-core + userdocs；ai.js 按需动态加载（幂等）
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
    // 资料上下文块（同步取模块级缓存）
    var ctx = (window.UserDocs && UserDocs.getContextBlock) ? UserDocs.getContextBlock() : '';
    var sys = '你是心镜的资料助手。请优先依据下面用户提供的「我的资料库」内容回答问题，' +
      '并在回答末尾用一行注明你引用了哪些文件（文件名）。若资料中没有相关内容，如实说明并可补充你的通用知识，但要标注哪些属于资料、哪些属于通用知识。\n\n' + (ctx || '（资料库暂无可用内容）');
    var messages = [{ role: 'system', content: sys }];
    // 带最近几轮对话
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

  // 从回复中粗略识别引用到的资料文件名（与已知文件名做包含匹配）
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
     视图 10 — 统计（KPI + 分布 + 注入覆盖）
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
      kpi(s.categoryCount || 0, '分类') +
      kpi((s.avgChars || 0).toLocaleString(), '篇均字数') +
      kpi(fmtBytes(s.totalBytes || 0), '占用空间') +
      '</div>';
    // 分类分布
    html += '<div class="kb-dist"><h3>分类分布</h3>' + cats.map(function (c) {
      return '<div class="kb-bar"><span class="lb">' + esc(c.name) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + (c.count / maxCat * 100) + '%"></span></span>' +
        '<span class="vv">' + c.count + '</span></div>';
    }).join('') + '</div>';
    // 关键词
    if (kws.length) {
      html += '<div class="kb-dist"><h3>高频关键词（自动提取）</h3><div class="kb-kw">' +
        kws.slice(0, 30).map(function (k) { return '<span title="出现 ' + k.count + ' 次 · ' + k.docs + ' 篇">' + esc(k.term) + '</span>'; }).join('') +
        '</div></div>';
    }
    // 注入覆盖说明
    html += '<div class="kb-dist"><h3>AI 注入覆盖</h3><div class="kb-cover">' +
      '你的资料库已接入心镜 AI 的 <b>6 处对话入口</b>（小镜助手、AI 督导、真人督导整理、大师 1v1 / 圆桌）。' +
      '每次对话时，资料内容会作为「我的资料库」上下文自动注入，AI 将优先依据你的资料作答。<br>' +
      '当前共 <b>' + (s.fileCount || 0) + '</b> 份资料参与注入，全部仅在本机读取、不上传。</div></div>';
    view.innerHTML = html;
  }
  function kpi(n, l) { return '<div class="kb-kpi"><div class="n">' + n + '</div><div class="l">' + esc(l) + '</div></div>'; }

  /* ============================================================
     轻量 Markdown 渲染（先转义再解析，安全）
     支持：标题 / 粗斜体 / 行内码 / 围栏码 / 列表 / 引用 / 链接 / 段落
     ============================================================ */
  function renderMarkdown(src) {
    var lines = String(src || '').split('\n');
    var out = [], i = 0;
    var listType = null; // 'ul' | 'ol'
    function closeList() { if (listType) { out.push('</' + listType + '>'); listType = null; } }
    while (i < lines.length) {
      var line = lines[i];
      // 围栏代码块
      var fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        closeList();
        var buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结束围栏
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      // 标题
      var h = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
      if (h) { closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      // 引用
      var bq = /^>\s?(.*)$/.exec(line);
      if (bq) { closeList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); i++; continue; }
      // 无序列表
      var ul = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push('<li>' + inline(ul[1]) + '</li>'); i++; continue; }
      // 有序列表
      var ol = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push('<li>' + inline(ol[1]) + '</li>'); i++; continue; }
      // 空行
      if (!line.trim()) { closeList(); i++; continue; }
      // 段落
      closeList();
      var para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    closeList();
    return out.join('\n');

    function inline(t) {
      var s = esc(t);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return s;
    }
  }

})();
