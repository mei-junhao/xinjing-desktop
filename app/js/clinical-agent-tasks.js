(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClinicalAgentTasks = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EFFECTS = Object.freeze(['read', 'retrieve-sensitive', 'draft', 'durable-write', 'export', 'external-send', 'destructive', 'config']);
  var OUTPUT_DISPOSITIONS = Object.freeze(['preview', 'draft']);
  var SOURCE_KINDS = Object.freeze(['client', 'session', 'material', 'supervision']);
  var TASK_ROWS = [
    ['countertransference-analysis', ['session', 'supervision'], ['session'], ['themes', 'countertransference-signals', 'questions'], 'retrieve-sensitive'],
    ['session-review', ['session', 'material'], ['session'], ['summary', 'observations', 'open-questions'], 'retrieve-sensitive'],
    ['case-conceptualization', ['client', 'session', 'material'], ['client'], ['formulation', 'evidence', 'uncertainties'], 'draft'],
    ['next-session-hypotheses', ['client', 'session', 'material'], ['session'], ['hypotheses', 'signals-to-check', 'questions'], 'draft'],
    ['supervision-question-builder', ['client', 'session', 'material', 'supervision'], ['supervision'], ['context', 'questions', 'rationale'], 'draft'],
    ['multi-school-comparison', ['client', 'session', 'material', 'supervision'], ['supervision'], ['school-lenses', 'comparison', 'questions'], 'draft'],
    ['supervision-preview', ['client', 'session', 'material', 'supervision'], [], ['overall-impression', 'evidence', 'questions'], 'draft', true]
  ];

  function freezeTask(row) {
    return Object.freeze({
      id: row[0],
      allowedSourceKinds: Object.freeze(row[1].slice()),
      requiredSourceKinds: Object.freeze(row[2].slice()),
      outputSections: Object.freeze(row[3].slice()),
      effect: row[4],
      outputDispositions: OUTPUT_DISPOSITIONS,
      confirmationBoundary: 'human-confirmation-before-durable-write',
      previewFirst: true,
      allowEmptySources: row[5] === true
    });
  }
  var TASKS = Object.freeze(TASK_ROWS.reduce(function (all, row) { all[row[0]] = freezeTask(row); return all; }, Object.create(null)));

  function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function fail(reason, extra) { return Object.freeze(Object.assign({ ok: false, reason: reason }, extra || {})); }
  function pass(value) { return Object.freeze(Object.assign({ ok: true }, value || {})); }
  function task(taskId) { return text(taskId) && hasOwn(TASKS, taskId) ? TASKS[taskId] : null; }
  function validEffect(effect) { return typeof effect === 'string' && EFFECTS.indexOf(effect) >= 0; }

  function validateSources(spec, sources, context) {
    context = context && typeof context === 'object' ? context : {};
    if (context.snapshotStale === true || context.stale === true || (context.snapshot && context.snapshot.stale === true)) return fail('stale-snapshot');
    if (!Array.isArray(sources)) return fail('required-source-missing');
    var unbound = !text(context.clientId) && !text(context.sessionId) && !(context.origin && (text(context.origin.clientId) || text(context.origin.sessionId) || text(context.origin.materialId) || text(context.origin.supervisionId)));
    if (sources.length === 0) return spec.allowEmptySources && unbound ? pass() : fail('required-source-missing');
    var seen = Object.create(null);
    var sourceClientIds = Object.create(null);
    var distinctClientIds = [];
    for (var i = 0; i < sources.length; i += 1) {
      var source = sources[i];
      if (!source || typeof source !== 'object' || Array.isArray(source)) return fail('malformed-source', { index: i });
      var kind = text(source.kind);
      if (SOURCE_KINDS.indexOf(kind) < 0 || spec.allowedSourceKinds.indexOf(kind) < 0) return fail('source-kind-not-allowed', { index: i });
      if (!text(source.id)) return fail('source-id-missing', { index: i });
      if (seen[source.id]) return fail('duplicate-source', { index: i });
      seen[source.id] = true;
      if (source.stale === true || source.isStale === true || text(source.status).toLowerCase() === 'stale') return fail('stale-snapshot', { index: i });
      if (context.clientId && text(source.clientId) !== text(context.clientId)) return fail('cross-client-source-mismatch', { index: i });
      if (!context.clientId && text(source.clientId) && !sourceClientIds[text(source.clientId)]) {
        sourceClientIds[text(source.clientId)] = true;
        distinctClientIds.push(text(source.clientId));
      }
      if (context.sessionId && text(source.sessionId) !== text(context.sessionId)) return fail('cross-session-source-mismatch', { index: i });
    }
    if (!context.clientId && distinctClientIds.length > 1) return fail('cross-client-source-mismatch');
    for (i = 0; i < spec.requiredSourceKinds.length; i += 1) {
      if (!sources.some(function (source) { return source && source.kind === spec.requiredSourceKinds[i]; })) return fail('required-source-missing', { kind: spec.requiredSourceKinds[i] });
    }
    return pass();
  }

  function validate(taskId, request) {
    var spec = task(taskId);
    if (!spec) return fail('unknown-task');
    if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('malformed-request');
    if (!validEffect(request.effect)) return fail('unknown-effect');
    if (request.effect !== spec.effect) return fail('effect-mismatch');
    if (OUTPUT_DISPOSITIONS.indexOf(request.outputDisposition) < 0) return fail('invalid-output-disposition');
    if (request.outputDisposition !== 'preview' && request.outputDisposition !== 'draft') return fail('invalid-output-disposition');
    if (request.confirmed === true && request.effect === 'durable-write') return fail('confirmation-boundary');
    var sourceResult = validateSources(spec, request.sources, request.context);
    return sourceResult.ok ? pass({ task: spec }) : sourceResult;
  }

  function project(taskId) {
    var spec = task(taskId);
    if (!spec) return null;
    return Object.freeze({
      taskId: spec.id,
      effect: spec.effect,
      risk: spec.effect === 'retrieve-sensitive' ? 'sensitive-read' : 'draft',
      sourceRequirements: Object.freeze({ allowedKinds: spec.allowedSourceKinds, requiredKinds: spec.requiredSourceKinds }),
      outputSections: spec.outputSections,
      outputDispositions: spec.outputDispositions,
      confirmationBoundary: spec.confirmationBoundary,
      previewFirst: spec.previewFirst
    });
  }

  return Object.freeze({
    EFFECTS: EFFECTS,
    TASKS: TASKS,
    getTask: function (taskId) { return task(taskId); },
    listTaskIds: function () { return Object.keys(TASKS); },
    validate: validate,
    validateSources: function (taskId, sources, context) { var spec = task(taskId); return spec ? validateSources(spec, sources, context) : fail('unknown-task'); },
    project: project
  });
}));
