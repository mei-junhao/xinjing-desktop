'use strict';
/*
 * 4.3 clinical task projection. This module is deliberately in-memory only:
 * it does not know about Store, IPC, entitlements, or clinical body content.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ClinicalTaskViewModel = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var STATUSES = Object.freeze({
    AI_DRAFT: 'ai-draft',
    OPEN: 'open',
    DONE: 'done',
    CANCELLED: 'cancelled'
  });
  var STATUS_SET = Object.freeze({
    'ai-draft': true,
    open: true,
    done: true,
    cancelled: true
  });
  var BODY_KEYS = Object.freeze({
    body: true,
    content: true,
    clinicalBody: true,
    clinical_body: true,
    transcript: true,
    rawContent: true,
    raw_content: true
  });

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { freeze(value[key]); });
    return Object.freeze(value);
  }

  function result(ok, value, code) {
    return freeze(ok ? { ok: true, value: value } : { ok: false, code: code || 'invalid-task' });
  }

  function hasBodyKey(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.keys(value).some(function (key) {
      return BODY_KEYS[key] || hasBodyKey(value[key]);
    });
  }

  function sourceRefs(value) {
    if (!Array.isArray(value) || value.length === 0) return null;
    var refs = value.map(function (ref) {
      if (typeof ref === 'string') return ref.trim();
      if (ref && typeof ref.id === 'string') return ref.id.trim();
      return '';
    });
    return refs.every(Boolean) ? refs : null;
  }

  function normalize(input) {
    if (!input || typeof input !== 'object' || hasBodyKey(input)) return result(false, null, 'body-field-forbidden');
    var status = String(input.status || '');
    if (!STATUS_SET[status]) return result(false, null, 'unknown-status');
    var refs = sourceRefs(input.sourceRefs);
    if (!refs) return result(false, null, 'source-refs-required');
    var required = ['id', 'clientId', 'originSessionId', 'title', 'createdBy', 'target'];
    for (var i = 0; i < required.length; i++) {
      if (typeof input[required[i]] !== 'string' || !input[required[i]].trim()) return result(false, null, 'required-field:' + required[i]);
    }
    var task = {
      id: input.id.trim(),
      clientId: input.clientId.trim(),
      originSessionId: input.originSessionId.trim(),
      title: input.title.trim(),
      status: status,
      due: typeof input.due === 'string' ? input.due : '',
      sourceRefs: refs,
      target: input.target.trim(),
      createdBy: input.createdBy.trim(),
      actionRunId: typeof input.actionRunId === 'string' ? input.actionRunId : '',
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : '',
      completedAt: typeof input.completedAt === 'string' ? input.completedAt : ''
    };
    return result(true, freeze(task));
  }

  function normalizeMany(tasks) {
    if (!Array.isArray(tasks)) return result(false, null, 'tasks-required');
    var ids = Object.create(null);
    var values = [];
    for (var i = 0; i < tasks.length; i++) {
      var item = normalize(tasks[i]);
      if (!item.ok) return item;
      if (ids[item.value.id]) return result(false, null, 'duplicate-id');
      ids[item.value.id] = true;
      values.push(item.value);
    }
    return result(true, values);
  }

  function project(tasks, clientId, sessionId, options) {
    options = options || {};
    if (typeof clientId !== 'string' || !clientId.trim()) return result(false, null, 'client-required');
    if (typeof sessionId !== 'string' || !sessionId.trim()) return result(false, null, 'session-required');
    var all = normalizeMany(tasks);
    if (!all.ok) return all;
    var active = [], terminal = [], rejected = [];
    all.value.forEach(function (task) {
      if (task.clientId !== clientId) {
        rejected.push({ id: task.id, reason: 'cross-client' });
        return;
      }
      if (task.status === STATUSES.AI_DRAFT || task.status === STATUSES.OPEN) {
        if (task.originSessionId === sessionId || options.allowLaterSession === true) active.push(task);
        else rejected.push({ id: task.id, reason: 'cross-session' });
        return;
      }
      if (options.includeTerminal === true) terminal.push(task);
    });
    return result(true, freeze({
      version: 'clinical-task-vm-v1',
      clientId: clientId,
      sessionId: sessionId,
      active: active,
      terminal: terminal,
      rejected: rejected
    }));
  }

  function confirmDraft(task) {
    var normalized = normalize(task);
    if (!normalized.ok) return normalized;
    if (normalized.value.status !== STATUSES.AI_DRAFT) return result(false, null, 'not-ai-draft');
    return result(true, freeze(Object.assign({}, normalized.value, { status: STATUSES.OPEN })));
  }

  function transition(task, status, completedAt) {
    var normalized = normalize(task);
    if (!normalized.ok) return normalized;
    if (status !== STATUSES.DONE && status !== STATUSES.CANCELLED) return result(false, null, 'terminal-status-required');
    return result(true, freeze(Object.assign({}, normalized.value, {
      status: status,
      completedAt: typeof completedAt === 'string' ? completedAt : normalized.value.completedAt
    })));
  }

  return {
    STATUSES: STATUSES,
    normalize: normalize,
    project: project,
    confirmDraft: confirmDraft,
    transition: transition,
    PERSISTENCE_STATUS: 'PERSISTED'
  };
});
