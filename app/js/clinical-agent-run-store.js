(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClinicalAgentRunStore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var KEY = 'clinicalAgentRuns.v1';
  var LIMIT = 60;
  function text(v) { return typeof v === 'string' ? v.trim() : ''; }
  function storeOf(candidate) {
    if (candidate && typeof candidate._get === 'function' && typeof candidate._mutate === 'function') return candidate;
    if (typeof Store !== 'undefined' && Store && typeof Store._get === 'function' && typeof Store._mutate === 'function') return Store;
    return null;
  }
  function projection(run) {
    if (!run || typeof run !== 'object') return null;
    var p = { runId: text(run.runId), taskId: text(run.taskId), status: text(run.status), stepIds: Array.isArray(run.stepIds) ? run.stepIds.map(text).filter(Boolean).slice(0, 50) : [], snapshotKey: text(run.snapshotKey), outputDisposition: text(run.outputDisposition), origin: {}, sources: [], error: text(run.error), cancellation: run.cancellation && typeof run.cancellation === 'object' ? { reason: text(run.cancellation.reason) } : null, updatedAt: new Date().toISOString() };
    var origin = run.origin && typeof run.origin === 'object' ? run.origin : {};
    ['clientId', 'sessionId', 'materialId', 'supervisionId'].forEach(function (key) { if (text(origin[key])) p.origin[key] = text(origin[key]); });
    p.sources = (Array.isArray(run.sources) ? run.sources : []).map(function (source) { return { id: text(source && source.id), kind: text(source && source.kind), status: text(source && source.status), version: text(source && (source.version || source.sourceVersion)) }; }).filter(function (source) { return source.id && source.kind; }).slice(0, 50);
    return p.runId && p.taskId ? p : null;
  }
  function list(candidate) {
    var store = storeOf(candidate);
    if (!store) return Promise.resolve([]);
    return Promise.resolve(store._get(KEY)).then(function (value) { var rows = value && Array.isArray(value.runs) ? value.runs : []; return rows.filter(function (row) { return row && row.runId && row.taskId; }).slice(0, LIMIT); });
  }
  function save(run, candidate) {
    var next = projection(run), store = storeOf(candidate);
    if (!next || !store) return Promise.resolve({ ok: false, reason: 'store-unavailable' });
    return store._mutate(KEY, function (value) { var rows = value && Array.isArray(value.runs) ? value.runs.filter(function (row) { return row && row.runId !== next.runId; }) : []; rows.unshift(next); return { version: 1, runs: rows.slice(0, LIMIT) }; }).then(function () { return { ok: true, run: next }; });
  }
  function get(runId, candidate) { return list(candidate).then(function (rows) { return rows.find(function (row) { return row.runId === text(runId); }) || null; }); }
  function resumable(candidate) { return list(candidate).then(function (rows) { return rows.filter(function (row) { return ['persisted', 'failed', 'cancelled', 'stale'].indexOf(row.status) < 0; }); }); }
  return Object.freeze({ KEY: KEY, project: projection, save: save, get: get, list: list, resumable: resumable });
}));
