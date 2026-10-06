const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Bridge = require('../../app/js/clinical-agent-production-bridge.js');
const Adapter = require('../../app/js/clinical-agent-adapter.js');
const Runtime = require('../../app/js/clinical-agent-runtime.js');

function loadOutcome() {
  const source = fs.readFileSync(path.join(__dirname, '../../app/js/supervision.js'), 'utf8');
  const context = { App: { initPage() {} }, console, setTimeout, clearTimeout, Promise };
  vm.runInNewContext(source, context, { filename: 'supervision.js' });
  assert.equal(typeof context.SupervisionOutcome, 'object');
  return context.SupervisionOutcome;
}

function fixture() {
  const events = [];
  const context = {
    build(task) { events.push('build:' + task); return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [], messages: [{ role: 'user', content: 'private' }] }; },
    isSnapshotCurrent() { return true; },
    createActionRun() { events.push('create'); return { id: 'run-1' }; },
    completeActionRun() { events.push('complete'); return { ok: true }; },
    failActionRun() { events.push('fail'); return { ok: true }; }
  };
  const workflow = { prepare(r) { return { ok: true, runId: r.runId, taskId: 'supervision-preview', status: 'awaiting-confirmation', snapshotKey: r.snapshotKey, sources: [] }; }, confirm(s, c) { return c && c.confirmed ? { ...s, ok: true, status: 'running' } : { ok: false, reason: 'confirmation-required' }; }, cancel(s) { return { ...s, ok: false, status: 'cancelled' }; }, isWorkflowState() { return true; } };
  const api = Bridge.withDependencies({ runtime: Runtime.withDependencies({ workflow, adapter: Adapter.withDependencies({ context, executor: async () => { events.push('ai'); return 'draft'; }, lifecycle: context }), defaultTimeoutMs: 100 }) });
  return { api, events };
}

test('standard bridge builds one private context and orders lifecycle around AI', async () => {
  const f = fixture();
  const token = f.api.prepareContext({ taskId: 'supervision-preview', runId: 'run-1', snapshotKey: 'pending', inputText: '生成整体印象', sources: [], origin: {} });
  const prepared = f.api.prepare({ text: '生成整体印象', runId: 'run-1', snapshotKey: token.snapshotKey, inputText: '生成整体印象', sources: [], origin: {} }, token);
  const result = await f.api.execute(f.api.confirm(prepared, { confirmed: true }));
  assert.equal(result.status, 'draft-ready');
  assert.deepEqual(f.events, ['build:supervision-ai', 'create', 'ai', 'complete']);
});

