'use strict';
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const modulePath = process.env.TASK_VM_MODULE || path.join(__dirname, '..', '..', '..', 'app', 'js', 'clinical-task-view-model.js');
const source = require('fs').readFileSync(modulePath, 'utf8');
const context = { module: { exports: {} }, exports: {}, globalThis: {}, Object, Array, String, Boolean, Number, Error };
vm.createContext(context);
vm.runInContext(source, context, { filename: modulePath });
const VM = context.module.exports;
const base = {
  id: 'task-1', clientId: 'client-a', originSessionId: 'session-1', title: '整理下一步',
  status: 'open', due: '2026-08-01', sourceRefs: ['source-session-1'], target: 'consult-notes',
  createdBy: 'manual', actionRunId: '', createdAt: '2026-07-27T00:00:00Z', completedAt: ''
};
const draft = Object.assign({}, base, { id: 'task-draft', status: 'ai-draft', createdBy: 'ai' });
const terminal = Object.assign({}, base, { id: 'task-done', status: 'done', completedAt: '2026-07-27T01:00:00Z' });
function check(label, fn) { try { fn(); console.log('[PASS] ' + label); } catch (e) { console.log('[FAIL] ' + label + ': ' + e.message); throw e; } }

check('valid task normalizes and freezes', function () {
  const r = VM.normalize(base); assert.strictEqual(r.ok, true); assert(Object.isFrozen(r.value)); assert(Object.isFrozen(r.value.sourceRefs)); assert.deepStrictEqual(r.value.sourceRefs, ['source-session-1']);
});
check('later same-client projection keeps open task', function () {
  const r = VM.project([base], 'client-a', 'session-2', { allowLaterSession: true }); assert.strictEqual(r.ok, true); assert.strictEqual(r.value.active.length, 1);
});
check('current session projection rejects cross-session task', function () {
  const r = VM.project([base], 'client-a', 'session-2'); assert.strictEqual(r.ok, true); assert.strictEqual(r.value.active.length, 0); assert.strictEqual(r.value.rejected[0].reason, 'cross-session');
});
check('cross-client projection rejects task', function () {
  const r = VM.project([base], 'client-b', 'session-1'); assert.strictEqual(r.ok, true); assert.strictEqual(r.value.rejected[0].reason, 'cross-client');
});
check('terminal tasks are hidden unless requested and retain origin', function () {
  const hidden = VM.project([terminal], 'client-a', 'session-1'); const shown = VM.project([terminal], 'client-a', 'session-1', { includeTerminal: true }); assert.strictEqual(hidden.value.terminal.length, 0); assert.strictEqual(shown.value.terminal[0].originSessionId, 'session-1'); assert.deepStrictEqual(shown.value.terminal[0].sourceRefs, ['source-session-1']);
});
check('AI draft requires explicit confirmation', function () {
  const r = VM.confirmDraft(draft); assert.strictEqual(r.ok, true); assert.strictEqual(r.value.status, 'open'); assert.strictEqual(draft.status, 'ai-draft'); assert.strictEqual(VM.confirmDraft(base).code, 'not-ai-draft');
});
check('transition only permits terminal status', function () {
  assert.strictEqual(VM.transition(base, 'open').ok, false); assert.strictEqual(VM.transition(base, 'done', 'now').value.completedAt, 'now');
});
check('forbidden body and invalid references fail closed', function () {
  assert.strictEqual(VM.normalize(Object.assign({}, base, { transcript: 'raw' })).code, 'body-field-forbidden'); assert.strictEqual(VM.normalize(Object.assign({}, base, { sourceRefs: [' '] })).code, 'source-refs-required');
});
check('duplicate and unknown status fail closed', function () {
  assert.strictEqual(VM.project([base, base], 'client-a', 'session-1').code, 'duplicate-id'); assert.strictEqual(VM.normalize(Object.assign({}, base, { status: 'pending' })).code, 'unknown-status');
});
console.log('clinical-task-view-model: PASS');
