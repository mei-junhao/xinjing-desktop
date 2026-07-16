/* 心镜 XinJing · 大师对话（方案D：左列表+中对话+右历史，拉齐Chat圆桌逻辑）
   - temperature: 0.7 (round1) / 0.6 (react/summary) — 与 Chat 项目一致
   - max_tokens: 512 (round1) / 400 (react) / 600 (summary) — 与 Chat 项目一致
   - 圆桌规则：独立回应、看不到别人、150字、可对其他大师说话 — 与 Chat 项目一致
   - 串行：过滤自己发言、600ms延迟、温尼科特summary、空格跳过 — 与 Chat 项目一致
   - @mention：其他人回应被@的大师 → 被@大师总结 — 与 Chat 项目一致
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var mode = '1v1';
  var currentConv = null;
  var roundKeys = [];
  var busy = false;
  var activeController = null;
  var convList = [];
  var includeUserDocs = true;
  // 温度滑块：每位大师独立存储，圆桌模式无滑块
  var talkTemp = 60;
  var talkDetail = 50;
  function loadTemp(key) {
    try { var v = localStorage.getItem('mc_temp_' + key); if (v != null) talkTemp = parseInt(v, 10) || 60; } catch(e) {}
    try { var d = localStorage.getItem('mc_detail_' + key); if (d != null) talkDetail = parseInt(d, 10) || 50; } catch(e) {}
    var slider = document.getElementById('temp-slider');
    if (slider) { slider.value = talkTemp; slider.parentElement.style.display = key ? '' : 'none'; }
    var dslider = document.getElementById('detail-slider');
    if (dslider) { dslider.value = talkDetail; }
  }
  function saveTemp(key) {
    try { localStorage.setItem('mc_temp_' + key, talkTemp); } catch(e) {}
    try { localStorage.setItem('mc_detail_' + key, talkDetail); } catch(e) {}
  }
  window.onTempChange = function (val) {
    talkTemp = parseInt(val, 10) || 60;
    if (currentConv && currentConv.mode === '1v1') saveTemp(currentConv.masterKeys[0]);
  };
  window.onDetailChange = function (val) {
    talkDetail = parseInt(val, 10) || 50;
    if (currentConv && currentConv.mode === '1v1') saveTemp(currentConv.masterKeys[0]);
  };

  function genId() { return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nowISO() { return new Date().toISOString(); }
  function masterName(key) { var m = getMasterByKey(key); return m ? m.name : key; }
  function accentOf(m) { var map = { accent: 'var(--accent)', purple: 'var(--purple)', blue: 'var(--blue)', green: 'var(--green)', orange: 'var(--orange)', indigo: 'var(--indigo)', red: 'var(--red)' }; return map[m.accent] || 'var(--accent)'; }

  function updateContextPanels() {
    var title = $('context-title');
    var sub = $('context-sub');
    var modeEl = $('context-mode');
    var count = $('context-master-count');
    var matrixTitle = $('matrix-title');
    var summary = $('summary-text');
    if (!title || !sub || !modeEl || !count) return;

    if (!currentConv) {
      title.textContent = '未开始对话';
      sub.textContent = mode === '1v1' ? '选择一位大师，或进入圆桌模式开始讨论' : '选择至少两位大师开始讨论';
      modeEl.textContent = mode === '1v1' ? '一对一' : '圆桌';
      count.textContent = mode === '1v1' ? '未选择' : (roundKeys.length ? roundKeys.length + ' 位大师' : '未选择');
      if (matrixTitle) matrixTitle.textContent = '尚未形成观点';
      if (summary) summary.textContent = '开始对话后，这里会保留核心议题、共识和待深入的张力。';
      return;
    }

    var names = currentConv.masterKeys.map(masterName);
    if (currentConv.mode === '1v1') {
      var master = getMasterByKey(currentConv.masterKeys[0]);
      title.textContent = currentConv.messages.length ? (currentConv.messages.find(function (m) { return m.role === 'user'; }) || {}).content || masterName(currentConv.masterKeys[0]) : '与' + masterName(currentConv.masterKeys[0]) + '开始工作';
      sub.textContent = (master ? master.school : '') + ' · 一对一';
      modeEl.textContent = '一对一';
      count.textContent = master ? master.name : names[0];
      if (matrixTitle) matrixTitle.textContent = master ? master.name + ' 的视角' : '大师视角';
    } else {
      title.textContent = currentConv.title || '圆桌研讨';
      sub.textContent = names.length + ' 位大师 · @大师 可指定发言';
      modeEl.textContent = '圆桌';
      count.textContent = names.length + ' 位大师';
      if (matrixTitle) matrixTitle.textContent = currentConv.messages.length ? '本轮观点' : '尚未形成观点';
    }
    if (summary) summary.textContent = currentConv.summary || '对话继续后，系统会自动保留核心议题、共识和待深入的张力。';
  }

  function syncDocsButton() {
    var button = $('btn-use-docs');
    if (!button) return;
    var enabled = currentDocsSetting();
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? '本次会话会引用我的资料' : '本次会话不引用我的资料';
    button.classList.toggle('active', enabled);
    var scope = $('source-scope');
    if (scope) scope.textContent = enabled ? '本次可引用资料库' : '仅本次输入';
  }

  function renderViewpoints() {
    var box = $('matrix-body');
    if (!box) return;
    if (!currentConv || !currentConv.messages.length) {
      box.innerHTML = '<div class="viewpoint-empty"><i data-lucide="layers-2"></i><span>大师回应会按视角汇总</span></div>';
      if (window.IconSystem && IconSystem.render) IconSystem.render(box);
      return;
    }
    var replies = currentConv.messages.filter(function (m) { return m.role === 'assistant' && m.content; }).slice(-3).reverse();
    box.innerHTML = replies.map(function (msg) {
      var m = msg.masterKey ? getMasterByKey(msg.masterKey) : null;
      return '<div class="viewpoint-item"><div class="viewpoint-avatar" style="background:' + accentOf(m || {}) + '">' + (m ? m.initial : '师') + '</div><div><strong>' + App.escapeHtml(m ? m.name : '大师') + '</strong><p>' + App.escapeHtml(String(msg.content).slice(0, 100)) + '</p></div></div>';
    }).join('');
    if (window.IconSystem && IconSystem.render) IconSystem.render(box);
  }

  function loadConvs() {
    try { convList = Store.getMasterConversations() || []; } catch (e) { convList = []; }
  }

  // ---------- 大师列表渲染 ----------
  function renderMasterList() {
    var box = $('master-list');
    var list = window.MASTERS || [];
    var panel = box.parentElement;
    panel.classList.toggle('mode-round', mode === 'round');
    box.innerHTML = list.map(function (m) {
      var sel = mode === '1v1' ? (currentConv && currentConv.mode === '1v1' && currentConv.masterKeys[0] === m.key) : roundKeys.indexOf(m.key) >= 0;
      return '<div class="master-card' + (sel ? ' active' : '') + '" data-key="' + m.key + '" onclick="onMasterClick(\'' + m.key + '\')">'
        + '<div class="m-avatar" style="background:' + accentOf(m) + '">' + (m.initial || m.emoji || '师') + '</div>'
        + '<div class="m-meta"><div class="m-name">' + m.name + '</div><div class="m-school">' + m.school + '</div></div>'
        + '<div class="m-check">&#10003;</div></div>';
    }).join('');
  }

  // ---------- 历史列表渲染 ----------
  function renderHistList() {
    var box = $('hist-list');
    if (!box) return;
    var filter = (document.getElementById('history-filter') || {}).value || '';
    filter = filter.trim().toLowerCase();
    var visible = convList.filter(function (c) {
      if (!filter) return true;
      var title = c.title || (c.mode === 'round' ? '圆桌研讨' : masterName(c.masterKeys[0]));
      var preview = c.messages && c.messages.length ? c.messages[0].content || '' : '';
      return (title + ' ' + preview).toLowerCase().indexOf(filter) >= 0;
    });
    if (!visible.length) { box.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px">暂无匹配对话</div>'; return; }
    box.innerHTML = visible.map(function (c) {
      var title = c.title || (c.mode === 'round' ? '圆桌研讨' : masterName(c.masterKeys[0]));
      var date = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
      var preview = c.messages.length ? (c.messages[0].content || '').slice(0, 20) : '';
      var active = currentConv && c.id === currentConv.id;
      return '<div class="hist-item' + (active ? ' active' : '') + '" onclick="loadHist(\'' + c.id + '\')">'
        + '<div>' + App.escapeHtml(title) + '</div>'
        + '<div>' + date + ' · ' + c.messages.length + '条</div>'
        + (preview ? '<div>' + App.escapeHtml(preview) + '</div>' : '')
        + '<button onclick="deleteConvById(\'' + c.id + '\', event)" title="删除" aria-label="删除"></button>'
        + '</div>';
    }).join('');
  }

  window.loadHist = function (id) {
    var c = convList.find(function (x) { return x.id === id; });
    if (!c) return;
    currentConv = c;
    if (c.mode === 'round') { roundKeys = c.masterKeys.slice(); mode = 'round'; }
    else { mode = '1v1'; }
    document.querySelectorAll('#mode-toggle button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };

  // ---------- 模式切换 ----------
  window.setMode = function (m) {
    mode = m;
    document.querySelectorAll('#mode-toggle button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === m); });
    currentConv = null; roundKeys = [];
    if (m === 'round') {
      // 多圆桌会话：按更新时间倒序选最近一个
      var rounds = convList.filter(function (c) { return c.mode === 'round'; });
      rounds.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
      var last = rounds[0] || null;
      if (last) { currentConv = last; roundKeys = last.masterKeys.slice(); }
    }
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };

  // 新建圆桌
  window.newRound = function () {
    mode = 'round';
    document.querySelectorAll('#mode-toggle button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === 'round'); });
    currentConv = null; roundKeys = [];
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };
  document.getElementById('mode-toggle').addEventListener('click', function (e) {
    var btn = e.target.closest('button'); if (!btn) return;
    window.setMode(btn.dataset.mode);
  });

  document.querySelectorAll('[data-inspector-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var key = tab.dataset.inspectorTab;
      document.querySelectorAll('[data-inspector-tab]').forEach(function (item) { item.classList.toggle('active', item === tab); });
      document.querySelectorAll('.inspector-view').forEach(function (view) { view.classList.toggle('active', view.id === 'inspector-' + key); });
    });
  });

  function currentDocsSetting() {
    if (currentConv && currentConv.settings && currentConv.settings.includeUserDocs === false) return false;
    return includeUserDocs;
  }

  function setDocsSetting(enabled) {
    includeUserDocs = enabled;
    if (currentConv) {
      currentConv.settings = Object.assign({}, currentConv.settings || {}, { includeUserDocs: enabled });
      Store.saveMasterConversation(currentConv);
    }
    var button = $('btn-use-docs');
    if (button) {
      button.setAttribute('aria-pressed', String(enabled));
      button.title = enabled ? '本次会话会引用我的资料' : '本次会话不引用我的资料';
      button.classList.toggle('active', enabled);
    }
    if (typeof App !== 'undefined' && App.showToast) App.showToast(enabled ? '本次会话将引用我的资料' : '本次会话不再引用我的资料', '');
  }

  function quoteLastMessage() {
    if (!currentConv || !currentConv.messages.length) { App.showToast('当前还没有可引用的发言', 'warning'); return; }
    var message = currentConv.messages.slice().reverse().find(function (m) { return m.role === 'assistant' && m.content; });
    if (!message) { App.showToast('当前还没有可引用的大师发言', 'warning'); return; }
    var input = $('msg-input');
    var quote = '> ' + masterName(message.masterKey) + '：' + message.content.trim() + '\n\n';
    input.value = quote + input.value;
    input.focus();
  }

  function saveCurrentPoint() {
    if (!currentConv || !currentConv.messages.length) { App.showToast('开始对话后才能保存观点', 'warning'); return; }
    var message = currentConv.messages.slice().reverse().find(function (m) { return m.role === 'assistant' && m.content; });
    if (!message) { App.showToast('当前还没有可保存的大师观点', 'warning'); return; }
    currentConv.savedPoints = Array.isArray(currentConv.savedPoints) ? currentConv.savedPoints : [];
    currentConv.savedPoints.push({ id: genId(), masterKey: message.masterKey, content: message.content, createdAt: nowISO() });
    Store.saveMasterConversation(currentConv);
    App.showToast('观点已保存到当前对话', 'success');
  }

  function insertMention() {
    var input = $('msg-input');
    if (!input || input.disabled) { App.showToast('请先选择大师', 'warning'); return; }
    input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + '@';
    input.focus();
  }

  function toggleInspectorDensity() {
    var page = document.querySelector('.masters-clinical-page');
    var button = $('btn-pin-inspector');
    if (!page || !button) return;
    var compact = page.classList.toggle('inspector-compact');
    button.setAttribute('aria-pressed', String(compact));
    button.title = compact ? '恢复摘要详情' : '切换摘要密度';
    App.showToast(compact ? '已切换为紧凑摘要' : '已显示摘要详情', '');
  }

  function openNextSession() { location.href = 'session-calendar.html'; }

  function saveSupervisionDraft() {
    if (!currentConv || !currentConv.messages.length) { App.showToast('开始对话后才能保存督导草稿', 'warning'); return; }
    var text = currentConv.summary || currentConv.messages.filter(function (m) { return m.role === 'assistant'; }).slice(-3).map(function (m) { return m.content; }).join('\n\n');
    if (!text) { App.showToast('当前没有可保存的观点', 'warning'); return; }
    try { localStorage.setItem('xj_sup_v31_draft', text); } catch (e) {}
    location.href = 'supervision.html';
  }

  var quoteButton = $('btn-quote-last');
  if (quoteButton) quoteButton.addEventListener('click', quoteLastMessage);
  var pointButton = $('btn-save-point');
  if (pointButton) pointButton.addEventListener('click', saveCurrentPoint);
  var docsButton = $('btn-use-docs');
  if (docsButton) docsButton.addEventListener('click', function () { setDocsSetting(!currentDocsSetting()); });
  var mentionButton = $('btn-mention');
  if (mentionButton) mentionButton.addEventListener('click', insertMention);
  var pinButton = $('btn-pin-inspector');
  if (pinButton) pinButton.addEventListener('click', toggleInspectorDensity);
  var nextButton = $('btn-next-session');
  if (nextButton) nextButton.addEventListener('click', openNextSession);
  var supervisionButton = $('btn-supervision-draft');
  if (supervisionButton) supervisionButton.addEventListener('click', saveSupervisionDraft);
  var filterButton = $('btn-filter-history');
  if (filterButton) filterButton.addEventListener('click', function () {
    var input = $('history-filter');
    if (!input) return;
    input.hidden = !input.hidden;
    filterButton.setAttribute('aria-pressed', String(!input.hidden));
    if (!input.hidden) { input.focus(); } else { input.value = ''; }
    renderHistList();
  });
  var filterInput = $('history-filter');
  if (filterInput) filterInput.addEventListener('input', renderHistList);

  var masterSearch = document.querySelector('.masters-search input');
  if (masterSearch) {
    masterSearch.addEventListener('input', function () {
      var q = masterSearch.value.trim().toLowerCase();
      document.querySelectorAll('#master-list .master-card').forEach(function (card) {
        card.hidden = !!q && card.textContent.toLowerCase().indexOf(q) === -1;
      });
    });
  }

  // ---------- 大师点击 ----------
  window.onMasterClick = function (key) {
    if (mode === '1v1') {
      loadTemp(key);
      var conv = convList.find(function (c) { return c.mode === '1v1' && c.masterKeys[0] === key; });
      if (!conv) {
        var m = getMasterByKey(key);
        conv = { id: genId(), mode: '1v1', masterKeys: [key], title: m ? m.name : key, messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        Store.saveMasterConversation(conv); convList.unshift(conv);
      }
      currentConv = conv;
    } else {
      var idx = roundKeys.indexOf(key);
      if (idx >= 0) roundKeys.splice(idx, 1); else roundKeys.push(key);
      var sameRound = currentConv && currentConv.mode === 'round' && !currentConv.messages.length;
      if (sameRound) {
        currentConv.masterKeys = roundKeys.slice();
        Store.saveMasterConversation(currentConv);
      } else if (roundKeys.length >= 2) {
        currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        Store.saveMasterConversation(currentConv); convList.unshift(currentConv);
      } else {
        currentConv = null;
      }
    }
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };

  // ---------- 对话渲染 ----------
  function renderChat() {
    var titleEl = $('chat-title'), subEl = $('chat-sub'), body = $('chat-body');
    syncDocsButton();
    var input = $('msg-input'), sendBtn = $('send-btn'), btnNew = $('btn-new'), btnDel = $('btn-del');

    if (!currentConv) {
      titleEl.textContent = mode === '1v1' ? '选择一位大师' : '勾选大师';
      subEl.textContent = mode === '1v1' ? '从左侧挑选一位开始对话' : '在左侧勾选两位及以上大师';
      body.innerHTML = '<div class="empty-state"><i data-lucide="messages-square"></i><div class="big">把一个临床问题带到桌面上</div><span>先选择大师，再输入你正在思考的材料</span></div>';
      input.disabled = true; sendBtn.disabled = true;
      btnNew.style.display = 'none'; btnDel.style.display = 'none';
      updateContextPanels(); renderViewpoints();
      if (window.IconSystem && IconSystem.render) IconSystem.render(body);
      return;
    }

    btnNew.style.display = ''; btnDel.style.display = '';
    input.disabled = false; sendBtn.disabled = false;

    if (currentConv.mode === '1v1') {
      var m = getMasterByKey(currentConv.masterKeys[0]);
      titleEl.innerHTML = '<span class="dialogue-title-mark" style="background:' + accentOf(m || {}) + '">' + (m ? m.initial : '师') + '</span>' + (m ? m.name : currentConv.masterKeys[0]);
      if (m && currentConv.messages.length === 0 && (m.introTitle || m.intro)) {
        // v3.4.2: 复刻截图式空态 — emoji + 问候 + 3 个专属选项
        var opts = '';
        var quickOpts = m.quickOptions || ['帮我理解临床中的移情-反移情', '如何理解来访者的沉默', '我最近在临床中感到疲惫'];
        opts = '<div class="masters-intro-quick">';
        quickOpts.forEach(function (o) {
          opts += '<button onclick="sendQuick(\'' + App.escapeHtml(o).replace(/'/g, "\\'") + '\')">' + App.escapeHtml(o) + '</button>';
        });
        opts += '</div>';
        subEl.innerHTML = '<div class="masters-intro">'
          + '<div class="masters-intro-mark">' + App.escapeHtml(m.initial || '') + '</div>'
          + '<div class="masters-intro-title">' + App.escapeHtml(m.introTitle || '') + '</div>'
          + '<div class="masters-intro-copy">' + App.escapeHtml(m.intro || '') + '</div>' + opts + '</div>';
      } else {
        subEl.textContent = (m ? m.school : '') + ' · 一对一';
      }
    } else {
      var names = currentConv.masterKeys.map(masterName).join('、');
      titleEl.textContent = '圆桌 · ' + (names || '');
      subEl.textContent = '多大师研讨 · @大师 可指定发言';
    }

    body.innerHTML = currentConv.messages.map(renderMsg).join('');
    body.scrollTop = body.scrollHeight;
    updateContextPanels(); renderViewpoints();
    if (window.IconSystem && IconSystem.render) IconSystem.render(body);
  }

  function renderMsg(msg) {
    if (msg.role === 'sys') {
      return '<div class="msg" style="justify-content:center"><div class="bubble" style="background:transparent;border:1px dashed var(--border);color:var(--text-muted);font-size:12px;padding:6px 14px;border-radius:10px;max-width:88%">' + App.escapeHtml(msg.content) + '</div></div>';
    }
    if (msg.role === 'user') {
      return '<div class="msg user"><div class="body"><div class="bubble">' + App.escapeHtml(msg.content) + '</div></div></div>';
    }
    var m = msg.masterKey ? getMasterByKey(msg.masterKey) : null;
    var name = m ? m.name : (msg.masterKey || '大师');
    var color = m ? accentOf(m) : 'var(--accent)';
    var initial = m ? m.initial : '师';
    var statusLabel = msg.status === 'interrupted' ? ' · 已中断' : '';
    return '<div class="msg ai' + (msg.status === 'interrupted' ? ' interrupted' : '') + '"><div class="av" style="background:' + color + '">' + initial + '</div><div class="body"><div class="sender">' + name + statusLabel + '</div><div class="bubble">' + App.escapeHtml(msg.content) + '</div></div></div>';
  }

  // ---------- 快捷提问（空态点击） ----------
  window.sendQuick = function (text) {
    var input = $('msg-input');
    if (input) input.value = text;
    window.sendMessage();
  };

  // ---------- 发送消息 ----------
  window.sendMessage = function () {
    if (busy) {
      if (activeController) activeController.abort();
      return;
    }
    if (!App.featureGate('ai-masters')) { applyAiLock(); App.showToast('AI 对话为付费功能' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'error'); return; }

    var input = $('msg-input');
    var text = (input.value || '').trim();
    if (!text) return;

    // 解析 @大师
    var targetKeys = null;
    var atMatch = text.match(/@([A-Za-z_\u4e00-\u9fa5]+)/);
    if (mode === 'round' && atMatch) {
      var hit = (window.MASTERS || []).find(function (m) { return m.name === atMatch[1] || m.key === atMatch[1].toLowerCase(); });
      if (hit) targetKeys = [hit.key];
    }

    if (!currentConv) {
      if (mode === '1v1') { App.showToast('请先选择一位大师', 'error'); return; }
      if (roundKeys.length < 2) { App.showToast('圆桌至少选择两位大师', 'warning'); return; }
      currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
      Store.saveMasterConversation(currentConv); convList.unshift(currentConv); flashSaved();
    }
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('master_chat', { summary: '与大师对话：' + text.slice(0, 30) });
    if (mode === 'round' && currentConv.mode !== 'round') {
      currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
      Store.saveMasterConversation(currentConv); convList.unshift(currentConv); flashSaved();
    }

    var cleanText = text.replace(/@[A-Za-z_\u4e00-\u9fa5]+\s*/, '').trim() || text;
    currentConv.messages.push({ role: 'user', content: cleanText, ts: Date.now() });
    input.value = '';
    renderChat();
    Store.saveMasterConversation(currentConv); flashSaved();

    var keys = (mode === '1v1') ? currentConv.masterKeys : (targetKeys || roundKeys);
    runMasters(keys, cleanText, targetKeys);
  };

  // ===== 圆桌 system prompt 规则（与 Chat roundtable.html 一致）=====
  // [我的资料库] 由 MastersCore 统一追加，页面只传递当前圆桌参数。
  function buildRoundSysPrompt(m, activeNames, isReactMode) {
    return MastersCore.buildRoundSystemPrompt(m, activeNames, isReactMode, { includeUserDocs: currentDocsSetting() });
  }

  // 1v1 system prompt（保持原逻辑 + style constraints）
  function build1v1SysPrompt(m) {
    return MastersCore.buildOneToOneSystemPrompt(currentConv, m, { temperature: talkTemp, includeUserDocs: currentDocsSetting() });
  }

  // 核心：调用大师 API（并行第一轮 + 串行 reacting）
  async function runMasters(keys, userText, mentionedKeys) {
    busy = true;
    activeController = mode === '1v1' && typeof AbortController !== 'undefined' ? new AbortController() : null;
    setGeneratingUi(true);
    $('msg-input').disabled = true;

    var activeNames = (mode === 'round' ? currentConv.masterKeys : keys).map(masterName).join('、');

    // 一对一优先使用流式响应；圆桌保留完整轮次，避免大师之间的上下文被半成品打断。
    if (mode === '1v1') {
      var singleKey = keys[0];
      var singleTyping = appendTyping(singleKey);
      var streamMessage = { role: 'assistant', content: '', masterKey: singleKey, status: 'streaming', ts: Date.now() };
      currentConv.messages.push(streamMessage);
      Store.saveMasterConversation(currentConv);
      var snapshotTimer = null;
      var scheduleSnapshot = function () {
        if (snapshotTimer) return;
        snapshotTimer = setTimeout(function () {
          snapshotTimer = null;
          Store.saveMasterConversation(currentConv);
        }, 700);
      };
      var singleResult = await callMaster(singleKey, userText, false, activeNames, {
        onDelta: function (piece, fullText) {
          streamMessage.content = fullText;
          updateTyping(singleTyping, fullText);
          scheduleSnapshot();
        },
        signal: activeController ? activeController.signal : undefined,
      });
      if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
      if (singleTyping) singleTyping.remove();
      if (singleResult && singleResult.content && singleResult.content.trim()) {
        streamMessage.content = singleResult.content;
        streamMessage.status = singleResult.interrupted ? 'interrupted' : 'complete';
      } else if (singleResult && singleResult.error) {
        var partial = singleResult.partialContent || '';
        streamMessage.content = partial || '（生成失败：' + singleResult.error + '）';
        streamMessage.status = partial ? 'interrupted' : 'error';
      } else {
        streamMessage.content = '（模型未返回内容）';
        streamMessage.status = 'error';
      }
      renderChat();
      Store.saveMasterConversation(currentConv); flashSaved();
      busy = false;
      setGeneratingUi(false);
      $('msg-input').disabled = false;
      $('msg-input').focus();
      activeController = null;
      return;
    }

    // Round 1：所有大师并行
    var typingEls = {};
    keys.forEach(function (k) { typingEls[k] = appendTyping(k); });

    var round1Results = {};
    var promises = keys.map(function (k) {
      return callMaster(k, userText, false, activeNames).then(function (r) { round1Results[k] = r; });
    });
    await Promise.allSettled(promises);

    keys.forEach(function (k) { if (typingEls[k]) typingEls[k].remove(); });

    var repliedKeys = [];
    keys.forEach(function (k) {
      var r = round1Results[k];
      if (r && !r.error && r.content && r.content.trim() && r.content.trim() !== ' ') {
        currentConv.messages.push({ role: 'assistant', content: r.content, masterKey: k, ts: Date.now() });
        repliedKeys.push(k);
      } else if (r && r.error) {
        currentConv.messages.push({ role: 'assistant', content: '（生成失败：' + r.error + '）', masterKey: k, ts: Date.now() });
      }
      // ponytail: 空格/空回复 = 跳过，与 Chat 一致
    });
    renderChat();
    Store.saveMasterConversation(currentConv); flashSaved();

    // Round 2：串行 reacting（仅圆桌模式，>=2 位大师回复）
    if (mode === 'round' && repliedKeys.length >= 2) {
      var isMention = mentionedKeys && mentionedKeys.length > 0;

      if (isMention) {
        // @mention 流程：其他人回应被@的大师 → 被@大师总结
        var targetKey = mentionedKeys[0];
        var others = repliedKeys.filter(function (k) { return k !== targetKey; });
        if (others.length > 0) {
          // 其他人并行回应被@的大师
          var mentionPromises = others.map(function (k) {
            var context = masterName(targetKey) + '：' + round1Results[targetKey].content;
            return callMaster(k, '以下是' + masterName(targetKey) + '的发言，请你就其观点做出回应：\n\n' + context, true, activeNames);
          });
          var mentionResults = await Promise.allSettled(mentionPromises);
          mentionResults.forEach(function (r, i) {
            var k = others[i];
            if (r.status === 'fulfilled' && r.value && r.value.content && r.value.content.trim() && r.value.content.trim() !== ' ') {
              currentConv.messages.push({ role: 'assistant', content: r.value.content, masterKey: k, ts: Date.now() });
            }
          });
          renderChat(); Store.saveMasterConversation(currentConv); flashSaved();
        }
        // 被@大师做总结
        var targetTyping = appendTyping(targetKey);
        var summaryResult = await callMaster(targetKey, null, 'summary', activeNames);
        if (targetTyping) targetTyping.remove();
        if (summaryResult && summaryResult.content && summaryResult.content.trim()) {
          currentConv.messages.push({ role: 'assistant', content: summaryResult.content, masterKey: targetKey, ts: Date.now() });
        }
        renderChat(); Store.saveMasterConversation(currentConv); flashSaved();
      } else {
        // 正常串行流程
        var serialOrder = repliedKeys.filter(function (k) { return k !== 'winnicott'; });
        if (repliedKeys.indexOf('winnicott') >= 0) serialOrder.push('winnicott');

        for (var i = 0; i < serialOrder.length; i++) {
          var sk = serialOrder[i];
          var isLast = (i === serialOrder.length - 1);

          // 收集其他大师的发言（过滤掉自己的）— 与 Chat 一致
          var context = repliedKeys.filter(function (k) { return k !== sk; }).map(function (k) {
            return masterName(k) + '：' + round1Results[k].content;
          }).join('\n\n');

          var reactPrompt = isLast
            ? '以下是其他大师对同一议题的发言，请你作为总结者，综合各位观点，给出你的最终回应：\n\n' + context
            : '以下是其他大师对这一议题的发言，请你就他们的观点做出回应，可补充、质疑或深化：\n\n' + context;

          var typingEl = appendTyping(sk);
          var rr = await callMaster(sk, reactPrompt, isLast ? 'summary' : true, activeNames);
          if (typingEl) typingEl.remove();

          // ponytail: 空格/空回复 = 跳过
          if (rr && !rr.error && rr.content && rr.content.trim() && rr.content.trim() !== ' ') {
            currentConv.messages.push({ role: 'assistant', content: rr.content, masterKey: sk, ts: Date.now() });
          }
          renderChat();
          Store.saveMasterConversation(currentConv); flashSaved();

          if (!isLast) await sleep(600);
        }
      }
    }

    busy = false;
    setGeneratingUi(false);
    $('msg-input').disabled = false;
    $('msg-input').focus();
    activeController = null;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function setGeneratingUi(isGenerating) {
    var button = $('send-btn');
    if (!button) return;
    button.disabled = isGenerating && mode === 'round';
    button.classList.toggle('is-stop', !!isGenerating);
    button.title = isGenerating ? '中止生成' : '发送';
    button.setAttribute('aria-label', isGenerating ? '中止生成' : '发送');
    button.innerHTML = '<i data-lucide="' + (isGenerating ? 'square' : 'arrow-up') + '"></i>';
    if (window.IconSystem && IconSystem.render) IconSystem.render(button);
  }

  // 调用单个大师 — 传递 temperature 和 maxTokens（与 Chat 项目一致）
  async function callMaster(masterKey, userText, isReactMode, activeNames, streamOptions) {
    var m = getMasterByKey(masterKey);
    if (!m) return { error: '大师未找到' };

    var system, options;
    if (mode === 'round' && activeNames) {
      system = buildRoundSysPrompt(m, activeNames, isReactMode);
      options = {
        temperature: isReactMode ? 0.6 : 0.7,
        maxTokens: isReactMode === 'summary' ? 600 : (isReactMode ? 400 : 512),
      };
    } else {
      system = build1v1SysPrompt(m);
      // v3.4.2: 温度滑块控制 temperature，详细度滑块控制 maxTokens
      options = {
        temperature: talkTemp / 100,
        maxTokens: 256 + Math.round(talkDetail / 100 * 768)
      };
    }

    if (typeof MastersCore !== 'undefined' && MastersCore.callMaster) {
      return MastersCore.callMaster(currentConv, m, userText, Object.assign({}, options, streamOptions || {}, { systemPrompt: system }))
        .then(function (res) {
          if (res && res.content && !res.error) return { content: res.content, interrupted: !!res.interrupted };
          return {
            error: (res && res.error) || '无响应',
            partialContent: (res && res.partialContent) || '',
            interrupted: !!(res && res.interrupted),
          };
        });
    }
    return Promise.resolve({ error: '大师对话核心未就绪' });
  }

  function appendTyping(key) {
    var m = getMasterByKey(key);
    var body = $('chat-body');
    var el = document.createElement('div');
    el.className = 'msg ai typing';
    el.innerHTML = '<div class="av" style="background:' + accentOf(m) + '">' + m.initial + '</div><div class="body"><div class="sender">' + m.name + '</div><div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span> 思考中…</div></div>';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function updateTyping(el, text) {
    if (!el) return;
    var bubble = el.querySelector('.bubble');
    if (!bubble) return;
    bubble.textContent = text || '思考中…';
    el.classList.toggle('has-content', !!text);
    var body = $('chat-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  // ---------- 新对话 / 删除 ----------
  // 语义：先把当前对话存入历史记录（若含消息），再开启一个全新、无上下文的对话
  window.newConversation = function () {
    if (currentConv && currentConv.messages && currentConv.messages.length) {
      if (!convList.some(function (c) { return c.id === currentConv.id; })) {
        Store.saveMasterConversation(currentConv);
        convList.unshift(currentConv);
      } else {
        Store.saveMasterConversation(currentConv); // 已在历史中，确保最新消息落盘
      }
    }
    currentConv = null; roundKeys = [];
    renderMasterList(); renderChat(); renderHistList();
  };
  window.deleteCurrent = function () {
    if (!currentConv) return;
    App.confirmDialog('确定删除当前对话？此操作不可恢复。', function () {
      Store.deleteMasterConversation(currentConv.id);
      convList = convList.filter(function (c) { return c.id !== currentConv.id; });
      currentConv = null; renderMasterList(); renderChat(); renderHistList();
    }, true);
  };
  // v3.4.2: 导出当前对话为 Markdown
  window.exportCurrent = function () {
    if (!currentConv) { App.showToast('请先选择对话', 'warning'); return; }
    var md = '# ' + (currentConv.title || '大师对话') + '\n\n';
    md += '> 日期：' + (currentConv.updatedAt ? new Date(currentConv.updatedAt).toLocaleDateString('zh-CN') : '') + ' | ' + currentConv.messages.length + ' 条消息\n\n';
    if (currentConv.summary) md += '## 摘要\n\n' + currentConv.summary + '\n\n';
    md += '## 对话\n\n';
    currentConv.messages.forEach(function (msg) {
      if (msg.role === 'user') md += '**你**：' + msg.content + '\n\n';
      else if (msg.role === 'assistant') {
        var nm = msg.masterKey ? (masterName(msg.masterKey) || msg.masterKey) : '大师';
        md += '**' + nm + '**：' + msg.content + '\n\n';
      }
    });
    var html = App.mdToWordHtml(md);
    App.exportWordDoc((currentConv.title || 'master_chat') + '_' + new Date().toISOString().slice(0, 10) + '.doc', html);
    App.showToast('已导出为 Word 文档', 'success');
  };
  // v3.4.2: 删除指定对话（从历史列表）
  window.deleteConvById = function (id, event) {
    if (event) event.stopPropagation();
    App.confirmDialog('确定删除这条对话？此操作不可恢复。', function () {
      Store.deleteMasterConversation(id);
      convList = convList.filter(function (c) { return c.id !== id; });
      if (currentConv && currentConv.id === id) currentConv = null;
      renderMasterList(); renderChat(); renderHistList();
    }, true);
  };

  // ---------- AI 锁 ----------
  function applyAiLock() {
    var lock = $('ai-lock'), input = $('msg-input'), sendBtn = $('send-btn');
    if (!lock) return;
    if (App.aiUnlocked()) {
      lock.classList.add('hidden');
      input.disabled = !currentConv; sendBtn.disabled = !currentConv;
    } else {
      lock.classList.remove('hidden');
      input.disabled = true; sendBtn.disabled = true;
    }
  }
  App.onLicenseStateChange(function () { try { applyAiLock(); } catch (e) {} });
  function openActivation() { if (window.__XJ_API__ && window.__XJ_API__.openActivation) window.__XJ_API__.openActivation(); }
  window.openActivation = openActivation;

  // "已保存" 闪烁提示
  function flashSaved() {
    var el = document.getElementById('save-indicator');
    if (!el) return;
    el.style.display = 'inline';
    setTimeout(function () { el.style.display = 'none'; }, 1500);
  }

  // ---------- 初始化 ----------
  App.initPage({
    title: '大师对话',
    noSidebar: true,
    onReady: function () {
      loadConvs();
      renderMasterList();
      renderChat();
      renderHistList();
      applyAiLock();
    },
  });
})();
