(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./clinical-agent-tasks.js'), require('./clinical-agent-run.js'));
  else root.ClinicalAgentContextBridge = factory(root.ClinicalAgentTasks, root.ClinicalAgentRun);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ClinicalAgentTasks, ClinicalAgentRun) {
  'use strict';
  function frozen(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.keys(value).forEach(function (key) { frozen(value[key]); }); return Object.freeze(value); }
  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function fail(reason, extra) { return frozen(Object.assign({ ok: false, reason: reason }, extra || {})); }
  function sourceMeta(sources) { return sources.map(function (source) { return frozen({ kind: text(source.kind), id: text(source.id) }); }); }
  function safeOrigin(origin) { var out = {}; if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return out; ['clientId', 'sessionId', 'materialId', 'supervisionId'].forEach(function (key) { if (text(origin[key])) out[key] = text(origin[key]); }); return out; }
  function makeBridge(tasks, runs) {
    if (!tasks || typeof tasks.validate !== 'function' || typeof tasks.getTask !== 'function') throw new Error('clinical-agent-tasks dependency required');
    if (!runs || typeof runs.create !== 'function' || typeof runs.transition !== 'function') throw new Error('clinical-agent-run dependency required');
    function project(value) {
      if (!value || typeof value !== 'object') return fail('invalid-admission');
      var sources = Array.isArray(value.sources) ? value.sources : value.metadata && Array.isArray(value.metadata.sources) ? value.metadata.sources : [];
      return frozen({ ok: true, runId: text(value.runId), taskId: text(value.taskId), status: text(value.status), effect: text(value.effect), risk: text(value.risk), sources: sourceMeta(sources), requiredKinds: Object.freeze((value.requiredKinds || []).slice()), snapshotKey: text(value.snapshotKey), confirmationBoundary: text(value.confirmationBoundary), previewFirst: value.previewFirst === true });
    }
    function admit(routeResult, input) {
      if (!routeResult || routeResult.ok !== true || !text(routeResult.taskId)) return fail('intent-unclear');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('malformed-request');
      var runId = text(input.runId), snapshotKey = text(input.snapshotKey);
      if (!runId) return fail('run-id-missing');
      if (!snapshotKey) return fail('snapshot-key-missing');
      var task = tasks.getTask(routeResult.taskId);
      if (!task) return fail('unknown-task');
      var validation = tasks.validate(routeResult.taskId, { effect: task.effect, outputDisposition: 'preview', sources: input.sources, context: Object.assign({}, input.context || {}, { origin: input.origin }) });
      if (!validation || validation.ok !== true) return fail(validation && validation.reason || 'invalid-context', validation && { index: validation.index, kind: validation.kind });
      try {
        var origin = safeOrigin(input.origin);
        var run = runs.create({ runId: runId, taskId: routeResult.taskId, status: 'planned', outputDisposition: 'preview', snapshotKey: snapshotKey, origin: origin, sources: input.sources });
        run = runs.transition(run, 'awaiting-confirmation', { outputDisposition: 'preview', snapshotKey: snapshotKey, origin: origin, sources: input.sources });
        return frozen({ ok: true, runId: run.runId, taskId: run.taskId, status: run.status, effect: task.effect, risk: task.effect === 'retrieve-sensitive' ? 'sensitive-read' : 'draft', sources: sourceMeta(input.sources), requiredKinds: task.requiredSourceKinds.slice(), snapshotKey: snapshotKey, confirmationBoundary: task.confirmationBoundary, previewFirst: task.previewFirst === true });
      } catch (error) { return fail('run-creation-failed'); }
    }
    function isAdmissible(admission) { return !!(admission && admission.ok === true && admission.status === 'awaiting-confirmation' && text(admission.runId) && text(admission.taskId) && text(admission.snapshotKey) && Array.isArray(admission.sources) && admission.previewFirst === true); }
    return { admit: admit, project: project, isAdmissible: isAdmissible, withDependencies: makeBridge };
  }
  return makeBridge(ClinicalAgentTasks, ClinicalAgentRun);
}));
