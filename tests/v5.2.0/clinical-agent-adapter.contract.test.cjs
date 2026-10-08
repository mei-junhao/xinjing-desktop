const test = require('node:test');
const assert = require('node:assert/strict');
const Adapter = require('../../app/js/clinical-agent-adapter.js');
function fixture(overrides = {}) {
  const calls = { build: 0, fresh: [], exec: 0, persist: 0 };
  const context = {
    build(task, selection, options) { calls.build++; if (overrides.build) return overrides.build(task, selection, options); return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, origin: { clientId: 'c1', sessionId: 's1' }, sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's1' }], messages: [{ role: 'user', content: 'private clinical text' }] }; },
    isSnapshotCurrent(snapshot, input, selection) { calls.fresh.push([snapshot, input, selection]); return overrides.fresh ? overrides.fresh(calls.fresh.length) : true; }
  };
  const adapter = Adapter.withDependencies({ context, executor: async (payload, meta) => { calls.exec++; if (overrides.exec) return overrides.exec(payload, meta); return { facts: 'draft [s1]', inferences: '', hypotheses: '' }; } });
  return { adapter, calls };
}
function request() { return { taskId: 'session-review', runId: 'run-1', snapshotKey: 'snap-1', sources: [{ kind: 'session', id: 's1' }], inputText: 'review', selection: { sessionId: 's1' }, contextOptions: { inputText: 'review' } }; }
test('positive lifecycle and metadata-only projection', async () => { const { adapter, calls } = fixture(); const state = adapter.create(request()); assert.equal(state.status, 'awaiting-confirmation'); assert.equal(adapter.isAdapterState(state), true); const result = await adapter.execute(state); assert.equal(result.status, 'draft-ready'); assert.equal(result.draft.facts, 'draft [s1]'); assert.equal(adapter.project(result).draft, undefined); assert.equal(calls.fresh.length, 2); assert.equal(calls.exec, 1); });
test('malformed and context build failures fail closed', async () => { const f = fixture({ build: () => ({ ok: false, reason: 'required-source-missing' }) }); assert.equal(f.adapter.create({}).reason, 'malformed-request'); assert.equal(f.adapter.create(request()).reason, 'required-source-missing'); });
test('stable failure paths and no persistence', async () => { let f = fixture({ fresh: n => n === 1 ? false : true }); let s = f.adapter.create(request()); assert.equal((await f.adapter.execute(s)).reason, 'stale-before'); assert.equal(f.calls.exec, 0); f = fixture({ exec: () => { throw new Error('secret'); } }); s = f.adapter.create(request()); assert.equal((await f.adapter.execute(s)).reason, 'executor-failed'); assert.equal((await f.adapter.execute(s)).reason, 'invalid-state'); });
test('payload mutation isolation and cancellation', async () => { let seen; const f = fixture({ exec: payload => { seen = payload; payload[0].content = 'mutated'; return { facts: '', inferences: 'ok', hypotheses: '' }; } }); const s = f.adapter.create(request()); const r = await f.adapter.execute(s); assert.equal(r.draft.inferences, 'ok'); assert.equal(seen[0].content, 'mutated'); const f2 = fixture(); const s2 = f2.adapter.create(request()); assert.equal((await f2.adapter.execute(s2, { isCancelled: () => true })).reason, 'cancelled'); });
test('stale-after, async await, malformed draft and source metadata fail closed', async () => { let resolve; const gate = new Promise(r => { resolve = r; }); const f = fixture({ fresh: n => n === 1 ? true : false, exec: async () => { await gate; return { body: 'draft' }; } }); const s = f.adapter.create(request()); const pending = f.adapter.execute(s); await new Promise(r => setImmediate(r)); assert.equal(f.calls.exec, 1); resolve(); assert.equal((await pending).reason, 'stale-after'); const f2 = fixture({ exec: () => [] }); const s2 = f2.adapter.create(request()); assert.equal((await f2.adapter.execute(s2)).reason, 'malformed-draft'); const f3 = fixture({ build: () => ({ ok: true, task: 'session-review', outputMode: 'preview-only', snapshot: {}, snapshotKey: 'snap-1', sources: [{ kind: 'session', id: '' }], messages: [] }) }); assert.equal(f3.adapter.create(request()).reason, 'invalid-context'); });
test('public projection has no private clinical body or persistence handles', () => { const f = fixture(); const state = f.adapter.create(request()); const view = f.adapter.project(state); assert.equal(view.messages, undefined); assert.equal(view.inputText, undefined); assert.equal(view.executor, undefined); assert.equal(view.persist, undefined); });
test('rejects snapshot mismatch and cross-client/session source identity', () => {
  let f = fixture({ build: (task) => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, snapshotKey: 'other', sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create(request()).reason, 'snapshot-mismatch');
  f = fixture({ build: (task) => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, snapshotKey: 'snap-1', sources: [{ kind: 'session', id: 's1', clientId: 'c2', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create({ ...request(), origin: { clientId: 'c1', sessionId: 's1' } }).reason, 'cross-client-source-mismatch');
  f = fixture({ build: (task) => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, snapshotKey: 'snap-1', sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's2' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create({ ...request(), origin: { clientId: 'c1', sessionId: 's1' } }).reason, 'cross-session-source-mismatch');
  f = fixture({ build: (task) => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, snapshotKey: 'snap-1', sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's1' }, { kind: 'session', id: 's2', clientId: 'c2', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create(request()).reason, 'source-mismatch');
});
test('rejects conflicting built snapshot aliases and keeps snapshot.key canonical', () => {
  let f = fixture({ build: (task) => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, snapshotKey: 'forged', sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  const conflict = f.adapter.create(request());
  assert.equal(conflict.reason, 'snapshot-mismatch');
  assert.equal(f.calls.exec, 0);
  f = fixture({ build: (task) => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, snapshotKey: 'snap-1', sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create(request()).status, 'awaiting-confirmation');
});
test('maps supervision workflow task to the real supervision-ai context task', () => {
  let builtTask;
  const f = fixture({ build: (task, selection, options) => { builtTask = task; return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [{ kind: 'supervision', id: 's1', clientId: 'c1', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }; } });
  const state = f.adapter.create({ ...request(), taskId: 'supervision-question-builder', sources: [{ kind: 'supervision', id: 's1' }] });
  assert.equal(state.status, 'awaiting-confirmation');
  assert.equal(builtTask, 'supervision-ai');
  const wrong = fixture({ build: (task) => ({ ok: true, task: 'supervision-question-builder', outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [{ kind: 'supervision', id: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(wrong.adapter.create({ ...request(), taskId: 'supervision-question-builder', sources: [{ kind: 'supervision', id: 's1' }] }).reason, 'unknown-task');
});
test('maps supervision preview and admits four source shapes plus independent empty', () => { const seen = []; const f = fixture({ build: (task, selection, options) => { seen.push(task); return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: options.sources || [], messages: [{ role: 'user', content: 'x' }] }; } }); for (const kind of ['client', 'session', 'material', 'supervision']) { const s = f.adapter.create({ taskId: 'supervision-preview', runId: 'r-' + kind, snapshotKey: 'snap-1', sources: [{ kind, id: kind + '-1' }], inputText: 'x', contextOptions: { sources: [{ kind, id: kind + '-1' }] } }); assert.equal(s.status, 'awaiting-confirmation'); } const empty = f.adapter.create({ taskId: 'supervision-preview', runId: 'r-empty', snapshotKey: 'snap-1', sources: [], inputText: 'x', contextOptions: { sources: [] } }); assert.equal(empty.status, 'awaiting-confirmation'); assert.equal(seen.every(x => x === 'supervision-ai'), true); });
test('adapter rejects material and supervision bound empty-source requests', () => { for (const origin of [{ materialId: 'm1' }, { supervisionId: 'sup1' }]) { const f = fixture({ build: (task, selection, options) => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [], messages: [{ role: 'user', content: 'x' }] }) }); const state = f.adapter.create({ taskId: 'supervision-preview', runId: 'r-bound', snapshotKey: 'snap-1', sources: [], inputText: 'x', origin, contextOptions: { sources: [] } }); assert.equal(state.reason, 'invalid-context'); } });
test('rejects non-plain executor drafts', async () => {
  for (const draft of [new Date(), function nope() {}, [], null, undefined]) {
    const f = fixture({ exec: () => draft });
    const state = f.adapter.create(request());
    assert.equal((await f.adapter.execute(state)).reason, 'malformed-draft');
  }
});

test('缺少可选 Context 输出方法也不能绕过三栏与来源校验', async () => {
  for (const [draft, reason] of [
    ['unstructured private output', 'malformed-draft'],
    [{ facts: 'uncited fact', inferences: '', hypotheses: '' }, 'output-evidence-missing'],
    [{ facts: 'forged fact [other-session]', inferences: '', hypotheses: '' }, 'output-citation-not-admitted'],
  ]) {
    const f = fixture({ exec: () => draft });
    const result = await f.adapter.execute(f.adapter.create(request()));
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.draft, undefined);
  }
});
test('binds request source set and preserves request stale semantics', async () => {
  let f = fixture({ build: task => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [{ kind: 'session', id: 's2', clientId: 'c1', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  let state = f.adapter.create(request());
  assert.equal(state.reason, 'source-mismatch');
  assert.equal((await f.adapter.execute(state)).reason, 'invalid-state');
  assert.equal(f.calls.exec, 0);
  f = fixture({ build: task => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [{ kind: 'material', id: 's1', clientId: 'c1', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create(request()).reason, 'source-mismatch');
  f = fixture();
  assert.equal(f.adapter.create({ ...request(), sources: [{ kind: 'session', id: 's1', stale: true }] }).reason, 'stale-snapshot');
  assert.equal(f.adapter.create({ ...request(), sources: [{ kind: 'session', id: 's1', isStale: true }] }).reason, 'stale-snapshot');
  assert.equal(f.adapter.create({ ...request(), sources: [{ kind: 'session', id: 's1', status: 'stale' }] }).reason, 'stale-snapshot');
  f = fixture({ build: task => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's1', status: 'stale' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create(request()).reason, 'stale-snapshot');
});
test('classifies missing and malformed request sources as invalid-context before admission', async () => {
  for (const sources of [undefined, [], [{ kind: 'session', id: 's1' }, { kind: 'session', id: 's1' }], [{ kind: 'session' }]]) {
    const f = fixture();
    const state = f.adapter.create({ ...request(), sources });
    assert.equal(state.reason, 'invalid-context');
    assert.equal(f.calls.build, 0);
    assert.equal((await f.adapter.execute(state)).reason, 'invalid-state');
    assert.equal(f.calls.exec, 0);
  }
});
test('rejects request and built origin disagreement', () => {
  const f = fixture({ build: task => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, origin: { clientId: 'c2', sessionId: 's1' }, sources: [{ kind: 'session', id: 's1', clientId: 'c2', sessionId: 's1' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create({ ...request(), origin: { clientId: 'c1', sessionId: 's1' } }).reason, 'cross-client-source-mismatch');
});
test('rejects request source identity substitution and preserves partial origin identities', () => {
  let f = fixture();
  assert.equal(f.adapter.create({ ...request(), sources: [{ kind: 'session', id: 's1', clientId: 'c2' }] }).reason, 'cross-client-source-mismatch');
  f = fixture();
  assert.equal(f.adapter.create({ ...request(), sources: [{ kind: 'session', id: 's1', sessionId: 's2' }] }).reason, 'cross-session-source-mismatch');
  f = fixture({ build: task => ({ ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, origin: { clientId: 'c1', sessionId: 's2' }, sources: [{ kind: 'session', id: 's1', clientId: 'c1', sessionId: 's2' }], messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(f.adapter.create({ ...request(), origin: { clientId: 'c1' } }).status, 'awaiting-confirmation');
});
