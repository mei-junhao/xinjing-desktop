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

    var clinicalTasks = typeof Store.getClinicalTasks === 'function' ? Store.getClinicalTasks() : [];
    clinicalTasks.filter(function (task) {
      return task && (task.status === 'open' || task.status === 'ai-draft');
    }).slice(0, 4).forEach(function (task) {
      var client = Store.getClient(task.clientId);
      var isAiDraft = task.status === 'ai-draft';
      var sourceRefs = Array.isArray(task.sourceRefs) ? task.sourceRefs : [];
      var aiDraftMeta = isAiDraft
        ? 'AI 草稿 · 待人工确认 · 运行 ' + (task.actionRunId || '未知') + (sourceRefs.length ? ' · 来源 ' + sourceRefs.join('、') : '')
        : '';
      var due = isAiDraft ? aiDraftMeta : (task.due ? ('截止 ' + task.due) : '跨会谈跟进');
      items.push({
        kind: 'clinical-task',
        id: task.id,
        status: task.status,
        nm: task.title,
        mt: (client ? client.name : '未知来访者') + ' · ' + due,
        href: task.target === 'consult-notes.html' ? routeFor('consult-notes.html', task.clientId, task.originSessionId) : '',
      });
    });

    var pending = allSessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).slice(0, 2);
    pending.forEach(function (s) {
      var c = Store.getClient(s.clientId);
      if (items.length < 4) items.push({ nm: '整理逐字稿：' + (c ? c.name : '?') + ' 第' + s.sessionNumber + '节', mt: App.formatDate(s.date) });
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
    container.innerHTML = items.slice(0, 4).map(function (i) {
      var title = i.href ? '<a class="nm task-link" href="' + esc(i.href) + '">' + App.escapeHtml(i.nm) + '</a>' : '<div class="nm">' + App.escapeHtml(i.nm) + '</div>';
      var action = i.kind === 'clinical-task' && i.status === 'open'
        ? '<button class="task-complete" type="button" data-task-complete="' + esc(i.id) + '" aria-label="完成任务：' + esc(i.nm) + '" title="标记完成"><i data-lucide="check"></i></button>'
        : (i.kind === 'clinical-task' && i.status === 'ai-draft'
          ? '<button class="task-confirm" type="button" data-task-confirm="' + esc(i.id) + '" aria-label="确认 AI 草稿：' + esc(i.nm) + '" title="确认 AI 草稿"><i data-lucide="check-circle"></i></button>'
          : '');
      return '<div class="ritem task-item"><div class="rav" style="background:var(--bg-sunken);color:var(--ink-2)">·</div><div class="info">' + title + '<div class="mt">' + App.escapeHtml(i.mt) + '</div></div>' + action + '</div>';
    }).join('');
    renderIcons(container);
    if (!container.dataset.taskBound) {
      container.dataset.taskBound = 'true';
      container.addEventListener('click', async function (event) {
        var button = event.target.closest('[data-task-confirm], [data-task-complete]');
        if (!button || button.disabled) return;
        var isConfirm = button.hasAttribute('data-task-confirm');
        var id = button.getAttribute(isConfirm ? 'data-task-confirm' : 'data-task-complete');
        var durableActionAvailable = isConfirm
          ? typeof Store.confirmClinicalTaskDurable === 'function'
          : typeof Store.transitionClinicalTaskDurable === 'function';
        if (!id || !durableActionAvailable) {
          App.showToast('任务完成能力暂不可用', 'error');
          return;
        }
        button.disabled = true;
        var result;
        try {
          result = isConfirm
            ? await Store.confirmClinicalTaskDurable(id)
            : await Store.transitionClinicalTaskDurable(id, 'done');
        }
        catch (error) { result = { ok: false, error: { message: (error && error.message) || '任务保存异常' } }; }
        if (!result || !result.ok) {
          button.disabled = false;
          App.showToast(isConfirm ? '草稿未确认：请恢复存储后重试' : '任务未完成：请恢复存储后重试', 'error');
          return;
        }
        App.showToast(isConfirm ? 'AI 草稿已确认，已加入待办' : '任务已完成', 'success');
        renderTodo();
      });
    }
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
      card.addEventListener('click', function (event) {
        if (quickToolsEditing) return;
        var href = card.getAttribute('href');
        if (!href) return;
        var allowedRoutes = ['consult-notes.html', 'supervision.html', 'masters.html', 'billing-shell.html', 'knowledge.html', 'session-calendar.html', 'transcript.html', 'report-writing.html', 'real-supervision.html', 'doc-center.html', 'settings.html'];
        if (allowedRoutes.indexOf(href.split('?')[0]) === -1) {
          event.preventDefault();
          if (App && App.showToast) App.showToast('快捷入口目标不可用：' + href, 'error');
          return;
        }
        if (card.dataset.feature && App && typeof App.openMembershipGate === 'function' && !App.openMembershipGate(card.dataset.feature)) {
          event.preventDefault();
        }
      });
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
    return WorkbenchReadonly.buildDeepLink(page, { clientId: clientId, sessionId: sessionId, materialId: materialId });
  }
  function renderIcons(root) { if (window.IconSystem) window.IconSystem.render(root); else if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
  function clientSessions(clientId) { return Store.getSessionsForPicker(clientId).slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); }); }
  function renderClientWorkbench(host) {
    var clients = WorkbenchReadonly.getClientQueue('all');
    if (!selectedWorkbenchClientId || !Store.getClient(selectedWorkbenchClientId)) selectedWorkbenchClientId = (App.getActiveClientId && App.getActiveClientId()) || (clients[0] && clients[0].id) || '';
    var client = Store.getClient(selectedWorkbenchClientId);
    var ctxMap = client ? WorkbenchReadonly.buildContextMap(client.id) : null;
    var sessions = client ? WorkbenchReadonly.getCurrentSession(client.id) : null;
    host.className = 'dual-workbench active';
    host.innerHTML = '<aside class="wb-panel wb-rail"><div class="wb-rail-head"><h2>来访者</h2><input id="wb-client-search" type="search" placeholder="搜索来访者"></div><div class="wb-client-list" id="wb-client-list"></div></aside>' +
      '<article class="wb-panel wb-main"><div class="wb-main-head"><h2 id="wb-client-name"></h2><span class="wb-muted" id="wb-client-meta"></span></div><div class="wb-main-body" id="wb-client-body"></div></article>' +
      '<aside class="wb-panel wb-actions-panel"><div class="wb-main-head"><h2>当前上下文</h2></div><div class="wb-actions" id="wb-client-actions"></div></aside>';
    function drawList(filter) {
      var list = clients.filter(function (item) { return !filter || String(item.name || '').indexOf(filter) >= 0; });
      document.getElementById('wb-client-list').innerHTML = list.length ? list.map(function (item) { var count = WorkbenchReadonly.sessionCount(item.id); return '<button class="wb-client' + (item.id === selectedWorkbenchClientId ? ' active' : '') + '" type="button" data-client-id="' + App.escapeHtml(item.id) + '"><span class="wb-avatar">' + App.escapeHtml((item.name || '?').charAt(0)) + '</span><span><b>' + App.escapeHtml(item.name || '未命名来访者') + '</b><small>' + count + ' 节会谈</small></span></button>'; }).join('') : '<p class="wb-muted">没有匹配的来访者</p>';
      document.querySelectorAll('[data-client-id]').forEach(function (button) { button.addEventListener('click', function () { selectedWorkbenchClientId = button.getAttribute('data-client-id'); if (App.setActiveClientId) App.setActiveClientId(selectedWorkbenchClientId); renderClientWorkbench(host); }); });
    }
    drawList('');
    document.getElementById('wb-client-search').addEventListener('input', function () { drawList(this.value.trim()); });
    if (!client) { document.getElementById('wb-client-body').innerHTML = '<div class="wb-empty"><i data-lucide="user-round-plus"></i><div><h2>从一位来访者开始</h2><p>新建来访者后，可以在这里继续会谈记录、逐字稿、报告和督导工作。</p></div></div>'; renderIcons(host); return; }
    document.getElementById('wb-client-name').textContent = client.name || '未命名来访者';
    document.getElementById('wb-client-meta').textContent = (client.status === 'active' ? '活跃个案' : '已结束') + ' · ' + (ctxMap ? ctxMap.sessionCount : 0) + ' 节会谈';
    var sessNum = sessions ? (sessions.sessionNumber || '?') : null;
    var sessDate = sessions ? (sessions.date || '日期待定') : null;
    var sessReady = sessions ? (sessions.hasTranscript ? '已就绪' : '待整理') : '尚无会谈';
    var sessText = sessions ? ('继续第 ' + sessNum + ' 节会谈') : '开始本次临床工作';
    var sessDetail = sessions ? (sessDate + (sessions.hasTranscript ? ' · 已有逐字稿' : ' · 可开始记录')) : '尚无会谈记录，可从日历创建。';
    document.getElementById('wb-client-body').innerHTML = '<div class="wb-kpis"><div class="wb-kpi"><b>' + (ctxMap ? ctxMap.sessionCount : 0) + '</b><span>累计会谈</span></div><div class="wb-kpi"><b>' + (ctxMap ? ctxMap.supervisionCount : 0) + '</b><span>督导记录</span></div><div class="wb-kpi"><b>' + sessReady + '</b><span>最近材料</span></div></div><div class="wb-focus"><div><strong>' + sessText + '</strong><p>' + App.escapeHtml(sessDetail) + '</p></div><button class="wb-primary" id="wb-continue"><i data-lucide="notebook-pen"></i>' + (sessions ? '继续记录' : '新建会谈') + '</button></div>';
    document.getElementById('wb-continue').addEventListener('click', function () { location.href = sessions ? routeFor('consult-notes.html', client.id, sessions.id) : 'session-calendar.html?action=new&clientId=' + encodeURIComponent(client.id); });
    document.getElementById('wb-client-actions').innerHTML = '<span class="wb-muted">当前来访者：' + App.escapeHtml(client.name || '') + '</span><button class="wb-action" data-page="transcript.html"><i data-lucide="audio-lines"></i>整理逐字稿<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="report-writing.html"><i data-lucide="file-text"></i>撰写报告<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="supervision.html" data-feature="ai-supervise"><i data-lucide="brain-circuit"></i>进入 AI 督导<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="real-supervision.html"><i data-lucide="handshake"></i>记录真人督导<i data-lucide="chevron-right"></i></button><button class="wb-action" data-page="billing-shell.html"><i data-lucide="wallet-cards"></i>查看账务<i data-lucide="chevron-right"></i></button>';
    document.querySelectorAll('#wb-client-actions [data-page]').forEach(function (button) { button.addEventListener('click', function () { if (button.dataset.feature && App.openMembershipGate && !App.openMembershipGate(button.dataset.feature)) return; location.href = routeFor(button.dataset.page, client.id, sessions && sessions.id); }); });
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
    document.querySelectorAll('#wb-material-actions [data-page]').forEach(function (button) { button.addEventListener('click', function () { if (button.dataset.feature && App.openMembershipGate && !App.openMembershipGate(button.dataset.feature)) return; location.href = routeFor(button.dataset.page, material.clientId, material.sessionId, material.id); }); });
    renderIcons(host);
  }
  function renderWorkbench(view) { var host = document.getElementById('dual-workbench'); if (!host) return; if (view === 'document') renderDocumentWorkbench(host); else renderClientWorkbench(host); }
  window.refreshDashboardWorkbench = function (client) {
    if (client && client.id) {
      selectedWorkbenchClientId = client.id;
      if (App.setActiveClientId) App.setActiveClientId(client.id);
    }
    renderWorkbench(safeView());
  };
  function bindWorkbench() { var clientButton = document.getElementById('wb-client-view'); var documentButton = document.getElementById('wb-document-view'); if (!clientButton || !documentButton) return; clientButton.addEventListener('click', function () { setWorkbenchView('client'); }); documentButton.addEventListener('click', function () { setWorkbenchView('document'); }); setWorkbenchView(safeView()); }

  // ---- QuickRecord 接入：首页快捷入口 + 工作台客户端动作 ----
  // 不修改 QuickRecord 模块本身，仅提供 UI 入口和 DOM 交互。
  function getActiveClientId() {
    if (typeof selectedWorkbenchClientId !== 'undefined' && selectedWorkbenchClientId) return selectedWorkbenchClientId;
    if (App.getActiveClientId) return App.getActiveClientId() || '';
    return '';
  }

  function renderQuickTemplateControl(overlay, selectedId, customTemplateId) {
    var select = overlay && overlay.querySelector('#qr-template');
    var help = overlay && overlay.querySelector('#qr-template-help');
    var customWrap = overlay && overlay.querySelector('#qr-custom-template-wrap');
    var customInput = overlay && overlay.querySelector('#qr-custom-template-id');
    var plans = overlay && overlay.querySelector('#qr-template-plans');
    if (!select || typeof SessionTemplateViewModel === 'undefined' || typeof SessionTemplateViewModel.list !== 'function') return;
    var licenseState = (App && typeof App.getLicenseState === 'function') ? App.getLicenseState() : null;
    var result = SessionTemplateViewModel.list({ licenseState: licenseState, context: 'individual', includeLocked: true });
    if (!result || !result.ok) {
      select.innerHTML = '<option value="manual-session-v1">基础手动记录</option>';
      select.value = 'manual-session-v1';
      if (help) help.textContent = '当前仅可使用基础手动记录。';
      if (customWrap) customWrap.hidden = true;
      return;
    }
    select.innerHTML = result.templates.map(function (item) {
      var suffix = item.locked
        ? (item.preview ? '（试用预览，仅可查看）' : '（' + (item.requiredTier === 'Flagship' ? '需旗舰版' : '需会员') + '）')
        : '';
      return '<option value="' + esc(item.id) + '"' + (item.locked ? ' disabled' : '') + ' title="' + esc(item.outline || '') + '">' + esc(item.title + suffix) + '</option>';
    }).join('');
    var wanted = selectedId || 'manual-session-v1';
    var wantedOption = Array.prototype.find.call(select.options, function (option) { return option.value === wanted && !option.disabled; });
    select.value = wantedOption ? wanted : 'manual-session-v1';
    var selected = result.templates.find(function (item) { return item.id === select.value; });
    if (customInput) customInput.value = customTemplateId || '';
    if (customWrap) customWrap.hidden = !selected || selected.id !== 'flagship-session-v1';
    if (help) {
      if (result.access && result.access.trial) help.textContent = '当前为 AI 试用：付费模板仅供预览，保存时必须使用可用模板。';
      else if (selected && selected.id === 'flagship-session-v1') help.textContent = '可选填稳定的定制模板标识，不保存模板正文或品牌资源。';
      else if (selected && selected.id === 'ai-session-v1') help.textContent = 'AI 辅助模板只保存结构选择，不会在此处调用模型。';
      else help.textContent = '基础手动记录始终可用。';
    }
    if (plans) plans.hidden = !result.templates.some(function (item) { return item.locked && !item.preview; });
    if (typeof window !== 'undefined' && window.IconSystem) window.IconSystem.render(overlay);
  }

  function openQuickRecord() {
    if (!window.QuickRecord || typeof window.QuickRecord.createQuickRecord !== 'function') {
      App.showToast('快速记录模块不可用', 'error');
      return;
    }
    var clientId = getActiveClientId();
    var client = clientId ? Store.getClient(clientId) : null;
    if (!client) { App.showToast('请先选择一位来访者', 'warning'); return; }

    var overlay = document.getElementById('qr-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'qr-overlay';
      overlay.className = 'qr-overlay';
      overlay.innerHTML =
        '<div class="qr-panel" role="dialog" aria-modal="true" aria-label="快速记录" tabindex="-1">' +
          '<div class="qr-head"><h2><i data-lucide="file-pen"></i>快速记录</h2>' +
          '<button class="qr-close" type="button" aria-label="关闭" title="关闭"><i data-lucide="x"></i></button></div>' +
          '<div class="qr-client-name" id="qr-client-name"></div>' +
            '<label class="qr-field-wide" for="qr-notes">会谈备注<span>可选</span></label>' +
            '<textarea class="qr-notes" id="qr-notes" rows="3" placeholder="简要记录本次会谈" aria-label="会谈备注"></textarea>' +
            '<div class="qr-fields">' +
              '<label>节次 <input type="number" id="qr-session-number" value="1" min="1" class="qr-input" aria-label="节次"></label>' +
              '<label>日期 <input type="date" id="qr-date" class="qr-input" aria-label="日期"></label>' +
              '<label>记录模板 <select id="qr-template" class="qr-input" aria-label="记录模板"><option value="manual-session-v1">基础手动记录</option></select></label>' +
            '</div>' +
            '<div class="qr-template-help" id="qr-template-help" role="status"></div>' +
            '<div class="qr-template-custom" id="qr-custom-template-wrap" hidden>' +
              '<label class="qr-field-wide" for="qr-custom-template-id">定制模板标识<span>可选，最多 128 个字符</span></label>' +
              '<input class="qr-input qr-custom-template-id" id="qr-custom-template-id" maxlength="128" pattern="[A-Za-z0-9._:-]{1,128}" placeholder="例如 brand-acme-001" aria-label="定制模板标识">' +
            '</div>' +
            '<button class="qr-plan-link" id="qr-template-plans" type="button" hidden><i data-lucide="sparkles"></i>查看方案</button>' +
            '<label class="qr-field-wide" for="qr-task-titles">后续任务<span>可选，每行一项，最多 5 项</span></label>' +
          '<textarea class="qr-notes qr-task-titles" id="qr-task-titles" rows="3" placeholder="例如：下节继续核对本次约定" aria-label="后续任务"></textarea>' +
          '<div class="qr-actions">' +
            '<button class="wb-primary" id="qr-submit" type="button"><i data-lucide="save"></i>保存</button>' +
            '<button class="wb-secondary" id="qr-cancel" type="button">取消</button>' +
          '</div>' +
          '<div class="qr-result" id="qr-result" hidden></div>' +
        '</div>';
      document.body.appendChild(overlay);
      renderIcons(overlay);
      function mayCloseQuickRecord() {
        if (!window.QuickRecord || typeof window.QuickRecord.canSwitchAway !== 'function') return true;
        var gate = window.QuickRecord.canSwitchAway();
        return !gate || gate.allowed !== false;
      }
      function closeQuickRecord() {
        if (!mayCloseQuickRecord()) {
          App.showToast('保存或待办同步尚未完成，请先重试', 'warning');
          return;
        }
        overlay.style.display = 'none';
      }
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay || e.target.closest('.qr-close') || e.target.closest('#qr-cancel')) {
          closeQuickRecord();
        }
      });
      overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); closeQuickRecord(); }
      });
      var templateSelect = overlay.querySelector('#qr-template');
      if (templateSelect) templateSelect.addEventListener('change', function () {
        renderQuickTemplateControl(overlay, templateSelect.value, overlay.querySelector('#qr-custom-template-id').value);
      });
      var plansButton = overlay.querySelector('#qr-template-plans');
      if (plansButton) plansButton.addEventListener('click', function () {
        if (App && typeof App.openPlans === 'function') App.openPlans();
      });
      if (App && typeof App.onLicenseStateChange === 'function') {
        App.onLicenseStateChange(function () {
          if (overlay.style.display !== 'none') renderQuickTemplateControl(overlay, templateSelect && templateSelect.value, overlay.querySelector('#qr-custom-template-id').value);
        });
      }
    }

    overlay.style.display = 'flex';
    overlay.querySelector('.qr-panel').focus();
    document.getElementById('qr-client-name').textContent = client.name;
    var dateInput = document.getElementById('qr-date');
    dateInput.value = App.todayStr();
    var numInput = document.getElementById('qr-session-number');
    var existing = Store.getSessionsByClient(clientId) || [];
    numInput.value = String((existing.length || 0) + 1);
    document.getElementById('qr-notes').value = '';
    var templateInput = document.getElementById('qr-template');
    var taskTitlesInput = document.getElementById('qr-task-titles');
    if (templateInput) templateInput.value = 'manual-session-v1';
    renderQuickTemplateControl(overlay, 'manual-session-v1', '');
    if (taskTitlesInput) taskTitlesInput.value = '';
    var result = document.getElementById('qr-result');
    result.hidden = true;
    result.innerHTML = '';
    var submitBtn = document.getElementById('qr-submit');
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="save"></i>保存';
    renderIcons(overlay);
    document.getElementById('qr-notes').focus();

    // 绑定提交（仅绑定一次，用 data-bound 标记）
    if (!submitBtn.dataset.bound) {
      submitBtn.dataset.bound = 'true';
      submitBtn.addEventListener('click', async function () {
        if (!window.QuickRecord) { App.showToast('快速记录模块不可用', 'error'); return; }
        if (window.QuickRecord._state && window.QuickRecord._state.pending) { App.showToast('保存仍在进行中', 'warning'); return; }

        var cid = getActiveClientId();
        if (!cid || !Store.getClient(cid)) { App.showToast('来访者无效，请重新选择', 'error'); return; }

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i data-lucide="loader"></i>保存中…';
        renderIcons(overlay);
        var input = {
          clientId: cid,
          date: document.getElementById('qr-date').value || App.todayStr(),
          sessionNumber: Number(document.getElementById('qr-session-number').value) || 1,
          notes: document.getElementById('qr-notes').value || '',
          templateId: document.getElementById('qr-template') ? document.getElementById('qr-template').value || 'manual-session-v1' : 'manual-session-v1',
          customTemplateId: document.getElementById('qr-custom-template-id') ? document.getElementById('qr-custom-template-id').value || '' : '',
          licenseState: (App && typeof App.getLicenseState === 'function') ? App.getLicenseState() : null,
          taskTitles: document.getElementById('qr-task-titles') ? (document.getElementById('qr-task-titles').value || '').split(/\r?\n/) : [],
        };
        var res;
        try {
          res = await window.QuickRecord.createQuickRecord(input);
        } catch (e) {
          res = { ok: false, error: { code: 'XJ_QR_EXCEPTION', message: (e && e.message) || '保存异常' } };
        }
        var rr = document.getElementById('qr-result');
        rr.hidden = false;
        if (res && res.ok) {
          var s = res.value;
          rr.innerHTML = '<div class="qr-success"><i data-lucide="check-circle"></i>已保存</div>' +
            '<div class="qr-followups">' +
              '<button class="qr-followup" data-action="billing" data-client="' + esc(cid) + '" data-session="' + esc(s.id) + '"><i data-lucide="receipt"></i>账务</button>' +
              '<button class="qr-followup" data-action="schedule" data-client="' + esc(cid) + '"><i data-lucide="calendar-plus"></i>下次安排</button>' +
              '<button class="qr-followup" data-action="supervision" data-client="' + esc(cid) + '" data-session="' + esc(s.id) + '"><i data-lucide="handshake"></i>督导</button>' +
              '<button class="qr-followup" data-action="notes" data-client="' + esc(cid) + '" data-session="' + esc(s.id) + '"><i data-lucide="file-text"></i>完整记录</button>' +
            '</div>';
          submitBtn.innerHTML = '<i data-lucide="check"></i>已保存';
        } else {
          var errMsg = (res && res.error && res.error.message) ? res.error.message : '保存失败';
          var errCode = (res && res.error && res.error.code) ? res.error.code : '';
          rr.innerHTML = '<div class="qr-error"><i data-lucide="alert-triangle"></i>' + (res && res.sessionSaved ? '会谈已保存，模板或待办未完成：' : '保存失败：') + esc(errMsg) + (errCode ? ' <code>' + esc(errCode) + '</code>' : '') + '</div><p class="qr-draft-hint">输入已保留，可直接重试。</p>';
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i data-lucide="save"></i>重试';
        }
        renderIcons(overlay);

        // 绑定四个后续动作（事件委托，只绑定一次）
        if (!rr.dataset.bound) {
          rr.dataset.bound = 'true';
          rr.addEventListener('click', function (ev) {
            var btn = ev.target.closest('[data-action]');
            if (!btn) return;
            var action = btn.dataset.action;
            var fcid = btn.dataset.client;
            var fsid = btn.dataset.session;
            if (!fcid || !Store.getClient(fcid)) { App.showToast('来访者无效', 'error'); return; }
            if (window.QuickRecord && typeof window.QuickRecord.canSwitchAway === 'function' && window.QuickRecord.canSwitchAway().allowed === false) {
              App.showToast('请先等待保存完成', 'warning'); return;
            }
            if (action === 'billing') {
              location.href = 'billing-shell.html?clientId=' + encodeURIComponent(fcid) + '&sessionId=' + encodeURIComponent(fsid || '');
            } else if (action === 'schedule') {
              location.href = 'session-calendar.html?action=new&clientId=' + encodeURIComponent(fcid);
            } else if (action === 'supervision') {
              location.href = 'supervision.html?clientId=' + encodeURIComponent(fcid) + '&sessionId=' + encodeURIComponent(fsid || '');
            } else if (action === 'notes') {
              location.href = routeFor('consult-notes.html', fcid, fsid);
            }
          });
        }
      });
    }
  }

  function bindQuickRecord() {
    // 首页快捷入口卡片
    var qrEntry = document.getElementById('qr-entry');
    if (qrEntry) {
      qrEntry.addEventListener('click', function () { openQuickRecord(); });
      qrEntry.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuickRecord(); } });
    }
    // 工作台客户端动作区动态注入（renderClientWorkbench 后自动处理）
    var workbench = document.getElementById('dual-workbench');
    if (workbench) {
      var observer = new MutationObserver(function () {
        var actionsPanel = document.getElementById('wb-client-actions');
        if (actionsPanel && !actionsPanel.querySelector('[data-qr-action]')) {
          var client = Store.getClient(getActiveClientId());
          if (client) {
            var btn = document.createElement('button');
            btn.className = 'wb-action';
            btn.setAttribute('data-qr-action', 'quick-record');
            btn.setAttribute('type', 'button');
            btn.innerHTML = '<i data-lucide="zap"></i>快速记录<i data-lucide="chevron-right"></i>';
            btn.addEventListener('click', function () { openQuickRecord(); });
            actionsPanel.insertBefore(btn, actionsPanel.firstChild);
            renderIcons(actionsPanel);
          }
        }
      });
      observer.observe(workbench, { childList: true, subtree: true });
    }
  }

  // 暴露 openQuickRecord 供首页入口和集成测试调用（不依赖 onReady 执行）
  if (typeof window !== 'undefined') window.openQuickRecord = openQuickRecord;

  App.initPage({ title: '今日工作台', subtitle: '', actions: '', onReady: function () {
    renderStats();
    renderSchedule();
    bindStartNextSession();
    renderRecent();
    renderTodo();
    renderKbTile();
    bindQuickTools();
    bindWorkbench();
    bindQuickRecord();
    // 强引导：新手任务清单（真实数据驱动）+ 首启聚光灯导览
    try {
      if (window.Onboarding) {
        Onboarding.renderChecklist();
        Onboarding.maybeStartTour();
      }
    } catch (e) { console.warn('[dashboard] onboarding 挂接失败', e); }
  }});
})();
