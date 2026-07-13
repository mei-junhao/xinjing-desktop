/* ============================================================
   心镜 XinJing — 咨询记录主工作区
   工作区：左栏来访者列表 / 中栏时间线 + 报告矩阵 / 右栏 AI 督导坞
   严格使用 components.css 提供的组件类，不粘贴任何 :root 或硬编码颜色。
   ============================================================ */

function initConsultations() {
  'use strict';

  const center = document.getElementById('center');
  const clist = document.getElementById('clist');
  const searchInput = document.getElementById('search');
  const statusPills = document.getElementById('statusPills');
  const aidock = document.getElementById('aidock');
  const docEditor = document.getElementById('docEditor');
  const orientMini = document.getElementById('orientMini');
  const floatTb = document.getElementById('floatTb');
  const resizer = document.getElementById('resizer');
  const ws = document.getElementById('ws');

  let currentClientId = null;
  let currentView = 'workspace'; // 'workspace' | 'matrix'
  let railStatus = 'all';
  let railQuery = '';
  let orientation = 'winnicott';
  let dockMode = 'free';      // 'free' | 'session'
  let curSessionId = null;    // 当前右栏选节快编的 session.id（P0-3）
  let curSessionObj = null;   // 当前右栏的 session 对象副本

  const ORIENT_LABELS = {
    winnicott: '温尼科特取向（足够好的母亲、过渡性客体、真/假自体）',
    psychoanalysis: '精神分析取向（无意识、移情、防御）',
    cbt: '认知行为取向（自动思维、信念、行为实验）',
    rogers: '人本主义取向（共情、无条件积极关注、自我实现）',
    yalom: '存在主义取向（死亡、孤独、自由、意义）',
    generic: '通用整合取向',
  };

  // ---------- 工具 ----------
  function supNames(sid) {
    return Store.getSupervisions()
      .filter((sv) => (sv.sessionIds || []).indexOf(sid) !== -1)
      .map((sv) => sv.supervisorName)
      .filter(Boolean);
  }
  function computeOwe(clientId) {
    return Store.getSessionsByClient(clientId).reduce(function (sum, s) {
      const b = s.billing || {};
      return sum + ((b.fee && !b.paid) ? Number(b.fee) || 0 : 0);
    }, 0);
  }
  function latestDate(sessions) {
    let best = '';
    sessions.forEach((s) => { if (s.date && s.date > best) best = s.date; });
    return best;
  }
  function earliestDate(sessions) {
    let best = '';
    sessions.forEach((s) => { if (s.date && (!best || s.date < best)) best = s.date; });
    return best;
  }
  function feeInfo(s) {
    const b = s.billing || {};
    if (!b.fee) return '';
    return ' · ¥' + b.fee + (b.paid ? ' 已收' : ' 未收');
  }
  function stat(n, label) {
    return '<div class="stat"><b>' + n + '</b><span>' + label + '</span></div>';
  }

  // ---------- 左栏 ----------
  function renderRail() {
    const q = railQuery.toLowerCase();
    const clients = Store.getClients().filter(function (c) {
      if (railStatus !== 'all' && c.status !== railStatus) return false;
      if (!q) return true;
      const tags = (c.tags || []).join(' ');
      return (c.name || '').toLowerCase().indexOf(q) !== -1
        || tags.toLowerCase().indexOf(q) !== -1
        || (c.notes || '').toLowerCase().indexOf(q) !== -1;
    });

    if (!clients.length) {
      clist.innerHTML = '<div class="empty">无匹配来访者</div>';
      return;
    }
    clist.innerHTML = clients.map(function (c) {
      const sessions = Store.getSessionsByClient(c.id);
      const last = sessions.length ? App.formatDate(latestDate(sessions), true) : '—';
      const owe = computeOwe(c.id);
      const active = c.id === currentClientId ? ' active' : '';
      return '<div class="ccard' + active + '" data-cid="' + c.id + '">'
        + '<div class="row1"><span class="dot ' + c.status + '"></span><span class="nm">' + App.escapeHtml(c.name) + '</span></div>'
        + '<div class="meta"><span>' + App.statusLabel(c.status) + '</span><span>末次 ' + last + '</span><span>' + sessions.length + ' 节</span>'
        + (owe ? '<span class="owe">欠¥' + owe + '</span>' : '')
        + '</div></div>';
    }).join('');
  }

  clist.addEventListener('click', function (e) {
    const card = e.target.closest('.ccard');
    if (!card) return;
    selectClient(card.getAttribute('data-cid'));
  });

  searchInput.addEventListener('input', function () {
    railQuery = searchInput.value.trim();
    renderRail();
  });

  statusPills.querySelectorAll('.pill').forEach(function (p) {
    p.addEventListener('click', function () {
      statusPills.querySelectorAll('.pill').forEach((x) => x.classList.remove('active'));
      p.classList.add('active');
      railStatus = p.getAttribute('data-status');
      renderRail();
    });
  });

  function selectClient(id) {
    currentClientId = id;
    renderRail();
    renderCenter();
  }

  // ---------- 中栏 ----------
  function timelineHtml(sessions) {
    if (!sessions.length) return '<div class="empty">该来访者尚无咨询记录。</div>';
    return '<div class="timeline">' + sessions.map(function (s) {
      const sup = supNames(s.id);
      const flag = (label, has) => '<span class="flag ' + (has ? 'has' : '') + '">' + label + '</span>';
      return '<div class="tnode"><div class="tcard" data-sid="' + s.id + '">'
        + '<div class="t1"><b>第 ' + s.sessionNumber + ' 节</b><span>' + (App.formatDate(s.date, true) || '') + feeInfo(s) + '</span></div>'
        + '<div class="flags">'
        + flag('逐字稿', s.hasTranscript)
        + flag('SOAP', s.hasSoap)
        + flag('DAP', s.hasDap)
        + flag('反思', s.hasReflection)
        + flag('督导', sup.length > 0)
        + '</div></div></div>';
    }).join('') + '</div>';
  }

  function renderCenter() {
    if (currentView === 'matrix') { renderMatrixView(); return; }

    const c = currentClientId ? Store.getClient(currentClientId) : null;
    if (!c) {
      center.innerHTML = '<div class="empty">从左侧选择一位来访者开始工作。</div>';
      return;
    }
    const sessions = Store.getSessionsByClient(c.id);
    const first = sessions.length ? App.formatDate(earliestDate(sessions), true) : '—';
    const last = sessions.length ? App.formatDate(latestDate(sessions), true) : '—';
    const owe = computeOwe(c.id);

    const tagsHtml = App.renderTags(c.tags);
    center.innerHTML =
      '<div class="client-head">'
        + '<h2>' + App.escapeHtml(c.name) + '</h2>'
        + '<span class="badge">' + App.statusLabel(c.status) + '</span>'
        + (tagsHtml ? '<div class="tags">' + tagsHtml + '</div>' : '')
        + '<div class="stats">'
          + stat(sessions.length, '节数')
          + stat(first, '首访')
          + stat(last, '末次')
          + (owe ? '<div class="stat danger"><b>¥' + owe + '</b><span>欠费</span></div>' : '')
        + '</div>'
      + '</div>'
      + '<div class="quick">'
        + '<button class="primary" id="btnNew">新建咨询记录</button>'
        + '<button id="btnExport">导出</button>'
      + '</div>'
      + '<div class="subtabs">'
        + '<div class="st active" data-st="timeline">时间线</div>'
        + '<div class="st" data-st="matrix">报告矩阵</div>'
      + '</div>'
      + '<div class="subpanel active" id="sub-timeline">' + timelineHtml(sessions) + '</div>'
      + '<div class="subpanel" id="sub-matrix"></div>';

    document.getElementById('btnNew').addEventListener('click', function () {
      location.href = 'client-detail.html?id=' + c.id;
    });
    document.getElementById('btnExport').addEventListener('click', function () {
      App.showToast('导出功能见会话页', 'success');
    });

    center.querySelectorAll('.subtabs .st').forEach(function (st) {
      st.addEventListener('click', function () {
        const which = st.getAttribute('data-st');
        center.querySelectorAll('.subtabs .st').forEach((x) => x.classList.toggle('active', x === st));
        document.getElementById('sub-timeline').classList.toggle('active', which === 'timeline');
        document.getElementById('sub-matrix').classList.toggle('active', which === 'matrix');
      });
    });

    // 每来访者报告矩阵（复用 Reports.renderMatrix）
    Reports.renderMatrix(document.getElementById('sub-matrix'), {
      clients: [c],
      onClickSession: function (id) { location.href = 'session.html?id=' + id; },
    });
  }

  // 时间线卡片点击 → 在右栏「选节快编」打开内嵌编辑器（替代跳转 session.html，P0-3）
  center.addEventListener('click', function (e) {
    const tc = e.target.closest('.tcard');
    if (tc && tc.getAttribute('data-sid')) {
      openSessionInDock(tc.getAttribute('data-sid'));
    }
  });

  function renderMatrixView() {
    center.innerHTML =
      '<div class="section-title">全站报告矩阵</div>'
      + '<div class="page-desc">行=节次，列=各类产出；点击单元格直达对应会话。</div>'
      + '<div id="matrixHost"></div>';
    Reports.renderMatrix(document.getElementById('matrixHost'), {
      onClickSession: function (id) { location.href = 'session.html?id=' + id; },
    });
  }

  // 顶栏视图切换
  function setView(v) {
    currentView = v;
    document.getElementById('vw-workspace').classList.toggle('active', v === 'workspace');
    document.getElementById('vw-matrix').classList.toggle('active', v === 'matrix');
    renderCenter();
  }
  document.getElementById('vw-workspace').addEventListener('click', function () { setView('workspace'); });
  document.getElementById('vw-matrix').addEventListener('click', function () { setView('matrix'); });

  // ---------- 右栏 AI 督导坞 ----------
  orientMini.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      orientMini.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      orientation = b.getAttribute('data-o');
    });
  });

  function insertMark(text) {
    if (!docEditor) return;
    const mark = document.createElement('mark');
    mark.className = 'ai';
    mark.textContent = text;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && docEditor.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      r.collapse(false);
      r.insertNode(mark);
      r.setStartAfter(mark);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      docEditor.appendChild(mark);
    }
    docEditor.focus();
  }

  function generateImpression(client) {
    const sessions = Store.getSessionsByClient(client.id);
    const orientLabel = ORIENT_LABELS[orientation] || ORIENT_LABELS.generic;
    let prompt = '你是一位严谨的心理咨询师督导，请基于以下来访者【' + client.name + '】的咨询记录，'
      + '以' + orientLabel + '的视角，撰写一份结构化的「整体印象」：包括整体工作状态、核心议题、'
      + '咨访关系动力、值得注意的纵向变化，以及在该框架下可深化关注的方面。请使用中文、条理清晰。\n\n'
      + '该来访者共 ' + sessions.length + ' 节咨询，各节记录情况如下：\n';
    sessions.forEach(function (s) {
      prompt += '· 第' + s.sessionNumber + '节（' + (App.formatDate(s.date, true) || '日期未填') + '）：'
        + (s.hasTranscript ? '有逐字稿' : '无逐字稿') + '；'
        + (s.hasSoap ? '有SOAP' : '无SOAP') + '；'
        + (s.hasDap ? '有DAP' : '无DAP') + '；'
        + (s.hasReflection ? '有反思' : '无反思') + '；'
        + '督导：' + (supNames(s.id).join('、') || '无') + '\n';
    });
    AI.send([{ role: 'user', content: prompt }], function (res) {
      if (res.error) { App.showToast('生成失败：' + (res.error.message || res.error), 'error'); return; }
      insertMark(res.content);
    });
  }

  function deepenSelection(kind) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !docEditor.contains(sel.anchorNode)) {
      App.showToast('请先在右侧文档中选中一段文字', 'error');
      return;
    }
    const text = sel.toString().trim();
    if (!text) { App.showToast('请先在右侧文档中选中一段文字', 'error'); return; }
    const orientLabel = ORIENT_LABELS[orientation] || ORIENT_LABELS.generic;
    const ask = kind === '深化'
      ? '深化讨论：提出可追问的方向、隐含的动力学假设与反移情提示'
      : '润色，使表达更专业、流畅，并保留原意';
    const prompt = '你是一位心理咨询师督导，取向为' + orientLabel + '。请针对以下咨询师撰写的片段进行' + ask
      + '。请使用中文。\n\n片段：\n' + text;
    AI.send([{ role: 'user', content: prompt }], function (res) {
      if (res.error) { App.showToast('生成失败：' + (res.error.message || res.error), 'error'); return; }
      insertMark(res.content);
    });
  }

  document.getElementById('aiImpression').addEventListener('click', function () {
    const c = currentClientId ? Store.getClient(currentClientId) : null;
    if (!c) { App.showToast('请先选择一位来访者', 'error'); return; }
    generateImpression(c);
  });
  document.getElementById('aiDeepen').addEventListener('click', function () { deepenSelection('深化'); });
  document.getElementById('aiPolish').addEventListener('click', function () { deepenSelection('润色'); });
  document.getElementById('aiMasters').addEventListener('click', function () { location.href = 'masters.html'; });

  // ---------- 选区浮动工具栏 ----------
  floatTb.style.position = 'fixed';
  function bindFloat() {
    if (!docEditor) return;
    docEditor.addEventListener('mouseup', function () {
      setTimeout(function () {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !docEditor.contains(sel.anchorNode)) {
          floatTb.style.display = 'none';
          return;
        }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        floatTb.style.display = 'flex';
        floatTb.style.left = r.left + 'px';
        floatTb.style.top = (r.top - floatTb.offsetHeight - 8) + 'px';
      }, 10);
    });
    docEditor.addEventListener('blur', function () {
      setTimeout(function () { floatTb.style.display = 'none'; }, 150);
    });
  }
  bindFloat();
  floatTb.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      const cmd = b.getAttribute('data-cmd');
      if (cmd === 'formatBlock') document.execCommand('formatBlock', false, b.getAttribute('data-val'));
      else document.execCommand(cmd, false, null);
      if (docEditor) docEditor.focus();
    });
  });

  // ---------- 坞宽拖拽 ----------
  let drag = false;
  resizer.addEventListener('mousedown', function (e) {
    drag = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    const rect = ws.getBoundingClientRect();
    let w = rect.right - e.clientX;
    w = Math.max(260, Math.min(560, w));
    document.documentElement.style.setProperty('--dock-w', w + 'px');
  });
  window.addEventListener('mouseup', function () {
    if (drag) { drag = false; document.body.style.cursor = ''; }
  });

  // ---------- P0-3：右栏「选节快编」内嵌编辑器 ----------
  // 切换模式
  const dockModeSwitch = document.getElementById('dockModeSwitch');
  if (dockModeSwitch) {
    dockModeSwitch.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        setDockMode(b.getAttribute('data-m'));
      });
    });
  }
  function setDockMode(m) {
    dockMode = m;
    dockModeSwitch.querySelectorAll('button').forEach(function (x) {
      x.classList.toggle('active', x.getAttribute('data-m') === m);
    });
    document.getElementById('dockPane-free').classList.toggle('active', m === 'free');
    document.getElementById('dockPane-session').classList.toggle('active', m === 'session');
  }

  // 时间线点击 / 矩阵点击 → 在右栏打开内嵌编辑器
  function openSessionInDock(sid) {
    // 用同步的 getSession 即可（已 hit cache）——无需 full 路径，
    // 因 Store.hydrate 后 cache.sessions 已含 transcript/soap/dap/reflection 全字段
    let s = null;
    try { s = Store.getSession(sid) || null; } catch (e) { s = null; }
    applySession(s);
  }
  function applySession(s) {
    if (!s) { App.showToast('未找到该会话', 'error'); return; }
    curSessionId = s.id;
    curSessionObj = s;
    // 切到 session 模式
    setDockMode('session');
    document.getElementById('sess-editor-empty').style.display = 'none';
    document.getElementById('sess-editor-body').style.display = '';
    document.getElementById('sess-head-title').textContent = '第 ' + (s.sessionNumber || '?') + ' 节';
    document.getElementById('sess-date').value = s.date || App.todayStr();
    document.getElementById('sess-num').value = s.sessionNumber || 1;
    document.getElementById('sess-transcript').value = s.transcript || '';
    const soap = s.soap || {};
    document.getElementById('sess-soap-s').value = soap.subjective || '';
    document.getElementById('sess-soap-o').value = soap.objective || '';
    document.getElementById('sess-soap-a').value = soap.assessment || '';
    document.getElementById('sess-soap-p').value = soap.plan || '';
    const dap = s.dap || {};
    document.getElementById('sess-dap-d').value = dap.data || '';
    document.getElementById('sess-dap-a').value = dap.assessment || '';
    document.getElementById('sess-dap-p').value = dap.plan || '';
    document.getElementById('sess-reflection').value = s.reflection || '';
    document.getElementById('sess-confirmed').checked = !!s.isConfirmed;
    // 重置到第一个 tab
    switchSessTab('transcript');
  }

  function switchSessTab(t) {
    const tabs = document.getElementById('sessTabs').querySelectorAll('button');
    tabs.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-t') === t); });
    ['transcript', 'soap', 'dap', 'reflection'].forEach(function (k) {
      document.getElementById('sp-' + k).classList.toggle('active', k === t);
    });
  }
  document.getElementById('sessTabs').addEventListener('click', function (e) {
    const b = e.target.closest('button');
    if (b) switchSessTab(b.getAttribute('data-t'));
  });

  // 保存
  document.getElementById('btnSessSave').addEventListener('click', function () {
    if (!curSessionObj) return;
    const updated = Object.assign({}, curSessionObj, {
      date: document.getElementById('sess-date').value,
      sessionNumber: parseInt(document.getElementById('sess-num').value, 10) || curSessionObj.sessionNumber,
      transcript: document.getElementById('sess-transcript').value,
      soap: {
        subjective: document.getElementById('sess-soap-s').value,
        objective: document.getElementById('sess-soap-o').value,
        assessment: document.getElementById('sess-soap-a').value,
        plan: document.getElementById('sess-soap-p').value,
      },
      dap: {
        data: document.getElementById('sess-dap-d').value,
        assessment: document.getElementById('sess-dap-a').value,
        plan: document.getElementById('sess-dap-p').value,
      },
      reflection: document.getElementById('sess-reflection').value,
      isConfirmed: document.getElementById('sess-confirmed').checked,
    });
    Store.updateSessionFull(updated).then(function (saved) {
      curSessionObj = saved;
      App.showToast('已保存', 'success');
      // 刷新中栏时间线 flag 状态
      renderCenter();
    }).catch(function (e) {
      App.showToast('保存失败：' + (e && e.message), 'error');
    });
  });

  // 跳转完整 session.html（保留为高级入口：AI 督导、删除、督导关联等）
  document.getElementById('btnSessFullEdit').addEventListener('click', function () {
    if (!curSessionId) return;
    location.href = 'session.html?id=' + curSessionId;
  });

  // ---------- 坞/栏 收放 ----------
  var dockCollapsed = false, railCollapsed = false;
  var btnTD = document.getElementById('btnToggleDock');
  var btnTR = document.getElementById('btnToggleRail');
  if (btnTD) btnTD.addEventListener('click', function () {
    dockCollapsed = !dockCollapsed;
    aidock.style.display = dockCollapsed ? 'none' : '';
    document.getElementById('resizer').style.display = dockCollapsed ? 'none' : '';
    btnTD.textContent = dockCollapsed ? '▶ 展开' : '◀ 收起';
    try { localStorage.setItem('xj_consultations_dock', dockCollapsed ? '1' : '0'); } catch(e){}
  });
  if (btnTR) btnTR.addEventListener('click', function () {
    railCollapsed = !railCollapsed;
    document.querySelector('.rail').style.display = railCollapsed ? 'none' : '';
    document.getElementById('search').parentElement.style.display = railCollapsed ? 'none' : 'block';
    btnTR.textContent = railCollapsed ? '▶ 展开' : '◀ 收起';
  });
  try {
    if (localStorage.getItem('xj_consultations_dock') === '1' && btnTD) btnTD.click();
  } catch(e) {}

  // ---------- P2-1：新建来访者模态（合并来访者导航后的责任容器） ----------
  window.saveNewClient = function () {
    const nameEl = document.getElementById('c-name');
    if (!nameEl) return;
    const name = nameEl.value.trim();
    if (!name) { App.showToast('请填写姓名或化名', 'error'); return; }
    const tagsInput = document.getElementById('c-tags').value.trim();
    const tags = tagsInput ? tagsInput.split(/[,，]/).map(function (t) { return t.trim(); }).filter(Boolean) : [];
    let client;
    try {
      client = Store.createClient({
        name: name,
        gender: document.getElementById('c-gender').value,
        birthDate: document.getElementById('c-birth').value,
        phone: document.getElementById('c-phone').value.trim(),
        firstVisitDate: document.getElementById('c-firstvisit').value,
        tags: tags,
        notes: document.getElementById('c-notes').value.trim(),
      });
    } catch (e) { App.showToast(e.message, 'error'); return; }
    App.closeModal('client-modal');
    App.showToast('已创建来访者：' + name, 'success');
    ['c-name', 'c-birth', 'c-phone', 'c-tags', 'c-notes'].forEach(function (id) {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    currentClientId = client.id;
    renderRail();
    selectClient(client.id);
  };

  // ---------- 初始渲染 ----------
  renderRail();
}

App.initPage({
  title: '咨询记录',
  onReady: initConsultations,
});