test('real fromGlobals forwards prepareContext and reuses the single private build', async () => {
  const events = [];
  const context = {
    build(task) { events.push('build:' + task); return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-2' }, sources: [], messages: [{ role: 'user', content: 'private' }] }; },
    isSnapshotCurrent() { return true; },
    createActionRun() { events.push('create'); return { id: 'run-2' }; },
    completeActionRun() { events.push('complete'); return { ok: true }; },
    failActionRun() { events.push('fail'); return { ok: true }; }
  };
  const workflow = { prepare(r) { return { ok: true, runId: r.runId, taskId: 'supervision-preview', status: 'awaiting-confirmation', snapshotKey: r.snapshotKey, sources: [] }; }, confirm(s, c) { return c && c.confirmed ? { ...s, ok: true, status: 'running' } : { ok: false, reason: 'confirmation-required' }; }, cancel(s) { return { ...s, ok: false, status: 'cancelled' }; }, isWorkflowState() { return true; } };
  const ai = { send(messages, cb) { events.push('ai'); cb({ content: 'draft' }); } };
  const api = Bridge.fromGlobals({ workflow, ClinicalContext: context, AI: ai, adapter: Adapter, timeoutMs: 100 });
  const token = api.prepareContext({ taskId: 'supervision-preview', runId: 'run-2', snapshotKey: 'pending', inputText: '生成整体印象', sources: [], origin: {} });
  assert.equal(token.ok, true);
  const prepared = api.prepare({ text: '生成整体印象', runId: 'run-2', snapshotKey: token.snapshotKey, inputText: '生成整体印象', sources: [], origin: {} }, token);
  const result = await api.execute(api.confirm(prepared, { confirmed: true }));
  assert.equal(result.status, 'draft-ready');
  assert.deepEqual(events, ['build:supervision-ai', 'create', 'ai', 'complete']);
});

test('real fromGlobals preserves bound client/session/material/supervision source metadata', async () => {
  const events = [];
  const sources = [
    { kind: 'client', id: 'client-1', clientId: 'client-1', sessionId: 'session-1' },
    { kind: 'session', id: 'session-1', clientId: 'client-1', sessionId: 'session-1' },
    { kind: 'material', id: 'material-1', clientId: 'client-1', sessionId: 'session-1' },
    { kind: 'supervision', id: 'supervision-1', clientId: 'client-1', sessionId: 'session-1' }
  ];
  const context = {
    build(task) { events.push('build:' + task); return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-bound' }, sources, origin: { clientId: 'client-1', sessionId: 'session-1' }, messages: [{ role: 'user', content: 'private' }] }; },
    isSnapshotCurrent() { return true; },
    createActionRun() { events.push('create'); return { id: 'run-bound' }; },
    completeActionRun() { events.push('complete'); return { ok: true }; },
    failActionRun() { events.push('fail'); return { ok: true }; }
  };
  const workflow = { prepare(r) { return { ok: true, runId: r.runId, taskId: 'supervision-preview', status: 'awaiting-confirmation', snapshotKey: r.snapshotKey, sources: r.sources }; }, confirm(s, c) { return c && c.confirmed ? { ...s, ok: true, status: 'running' } : { ok: false, reason: 'confirmation-required' }; }, cancel(s) { return { ...s, ok: false, status: 'cancelled' }; }, isWorkflowState() { return true; } };
  const ai = { send(messages, cb) { events.push('ai'); cb({ content: 'draft' }); } };
  const api = Bridge.fromGlobals({ workflow, ClinicalContext: context, AI: ai, adapter: Adapter, timeoutMs: 100 });
  const token = api.prepareContext({ taskId: 'supervision-preview', runId: 'run-bound', snapshotKey: 'pending', inputText: '生成整体印象', sources, origin: { clientId: 'client-1', sessionId: 'session-1', materialId: 'material-1', supervisionId: 'supervision-1' } });
  assert.deepEqual(token.sources, sources.map((source) => ({ kind: source.kind, id: source.id })));
  const prepared = api.prepare({ text: '生成整体印象', runId: 'run-bound', snapshotKey: token.snapshotKey, inputText: '生成整体印象', sources: token.sources, origin: { clientId: 'client-1', sessionId: 'session-1', materialId: 'material-1', supervisionId: 'supervision-1' } }, token);
  const result = await api.execute(api.confirm(prepared, { confirmed: true }));
  assert.equal(result.status, 'draft-ready');
  assert.deepEqual(events, ['build:supervision-ai', 'create', 'ai', 'complete']);
});

test('confirmation projection preserves safe source summary but never raw body', async () => {
  const context = {
    build() { return { ok: true, task: 'supervision-ai', outputMode: 'preview-only', snapshot: { key: 'snap-summary' }, estimatedChars: 321, sources: [{ kind: 'material', id: 'm1', label: '会谈材料', chars: 300, truncated: true, body: 'PRIVATE BODY' }], messages: [{ role: 'user', content: 'PRIVATE BODY' }] }; },
    isSnapshotCurrent() { return true; }, createActionRun() { return { id: 'r' }; }, completeActionRun() { return { ok: true }; }, failActionRun() { return { ok: true }; }
  };
  const workflow = { prepare(r) { return { ok: true, runId: r.runId, taskId: 'supervision-preview', status: 'awaiting-confirmation', snapshotKey: r.snapshotKey, sources: r.sources }; }, confirm(s, c) { return c && c.confirmed ? { ...s, ok: true, status: 'running' } : { ok: false, reason: 'confirmation-required' }; }, cancel(s) { return s; }, isWorkflowState() { return true; } };
  const api = Bridge.fromGlobals({ workflow, ClinicalContext: context, AI: { send(_m, cb) { cb({ content: 'draft' }); } }, adapter: Adapter });
  const token = api.prepareContext({ taskId: 'supervision-preview', runId: 'r', snapshotKey: 'pending', inputText: 'x', sources: [], origin: {} });
  const json = JSON.stringify(token);
  assert.match(json, /会谈材料/); assert.match(json, /321/); assert.match(json, /300/); assert.match(json, /truncated/); assert.doesNotMatch(json, /PRIVATE BODY|messages|executor/);
});

test('standard outcome boundary settles resolved provider failure without raw error fields', async () => {
  const outcome = loadOutcome();
  const result = await outcome.execute({ execute() { return Promise.resolve({ ok: false, reason: 'ai-failed', message: 'PRIVATE PROVIDER ERROR', privateContext: 'PRIVATE CONTEXT' }); } }, {}, {});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { error: '本次生成未完成，请重试。', code: 'ai-failed' });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('standard outcome boundary converts execute rejection and synchronous throw to retryable safe failures', async () => {
  const outcome = loadOutcome();
  const rejected = await outcome.execute({ execute() { return Promise.reject(new Error('PRIVATE REJECTION')); } }, {}, {});
  const thrown = await outcome.execute({ execute() { throw new Error('PRIVATE THROW'); } }, {}, {});
  assert.deepEqual(JSON.parse(JSON.stringify(rejected)), { error: '本次生成未完成，请重试。', code: 'executor-failed' });
  assert.deepEqual(JSON.parse(JSON.stringify(thrown)), { error: '本次生成未完成，请重试。', code: 'executor-failed' });
  assert.equal(JSON.stringify({ rejected, thrown }).includes('PRIVATE'), false);
});

test('standard outcome boundary settles confirmation cancellation and confirm throw without executing', async () => {
  const outcome = loadOutcome();
  let executeCalls = 0;
  const bridge = {
    confirm() { return { ok: true }; },
    execute() { executeCalls += 1; return Promise.resolve({ ok: true, draft: 'must not run' }); },
  };
  const cancelled = await outcome.confirmAndExecute(bridge, {}, () => false, {});
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), { error: '用户已取消本次 AI 督导', cancelled: true });
  const thrown = await outcome.confirmAndExecute({ confirm() { throw new Error('PRIVATE CONFIRM'); }, execute() { executeCalls += 1; } }, {}, () => true, {});
  assert.deepEqual(JSON.parse(JSON.stringify(thrown)), { error: '确认失败，请重试。', code: 'bridge-confirm-failed' });
  assert.equal(executeCalls, 0);
});

test('standard outcome boundary suppresses late success and stream after cancellation', async () => {
  const outcome = loadOutcome();
  let resolve;
  let cancelled = false;
  let streamCalls = 0;
  const pending = outcome.execute({ execute(_state, options) {
    return new Promise((done) => { resolve = () => { options.onDelta('late', 'late'); done({ ok: true, draft: 'late success' }); }; });
  } }, {}, {
    onDelta() { if (!cancelled) streamCalls += 1; },
    isCancelled() { return cancelled; },
  });
  cancelled = true;
  resolve();
  const result = await pending;
  assert.equal(result.code, 'ai-cancelled');
  assert.equal(result.error, '本次生成已取消');
  assert.equal(result.cancelled, true);
  assert.equal(result.contextSent, true);
  assert.equal(streamCalls, 0);
  assert.equal(JSON.stringify(result).includes('late success'), false);
});

test('standard outcome boundary waits for the execution Promise to settle', async () => {
  const outcome = loadOutcome();
  let resolve;
  let settled = false;
  const result = outcome.execute({ execute() { return new Promise((done) => { resolve = done; }); } }, {}, {});
  result.then(() => { settled = true; });
  await new Promise((done) => setImmediate(done));
  assert.equal(settled, false);
  resolve({ ok: true, draft: 'real draft' });
  assert.equal((await result).content, 'real draft');
});

test('standard attempt releases busy/controller state after rejection and retains retry metadata', async () => {
  const outcome = loadOutcome();
  const ui = { busy: true, controller: {}, retry: null, message: '' };
  await outcome.runAttempt(() => Promise.reject(new Error('PRIVATE ERROR')), () => {
    ui.retry = { text: '重试指令', isImpression: true };
    ui.message = '执行异常：本次生成未完成。';
  }, () => {
    ui.controller = null;
    ui.busy = false;
  });
  assert.equal(ui.busy, false);
  assert.equal(ui.controller, null);
  assert.deepEqual(ui.retry, { text: '重试指令', isImpression: true });
  assert.equal(ui.message.includes('PRIVATE ERROR'), false);
});

test('supervision page loads agent modules before page handler and removes direct standard calls', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../app/supervision.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../../app/js/supervision.js'), 'utf8');
  assert.ok(html.indexOf('clinical-agent-production-bridge.js') < html.indexOf('supervision.js'));
  assert.equal((html.match(/clinical-agent-production-bridge.js/g) || []).length, 1);
  const standard = js.slice(js.indexOf('function callAI'), js.indexOf('// 快捷追问'));
  assert.equal(['ClinicalContext.createActionRun(', 'ClinicalContext.completeActionRun(', 'ClinicalContext.failActionRun(', 'AI.send('].some((needle) => standard.includes(needle)), false);
  assert.equal(standard.includes('error.message'), false);
  assert.match(standard, /SupervisionOutcome\.confirmAndExecute/);
});
