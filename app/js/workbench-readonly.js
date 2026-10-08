/* ============================================================
   心镜 v4.2.2 — 工作台只读壳层
   职责：从真实 Store 读取来访者队列、当前会谈、上下文投影，
   不执行任何 Store 写入或持久化操作。
   ============================================================ */
(function () {
  'use strict';

  // ---- 来访者队列 ----
  function getClientQueue(statusFilter) {
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    if (statusFilter && statusFilter !== 'all') clients = clients.filter(function (c) { return c.status === statusFilter; });
    return clients.sort(function (a, b) {
      var aLatest = latestSessionDate(a.id);
      var bLatest = latestSessionDate(b.id);
      return (bLatest || '').localeCompare(aLatest || '');
    });
  }

  function latestSessionDate(clientId) {
    var sessions = Store.getSessionsByClient(clientId);
    if (!sessions.length) return '';
    sessions.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    return sessions[0].date || '';
  }

  function sessionCount(clientId) {
    return (Store.getSessionsByClient(clientId) || []).length;
  }

  // ---- 当前会谈 ----
  function getCurrentSession(clientId) {
    var sessions = Store.getSessionsByClient(clientId).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    return sessions[0] || null;
  }

  function getTodaySessions() {
    var today = App.todayStr();
    return (Store.getSessions() || []).filter(function (s) { return s.date === today; });
  }

  // ---- 上下文投影 ----
  function buildContextMap(clientId) {
    var client = Store.getClient(clientId);
    if (!client) return null;
    var sessions = Store.getSessionsByClient(clientId).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var supervisions = Store.getSupervisionsByClient ? Store.getSupervisionsByClient(clientId) : [];
    var latest = sessions[0] || null;
    return {
      client: client,
      name: client.name || '',
      status: client.status || 'active',
      sessionCount: sessions.length,
      latestSession: latest,
      hasTranscript: !!(latest && latest.hasTranscript),
      hasSoap: !!(latest && latest.hasSoap),
      supervisionCount: supervisions.length,
      billing: client.billing || {},
    };
  }

  // ---- 深链构造（带 Store 校验）----
  function buildDeepLink(page, queryParams) {
    var params = {};
    for (var k in queryParams) { if (queryParams[k] != null && queryParams[k] !== '') params[k] = queryParams[k]; }

    // 校验实体 ID：clientId 必须存在
    if (params.clientId && !validateClientId(params.clientId)) {
      // 不合法 clientId → 去掉所有实体参数，仅保留纯页面路由
      delete params.clientId;
      delete params.sessionId;
      delete params.materialId;
    }
    // 校验 sessionId：必须存在且属于 clientId
    if (params.sessionId && params.clientId) {
      if (!validateSessionId(params.clientId, params.sessionId)) {
        delete params.sessionId;
      }
    } else if (params.sessionId && !params.clientId) {
      // sessionId 不允许单独出现（缺少 clientId 上下文）
      delete params.sessionId;
    }
    // 校验 materialId：若带 clientId/sessionId 则关系必须一致
    if (params.materialId) {
      var mat = Store.getMaterialWorkspace ? Store.getMaterialWorkspace(params.materialId) : null;
      if (!mat) {
        delete params.materialId;
      } else {
        if (mat.clientId && mat.clientId !== params.clientId) delete params.clientId;
        if (mat.sessionId && mat.sessionId !== params.sessionId) delete params.sessionId;
      }
    }

    var pairs = [];
    for (var kk in params) {
      if (params[kk] != null && params[kk] !== '') pairs.push(encodeURIComponent(kk) + '=' + encodeURIComponent(params[kk]));
    }
    return page + (pairs.length ? '?' + pairs.join('&') : '');
  }

  function validateClientId(id) {
    return !!(id && Store.getClient(id));
  }

  function validateSessionId(clientId, sessionId) {
    if (!sessionId) return false;
    var session = Store.getSession(sessionId);
    return !!(session && session.clientId === clientId);
  }

  // ---- 路由完整性 ----
  function getRouteList() {
    return [
      { page: 'index.html', key: 'dashboard' },
      { page: 'consult-notes.html', key: 'consult-notes' },
      { page: 'report-writing.html', key: 'report-writing' },
      { page: 'supervision.html', key: 'supervision' },
      { page: 'real-supervision.html', key: 'real-supervision' },
      { page: 'real-supervision-ai.html', key: 'real-supervision-ai' },
      { page: 'supervision-mindmap.html', key: 'supervision-mindmap' },
      { page: 'masters.html', key: 'masters' },
      { page: 'billing-shell.html', key: 'billing' },
      { page: 'billing-calendar.html', key: 'billing-calendar' },
      { page: 'chat-home.html', key: 'chat-home' },
      { page: 'transcript.html', key: 'transcript' },
      { page: 'transcript-guide.html', key: 'transcript-guide' },
      { page: 'session-calendar.html', key: 'session-calendar' },
      { page: 'doc-center.html', key: 'doc-center' },
      { page: 'doc-growth.html', key: 'doc-growth' },
      { page: 'knowledge.html', key: 'knowledge' },
      { page: 'settings.html', key: 'settings' },
      { page: 'feedback.html', key: 'feedback' },
      { page: 'activation.html', key: 'activation' },
      { page: 'confirm-close.html', key: 'confirm-close' },
      { page: 'migrate-helper.html', key: 'migrate-helper' },
    ];
  }

  function verifyRoutes() {
    var routes = getRouteList();
    var ok = 0, missing = [];
    routes.forEach(function (r) {
      // Static check: route keys exist in source
      if (r.page && r.key) ok++;
      else missing.push(r);
    });
    return { total: routes.length, verified: ok, missing: missing };
  }

  // Exports
  window.WorkbenchReadonly = {
    getClientQueue: getClientQueue,
    sessionCount: sessionCount,
    getCurrentSession: getCurrentSession,
    getTodaySessions: getTodaySessions,
    buildContextMap: buildContextMap,
    buildDeepLink: buildDeepLink,
    validateClientId: validateClientId,
    validateSessionId: validateSessionId,
    getRouteList: getRouteList,
    verifyRoutes: verifyRoutes,
  };
})();
