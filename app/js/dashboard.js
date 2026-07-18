/* 心镜 v3.5.0 — 首页工作台（小镜面板已统一到 xiaojing-panel.js） */
(function () {
  'use strict';

  var money = function (n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); };

  document.getElementById('wel-date').textContent = App.todayFullCN();

  function renderStats() {
    var allSessions = Store.getSessions();
    var today = App.todayStr();
    var ym = today.slice(0, 7);
    var todaySessions = allSessions.filter(function (s) { return s.date === today; });
    var mRec = 0, mRecv = 0;
    allSessions.forEach(function (s) {
      var fee = (s.billing && Number(s.billing.fee)) || 0;
      if (fee > 0 && s.date && s.date.slice(0, 7) === ym) {
        mRec += fee;
        if (s.billing && s.billing.paid) mRecv += fee;
      }
    });
    var pendingReports = allSessions.filter(function (s) { return noteMode(s) === '待记录' && s.status !== 'cancelled'; }).length;

    document.getElementById('stat-today').textContent = todaySessions.length + ' 节';
    document.getElementById('stat-today-sub').textContent = '已记录 ' + todaySessions.filter(function (s) { return noteMode(s) === '已有记录'; }).length + ' 节';
    document.getElementById('stat-income').textContent = money(Math.max(0, mRec - mRecv));
    document.getElementById('stat-income-sub').textContent = '应收 ' + money(mRec) + ' · 已收 ' + money(mRecv);
    document.getElementById('stat-pending-reports').textContent = pendingReports;
  }

  function esc(v) { return App.escapeHtml(String(v || '')); }

  function noteMode(s) {
    return (s.hasSoap || s.hasDap || s.hasSummary || s.notes || s.transcript) ? '已有记录' : '待记录';
  }

  function sessionHref(s) {
    return 'consult-notes.html?clientId=' + encodeURIComponent(s.clientId || '') +
      '&sessionId=' + encodeURIComponent(s.id || '') + '&mode=quick';
  }

  function renderSchedule() {
    var today = App.todayStr();
    var sessions = Store.getSessions().filter(function (s) { return s && s.date; });
    var todaySessions = sessions.filter(function (s) { return s.date === today; }).sort(function (a, b) {
      return String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99'));
    });
    var week = document.getElementById('week-schedule');
    var list = document.getElementById('today-schedule');
    if (!week || !list) return;
    var base = new Date(today + 'T00:00:00');
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(base); d.setDate(base.getDate() + i);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      var count = sessions.filter(function (s) { return s.date === key && s.status !== 'cancelled'; }).length;
      days.push('<button class="schedule-day' + (count ? ' has-session' : '') + '" onclick="location.href=\'session-calendar.html?date=' + key + '\'" title="查看日历">' +
        (i === 0 ? '今天' : ('周' + '日一二三四五六'.charAt(d.getDay()))) + '<br><b>' + (d.getMonth() + 1) + '/' + d.getDate() + '</b><br>' + (count ? count + ' 节' : '空闲') + '</button>');
    }
    week.innerHTML = days.join('');
    if (!todaySessions.length) {
      list.innerHTML = '<div class="schedule-empty">今天没有已安排的会谈。<a href="session-calendar.html">安排一节会谈</a></div>';
      return;
    }
    list.innerHTML = todaySessions.map(function (s) {
      var c = Store.getClient(s.clientId);
      var name = c ? c.name : '未命名来访者';
      return '<div class="today-session"><div class="today-session-time">' + esc((s.startTime || '待定').slice(0, 5)) + '</div>' +
        '<div class="today-session-info"><div class="today-session-name">' + esc(name) + ' · 第' + esc(s.sessionNumber || '?') + '节</div><div class="today-session-meta">' + esc(noteMode(s)) + (s.status ? ' · ' + esc(s.status) : '') + '</div></div>' +
        '<div class="today-session-actions"><a class="back" href="' + sessionHref(s) + '">开始记录</a></div></div>';
    }).join('');
  }

  function bindStartNextSession() {
    var button = document.getElementById('start-next-session');
    if (!button) return;
    button.addEventListener('click', function () {
      var today = App.todayStr();
      var now = new Date();
      var current = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      var sessions = Store.getSessions().filter(function (s) {
        return s && s.date === today && s.status !== 'cancelled';
      }).sort(function (a, b) {
        return String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99'));
      });
      var next = sessions.find(function (s) { return !s.startTime || String(s.startTime).slice(0, 5) >= current; }) || sessions[0];
      location.href = next ? sessionHref(next) : 'session-calendar.html?action=new&date=' + encodeURIComponent(today);
    });
  }

  function renderRecent() {
    var container = document.getElementById('recent-sessions');
    var sessions = Store.getRecentSessions(3);
    if (!sessions.length) {
      container.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">暂无咨询记录</div>';
      return;
    }
    container.innerHTML = sessions.map(function (s) {
      var client = Store.getClient(s.clientId);
      var name = client ? client.name : '未知';
      var fee = (s.billing && s.billing.fee) ? ' · ¥' + s.billing.fee : '';
      var tags = [];
      if (s.hasSoap) tags.push('SOAP');
      if (s.hasDap) tags.push('DAP');
      if (s.hasReflection) tags.push('反思');
      return '<div class="ritem"><div class="rav">' + (name.charAt(0) || '?') + '</div><div class="info"><div class="nm">' + App.escapeHtml(name) + ' · 第' + s.sessionNumber + '节</div><div class="mt">' + App.formatDate(s.date) + fee + '</div></div>' + (tags.length ? '<span class="tag">' + tags.join(' · ') + '</span>' : '') + '</div>';
    }).join('');
  }

  function renderTodo() {
    var container = document.getElementById('todo-list');
    var allSessions = Store.getSessions();
    var clients = Store.getClients();
    var items = [];

    var pending = allSessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).slice(0, 2);
    pending.forEach(function (s) {
      var c = Store.getClient(s.clientId);
      items.push({ nm: '整理逐字稿：' + (c ? c.name : '?') + ' 第' + s.sessionNumber + '节', mt: App.formatDate(s.date) });
    });

    clients.forEach(function (c) {
      var owe = Store.getSessionsByClient(c.id).reduce(function (s, x) {
        return s + ((x.billing && x.billing.fee > 0 && !x.billing.paid) ? 1 : 0);
      }, 0);
      if (owe > 0 && items.length < 4) {
        items.push({ nm: '催收：' + c.name, mt: owe + ' 节未付' });
      }
    });

    if (!items.length) {
      container.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">暂无待办</div>';
      return;
    }
    container.innerHTML = items.map(function (i) {
      return '<div class="ritem"><div class="rav" style="background:var(--bg-sunken);color:var(--ink-2)">·</div><div class="info"><div class="nm">' + App.escapeHtml(i.nm) + '</div><div class="mt">' + App.escapeHtml(i.mt) + '</div></div></div>';
    }).join('');
  }

  function renderKbTile(_retry) {
    var el = document.getElementById('kb-mod-count');
    if (!el) return;
    if (typeof UserDocs === 'undefined' || !UserDocs.getMeta) {
      if ((_retry || 0) < 10) { setTimeout(function () { renderKbTile((_retry || 0) + 1); }, 300); }
      return;
    }
    UserDocs.getMeta(false).then(function (meta) {
      if (!meta || !meta.ok || !meta.folder) {
        el.textContent = '未设置';
        el.style.background = 'var(--bg-sunken)';
        el.style.color = 'var(--ink-2)';
        return;
      }
      var st = meta.stats || {};
      var files = st.fileCount || (meta.files ? meta.files.length : 0);
      if (!files) {
        el.textContent = '空文件夹';
        el.style.background = 'var(--bg-sunken)';
        el.style.color = 'var(--ink-2)';
        return;
      }
      var chars = st.totalChars || 0;
      var kw = chars >= 10000 ? (Math.round(chars / 1000) / 10) + '万字' : chars + '字';
      el.textContent = files + ' 份 · ' + kw;
      el.style.background = 'var(--success)';
      el.style.color = '#fff';
    }).catch(function () {
      el.textContent = '未设置';
    });
  }

  // 快捷入口只保存界面偏好，不触碰来访者、会谈或账务数据。
  var QUICK_LAYOUT_KEY = 'xj_quick_tools_layout_v1';
  var quickToolsEditing = false;
  var draggedQuickCard = null;
  var defaultQuickLayout = null;
  var moreWasOpenBeforeEditing = false;

  function getQuickToolContainers() {
    return {
      quick: document.getElementById('quick-modules'),
      more: document.getElementById('more-modules'),
      moreButton: document.getElementById('more-mod-btn')
    };
  }

  function getQuickToolKeys(container) {
    if (!container) return [];
    return Array.prototype.slice.call(container.querySelectorAll('[data-quick-key]')).map(function (card) {
      return card.dataset.quickKey;
    });
  }

  function captureQuickLayout() {
    var containers = getQuickToolContainers();
    return { quick: getQuickToolKeys(containers.quick), more: getQuickToolKeys(containers.more) };
  }

  function readQuickLayout() {
    try {
      var saved = localStorage.getItem(QUICK_LAYOUT_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      try { localStorage.removeItem(QUICK_LAYOUT_KEY); } catch (ignore) {}
      return null;
    }
  }

  function isValidQuickLayout(layout) {
    if (!layout || !Array.isArray(layout.quick) || !Array.isArray(layout.more) || !defaultQuickLayout) return false;
    var expected = defaultQuickLayout.quick.concat(defaultQuickLayout.more).sort();
    var actual = layout.quick.concat(layout.more).slice().sort();
    return actual.length === expected.length && actual.every(function (key, index) { return key === expected[index]; });
  }

  function applyQuickLayout(layout) {
    if (!isValidQuickLayout(layout)) return;
    var containers = getQuickToolContainers();
    if (!containers.quick || !containers.more) return;
    var cards = {};
    document.querySelectorAll('[data-quick-key]').forEach(function (card) { cards[card.dataset.quickKey] = card; });
    layout.quick.forEach(function (key) {
      if (cards[key]) containers.quick.insertBefore(cards[key], containers.moreButton || null);
    });
    layout.more.forEach(function (key) {
      if (cards[key]) containers.more.appendChild(cards[key]);
    });
  }

  function saveQuickLayout() {
    try { localStorage.setItem(QUICK_LAYOUT_KEY, JSON.stringify(captureQuickLayout())); } catch (e) {}
  }

  function setMoreModulesVisible(visible) {
    var containers = getQuickToolContainers();
    if (!containers.more) return;
    containers.more.style.display = visible ? '' : 'none';
  }

  function finishQuickToolDrag() {
    document.querySelectorAll('.modules.drag-over').forEach(function (zone) { zone.classList.remove('drag-over'); });
    if (draggedQuickCard) draggedQuickCard.classList.remove('dragging');
    draggedQuickCard = null;
  }

  function setQuickToolsEditing(editing) {
    var section = document.querySelector('.quick-tools');
    var button = document.getElementById('manage-quick-tools');
    var containers = getQuickToolContainers();
    if (!section || !button) return;
    quickToolsEditing = editing;
    section.classList.toggle('editing', editing);
    button.setAttribute('aria-pressed', editing ? 'true' : 'false');
    button.innerHTML = editing ? '<i data-lucide="check"></i>完成整理' : '<i data-lucide="grip"></i>整理快捷方式';
    if (editing) {
      moreWasOpenBeforeEditing = !!(containers.more && containers.more.style.display !== 'none');
      setMoreModulesVisible(true);
    } else {
      setMoreModulesVisible(moreWasOpenBeforeEditing);
      finishQuickToolDrag();
    }
    document.querySelectorAll('[data-quick-key]').forEach(function (card) { card.draggable = editing; });
    if (window.IconSystem) window.IconSystem.render(button);
  }

  function bindQuickTools() {
    var containers = getQuickToolContainers();
    var manage = document.getElementById('manage-quick-tools');
    var reset = document.getElementById('reset-quick-tools');
    if (!containers.quick || !containers.more || !manage || !reset) return;

    defaultQuickLayout = captureQuickLayout();
    var saved = readQuickLayout();
    if (isValidQuickLayout(saved)) applyQuickLayout(saved);

    manage.addEventListener('click', function () { setQuickToolsEditing(!quickToolsEditing); });
    reset.addEventListener('click', function () {
      try { localStorage.removeItem(QUICK_LAYOUT_KEY); } catch (e) {}
      applyQuickLayout(defaultQuickLayout);
      App.showToast('快捷入口已恢复默认组合', 'success');
    });

    document.querySelectorAll('[data-quick-key]').forEach(function (card) {
      card.addEventListener('dragstart', function (event) {
        if (!quickToolsEditing) { event.preventDefault(); return; }
        draggedQuickCard = card;
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.dataset.quickKey || '');
      });
      card.addEventListener('dragend', finishQuickToolDrag);
      card.addEventListener('click', function (event) {
        if (quickToolsEditing) {
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
    });

    [containers.quick, containers.more].forEach(function (zone) {
      zone.addEventListener('dragover', function (event) {
        if (!quickToolsEditing || !draggedQuickCard) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', function (event) {
        if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
      });
      zone.addEventListener('drop', function (event) {
        if (!quickToolsEditing || !draggedQuickCard) return;
        event.preventDefault();
        var target = event.target.closest ? event.target.closest('[data-quick-key]') : null;
        if (target && target !== draggedQuickCard && target.parentElement === zone) {
          var before = event.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2;
          zone.insertBefore(draggedQuickCard, before ? target : target.nextSibling);
        } else if (zone === containers.quick) {
          zone.insertBefore(draggedQuickCard, containers.moreButton || null);
        } else {
          zone.appendChild(draggedQuickCard);
        }
        saveQuickLayout();
        finishQuickToolDrag();
      });
    });
  }

  var WORKBENCH_VIEW_KEY = 'xj_workbench_view_v1';
  var selectedWorkbenchClientId = '';
  var selectedMaterialId = '';
  function safeView() { try { return localStorage.getItem(WORKBENCH_VIEW_KEY) === 'document' ? 'document' : 'client'; } catch (e) { return 'client'; } }
  function setWorkbenchView(view) {
    var documentView = view === 'document';
    try { localStorage.setItem(WORKBENCH_VIEW_KEY, documentView ? 'document' : 'client'); } catch (e) {}
    document.getElementById('wb-client-view').setAttribute('aria-selected', documentView ? 'false' : 'true');
    document.getElementById('wb-document-view').setAttribute('aria-selected', documentView ? 'true' : 'false');
    ['hero-stats', 'ob-checklist'].forEach(function (id) { var el = document.getElementById(id); if (el) el.closest('section,div').hidden = documentView; });
    document.querySelectorAll('.work-schedule').forEach(function (el) { el.hidden = documentView; });
    document.querySelectorAll('.quick-tools,.bottom-row').forEach(function (el) { el.hidden = documentView; });
    renderWorkbench(documentView ? 'document' : 'client');
  }
  function routeFor(page, clientId, sessionId, materialId) {
    var query = [];
    if (clientId) query.push('clientId=' + encodeURIComponent(clientId));
    if (sessionId) query.push('sessionId=' + encodeURIComponent(sessionId));
    if (materialId) query.push('materialId=' + encodeURIComponent(materialId));
    return page + (query.length ? '?' + query.join('&') : '');
  }
  function renderIcons(root) { if (window.IconSystem) window.IconSystem.render(root); else if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
  function clientSessions(clientId) { return Store.getSessionsForPicker(clientId).slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); }); }
  function renderClientWorkbench(host) {
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    if (!selectedWorkbenchClientId || !Store.getClient(selectedWorkbenchClientId)) selectedWorkbenchClientId = (App.getActiveClientId && App.getActiveClientId()) || (clients[0] && clients[0].id) || '';
    var client = Store.getClient(selectedWorkbenchClientId);
    var sessions = client ? clientSessions(client.id) : [];
    var latest = sessions[0] || null;
    var supervisions = client && Store.getSupervisionsByClient ? Store.getSupervisionsByClient(client.id) : [];
    host.className = 'dual-workbench active';
    host.innerHTML = '<aside class="wb-panel wb-rail"><div class="wb-rail-head"><h2>来访者</h2><input id="wb-client-search" type="search" placeholder="搜索来访者"></div><div class="wb-client-list" id="wb-client-list"></div></aside>' +
      '<article class="wb-panel wb-main"><div class="wb-main-head"><h2 id="wb-client-name"></h2><span class="wb-muted" id="wb-client-meta"></span></div><div class="wb-main-body" id="wb-client-body"></div></article>' +
      '<aside class="wb-panel wb-actions-panel"><div class="wb-main-head"><h2>当前上下文</h2></div><div class="wb-actions" id="wb-client-actions"></div></aside>';
    function drawList(filter) {
      var list = clients.filter(function (item) { return !filter || String(item.name || '').indexOf(filter) >= 0; });
      document.getElementById('wb-client-list').innerHTML = list.length ? list.map(function (item) { var count = clientSessions(item.id).length; return '<button class="wb-client' + (item.id === selectedWorkbenchClientId ? ' active' : '') + '" type="button" data-client-id="' + App.escapeHtml(item.id) + '"><span class="wb-avatar">' + App.escapeHtml((item.name || '?').charAt(0)) + '</span><span><b>' + App.escapeHtml(item.name || '未命名来访者') + '</b><small>' + count + ' 节会谈</small></span></button>'; }).join('') : '<p class="wb-muted">没有匹配的来访者</p>';
      document.querySelectorAll('[data-client-id]').forEach(function (button) { button.addEventListener('click', function () { selectedWorkbenchClientId = button.getAttribute('data-client-id'); if (App.setActiveClientId) App.setActiveClientId(selectedWorkbenchClientId); renderClientWorkbench(host); }); });
    }
    drawList('');
    document.getElementById('wb-client-search').addEventListener('input', function () { drawList(this.value.trim()); });
    if (!client) { document.getElementById('wb-client-body').innerHTML = '<div class="wb-empty"><i data-lucide="user-round-plus"></i><div><h2>从一位来访者开始</h2><p>新建来访者后，可以在这里继续会谈记录、逐字稿、报告和督导工作。</p></div></div>'; renderIcons(host); return; }
    document.getElementById('wb-client-name').textContent = client.name || '未命名来访者';
    document.getElementById('wb-client-meta').textContent = (client.status === 'active' ? '活跃个案' : '已结束') + ' · ' + sessions.length + ' 节会谈';
    document.getElementById('wb-client-body').innerHTML = '<div class="wb-kpis"><div class="wb-kpi"><b>' + sessions.length + '</b><span>累计会谈</span></div><div class="wb-kpi"><b>' + supervisions.length + '</b><span>督导记录</span></div><div class="wb-kpi"><b>' + (latest && latest.hasTranscript ? '已就绪' : '待整理') + '</b><span>最近材料</span></div></div><div class="wb-focus"><div><strong>' + (latest ? '继续第 ' + (latest.sessionNumber || '?') + ' 节会谈' : '开始本次临床工作') + '</strong><p>' + (latest ? App.escapeHtml(latest.date || '日期待定') + (latest.hasTranscript ? ' · 已有逐字稿' : ' · 可开始记录') : '尚无会谈记录，可从日历创建。') + '</p></div><button class="wb-primary" id="wb-continue"><i data-lucide="notebook-pen"></i>' + (latest ? '继续记录' : '新建会谈') + '</button></div>';
    document.getElementById('wb-continue').addEventListener('click', function () { location.href = latest ? routeFor('consult-notes.html', client.id, latest.id) : 'session-calendar.html?action=new&clientId=' + encodeURIComponent(client.id); });
    document.getElementById('wb-client-actions').innerHTML = '<span class="wb-muted">当前来访者：' + App.escapeHtml(client.name || '') + '</span><button class="wb-action" data-page="transcript.html"><i data-lucide="audio-lines"></i>整理逐字稿<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="report-writing.html"><i data-lucide="file-text"></i>撰写报告<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="supervision.html" data-feature="ai-supervise"><i data-lucide="brain-circuit"></i>进入 AI 督导<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="real-supervision.html"><i data-lucide="handshake"></i>记录真人督导<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="billing-shell.html"><i data-lucide="wallet-cards"></i>查看账务<i data-lucide="chevron-right"></i></button>';
    document.querySelectorAll('#wb-client-actions [data-page]').forEach(function (button) { button.addEventListener('click', function () { if (button.dataset.feature && !App.featureGate(button.dataset.feature)) return; location.href = routeFor(button.dataset.page, client.id, latest && latest.id); }); });
    renderIcons(host);
  }
  function renderDocumentWorkbench(host) {
    var materials = Store.getMaterialWorkspaces ? Store.getMaterialWorkspaces() : [];
    if (!selectedMaterialId || !Store.getMaterialWorkspace(selectedMaterialId)) selectedMaterialId = materials[0] && materials[0].id || '';
    var material = Store.getMaterialWorkspace(selectedMaterialId);
    host.className = 'dual-workbench wb-doc active';
    host.innerHTML = '<aside class="wb-panel wb-rail"><div class="wb-rail-head"><h2>材料来源</h2><button class="wb-primary" id="wb-select-material" type="button"><i data-lucide="file-up"></i>选择文档</button></div><div class="wb-material-list" id="wb-material-list"></div></aside><article class="wb-panel wb-main"><div class="wb-main-head"><h2>材料工作区</h2><span class="wb-muted">文件仅保存解析文本与元数据</span></div><div class="wb-main-body" id="wb-material-body"></div></article><aside class="wb-panel wb-actions-panel"><div class="wb-main-head"><h2>继续处理</h2></div><div class="wb-actions" id="wb-material-actions"></div></aside>';
    document.getElementById('wb-material-list').innerHTML = materials.length ? materials.map(function (item) { return '<button class="wb-material' + (item.id === selectedMaterialId ? ' active' : '') + '" type="button" data-material-id="' + App.escapeHtml(item.id) + '"><i data-lucide="file-text"></i><span><b>' + App.escapeHtml(item.title) + '</b><small>' + App.escapeHtml(item.parseStatus === 'ready' ? (item.linkStatus === 'linked' ? '已关联' : '未归档') : item.parseStatus === 'parsing' ? '解析中' : '解析失败') + '</small></span></button>'; }).join('') : '<p class="wb-muted">尚无材料</p>';
    document.querySelectorAll('[data-material-id]').forEach(function (button) { button.addEventListener('click', function () { selectedMaterialId = button.getAttribute('data-material-id'); renderDocumentWorkbench(host); }); });
    document.getElementById('wb-select-material').addEventListener('click', async function () {
      var api = window.__XJ_API__;
      if (!api || !api.selectClinicalMaterialFile || !api.parseClinicalMaterialFile) { App.showToast('当前环境不支持原生文件选择', 'error'); return; }
      var picked = await api.selectClinicalMaterialFile();
      if (!picked || picked.canceled) return;
      if (!picked.ok) { App.showToast(picked.error || '无法选择文件', 'error'); return; }
      var item = Store.createMaterialWorkspace({ title: picked.file.name, source: picked.file, parseStatus: 'parsing' });
      if (!item) { App.showToast('未归档材料数量已达当前方案上限', 'warning'); return; }
      selectedMaterialId = item.id; renderDocumentWorkbench(host);
      var parsed = await api.parseClinicalMaterialFile(picked.selectionId);
      if (selectedMaterialId !== item.id || !Store.getMaterialWorkspace(item.id)) return;
      if (!parsed || !parsed.ok) { Store.updateMaterialWorkspace(item.id, { parseStatus: 'failed', parseError: (parsed && parsed.error) || '解析失败', extractedText: '' }); App.showToast((parsed && parsed.error) || '解析失败，请重新选择文件', 'error'); }
      else { Store.updateMaterialWorkspace(item.id, { title: parsed.file.name, source: parsed.file, parseStatus: 'ready', parseError: '', extractedText: parsed.text }); App.showToast('材料已解析并保存到本地工作区', 'success'); }
      renderDocumentWorkbench(host);
    });
    if (!material) { document.getElementById('wb-material-body').innerHTML = '<div class="wb-empty"><i data-lucide="files"></i><div><h2>从一份材料开始</h2><p>选择 TXT、MD 或 DOCX 后，可先整理内容，再显式关联来访者和会谈。</p></div></div>'; renderIcons(host); return; }
    var clients = Store.getClients().filter(function (client) { return client.status !== 'ended'; });
    var sessions = material.clientId ? clientSessions(material.clientId) : [];
    document.getElementById('wb-material-body').innerHTML = '<h2>' + App.escapeHtml(material.title) + '</h2><span class="wb-status ' + App.escapeHtml(material.parseStatus) + '">' + App.escapeHtml(material.parseStatus === 'ready' ? (material.linkStatus === 'linked' ? '已关联来访者' : '未归档材料') : material.parseStatus === 'parsing' ? '正在解析' : material.parseError || '解析失败') + '</span><div class="wb-link-grid"><label>关联来访者<select id="wb-material-client"><option value="">暂不关联</option>' + clients.map(function (client) { return '<option value="' + App.escapeHtml(client.id) + '"' + (client.id === material.clientId ? ' selected' : '') + '>' + App.escapeHtml(client.name) + '</option>'; }).join('') + '</select></label><label>关联会谈<select id="wb-material-session"><option value="">暂不指定会谈</option>' + sessions.map(function (session) { return '<option value="' + App.escapeHtml(session.id) + '"' + (session.id === material.sessionId ? ' selected' : '') + '>第' + App.escapeHtml(String(session.sessionNumber || '?')) + ' 节 · ' + App.escapeHtml(session.date || '') + '</option>'; }).join('') + '</select></label></div><button class="wb-secondary" id="wb-save-link">确认关联</button><div class="wb-source">' + App.escapeHtml(material.parseStatus === 'ready' ? (material.extractedText || '').slice(0, 5000) : material.parseError || '正在等待解析结果') + '</div>';
    document.getElementById('wb-material-client').addEventListener('change', function () { var selected = this.value; var sessionSelect = document.getElementById('wb-material-session'); var nextSessions = selected ? clientSessions(selected) : []; sessionSelect.innerHTML = '<option value="">暂不指定会谈</option>' + nextSessions.map(function (session) { return '<option value="' + App.escapeHtml(session.id) + '">第' + App.escapeHtml(String(session.sessionNumber || '?')) + ' 节 · ' + App.escapeHtml(session.date || '') + '</option>'; }).join(''); });
    document.getElementById('wb-save-link').addEventListener('click', function () { var clientId = document.getElementById('wb-material-client').value; var sessionId = document.getElementById('wb-material-session').value; if (!Store.linkMaterialWorkspace(material.id, clientId, sessionId)) { App.showToast('关联的会谈必须属于当前来访者', 'error'); return; } App.showToast(clientId ? '材料关联已确认' : '材料保留在未归档工作区', 'success'); renderDocumentWorkbench(host); });
    document.getElementById('wb-material-actions').innerHTML = material.parseStatus === 'ready' ? '<span class="wb-muted">AI 生成前会显示当前材料与来访者来源。</span><button class="wb-action" data-page="transcript.html"><i data-lucide="audio-lines"></i>整理逐字稿<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="report-writing.html"><i data-lucide="file-text"></i>撰写报告<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="supervision.html" data-feature="ai-supervise"><i data-lucide="brain-circuit"></i>进入 AI 督导<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="real-supervision.html"><i data-lucide="handshake"></i>记录真人督导<i data-lucide="chevron-right"></i></button>' : '<span class="wb-muted">解析完成后可以继续处理。</span>';
    document.querySelectorAll('#wb-material-actions [data-page]').forEach(function (button) { button.addEventListener('click', function () { if (button.dataset.feature && !App.featureGate(button.dataset.feature)) return; location.href = routeFor(button.dataset.page, material.clientId, material.sessionId, material.id); }); });
    renderIcons(host);
  }
  function renderWorkbench(view) { var host = document.getElementById('dual-workbench'); if (!host) return; if (view === 'document') renderDocumentWorkbench(host); else renderClientWorkbench(host); }
  function bindWorkbench() { var clientButton = document.getElementById('wb-client-view'); var documentButton = document.getElementById('wb-document-view'); if (!clientButton || !documentButton) return; clientButton.addEventListener('click', function () { setWorkbenchView('client'); }); documentButton.addEventListener('click', function () { setWorkbenchView('document'); }); setWorkbenchView(safeView()); }

  App.initPage({ title: '今日工作台', subtitle: '', actions: '', onReady: function () {
    renderStats();
    renderSchedule();
    bindStartNextSession();
    renderRecent();
    renderTodo();
    renderKbTile();
    bindQuickTools();
    bindWorkbench();
    // 强引导：新手任务清单（真实数据驱动）+ 首启聚光灯导览
    try {
      if (window.Onboarding) {
        Onboarding.renderChecklist();
        Onboarding.maybeStartTour();
      }
    } catch (e) { console.warn('[dashboard] onboarding 挂接失败', e); }
  }});
})();
