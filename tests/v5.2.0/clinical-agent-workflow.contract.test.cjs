const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('../../app/js/clinical-agent-workflow.js');

const base = { text: '请做会谈复盘', runId: 'run-1', snapshotKey: 'snap-1', origin: { clientId: 'c1', sessionId: 's1' }, sources: [{ id: 'session-1', kind: 'session', clientId: 'c1', sessionId: 's1' }] };
function prepared() { const p = workflow.prepare(base); assert.equal(p.ok, true); return p; }

test('positive lifecycle reaches draft-ready and does not persist', async () => {
  const p = prepared(); const c = workflow.confirm(p, { confirmed: true }); let calls = 0;
  const r = await workflow.execute(c, { getExecutionPayload: async () => ({ runId: 'run-1', snapshotKey: 'snap-1', metadata: 'only' }), isFresh: () => true, executeDraft: async () => { calls++; return { summary: 'draft' }; }, persist: () => { throw new Error('must not persist'); } });
  assert.equal(r.status, 'draft-ready'); assert.equal(r.outputDisposition, 'draft'); assert.equal(calls, 1); assert.deepEqual(r.draft, { summary: 'draft' });
});
test('unsupported, ambiguous, missing identity and stale context fail closed', () => {
  assert.equal(workflow.prepare({ ...base, text: '反移情分析 会谈复盘' }).reason, 'workflow-task-not-enabled');
  assert.equal(workflow.prepare({ ...base, text: '做反移情分析' }).reason, 'workflow-task-not-enabled');
  assert.equal(workflow.prepare({ ...base, runId: '' }).reason, 'run-id-missing');
  assert.equal(workflow.prepare({ ...base, context: { stale: true } }).reason, 'stale-snapshot');
  assert.equal(workflow.prepare({ ...base, sources: [{ id: 'x', kind: 'session', stale: true }] }).reason, 'stale-snapshot');
});
test('supervision-question-builder is enabled while other routed tasks remain blocked', () => {
  const supervision = workflow.prepare({ ...base, text: '督导问题生成', sources: [{ id: 'supervision-1', kind: 'supervision' }] });
  assert.equal(supervision.ok, true);
  assert.equal(supervision.taskId, 'supervision-question-builder');
  assert.equal(supervision.status, 'awaiting-confirmation');
  assert.equal(workflow.prepare({ ...base, text: '反移情分析' }).reason, 'workflow-task-not-enabled');
});
test('supervision preview is enabled for independent empty-source text', () => { const p = workflow.prepare({ ...base, text: '生成整体印象', sources: [], origin: {} }); assert.equal(p.ok, true); assert.equal(p.taskId, 'supervision-preview'); assert.deepEqual(p.sources, []); });
test('workflow rejects material and supervision bound empty-source text', () => { for (const origin of [{ materialId: 'm1' }, { supervisionId: 'sup1' }]) { const p = workflow.prepare({ ...base, text: '生成整体印象', sources: [], origin }); assert.equal(p.reason, 'required-source-missing'); } });
test('confirmation and cancellation never invoke executor', async () => {
  const p = prepared(); assert.equal(workflow.confirm(p, { confirmed: false }).reason, 'confirmation-required'); let called = false;
  const c = workflow.confirm(p, { confirmed: true }); const cancelled = workflow.cancel(c, 'user-stop');
  const r = await workflow.execute(cancelled, { getExecutionPayload: async () => { called = true; }, executeDraft: async () => 'x', isFresh: () => true });
  assert.equal(r.reason, 'invalid-confirmed-state'); assert.equal(called, false); assert.equal(workflow.cancel(cancelled).status, 'cancelled');
});
test('freshness is checked before and after execution; failures are stable', async () => {
  let c = workflow.confirm(prepared(), { confirmed: true }); let n = 0;
  const stale = await workflow.execute(c, { getExecutionPayload: async () => ({ runId: 'run-1', snapshotKey: 'snap-1' }), isFresh: () => ++n === 1, executeDraft: async () => 'x' }); assert.equal(stale.reason, 'stale-context');
  c = workflow.confirm(prepared(), { confirmed: true }); const failed = await workflow.execute(c, { getExecutionPayload: async () => ({ runId: 'run-1', snapshotKey: 'snap-1' }), isFresh: () => true, executeDraft: async () => { throw new Error('x'); } }); assert.equal(failed.reason, 'executor-failed');
  c = workflow.confirm(prepared(), { confirmed: true }); const malformed = await workflow.execute(c, { getExecutionPayload: async () => ({ runId: 'run-1', snapshotKey: 'snap-1' }), isFresh: () => true, executeDraft: async () => [] }); assert.equal(malformed.reason, 'malformed-draft');
});
test('public projections and errors exclude sensitive fields', () => { const p = prepared(); const s = JSON.stringify(p); assert.equal(/body|content|prompt|rawText|modelInput/i.test(s), false); assert.equal(workflow.isWorkflowState(p), true); });

