(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClinicalAgentRunStore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var KEY = 'clinicalAgentRuns.v1', DRAFT_KEY = 'clinicalAgentDrafts.v1', LIMIT = 60;
  var TASKS = ['countertransference-analysis', 'session-review', 'case-conceptualization', 'next-session-hypotheses', 'supervision-question-builder', 'multi-school-comparison', 'supervision-preview'];
  var STATUSES = ['planned', 'awaiting-context', 'awaiting-confirmation', 'running', 'draft-ready', 'adopted', 'persisted', 'cancelled', 'stale', 'failed'];
  var STEPS = ['context-builder', 'intent-classifier', 'supervision-router', 'evidence-validator', 'draft-orchestrator'];
  var ORIGIN_KEYS = ['clientId', 'sessionId', 'materialId', 'supervisionId'];
  function text(v) { return typeof v === 'string' ? v.trim() : ''; }
  function storeOf(candidate) { return candidate || (typeof Store !== 'undefined' ? Store : null); }
  function originOf(value) { var out = {}; ORIGIN_KEYS.forEach(function (key) { if (text(value && value[key])) out[key] = text(value[key]); }); return out; }
  function sameOrigin(left, right) { return ORIGIN_KEYS.every(function (key) { return text(left && left[key]) === text(right && right[key]); }); }
  function safeCode(value) { return ['ai-failed', 'ai-cancelled', 'executor-failed', 'execution-payload-failed', 'lifecycle-failed', 'run-persistence-failed', 'draft-persistence-failed', 'malformed-draft', 'output-evidence-missing', 'output-citation-not-admitted', 'stale-before', 'stale-after', 'stale-context', 'stale', 'failed', 'cancelled', 'timeout', 'user-cancelled', 'context-changed', 'page-hidden', 'request-save-failed', 'adapter-rejected'].indexOf(text(value)) >= 0 ? text(value) : ''; }
  function projection(run) {
    if (!run || TASKS.indexOf(run.taskId) < 0 || STATUSES.indexOf(run.status) < 0 || !text(run.runId)) return null;
    var p = { runId: text(run.runId), taskId: run.taskId, status: run.status, stepIds: (Array.isArray(run.stepIds) ? run.stepIds : []).filter(function (id) { return STEPS.indexOf(id) >= 0; }), snapshotKey: text(run.snapshotKey), outputDisposition: run.outputDisposition === 'draft' ? 'draft' : 'preview', origin: originOf(run.origin), sources: [], error: safeCode(run.error), cancellation: run.cancellation ? { reason: safeCode(run.cancellation.reason) || 'cancelled' } : null, updatedAt: text(run.updatedAt) || new Date().toISOString() };
    p.sources = (Array.isArray(run.sources) ? run.sources : []).map(function (source) {
      var out = {};
      ['id', 'kind', 'clientId', 'sessionId', 'normalizationVersion', 'sourceVersion', 'sourceContentHash', 'anchorContentHash', 'status'].forEach(function (key) { if (text(source && source[key])) out[key] = text(source[key]); });
      if (!out.sourceVersion && text(source && source.version)) out.sourceVersion = text(source.version);
      return out;
    }).filter(function (source) { return source.id && ['client', 'session', 'material', 'supervision'].indexOf(source.kind) >= 0; }).slice(0, 50);
    return p;
  }
  function rowsOf(value) { return value && Array.isArray(value.runs) ? value.runs : []; }
  async function list(candidate) {
    var store = storeOf(candidate);
    if (!store || typeof store._get !== 'function') return [];
    var rows = rowsOf(await store._get(KEY)).map(projection).filter(Boolean).slice(0, LIMIT);
    var drafts = rowsOf(await store._get(DRAFT_KEY));
    return rows.map(function (run) {
      var draft = drafts.find(function (row) { return row && row.runId === run.runId && row.snapshotKey === run.snapshotKey && sameOrigin(row.origin, run.origin); });
      if (draft && ['draft-ready', 'adopted', 'cancelled'].indexOf(draft.status) >= 0) run.status = draft.status;
      return run;
    });
  }
  async function save(run, candidate) {
    var next = projection(run), store = storeOf(candidate);
    if (!next || !store || typeof store._mutate !== 'function') return { ok: false, reason: 'store-unavailable' };
    try {
      next.updatedAt = new Date().toISOString();
      await store._mutate(KEY, function (value) { return { version: 1, runs: [next].concat(rowsOf(value).map(projection).filter(function (row) { return row && row.runId !== next.runId; })).slice(0, LIMIT) }; });
      return { ok: true, run: next };
    } catch (_) { return { ok: false, reason: 'run-persistence-failed' }; }
  }
  function fieldsOf(draft) {
    var parsed = draft;
    if (typeof draft === 'string') { try { parsed = JSON.parse(draft); } catch (_) {} }
    var fields = { facts: '', inferences: '', hypotheses: '' };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.keys(fields).forEach(function (key) { if (typeof parsed[key] === 'string') fields[key] = parsed[key]; });
    }
    if (!fields.facts && !fields.inferences && !fields.hypotheses) fields.inferences = typeof draft === 'string' ? draft : JSON.stringify(draft || '');
    return fields;
  }
  // 临床正文只保存在独立的本机草稿集合，运行历史始终是元数据。
  async function saveRequest(run, question, candidate) {
    var store = storeOf(candidate), meta = projection(run);
    if (!meta || typeof question !== 'string' || !store || !store._mutate) return { ok: false, reason: 'invalid-request' };
    try {
      await store._mutate(DRAFT_KEY, function (value) {
        var rows = rowsOf(value).filter(function (row) { return row && row.runId !== meta.runId; });
        rows.unshift({ runId: meta.runId, snapshotKey: meta.snapshotKey, origin: meta.origin, question: question.slice(0, 24000), status: 'awaiting-confirmation' });
        return { version: 1, runs: rows.slice(0, LIMIT) };
      });
      return { ok: true };
    } catch (_) { return { ok: false, reason: 'draft-persistence-failed' }; }
  }
  async function saveDraft(run, candidate) {
    var store = storeOf(candidate), meta = projection(run);
    if (!meta || run.status !== 'draft-ready' || !store || !store._mutate) return { ok: false, reason: 'invalid-draft' };
    try {
      var document;
      await store._mutate(DRAFT_KEY, function (value) {
        var previous = rowsOf(value).find(function (row) { return row && row.runId === meta.runId; });
        document = { runId: meta.runId, taskId: meta.taskId, origin: meta.origin, snapshotKey: meta.snapshotKey, status: 'draft-ready', fields: fieldsOf(run.draft), question: previous && text(previous.question) || '', updatedAt: new Date().toISOString() };
        return { version: 1, runs: [document].concat(rowsOf(value).filter(function (row) { return row && row.runId !== meta.runId; })).slice(0, LIMIT) };
      });
      return { ok: true, draft: document };
    } catch (_) { return { ok: false, reason: 'draft-persistence-failed' }; }
  }
  async function getRequest(runId, candidate) {
    var store = storeOf(candidate);
    if (!store || !store._get) return null;
    var row = rowsOf(await store._get(DRAFT_KEY)).find(function (item) { return item && item.runId === text(runId); });
    return row && typeof row.question === 'string' && row.status !== 'cancelled' ? { question: row.question, origin: originOf(row.origin), snapshotKey: text(row.snapshotKey) } : null;
  }
  async function getDraft(runId, candidate) {
    var store = storeOf(candidate);
    if (!store || !store._get) return null;
    var row = rowsOf(await store._get(DRAFT_KEY)).find(function (item) { return item && item.runId === text(runId); });
    if (!row || ['draft-ready', 'adopted'].indexOf(row.status) < 0 || !row.fields) return null;
    return { runId: row.runId, status: row.status, fields: fieldsOf(row.fields), question: text(row.question), origin: originOf(row.origin), snapshotKey: text(row.snapshotKey) };
  }
  async function updateDraft(runId, fields, action, expected, candidate) {
    var store = storeOf(candidate);
    if (!store || !store._mutate || ['save', 'adopt', 'discard'].indexOf(action) < 0 || !expected) return { ok: false, reason: 'invalid-draft-action' };
    var result;
    try {
      await store._mutate(DRAFT_KEY, function (value) {
        var rows = rowsOf(value), current = rows.find(function (row) { return row && row.runId === text(runId); });
        if (!current || !current.fields || !sameOrigin(current.origin, expected.origin) || current.snapshotKey !== expected.snapshotKey || ['draft-ready', 'adopted'].indexOf(current.status) < 0) throw new Error('draft-context-mismatch');
        result = Object.assign({}, current, { fields: action === 'discard' ? null : fieldsOf(fields), question: action === 'discard' ? '' : current.question, status: action === 'adopt' ? 'adopted' : action === 'discard' ? 'cancelled' : 'draft-ready', updatedAt: new Date().toISOString() });
        return { version: 1, runs: rows.map(function (row) { return row === current ? result : row; }) };
      });
      return { ok: true, draft: result };
    } catch (_) { return { ok: false, reason: 'draft-save-failed' }; }
  }
  function get(runId, candidate) { return list(candidate).then(function (rows) { return rows.find(function (row) { return row.runId === text(runId); }) || null; }); }
  function isResumable(run) { return !!run && ['planned', 'awaiting-context', 'awaiting-confirmation', 'running'].indexOf(run.status) >= 0; }
  function resumable(candidate) { return list(candidate).then(function (rows) { return rows.filter(isResumable); }); }
  return Object.freeze({ KEY: KEY, DRAFT_KEY: DRAFT_KEY, project: projection, sameOrigin: sameOrigin, fieldsOf: fieldsOf, save: save, get: get, list: list, resumable: resumable, isResumable: isResumable, saveRequest: saveRequest, getRequest: getRequest, saveDraft: saveDraft, getDraft: getDraft, updateDraft: updateDraft });
}));
