const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Pipeline = require('../../app/js/clinical-agent-pipeline.js');
const RunStore = require('../../app/js/clinical-agent-run-store.js');

test('controlled pipeline exposes five safe specialist stages and defers AI until confirmation', async () => {
  const calls = [];
  const bridge = {
    prepareContext(request) { calls.push('context'); return { ok: true, runId: request.runId, taskId: request.taskId, snapshotKey: 'snap-1', sources: [{ kind: 'session', id: 's1' }] }; },
    prepare(request) { calls.push('prepare'); return { ok: true, runId: request.runId, taskId: request.taskId, status: 'awaiting-confirmation', snapshotKey: request.snapshotKey, sources: request.sources }; },
    confirm(state) { calls.push('confirm'); return { ...state, ok: true, status: 'running' }; },
    execute(state) { calls.push('execute'); return Promise.resolve({ ok: true, runId: state.runId, taskId: state.taskId, snapshotKey: state.snapshotKey, status: 'draft-ready', draft: { kind: 'session-review', citations: [] } }); }
  };
  const pipeline = Pipeline.create({ bridge, router: { route() { return { ok: true, taskId: 'session-review' }; } } });
  const plan = pipeline.prepare({ text: '会谈复盘', runId: 'r1', selection: { sessionId: 's1' } });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map(step => step.id), ['context-builder', 'intent-classifier', 'supervision-router', 'evidence-validator', 'draft-orchestrator']);
  assert.equal(calls.includes('execute'), false);
  const confirmed = pipeline.confirm(plan);
  assert.equal(confirmed.confirmed.status, 'running');
  const result = await pipeline.execute(confirmed);
  assert.equal(result.status, 'draft-ready');
  assert.equal(calls.at(-1), 'execute');
  assert.equal(/content|prompt|rawText|messages/.test(JSON.stringify(plan)), false);
});

test('AgentRun persistence stores only metadata and restores resumable runs', async () => {
  let value;
  const store = {
    _get: async () => value,
    _mutate: async (_key, transform) => { value = transform(value); return value; }
  };
  const run = { runId: 'r2', taskId: 'case-conceptualization', status: 'running', stepIds: ['context-builder'], snapshotKey: 'snap-2', outputDisposition: 'draft', origin: { clientId: 'c1' }, sources: [{ kind: 'client', id: 'c1', status: 'verified', sourceVersion: 'v1' }], body: 'private clinical body', prompt: 'private prompt' };
  const saved = await RunStore.save(run, store);
  assert.equal(saved.ok, true);
  const rows = await RunStore.list(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, 'r2');
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'prompt'), false);
  assert.equal((await RunStore.resumable(store))[0].status, 'running');
  assert.equal((await RunStore.get('r2', store)).snapshotKey, 'snap-2');
});

test('resumable metadata keeps the original run identity while rebuilding from current selection', async () => {
  let value = { version: 1, runs: [{ runId: 'resume-1', taskId: 'session-review', status: 'running', snapshotKey: 'old-snapshot', origin: { clientId: 'c1', sessionId: 's1' }, sources: [] }] };
  const store = { _get: async () => value, _mutate: async (_key, transform) => { value = transform(value); return value; } };
  const record = (await RunStore.resumable(store))[0];
  assert.equal(record.runId, 'resume-1');
  assert.equal(record.origin.clientId, 'c1');
  assert.equal(record.origin.sessionId, 's1');
  const source = fs.readFileSync('app/js/chat-home.js', 'utf8');
  assert.match(source, /resumeClinicalAgentRun/);
  assert.match(source, /pendingResumeRun/);
});

test('chat page loads clinical agent dependencies and workbench entry', () => {
  const html = fs.readFileSync('app/chat-home.html', 'utf8');
  for (const src of ['clinical-context.js', 'clinical-agent-run-store.js', 'clinical-agent-pipeline.js', 'clinical-agent-workbench.js']) assert.match(html, new RegExp('js/' + src.replace('.', '\.') + '"'));
  assert.match(html, /clinical-agent-workbench-root/);
});

test('six clinical context task definitions are present', () => {
  const source = fs.readFileSync('app/js/clinical-context.js', 'utf8');
  for (const id of ['countertransference-analysis', 'session-review', 'case-conceptualization', 'next-session-hypotheses', 'supervision-ai', 'supervision-multi-school']) assert.ok(source.includes("'" + id + "': taskSpec"), id);
});
