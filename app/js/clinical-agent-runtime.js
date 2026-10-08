(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : this);
  else root.ClinicalAgentRuntime = factory(root);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (globalRoot) {
  'use strict';
  function text(v) { return typeof v === 'string' ? v.trim() : ''; }
  function freeze(v) { if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v; Object.keys(v).forEach(function (k) { freeze(v[k]); }); return Object.freeze(v); }
  function fail(reason, extra) { return freeze(Object.assign({ ok: false, reason: reason }, extra || {})); }
  function safeSources(list) { return Array.isArray(list) ? list.map(function (s) { var out = { kind: text(s && s.kind), id: text(s && s.id) }; if (text(s && s.label)) out.label = text(s.label); if (s && s.chars != null && isFinite(Number(s.chars))) out.chars = Number(s.chars); if (s && s.truncated === true) out.truncated = true; return out; }) : []; }
  function metadata(value) { return freeze({ ok: value && value.ok === true, runId: text(value && value.runId), taskId: text(value && value.taskId), status: text(value && value.status), snapshotKey: text(value && value.snapshotKey), outputDisposition: text(value && value.outputDisposition), sources: safeSources(value && value.sources), estimatedChars: Number.isFinite(Number(value && value.estimatedChars)) ? Number(value.estimatedChars) : 0, reason: text(value && value.reason), clinicalActionRunId: text(value && value.clinicalActionRunId) }); }
  function make(deps) {
    deps = deps || {};
    var workflow = deps.workflow, adapter = deps.adapter, executor = deps.executor, defaultTimeoutMs = Number(deps.defaultTimeoutMs);
    if (!workflow || typeof workflow.prepare !== 'function' || typeof workflow.confirm !== 'function' || typeof workflow.cancel !== 'function' || typeof workflow.isWorkflowState !== 'function' || !adapter || typeof adapter.create !== 'function' || typeof adapter.execute !== 'function') throw new Error('runtime dependencies required');
    var states = typeof WeakMap === 'function' ? new WeakMap() : new Map();
    function prepareContext(request) {
      var built = typeof adapter.prepareContext === 'function' ? adapter.prepareContext(request) : null;
      if (!built || built.ok !== true) return fail(built && built.reason || 'context-build-failed');
      var token = metadata({ ok: true, runId: request && request.runId, taskId: request && request.taskId, status: 'context-ready', snapshotKey: built.snapshot && built.snapshot.key, sources: built.sources, estimatedChars: built.estimatedChars });
      states.set(token, { context: built, contextReady: true, active: true });
      return token;
    }
    function prepare(request, preparedContext) {
      var contextEntry = preparedContext && states.get(preparedContext);
      var workflowRequest = contextEntry && contextEntry.context ? Object.assign({}, request, { sources: contextEntry.context.sources, origin: contextEntry.context.origin || request.origin }) : request;
      var prepared = workflow.prepare(workflowRequest);
      if (!prepared || prepared.ok !== true) return fail(prepared && prepared.reason || 'workflow-rejected');
      var adapterRequest = Object.assign({}, request, { taskId: prepared.taskId, runId: prepared.runId, snapshotKey: prepared.snapshotKey, inputText: typeof request.inputText === 'string' ? request.inputText : request.text });
      var handle = adapter.create(adapterRequest, contextEntry && contextEntry.context);
      if (!handle || handle.ok !== true) { workflow.cancel(prepared, 'adapter-rejected'); return fail(handle && handle.reason || 'adapter-rejected'); }
      var out = metadata(prepared);
      states.set(out, { workflow: prepared, adapter: handle, active: true });
      return out;
    }
    function confirm(prepared, confirmation) {
      var entry = states.get(prepared);
      if (!entry || !entry.active) return fail('invalid-prepared-state');
      var confirmed = workflow.confirm(entry.workflow, confirmation);
      if (!confirmed || confirmed.ok !== true) return fail(confirmed && confirmed.reason || 'confirmation-required');
      var out = metadata(confirmed);
      states.delete(prepared); states.set(out, { workflow: confirmed, adapter: entry.adapter, active: true, running: false, cancelled: false });
      return out;
    }
    async function execute(confirmed, options) {
      options = options || {};
      var entry = states.get(confirmed);
      if (!entry || !entry.active || !confirmed || confirmed.status !== 'running') return fail('invalid-confirmed-state');
      if (entry.running) return fail('execution-already-running');
      entry.running = true;
      if (typeof workflow.waitForPersistence === 'function') {
        var stored = await workflow.waitForPersistence(entry.workflow);
        if (!stored || stored.ok !== true) { entry.running = false; entry.active = false; return fail('run-persistence-failed'); }
        if (!entry.active || entry.cancelled) { entry.running = false; return fail('ai-cancelled'); }
      }
      entry.running = true;
      var cancelled = function () { return entry.cancelled || (typeof options.isCancelled === 'function' && options.isCancelled()); };
      var controller = null;
      if (!options.signal && typeof AbortController === 'function') controller = new AbortController();
      var signal = options.signal || (controller && controller.signal);
      entry.controller = controller;
      var timeoutMs = Object.prototype.hasOwnProperty.call(options, 'timeoutMs') ? Number(options.timeoutMs) : defaultTimeoutMs;
      var timedOut = false;
      var timer = null;
      var execution;
      var result;
      var settled = false;
      function onDelta(content, safeContent) {
        if (settled || cancelled() || typeof options.onDelta !== 'function') return;
        try { options.onDelta(content, safeContent); } catch (_) {}
      }
      try {
        execution = adapter.execute(entry.adapter, { isCancelled: cancelled, signal: signal, onDelta: onDelta });
        if (timeoutMs > 0 && isFinite(timeoutMs)) {
          execution = Promise.race([execution, new Promise(function (resolve) { timer = setTimeout(function () { timedOut = true; entry.cancelled = true; try { if (controller) controller.abort(); } catch (_) {} try { if (typeof adapter.cancel === 'function') adapter.cancel(entry.adapter, 'timeout'); } catch (_) {} try { workflow.cancel(entry.workflow, 'timeout'); } catch (_) {} resolve(fail('ai-cancelled')); }, timeoutMs); })]);
        }
        result = await execution;
      } catch (e) { result = fail('executor-failed'); }
      settled = true;
      if (timer) clearTimeout(timer);
      entry.running = false;
      entry.controller = null;
      if (result && (result.ok === true || result.ok === false)) entry.active = false;
      if (timedOut || entry.cancelled || cancelled()) {
        workflow.cancel(entry.workflow, 'cancelled');
        if (typeof workflow.waitForPersistence === 'function') await workflow.waitForPersistence(entry.workflow);
        return fail('ai-cancelled', { clinicalActionRunId: result && result.clinicalActionRunId });
      }
      if (!result || result.ok !== true) {
        var failureReason = result && result.reason || 'executor-failed';
        if (typeof workflow.settle === 'function') workflow.settle(entry.workflow, failureReason === 'stale-after' || failureReason === 'stale-before' ? 'stale' : 'failed', failureReason);
        if (typeof workflow.waitForPersistence === 'function') await workflow.waitForPersistence(entry.workflow);
        return fail(failureReason, { clinicalActionRunId: result && result.clinicalActionRunId });
      }
      if (typeof workflow.settle === 'function') workflow.settle(entry.workflow, 'draft-ready');
      if (typeof workflow.waitForPersistence === 'function') {
        var terminalStored = await workflow.waitForPersistence(entry.workflow);
        if (!terminalStored || terminalStored.ok !== true) return fail('run-persistence-failed');
      }
      return freeze({ ok: true, runId: confirmed.runId, taskId: confirmed.taskId, status: 'draft-ready', snapshotKey: result.snapshotKey || confirmed.snapshotKey, sources: result.sources || confirmed.sources, outputDisposition: 'draft', draft: result.draft, clinicalActionRunId: result.clinicalActionRunId });
    }
    function cancel(state, reason) { var entry = states.get(state); if (!entry || !entry.active) return fail('invalid-runtime-state'); entry.cancelled = true; try { if (entry.controller) entry.controller.abort(); } catch (_) {} try { if (typeof adapter.cancel === 'function') adapter.cancel(entry.adapter, reason || 'cancelled'); } catch (_) {} if (!entry.running) entry.active = false; workflow.cancel(entry.workflow, reason || 'cancelled'); return freeze({ ok: false, runId: state.runId, taskId: state.taskId, status: 'cancelled', reason: text(reason) || 'cancelled' }); }
    function project(value) { return metadata(value); }
    function isRuntimeState(value) { return !!(value && typeof value === 'object' && states.has(value)); }
    return Object.freeze({ prepareContext: prepareContext, prepare: prepare, confirm: confirm, execute: execute, cancel: cancel, project: project, isRuntimeState: isRuntimeState });
  }
  function fromGlobals(options) {
    options = options || {};
    var workflow = options.workflow || globalRoot.ClinicalAgentWorkflow, adapterApi = options.adapter || globalRoot.ClinicalAgentAdapter, context = options.ClinicalContext || globalRoot.ClinicalContext, ai = options.AI || globalRoot.AI;
    if (!context || typeof context.build !== 'function' || typeof context.isSnapshotCurrent !== 'function' || !ai || typeof ai.send !== 'function') throw new Error('global runtime dependencies required');
    if (!adapterApi || typeof adapterApi.withDependencies !== 'function') throw new Error('adapter factory required');
    var signals = new Map();
    function signalKey(meta) { return text(meta && meta.runId) + '|' + text(meta && meta.snapshotKey); }
    var executor = function (messages, meta) { return new Promise(function (resolve) { var settled = false; function done(value) { if (value && typeof meta.onDelta === 'function' && value.content && !value.error && !value.interrupted && !value.cancelled && !value.aborted) { try { meta.onDelta(value.content, value.content); } catch (_) {} } if (settled) return; if (value && value.error) { settled = true; return resolve({ __runtimeFailure: 'ai-failed' }); } if (value && (value.interrupted || value.cancelled || value.aborted)) { settled = true; return resolve({ __runtimeFailure: 'ai-cancelled' }); } var draft = typeof value === 'string' ? value : value && (value.content || value.text || value.draft); if (draft === undefined || draft === null) { settled = true; return resolve({ __runtimeFailure: 'ai-failed' }); } settled = true; resolve(draft); } try { var result = ai.send(messages, done, { runId: meta.runId, taskId: meta.taskId, snapshotKey: meta.snapshotKey, outputDisposition: meta.outputDisposition, sources: meta.sources, signal: meta.signal || signals.get(signalKey(meta)), onDelta: meta.onDelta }); if (result && typeof result.then === 'function') result.then(done, function () { done({ error: true }); }); } catch (e) { done({ error: true }); } }); };
    var lifecycle = typeof context.createActionRunDurable === 'function' && typeof context.completeActionRunDurable === 'function' && typeof context.failActionRunDurable === 'function'
      ? { createActionRun: context.createActionRunDurable, completeActionRun: context.completeActionRunDurable, failActionRun: context.failActionRunDurable }
      : typeof context.createActionRun === 'function' && typeof context.completeActionRun === 'function' && typeof context.failActionRun === 'function' ? { createActionRun: context.createActionRun, completeActionRun: context.completeActionRun, failActionRun: context.failActionRun } : null;
    var builtAdapter = adapterApi.withDependencies({ context: context, executor: executor, lifecycle: lifecycle });
    var adapter = { prepareContext: builtAdapter.prepareContext, create: builtAdapter.create, cancel: builtAdapter.cancel, isAdapterState: builtAdapter.isAdapterState, async execute(state, options) { options = options || {}; var key = signalKey(state); signals.set(key, options.signal); try { var out = await builtAdapter.execute(state, options); if (out && out.ok === true && out.draft && out.draft.__runtimeFailure) return fail(out.draft.__runtimeFailure, { clinicalActionRunId: out.clinicalActionRunId }); if (out && out.ok === false && out.reason === 'cancelled') return fail('ai-cancelled', { clinicalActionRunId: out.clinicalActionRunId }); if (out && out.ok === false && out.reason === 'executor-failed') return fail('ai-failed', { clinicalActionRunId: out.clinicalActionRunId }); return out; } finally { signals.delete(key); } } };
    return make({ workflow: workflow, adapter: adapter, executor: executor, defaultTimeoutMs: options.timeoutMs });
  }
  return Object.freeze({ withDependencies: make, fromGlobals: fromGlobals });
}));
