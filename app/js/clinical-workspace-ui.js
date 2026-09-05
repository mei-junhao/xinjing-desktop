/* XinJing shared clinical-workspace UI projection. Read-only: never owns business data. */
(function (root) {
  'use strict';

  function text(value) { return String(value == null ? '' : value).trim(); }
  function escapeHtml(value) {
    if (root.App && typeof root.App.escapeHtml === 'function') return root.App.escapeHtml(text(value));
    return text(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function store() { return root.Store && typeof root.Store.getClients === 'function' ? root.Store : null; }
  function app() { return root.App || null; }
  function query() {
    try { return new URLSearchParams(root.location && root.location.search ? root.location.search : ''); }
    catch (error) { return new URLSearchParams(''); }
  }
  function validClient(id) {
    var currentStore = store();
    return currentStore && id && typeof currentStore.getClient === 'function' ? currentStore.getClient(id) : null;
  }
  function validSession(id, clientId) {
    var currentStore = store();
    var session = currentStore && id && typeof currentStore.getSession === 'function' ? currentStore.getSession(id) : null;
    return session && (!clientId || session.clientId === clientId) ? session : null;
  }
  function resolveContext(options) {
    options = options || {};
    var params = query();
    var currentApp = app();
    var clientId = text(options.clientId || params.get('clientId'));
    var client = validClient(clientId);
    if (!client && currentApp && typeof currentApp.getActiveClientId === 'function') {
      clientId = text(currentApp.getActiveClientId());
      client = validClient(clientId);
    }
    var sessionId = text(options.sessionId || params.get('sessionId'));
    var session = validSession(sessionId, client && client.id);
    if (!session && client && options.preferRecentSession !== false) {
      var sessions = store().getSessionsByClient(client.id) || [];
      session = sessions.slice().sort(function (left, right) {
        return text(right.date || right.updatedAt).localeCompare(text(left.date || left.updatedAt));
      })[0] || null;
      sessionId = session ? session.id : '';
    }
    return Object.freeze({
      clientId: client ? text(client.id) : '',
      sessionId: session ? text(session.id) : '',
      client: client || null,
      session: session || null
    });
  }
  function featureState(feature) {
    var currentApp = app();
    var label = root.XJEntitlements && typeof root.XJEntitlements.featureLabel === 'function'
      ? root.XJEntitlements.featureLabel(feature) : feature;
    var eligible = !!(currentApp && typeof currentApp.canUse === 'function' && currentApp.canUse(feature));
    var computeAvailable = feature.indexOf('ai-') !== 0 || !!(currentApp && typeof currentApp.hasAICompute === 'function' && currentApp.hasAICompute());
    var tier = currentApp && typeof currentApp.getLicenseState === 'function' ? text(currentApp.getLicenseState().tier || 'free') : 'free';
    return Object.freeze({ feature: feature, label: label, eligible: eligible, computeAvailable: computeAvailable, tier: tier });
  }
  function formatSession(session) {
    if (!session) return '未选择会谈';
    var number = session.sessionNumber ? '第 ' + session.sessionNumber + ' 次' : '未编号会谈';
    var date = session.date && app() && typeof app().formatDate === 'function' ? app().formatDate(session.date) : text(session.date);
    return number + (date ? ' · ' + date : '');
  }
  function contextStripMarkup(options) {
    options = options || {};
    var context = resolveContext(options);
    var feature = options.feature ? featureState(options.feature) : null;
    var approach = context.client && text(context.client.approach || context.client.orientation || context.client.modality);
    var cells = [
      { label: '来访者', value: context.client ? text(context.client.name || '未命名来访者') : '未选择' },
      { label: '会谈', value: formatSession(context.session) },
      { label: '取向', value: approach || '未设置' }
    ];
    if (feature) {
      cells.push({ label: '产品权益', value: feature.eligible ? feature.label + ' · 可用' : feature.label + ' · 需升级', tone: feature.eligible ? 'eligible' : 'locked' });
      cells.push({ label: '计算状态', value: feature.computeAvailable ? 'AI 计算就绪' : '需要配置 AI', tone: feature.computeAvailable ? 'ready' : 'warning' });
    }
    return cells.map(function (cell) {
      return '<span class="xj-context-cell"><small>' + escapeHtml(cell.label) + '</small><strong' + (cell.tone ? ' data-tone="' + cell.tone + '"' : '') + '>' + escapeHtml(cell.value) + '</strong></span>';
    }).join('');
  }
  function renderContextStrip(target, options) {
    var element = typeof target === 'string' ? root.document.getElementById(target) : target;
    if (!element) return false;
    element.innerHTML = contextStripMarkup(options);
    element.dataset.contextReady = 'true';
    return true;
  }
  function recentClientRows(limit) {
    var currentStore = store();
    if (!currentStore) return [];
    return currentStore.getClients().filter(function (client) { return client && client.status !== 'ended'; }).map(function (client) {
      var sessions = (currentStore.getSessionsByClient(client.id) || []).slice().sort(function (left, right) {
        return text(right.date || right.updatedAt).localeCompare(text(left.date || left.updatedAt));
      });
      return { client: client, session: sessions[0] || null, sessionCount: sessions.length };
    }).sort(function (left, right) {
      return text((right.session && (right.session.date || right.session.updatedAt)) || right.client.updatedAt)
        .localeCompare(text((left.session && (left.session.date || left.session.updatedAt)) || left.client.updatedAt));
    }).slice(0, Math.max(1, Number(limit) || 8));
  }
  function setContext(clientId, sessionId) {
    var client = validClient(text(clientId));
    if (!client) return false;
    var currentApp = app();
    if (currentApp && typeof currentApp.setActiveClientId === 'function') currentApp.setActiveClientId(client.id);
    try {
      var params = query();
      params.set('clientId', client.id);
      if (validSession(text(sessionId), client.id)) params.set('sessionId', text(sessionId));
      else params.delete('sessionId');
      root.history.replaceState({}, '', root.location.pathname + '?' + params.toString() + (root.location.hash || ''));
    } catch (error) {}
    root.dispatchEvent(new CustomEvent('xj:clinical-context-changed', { detail: { clientId: client.id, sessionId: text(sessionId) } }));
    return true;
  }
  function refreshIcons(target) {
    if (root.IconSystem && typeof root.IconSystem.render === 'function') root.IconSystem.render(target || root.document);
    else if (root.lucide && typeof root.lucide.createIcons === 'function') root.lucide.createIcons();
  }

  var api = Object.freeze({
    escapeHtml: escapeHtml,
    resolveContext: resolveContext,
    featureState: featureState,
    formatSession: formatSession,
    contextStripMarkup: contextStripMarkup,
    renderContextStrip: renderContextStrip,
    recentClientRows: recentClientRows,
    setContext: setContext,
    refreshIcons: refreshIcons
  });
  root.XJClinicalWorkspace = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
