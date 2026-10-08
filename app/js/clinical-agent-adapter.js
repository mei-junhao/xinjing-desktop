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
  function contextTaskFor(taskId) {
    if (taskId === 'supervision-question-builder' || taskId === 'supervision-preview') return 'supervision-ai';
    if (taskId === 'multi-school-comparison') return 'supervision-multi-school';
    return taskId;
  }
  var INSTRUCTIONS = {
    'countertransference-analysis': '反移情分析：区分咨询师的情绪、身体与行动倾向和来访者事实，提出关系假设、替代解释及督导问题，不将感受当作来访者的诊断。',
    'session-review': '会谈复盘：按会谈进程总结关键互动、干预、观察与待复核问题，区分逐字记录和推测。',
    'case-conceptualization': '个案概念化：组织主诉、维持因素、保护因素和关系模式，注明证据缺口及替代解释，不作确定诊断。',
    'next-session-hypotheses': '下次会谈假设：提出可验证的工作假设、观察信号和开放问题，不替咨询师决定行动。',
    'supervision-question-builder': '督导问题生成：整理背景、关键难点与具体督导提问，逐项说明提问依据及待澄清点。',
    'multi-school-comparison': '多流派比较：分别从精神动力学、认知行为、人本视角比较理解与提问，注明适用范围和冲突，不虚构专家共识。',
    'supervision-preview': '督导整体印象：给出审慎的整体理解、证据与下一步待验证问题。'
  };
  function reviewDraft(draft, sources) {
    var fields = draft;
    if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch (_) { return fail('malformed-draft'); } }
    var keys = ['facts', 'inferences', 'hypotheses'];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(function (key) { return keys.indexOf(key) < 0; }) || keys.some(function (key) { return typeof fields[key] !== 'string'; }) || !keys.some(function (key) { return text(fields[key]); })) return fail('malformed-draft');
    var admitted = new Set(sources.map(function (source) { return source.id; })), cited = new Set();
    for (var i = 0; i < keys.length; i += 1) {
      var refs = fields[keys[i]].match(/\[[^\[\]\r\n]+\]/g) || [];
      for (var j = 0; j < refs.length; j += 1) {
        var id = refs[j].slice(1, -1).trim();
        if (!admitted.has(id)) return fail('output-citation-not-admitted');
        cited.add(id);
      }
    }
    // 只核验引用归属，不把“引用存在”当作事实语义已经得到临床证实。
    if (fields.facts.split(/\r?\n/).some(function (line) { return text(line) && !/\[[^\[\]\r\n]+\]/.test(line); })) return fail('output-evidence-missing');
    return { ok: true, citations: sourceMeta(sources.filter(function (source) { return cited.has(source.id); })) };
  }
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
    async function failLifecycle(privateState, reason, status) {
      if (privateState && privateState.failurePending) return privateState.failurePending;
      if (!privateState || !privateState.actionRunId || privateState.lifecycleSettled) return fail(reason, privateState && privateState.actionRunId ? { clinicalActionRunId: privateState.actionRunId } : undefined);
      privateState.lifecycleSettled = true;
      privateState.failurePending = (async function () {
        try { if (!lifecycle || typeof lifecycle.failActionRun !== 'function' || !lifecycleOk(await lifecycle.failActionRun(privateState.actionRunId, reason, status || 'failed'))) return fail('lifecycle-failed', { clinicalActionRunId: privateState.actionRunId }); } catch (e) { return fail('lifecycle-failed', { clinicalActionRunId: privateState.actionRunId }); }
        return fail(reason, { clinicalActionRunId: privateState.actionRunId });
      }());
      return privateState.failurePending;
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
        try { actionRun = await lifecycle.createActionRun(privateState.context); } catch (e0) { return fail('lifecycle-failed'); }
        privateState.actionRunId = text(actionRun && (actionRun.id || actionRun.clinicalActionRunId || actionRun.runId));
        if (!privateState.actionRunId) return fail('lifecycle-failed');
        if (cancelled()) return failLifecycle(privateState, 'cancelled', 'cancelled');
        try { current = context.isSnapshotCurrent(privateState.context.snapshot, privateState.request.inputText, privateState.request.selection); } catch (_) { current = false; }
        if (!current) return failLifecycle(privateState, 'stale-before', 'stale');
      }
      var payload = privateState.context.messages.map(function (m) { return { role: m.role, content: m.content }; });
      var instruction = (INSTRUCTIONS[state.taskId] || '') + '\n仅输出 JSON 对象，且只含 facts、inferences、hypotheses 三个字符串字段，不加 Markdown 围栏或其他字段。facts 每一非空行必须以 [来源ID] 标注来源可核对内容；没有事实依据时留空。inferences 明确标为推论；hypotheses 明确标为待验证假设。方括号仅用于引用下列来源，不引用不存在的来源：' + privateState.context.sources.map(function (source) { return source.id; }).join('、');
      var system = payload.find(function (message) { return message.role === 'system'; });
      if (system) system.content += '\n' + instruction;
      else payload.unshift({ role: 'system', content: instruction });
      var meta = { runId: state.runId, taskId: state.taskId, snapshotKey: state.snapshotKey, outputDisposition: 'draft', sources: sourceMeta(privateState.context.sources), clinicalActionRunId: privateState.actionRunId };
      var draft;
      try { draft = await executor(payload, Object.assign({}, meta, { signal: options.signal, onDelta: options.onDelta })); } catch (e2) { return failLifecycle(privateState, 'executor-failed', 'failed'); }
      if (cancelled()) return failLifecycle(privateState, 'cancelled', 'cancelled');
      if (draft && typeof draft === 'object' && draft.__runtimeFailure) return failLifecycle(privateState, text(draft.__runtimeFailure) || 'executor-failed', draft.__runtimeFailure === 'ai-cancelled' ? 'cancelled' : 'failed');
      try { current = context.isSnapshotCurrent(privateState.context.snapshot, privateState.request.inputText, privateState.request.selection); } catch (e3) { return failLifecycle(privateState, 'stale-after', 'stale'); }
      if (!current) return failLifecycle(privateState, 'stale-after', 'stale');
      if (draft === null || draft === undefined || Array.isArray(draft) || (typeof draft !== 'string' && (typeof draft !== 'object' || (Object.getPrototypeOf(draft) !== Object.prototype && Object.getPrototypeOf(draft) !== null)))) return failLifecycle(privateState, 'malformed-draft', 'failed');
      var reviewed = reviewDraft(draft, privateState.context.sources);
      if (!reviewed.ok) return failLifecycle(privateState, reviewed.reason, 'failed');
      if (privateState.actionRunId) {
        if (!lifecycle || typeof lifecycle.completeActionRun !== 'function') return failLifecycle(privateState, 'lifecycle-failed', 'failed');
        var completed;
        var outputKind = 'supervision-preview';
        try {
          outputKind = privateState.request && (privateState.request.taskId === 'supervision-preview' || privateState.request.taskId === 'supervision-question-builder')
            ? 'supervision-preview' : (text(privateState.context && privateState.context.task) || outputKind);
        } catch (_) {}
        try { completed = await lifecycle.completeActionRun(privateState.actionRunId, { kind: outputKind, summary: typeof draft === 'string' ? draft : JSON.stringify(draft), citations: reviewed.citations }); } catch (e4) { return failLifecycle(privateState, 'lifecycle-failed', 'failed'); }
        if (!lifecycleOk(completed) || completed.status === 'failed') return failLifecycle(privateState, 'lifecycle-failed', 'failed');
        if (cancelled()) return failLifecycle(privateState, 'cancelled', 'cancelled');
        try { current = context.isSnapshotCurrent(privateState.context.snapshot, privateState.request.inputText, privateState.request.selection); } catch (_) { current = false; }
        if (!current) return failLifecycle(privateState, 'stale-after', 'stale');
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
