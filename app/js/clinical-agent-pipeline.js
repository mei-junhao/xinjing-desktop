(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./clinical-agent-router.js'));
  else root.ClinicalAgentPipeline = factory(root.ClinicalAgentRouter);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Router) {
  'use strict';
  function text(v) { return typeof v === 'string' ? v.trim() : ''; }
  function fail(reason, extra) { return Object.freeze(Object.assign({ ok: false, reason: reason }, extra || {})); }
  function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.keys(value).forEach(function (key) { freeze(value[key]); }); return Object.freeze(value); }
  function create(options) {
    options = options || {};
    var bridge = options.bridge, router = options.router || Router;
    if (!bridge || typeof bridge.prepareContext !== 'function' || typeof bridge.prepare !== 'function' || typeof bridge.confirm !== 'function' || typeof bridge.execute !== 'function' || !router || typeof router.route !== 'function') throw new Error('pipeline dependencies required');
    function prepare(request) {
      request = request && typeof request === 'object' ? request : {};
      var route = router.route(request.text, { sources: [] });
      if (!route || route.ok !== true) return fail(route && route.reason || 'intent-unclear');
      var steps = [
        { id: 'context-builder', status: 'ready' },
        { id: 'intent-classifier', status: 'ready' },
        { id: 'supervision-router', status: 'ready' },
        { id: 'evidence-validator', status: 'pending' },
        { id: 'draft-orchestrator', status: 'pending' }
      ];
      var token = bridge.prepareContext(Object.assign({}, request, { taskId: route.taskId, snapshotKey: 'pending' }));
      if (!token || token.ok !== true) return fail(token && token.reason || 'context-build-failed', { taskId: route.taskId, steps: steps });
      steps[3].status = 'ready';
      var prepared = bridge.prepare(Object.assign({}, request, { text: request.text, taskId: route.taskId, runId: token.runId || request.runId, snapshotKey: token.snapshotKey, sources: token.sources || [], origin: request.selection || request.origin || {} }), token);
      if (!prepared || prepared.ok !== true) return fail(prepared && prepared.reason || 'workflow-rejected', { taskId: route.taskId, steps: steps });
      steps[4].status = 'awaiting-confirmation';
      return freeze({ ok: true, taskId: prepared.taskId, runId: prepared.runId, snapshotKey: prepared.snapshotKey, sources: prepared.sources, prepared: prepared, token: token, steps: steps });
    }
    function confirm(plan) {
      if (!plan || plan.ok !== true || !plan.prepared) return fail('invalid-pipeline-plan');
      var confirmed = bridge.confirm(plan.prepared, { confirmed: true });
      if (!confirmed || confirmed.ok === false) return fail(confirmed && confirmed.reason || 'confirmation-required');
      return freeze(Object.assign({}, plan, { confirmed: confirmed, steps: plan.steps.map(function (step) { return step.id === 'draft-orchestrator' ? { id: step.id, status: 'running' } : step; }) }));
    }
    function execute(plan, options) {
      if (!plan || plan.ok !== true || !plan.confirmed) return Promise.resolve(fail('invalid-pipeline-plan'));
      return Promise.resolve(bridge.execute(plan.confirmed, options || {})).then(function (result) {
        if (!result || result.ok !== true) return result;
        return freeze(Object.assign({}, result, { pipelineSteps: plan.steps.map(function (step) { return step.id === 'draft-orchestrator' ? { id: step.id, status: 'completed' } : step; }) }));
      });
    }
    return Object.freeze({ prepare: prepare, confirm: confirm, execute: execute });
  }
  return Object.freeze({ create: create });
}));
