(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClinicalAgentRun = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var STATUSES = Object.freeze(['planned', 'awaiting-context', 'awaiting-confirmation', 'running', 'draft-ready', 'stale', 'failed', 'cancelled', 'adopted', 'persisted']);
  var TERMINAL = Object.freeze(['persisted', 'stale', 'failed', 'cancelled']);
  var EDGES = Object.freeze({
    planned: Object.freeze(['awaiting-context', 'awaiting-confirmation', 'running', 'cancelled', 'failed']),
    'awaiting-context': Object.freeze(['awaiting-confirmation', 'running', 'cancelled', 'failed']),
    'awaiting-confirmation': Object.freeze(['running', 'cancelled', 'stale', 'failed']),
    running: Object.freeze(['draft-ready', 'stale', 'failed', 'cancelled']),
    'draft-ready': Object.freeze(['adopted', 'stale', 'cancelled', 'failed']),
    adopted: Object.freeze(['persisted', 'stale']),
    persisted: Object.freeze([]), stale: Object.freeze([]), failed: Object.freeze([]), cancelled: Object.freeze([])
  });
  var STEP_KEYS = Object.freeze(['stepId', 'status', 'task', 'effect', 'startedAt', 'completedAt', 'errorCode', 'retryable']);
  var OUTPUT_DISPOSITIONS = Object.freeze(['preview', 'draft']);
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : ''; }
  function clone(v) { if (Array.isArray(v)) return v.map(clone); if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = clone(v[k]); }); return o; } return v; }
  function deepFreeze(v) { if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v; Object.keys(v).forEach(function (k) { deepFreeze(v[k]); }); return Object.freeze(v); }
  function cleanMeta(input) {
    var out = {};
    ['origin', 'snapshotKey', 'stepId', 'error', 'cancellation'].forEach(function (k) { if (own(input, k) && input[k] !== undefined) out[k] = clone(input[k]); });
    if (input.outputDisposition !== undefined) { if (OUTPUT_DISPOSITIONS.indexOf(input.outputDisposition) < 0) throw new TypeError('invalid output disposition'); out.outputDisposition = input.outputDisposition; }
    if (own(input, 'sources')) { if (!Array.isArray(input.sources)) throw new TypeError('sources must be an array'); out.sources = input.sources.map(function (s) { if (!s || typeof s !== 'object' || Array.isArray(s)) throw new TypeError('invalid source'); var x = {}; ['id', 'kind', 'version', 'contentHash', 'anchorContentHash', 'status'].forEach(function (k) { if (own(s, k)) x[k] = clone(s[k]); }); if (!str(x.id)) throw new TypeError('source id required'); return x; }); }
    return out;
  }
  function create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !str(input.runId) || !str(input.taskId)) throw new TypeError('runId and taskId required');
    var status = input.status === undefined ? 'planned' : input.status;
    if (status !== 'planned' && status !== 'awaiting-context') throw new TypeError('invalid initial status');
    var run = { runId: str(input.runId), taskId: str(input.taskId), status: status, steps: [], metadata: cleanMeta(Object.assign({ outputDisposition: 'preview' }, input)) };
    return deepFreeze(run);
  }
  function canTransition(from, to) { return !!(EDGES[from] && EDGES[from].indexOf(to) >= 0); }
  function transition(run, nextStatus, patch) {
    if (!run || typeof run !== 'object' || !STATUSES.includes(nextStatus) || !canTransition(run.status, nextStatus)) throw new Error('illegal-transition');
    if (nextStatus === 'persisted' && run.status !== 'adopted') throw new Error('persisted-requires-adopted');
    if (nextStatus === 'adopted' && run.status !== 'draft-ready') throw new Error('adopted-requires-draft-ready');
    var p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    var metadata = Object.assign({}, clone(run.metadata), cleanMeta(p));
    if (nextStatus === 'draft-ready' && OUTPUT_DISPOSITIONS.indexOf(metadata.outputDisposition) < 0) metadata.outputDisposition = 'draft';
    if (nextStatus === 'stale' && !own(metadata, 'error') && !own(metadata, 'cancellation')) metadata.error = 'stale';
    if (nextStatus === 'cancelled' && !own(metadata, 'cancellation')) metadata.cancellation = { reason: 'cancelled' };
    return deepFreeze({ runId: run.runId, taskId: run.taskId, status: nextStatus, steps: run.steps.map(clone), metadata: metadata });
  }
  function appendStep(run, step) {
    if (!run || typeof run !== 'object' || !step || typeof step !== 'object' || Array.isArray(step) || !str(step.stepId) || !STATUSES.includes(step.status)) throw new TypeError('invalid step');
    var keys = Object.keys(step); for (var i = 0; i < keys.length; i += 1) if (STEP_KEYS.indexOf(keys[i]) < 0) throw new TypeError('step metadata only');
    var item = {}; STEP_KEYS.forEach(function (k) { if (own(step, k)) item[k] = clone(step[k]); });
    return deepFreeze({ runId: run.runId, taskId: run.taskId, status: run.status, steps: run.steps.concat([item]), metadata: clone(run.metadata) });
  }
  function project(run) {
    if (!run || typeof run !== 'object') throw new TypeError('run required');
    return deepFreeze({ runId: run.runId, taskId: run.taskId, status: run.status, stepIds: run.steps.map(function (s) { return s.stepId; }), origin: clone(run.metadata.origin), sources: clone(run.metadata.sources), snapshotKey: clone(run.metadata.snapshotKey), stepId: clone(run.metadata.stepId), error: clone(run.metadata.error), cancellation: clone(run.metadata.cancellation), outputDisposition: run.metadata.outputDisposition, terminal: TERMINAL.indexOf(run.status) >= 0 });
  }
  return Object.freeze({ STATUSES: STATUSES, create: create, transition: transition, appendStep: appendStep, project: project, canTransition: canTransition });
}));
