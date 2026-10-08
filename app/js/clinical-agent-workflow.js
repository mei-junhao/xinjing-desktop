(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./clinical-agent-router.js'), require('./clinical-agent-context-bridge.js'), require('./clinical-agent-run.js'));
  else root.ClinicalAgentWorkflow = factory(root.ClinicalAgentRouter, root.ClinicalAgentContextBridge, root.ClinicalAgentRun);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Router, Bridge, Runs) {
  'use strict';
  var ENABLED = { 'countertransference-analysis': true, 'session-review': true, 'case-conceptualization': true, 'next-session-hypotheses': true, 'supervision-question-builder': true, 'multi-school-comparison': true, 'supervision-preview': true };
  var TERMINAL = { 'draft-ready': true, stale: true, failed: true, cancelled: true };
  function text(v) { return typeof v === 'string' ? v.trim() : ''; }
  function freeze(v) { if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v; Object.keys(v).forEach(function (k) { freeze(v[k]); }); return Object.freeze(v); }
  function fail(reason, extra) { return freeze(Object.assign({ ok: false, reason: reason }, extra || {})); }
  function cleanSource(s) { return { id: text(s && s.id), kind: text(s && s.kind) }; }
  function safeSources(list) { return Array.isArray(list) ? list.map(cleanSource) : []; }
  function projection(state) { if (!state || typeof state !== 'object') throw new TypeError('workflow state required'); return freeze({ ok: true, runId: state.runId, taskId: state.taskId, status: state.status, snapshotKey: state.snapshotKey, sources: safeSources(state.sources), outputDisposition: state.outputDisposition, reason: state.reason }); }
  function isWorkflowState(v) { return !!(v && typeof v === 'object' && text(v.runId) && text(v.taskId) && text(v.status) && Array.isArray(v.sources)); }
  function make(deps) {
    deps = deps || {};
    var router = deps.router || Router, bridge = deps.bridge || Bridge, runs = deps.runs || Runs;
    var runStore = deps.runStore || (typeof globalThis !== 'undefined' ? globalThis.ClinicalAgentRunStore : null);
    var states = typeof WeakMap === 'function' ? new WeakMap() : new Map();
    var writes = new Map();
    if (!router || typeof router.route !== 'function' || !bridge || typeof bridge.admit !== 'function' || !runs || typeof runs.create !== 'function' || typeof runs.transition !== 'function') throw new Error('workflow dependencies required');
    function persist(run) {
      if (!runStore || typeof runStore.save !== 'function' || !run) return;
      var previous = writes.get(run.runId) || Promise.resolve({ ok: true });
      var pending = previous.then(function () {
        return runStore.save(runs.project(run));
      }).then(function (result) { return result && result.ok === true ? { ok: true } : fail('run-persistence-failed'); }, function () { return fail('run-persistence-failed'); });
      writes.set(run.runId, pending);
    }
    function waitForPersistence(state) { return writes.get(state && state.runId) || Promise.resolve({ ok: true }); }
    function failure(state, reason, target) { var run = states.get(state); var status = target || 'failed'; if (run && run.status !== status) run = runs.transition(run, status, { error: reason }); var out = freeze(Object.assign({}, state, { ok: false, reason: reason, status: status })); states.delete(state); if (run) { states.set(out, run); persist(run); } return out; }
    function prepare(request) { if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('malformed-request'); var route = router.route(request.text, { sources: request.sources }); if (!route || route.ok !== true) return fail(route && route.reason || 'intent-unclear'); if (!ENABLED[route.taskId]) return fail('workflow-task-not-enabled'); var admitted = bridge.admit(route, request); if (!admitted || admitted.ok !== true) return fail(admitted && admitted.reason || 'context-not-admitted'); var run = runs.create({ runId: admitted.runId, taskId: admitted.taskId, status: 'planned', outputDisposition: 'preview', snapshotKey: admitted.snapshotKey, origin: request.origin, sources: request.sources }); if (typeof runs.appendStep === 'function') (request.stepIds || []).forEach(function (id) { run = runs.appendStep(run, { stepId: id, status: 'planned' }); }); run = runs.transition(run, 'awaiting-confirmation', { outputDisposition: 'preview', snapshotKey: admitted.snapshotKey }); var out = projection(Object.assign({}, admitted, { outputDisposition: 'preview' })); states.set(out, run); persist(run); return out; }
    function confirm(prepared, confirmation) { if (!isWorkflowState(prepared) || prepared.status !== 'awaiting-confirmation') return fail('invalid-prepared-state'); if (!confirmation || confirmation.confirmed !== true) return fail('confirmation-required'); var run = states.get(prepared); if (!run) return fail('invalid-prepared-state'); run = runs.transition(run, 'running', { outputDisposition: 'draft' }); var out = freeze(Object.assign({}, prepared, { ok: true, status: 'running', outputDisposition: 'draft' })); states.delete(prepared); states.set(out, run); persist(run); return out; }
    function settle(state, nextStatus, reason) {
      if (!isWorkflowState(state) || !states.has(state)) return fail('invalid-workflow-state');
      if (['draft-ready', 'stale', 'failed', 'cancelled'].indexOf(nextStatus) < 0) return fail('invalid-terminal-status');
      var run = states.get(state);
      if (!run || run.status !== 'running') return projection(state);
      run = runs.transition(run, nextStatus, nextStatus === 'draft-ready' ? { outputDisposition: 'draft' } : { error: text(reason) || nextStatus });
      var out = freeze(Object.assign({}, state, { ok: nextStatus === 'draft-ready', status: nextStatus, outputDisposition: nextStatus === 'draft-ready' ? 'draft' : state.outputDisposition, reason: text(reason) || undefined }));
      states.delete(state); states.set(out, run); persist(run); return out;
    }
    async function execute(confirmed, adapters) { if (!isWorkflowState(confirmed) || confirmed.status !== 'running' || !states.has(confirmed)) return fail('invalid-confirmed-state'); adapters = adapters || {}; if (typeof adapters.getExecutionPayload !== 'function' || typeof adapters.executeDraft !== 'function') return fail('execution-adapter-required'); if (typeof adapters.isFresh !== 'function') return fail('freshness-adapter-required'); if (adapters.isCancelled && adapters.isCancelled()) return failure(confirmed, 'cancelled', 'cancelled'); var payload; try { payload = await adapters.getExecutionPayload(confirmed); } catch (e) { return failure(confirmed, 'execution-payload-failed', 'failed'); } if (!payload || typeof payload !== 'object' || payload.runId !== confirmed.runId || payload.snapshotKey !== confirmed.snapshotKey) return failure(confirmed, 'stale-context', 'stale'); if (!adapters.isFresh(payload, confirmed)) return failure(confirmed, 'stale-context', 'stale'); if (adapters.isCancelled && adapters.isCancelled()) return failure(confirmed, 'cancelled', 'cancelled'); var draft; try { draft = await adapters.executeDraft(payload, confirmed); } catch (e2) { return failure(confirmed, 'executor-failed', 'failed'); } if (adapters.isCancelled && adapters.isCancelled()) return failure(confirmed, 'cancelled', 'cancelled'); if (!adapters.isFresh(payload, confirmed)) return failure(confirmed, 'stale-context', 'stale'); if (draft === undefined || draft === null || (typeof draft !== 'string' && (typeof draft !== 'object' || Array.isArray(draft)))) return failure(confirmed, 'malformed-draft', 'failed'); var run = states.get(confirmed); run = runs.transition(run, 'draft-ready', { outputDisposition: 'draft' }); var out = freeze({ ok: true, runId: confirmed.runId, taskId: confirmed.taskId, status: 'draft-ready', snapshotKey: confirmed.snapshotKey, sources: safeSources(confirmed.sources), outputDisposition: 'draft', draft: draft }); states.delete(confirmed); states.set(out, run); persist(run); return out; }
    function cancel(state, reason) { if (!isWorkflowState(state) || !states.has(state)) return fail('invalid-workflow-state'); if (TERMINAL[state.status]) return projection(state); return failure(state, text(reason) || 'cancelled', 'cancelled'); }
    return Object.freeze({ prepare: prepare, confirm: confirm, execute: execute, settle: settle, waitForPersistence: waitForPersistence, cancel: cancel, project: projection, isWorkflowState: isWorkflowState, listPersisted: function () { return runStore && typeof runStore.list === 'function' ? runStore.list() : Promise.resolve([]); }, resumable: function () { return runStore && typeof runStore.resumable === 'function' ? runStore.resumable() : Promise.resolve([]); } });
  }
  var api = make(); return Object.freeze(Object.assign({}, api, { withDependencies: make }));
}));