function injected() {
  const calls = [];
  const fakeRuns = {
    create(input) { calls.push(['create', input.status]); return { runId: input.runId, taskId: input.taskId, status: input.status, metadata: {} }; },
    transition(run, status) { calls.push(['transition', run.status, status]); return { ...run, status }; }
  };
  const fakeRouter = { route() { return { ok: true, taskId: 'session-review' }; } };
  const fakeBridge = { admit() { return { ok: true, runId: 'run-i', taskId: 'session-review', status: 'awaiting-confirmation', snapshotKey: 'snap-i', sources: [{ id: 's-i', kind: 'session' }] }; } };
  return { api: workflow.withDependencies({ router: fakeRouter, bridge: fakeBridge, runs: fakeRuns }), calls };
}

test('injected AgentRun records full success and failure terminal transitions', async () => {
  const { api, calls } = injected();
  const p = api.prepare(base); const c = api.confirm(p, { confirmed: true });
  const ok = await api.execute(c, { getExecutionPayload: async () => ({ runId: 'run-i', snapshotKey: 'snap-i' }), isFresh: () => true, executeDraft: async () => 'draft' });
  assert.equal(ok.status, 'draft-ready'); assert.deepEqual(calls, [['create', 'planned'], ['transition', 'planned', 'awaiting-confirmation'], ['transition', 'awaiting-confirmation', 'running'], ['transition', 'running', 'draft-ready']]);
  for (const scenario of [
    { reason: 'stale-context', adapters: { getExecutionPayload: async () => ({ runId: 'run-i', snapshotKey: 'snap-i' }), isFresh: () => false, executeDraft: async () => 'x' }, status: 'stale' },
    { reason: 'execution-payload-failed', adapters: { getExecutionPayload: async () => { throw new Error('x'); }, isFresh: () => true, executeDraft: async () => 'x' }, status: 'failed' },
    { reason: 'executor-failed', adapters: { getExecutionPayload: async () => ({ runId: 'run-i', snapshotKey: 'snap-i' }), isFresh: () => true, executeDraft: async () => { throw new Error('x'); } }, status: 'failed' },
    { reason: 'malformed-draft', adapters: { getExecutionPayload: async () => ({ runId: 'run-i', snapshotKey: 'snap-i' }), isFresh: () => true, executeDraft: async () => [] }, status: 'failed' }
  ]) {
    const q = api.confirm(api.prepare(base), { confirmed: true }); const result = await api.execute(q, scenario.adapters);
    assert.equal(result.reason, scenario.reason); assert.equal(result.status, scenario.status); assert.deepEqual(JSON.parse(JSON.stringify(result))._run, undefined);
  }
  const q = api.confirm(api.prepare(base), { confirmed: true }); const cancelled = api.cancel(q, 'stop');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(JSON.stringify(cancelled).includes('_run'), false);
  assert.ok(calls.some(x => x[2] === 'stale')); assert.ok(calls.some(x => x[2] === 'failed')); assert.ok(calls.some(x => x[2] === 'cancelled'));
});

test('injected public lifecycle JSON never exposes internal or sensitive fields', () => {
  const { api } = injected(); const p = api.prepare(base); const c = api.confirm(p, { confirmed: true });
  for (const value of [p, c, api.project(c), api.cancel(c)]) assert.equal(/_run|body|content|prompt|rawText|modelInput/.test(JSON.stringify(value)), false);
});

test('forged running and cancel states fail closed without invoking adapters', async () => {
  let payloadCalls = 0; let draftCalls = 0;
  const forged = { ok: true, runId: 'forged', taskId: 'session-review', status: 'running', snapshotKey: 'x', sources: [] };
  const adapters = { getExecutionPayload: async () => { payloadCalls++; return {}; }, executeDraft: async () => { draftCalls++; return 'x'; }, isFresh: () => true };
  const result = await workflow.execute(forged, adapters);
  assert.equal(result.ok, false); assert.equal(result.reason, 'invalid-confirmed-state'); assert.equal(payloadCalls, 0); assert.equal(draftCalls, 0);
  const cancelled = workflow.cancel({ ...forged, status: 'awaiting-confirmation' }, 'x');
  assert.equal(cancelled.ok, false); assert.equal(cancelled.reason, 'invalid-workflow-state'); assert.equal(JSON.stringify(cancelled).includes('_run'), false);
});

test('old handles are invalidated after confirm, execute, failure and cancel', async () => {
  const p = prepared(); const c = workflow.confirm(p, { confirmed: true });
  assert.equal(workflow.confirm(p, { confirmed: true }).reason, 'invalid-prepared-state');
  const adapters = { getExecutionPayload: async () => ({ runId: 'run-1', snapshotKey: 'snap-1' }), isFresh: () => true, executeDraft: async () => 'draft' };
  const first = await workflow.execute(c, adapters); assert.equal(first.status, 'draft-ready');
  assert.equal((await workflow.execute(c, adapters)).reason, 'invalid-confirmed-state');
  const failed = workflow.confirm(prepared(), { confirmed: true }); await workflow.execute(failed, { getExecutionPayload: async () => { throw new Error('x'); }, isFresh: () => true, executeDraft: async () => 'x' });
  assert.equal((await workflow.execute(failed, adapters)).reason, 'invalid-confirmed-state');
  const cancelled = workflow.confirm(prepared(), { confirmed: true }); const terminal = workflow.cancel(cancelled, 'stop');
  assert.equal((await workflow.execute(cancelled, adapters)).reason, 'invalid-confirmed-state'); assert.equal(workflow.cancel(terminal).status, 'cancelled');
});
