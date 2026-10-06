(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClinicalAgentAdapter = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function text(v) { return typeof v === 'string' ? v.trim() : ''; }
  function freeze(v) { if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v; Object.keys(v).forEach(function (k) { freeze(v[k]); }); return Object.freeze(v); }
  function fail(reason, extra) { return freeze(Object.assign({ ok: false, reason: reason }, extra || {})); }
  function sourceMeta(list) { return (Array.isArray(list) ? list : []).map(function (s) { var out = { kind: text(s && s.kind), id: text(s && s.id) }; if (text(s && s.label)) out.label = text(s.label); if (s && s.chars != null && isFinite(Number(s.chars))) out.chars = Number(s.chars); if (s && s.truncated === true) out.truncated = true; return out; }); }
  function validateSources(list, allowEmpty) {
    if (!Array.isArray(list)) return 'invalid-context';
    if (list.length === 0) return allowEmpty ? '' : 'invalid-context';
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i += 1) { var s = list[i]; if (!s || typeof s !== 'object' || Array.isArray(s) || !text(s.kind) || !text(s.id)) return 'invalid-context'; var key = text(s.kind) + '|' + text(s.id); if (seen[key]) return 'invalid-context'; seen[key] = true; if (s.stale === true || s.isStale === true || text(s.status).toLowerCase() === 'stale') return 'stale-snapshot'; }
    return '';
  }
  function sourceIdentityCheck(sources, origin) {
    var expectedClient = text(origin && origin.clientId), expectedSession = text(origin && origin.sessionId);
    var clients = Object.create(null), sessions = Object.create(null), clientCount = 0, sessionCount = 0;
    for (var i = 0; i < sources.length; i += 1) {
      var source = sources[i] || {}, client = text(source.clientId), session = text(source.sessionId);
      if (expectedClient && client !== expectedClient) return 'cross-client-source-mismatch';
      if (expectedSession && session !== expectedSession) return 'cross-session-source-mismatch';
      if (client && !clients[client]) { clients[client] = true; clientCount += 1; }
      if (session && !sessions[session]) { sessions[session] = true; sessionCount += 1; }
    }
    if (!expectedClient && clientCount > 1) return 'cross-client-source-mismatch';
    if (!expectedSession && sessionCount > 1) return 'cross-session-source-mismatch';
    return '';
  }
  function contextTaskFor(taskId) { return taskId === 'supervision-question-builder' || taskId === 'supervision-preview' ? 'supervision-ai' : taskId === 'session-review' ? 'session-review' : ''; }
  function validRequest(r) { return !!(r && typeof r === 'object' && !Array.isArray(r) && !!contextTaskFor(text(r.taskId)) && text(r.runId) && text(r.snapshotKey) && typeof r.inputText === 'string'); }
  function sameSourceSet(requestSources, builtSources) {
    if (requestSources.length !== builtSources.length) return false;
    var built = Object.create(null);
    for (var i = 0; i < builtSources.length; i += 1) built[text(builtSources[i].kind) + '|' + text(builtSources[i].id)] = true;
    for (var j = 0; j < requestSources.length; j += 1) if (!built[text(requestSources[j].kind) + '|' + text(requestSources[j].id)]) return false;
    return true;
  }
  function sourceIdentityAgreement(requestSources, builtSources) {
    var built = Object.create(null);
    for (var i = 0; i < builtSources.length; i += 1) built[text(builtSources[i].kind) + '|' + text(builtSources[i].id)] = builtSources[i];
    for (var j = 0; j < requestSources.length; j += 1) {
      var requestSource = requestSources[j] || {};
      var builtSource = built[text(requestSource.kind) + '|' + text(requestSource.id)] || {};
      if (text(requestSource.clientId) && text(requestSource.clientId) !== text(builtSource.clientId)) return 'cross-client-source-mismatch';
      if (text(requestSource.sessionId) && text(requestSource.sessionId) !== text(builtSource.sessionId)) return 'cross-session-source-mismatch';
    }
    return '';
  }
  function make(deps) {
    deps = deps || {};
    var context = deps.context;
    var executor = deps.executor;
    var lifecycle = deps.lifecycle || null;
    if (!context || typeof context.build !== 'function' || typeof context.isSnapshotCurrent !== 'function' || typeof executor !== 'function') throw new Error('adapter dependencies required');
    var handles = typeof WeakMap === 'function' ? new WeakMap() : new Map();
    function projection(state) {
      if (!state || typeof state !== 'object') return fail('invalid-state');
      return freeze({ ok: state.ok === true, status: text(state.status), reason: text(state.reason), runId: text(state.runId), taskId: text(state.taskId), snapshotKey: text(state.snapshotKey), outputDisposition: text(state.outputDisposition), sources: sourceMeta(state.sources), clinicalActionRunId: text(state.clinicalActionRunId) });
    }
    function create(request, prebuilt) {
      if (!validRequest(request)) return fail('malformed-request');
      var requestSourceReason = validateSources(request.sources, text(request.taskId) === 'supervision-preview' && !(request.origin && (text(request.origin.clientId) || text(request.origin.sessionId) || text(request.origin.materialId) || text(request.origin.supervisionId))));
      if (requestSourceReason) return fail(requestSourceReason);
      var built;
      var contextTask = contextTaskFor(text(request.taskId));
      if (prebuilt && typeof prebuilt === 'object') built = prebuilt;
      else { try { built = context.build(contextTask, request.selection, request.contextOptions || {}); } catch (e) { return fail('context-build-failed'); } }
      if (!built || built.ok !== true) return fail(built && text(built.reason) || 'context-build-failed');
      var canonicalBuiltKey = text(built.snapshot && built.snapshot.key);
      var aliasBuiltKey = text(built.snapshotKey);
      if (canonicalBuiltKey && aliasBuiltKey && canonicalBuiltKey !== aliasBuiltKey) return fail('snapshot-mismatch');
      var builtKey = canonicalBuiltKey;
      if (built.outputMode !== 'preview-only' || !built.snapshot || !builtKey || builtKey !== request.snapshotKey || !Array.isArray(built.messages) || built.messages.length === 0 || built.messages.some(function (m) { return !m || typeof m !== 'object' || typeof m.role !== 'string' || typeof m.content !== 'string'; })) return fail(builtKey && builtKey !== request.snapshotKey ? 'snapshot-mismatch' : 'invalid-context');
      if (text(built.task) !== contextTask) return fail('unknown-task');
      var sources = built.sources;
      var sourceReason = validateSources(sources, text(request.taskId) === 'supervision-preview' && !(request.origin && (text(request.origin.clientId) || text(request.origin.sessionId) || text(request.origin.materialId) || text(request.origin.supervisionId))));
      if (sourceReason) return fail(sourceReason);
      if (!sameSourceSet(request.sources, sources)) return fail('source-mismatch');
      var sourceIdentityReason = sourceIdentityAgreement(request.sources, sources);
      if (sourceIdentityReason) return fail(sourceIdentityReason);
      var builtOrigin = built.origin || {};
      if (request.origin && text(request.origin.clientId) && text(builtOrigin.clientId) && text(request.origin.clientId) !== text(builtOrigin.clientId)) return fail('cross-client-source-mismatch');
      if (request.origin && text(request.origin.sessionId) && text(builtOrigin.sessionId) && text(request.origin.sessionId) !== text(builtOrigin.sessionId)) return fail('cross-session-source-mismatch');
      var expectedOrigin = {
        clientId: text(request.origin && request.origin.clientId) || text(builtOrigin.clientId),
        sessionId: text(request.origin && request.origin.sessionId) || text(builtOrigin.sessionId)
      };
      var identityReason = sourceIdentityCheck(sources, expectedOrigin);
      if (identityReason) return fail(identityReason);
      if (text(builtOrigin.clientId) && sources.some(function (s) { return text(s.clientId) !== text(builtOrigin.clientId); })) return fail('cross-client-source-mismatch');
      if (text(builtOrigin.sessionId) && sources.some(function (s) { return text(s.sessionId) !== text(builtOrigin.sessionId); })) return fail('cross-session-source-mismatch');
      var state = freeze({ ok: true, status: 'awaiting-confirmation', runId: text(request.runId), taskId: request.taskId, snapshotKey: text(request.snapshotKey), outputDisposition: 'preview', sources: sourceMeta(sources) });
      handles.set(state, { request: request, context: built, active: true, actionRunId: '' });
      return state;
    }
    function lifecycleOk(value) { return value !== null && value !== undefined && (!value || value.ok !== false); }
    function failLifecycle(privateState, reason, status) {
      if (!privateState || !privateState.actionRunId || privateState.lifecycleSettled) return fail(reason, privateState && privateState.actionRunId ? { clinicalActionRunId: privateState.actionRunId } : undefined);
      privateState.lifecycleSettled = true;
      try { if (!lifecycle || typeof lifecycle.failActionRun !== 'function' || !lifecycleOk(lifecycle.failActionRun(privateState.actionRunId, reason, status || 'failed'))) return fail('lifecycle-failed', { clinicalActionRunId: privateState.actionRunId }); } catch (e) { return fail('lifecycle-failed', { clinicalActionRunId: privateState.actionRunId }); }
      return fail(reason, { clinicalActionRunId: privateState.actionRunId });
    }
    function cancel(state, reason) {
      var privateState = handles.get(state);
      if (!privateState || (!privateState.active && !privateState.executing)) return fail('invalid-state');
      privateState.active = false;
      privateState.executing = false;
      return failLifecycle(privateState, text(reason) || 'cancelled', 'cancelled');
    }
    async function execute(state, options) {
      options = options || {};
      var privateState = handles.get(state);
      if (!privateState || !privateState.active || !state || state.status !== 'awaiting-confirmation') return fail('invalid-state');
      privateState.active = false;
      privateState.executing = true;
      function cancelled() { return typeof options.isCancelled === 'function' && options.isCancelled() === true; }
      if (cancelled()) return fail('cancelled');
      var current;
      try { current = context.isSnapshotCurrent(privateState.context.snapshot, privateState.request.inputText, privateState.request.selection); } catch (e) { return fail('stale-before'); }
      if (!current) return fail('stale-before');
      if (lifecycle) {
        if (typeof lifecycle.createActionRun !== 'function') return fail('lifecycle-failed');
        var actionRun;
        try { actionRun = lifecycle.createActionRun(privateState.context); } catch (e0) { return fail('lifecycle-failed'); }
        privateState.actionRunId = text(actionRun && (actionRun.id || actionRun.clinicalActionRunId || actionRun.runId));
        if (!privateState.actionRunId) return fail('lifecycle-failed');
      }
      var payload = privateState.context.messages.map(function (m) { return { role: m.role, content: m.content }; });
      var meta = { runId: state.runId, taskId: state.taskId, snapshotKey: state.snapshotKey, outputDisposition: 'draft', sources: sourceMeta(privateState.context.sources), clinicalActionRunId: privateState.actionRunId };
      var draft;
      try { draft = await executor(payload, Object.assign({}, meta, { signal: options.signal, onDelta: options.onDelta })); } catch (e2) { return failLifecycle(privateState, 'executor-failed', 'failed'); }
      if (cancelled()) return failLifecycle(privateState, 'cancelled', 'cancelled');
      if (draft && typeof draft === 'object' && draft.__runtimeFailure) return failLifecycle(privateState, text(draft.__runtimeFailure) || 'executor-failed', draft.__runtimeFailure === 'ai-cancelled' ? 'cancelled' : 'failed');
      try { current = context.isSnapshotCurrent(privateState.context.snapshot, privateState.request.inputText, privateState.request.selection); } catch (e3) { return failLifecycle(privateState, 'stale-after', 'stale'); }
      if (!current) return failLifecycle(privateState, 'stale-after', 'stale');
      if (draft === null || draft === undefined || Array.isArray(draft) || (typeof draft !== 'string' && (typeof draft !== 'object' || (Object.getPrototypeOf(draft) !== Object.prototype && Object.getPrototypeOf(draft) !== null)))) return failLifecycle(privateState, 'malformed-draft', 'failed');
      if (privateState.actionRunId) {
        if (!lifecycle || typeof lifecycle.completeActionRun !== 'function') return failLifecycle(privateState, 'lifecycle-failed', 'failed');
        var completed;
        try { completed = lifecycle.completeActionRun(privateState.actionRunId, { kind: 'supervision-preview', summary: typeof draft === 'string' ? draft : JSON.stringify(draft), citations: [] }); } catch (e4) { return failLifecycle(privateState, 'lifecycle-failed', 'failed'); }
        if (!lifecycleOk(completed)) return failLifecycle(privateState, 'lifecycle-failed', 'failed');
        privateState.lifecycleSettled = true;
      }
      var result = { ok: true, status: 'draft-ready', runId: state.runId, taskId: state.taskId, snapshotKey: state.snapshotKey, outputDisposition: 'draft', sources: sourceMeta(privateState.context.sources), draft: draft, clinicalActionRunId: privateState.actionRunId };
      return freeze(result);
    }
    function isAdapterState(value) { return !!(value && typeof value === 'object' && handles.has(value)); }
    function prepareContext(request) {
      if (!request || typeof request !== 'object') return fail('malformed-request');
      var contextTask = contextTaskFor(text(request.taskId));
      if (!contextTask) return fail('malformed-request');
      try { return context.build(contextTask, request.selection, request.contextOptions || {}); } catch (e) { return fail('context-build-failed'); }
    }
    return Object.freeze({ create: create, prepareContext: prepareContext, execute: execute, cancel: cancel, isAdapterState: isAdapterState, project: projection });
  }
  var api = make;
  return Object.freeze({ withDependencies: make, create: function () { throw new Error('withDependencies required'); }, execute: function () { throw new Error('withDependencies required'); }, isAdapterState: function () { return false; }, project: function () { return fail('dependencies-required'); } });
}));
