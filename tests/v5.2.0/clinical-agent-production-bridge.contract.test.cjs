const test = require('node:test');
const assert = require('node:assert/strict');
const Bridge = require('../../app/js/clinical-agent-production-bridge.js');
const Adapter = require('../../app/js/clinical-agent-adapter.js');

function workflow() {
  return {
    prepare(r) { return { ok: true, runId: r.runId, taskId: 'supervision-preview', status: 'awaiting-confirmation', snapshotKey: r.snapshotKey, sources: r.sources || [] }; },
    confirm(s, c) { return c && c.confirmed === true ? { ...s, ok: true, status: 'running' } : { ok: false, reason: 'confirmation-required' }; },
    cancel(s) { return { ...s, ok: false, status: 'cancelled', reason: 'cancelled' }; },
    isWorkflowState() { return true; }
  };
}
function request() { return { text: '生成整体印象', runId: 'run-1', snapshotKey: 'snap-1', sources: [], origin: {}, inputText: '生成整体印象' }; }
function fixture(overrides = {}) {
  const events = [];
  const context = {
    build(task) { events.push('build:' + task); return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [], messages: [{ role: 'user', content: 'private' }] }; },
    isSnapshotCurrent() { return overrides.fresh ? overrides.fresh() : true; },
    createActionRun(ctx) { events.push('create'); if (overrides.create) return overrides.create(ctx); return { id: 'car-1' }; },
    completeActionRun(id, output) { events.push('complete:' + id + ':' + output.kind); if (overrides.complete) return overrides.complete(id, output); return { ok: true }; },
    failActionRun(id, reason, status) { events.push('fail:' + id + ':' + reason + ':' + status); if (overrides.fail) return overrides.fail(id, reason, status); return { ok: true }; }
  };
  let ai = overrides.ai || ((messages, cb) => { events.push('ai'); cb({ content: 'draft text' }); });
  const api = Bridge.fromGlobals({ workflow: workflow(), ClinicalContext: context, AI: { send: ai }, adapter: { withDependencies: d => Adapter.withDependencies(d) }, timeoutMs: overrides.timeoutMs });
  return { api, context, events };
}

test('confirmed supervision lifecycle creates action-run before AI and completes once', async () => { const f = fixture(); const p = f.api.prepare(request()); const c = f.api.confirm(p, { confirmed: true }); const out = await f.api.execute(c); assert.equal(out.status, 'draft-ready'); assert.equal(out.clinicalActionRunId, 'car-1'); assert.deepEqual(f.events, ['build:supervision-ai', 'create', 'ai', 'complete:car-1:supervision-preview']); });
test('confirmation gate and independent empty-source admission stay closed before lifecycle', async () => { const f = fixture(); const p = f.api.prepare(request()); assert.equal(f.api.confirm(p, { confirmed: false }).reason, 'confirmation-required'); assert.equal(f.events.includes('create'), false); assert.equal(f.events.includes('ai'), false); });
test('provider failure, stale-after, malformed draft and cancel fail action-run exactly once', async () => {
  for (const scenario of [
    { ai: (m, cb) => cb({ error: 'provider secret' }), reason: 'ai-failed' },
    { fresh: (() => { let n = 0; return () => ++n === 1; })(), reason: 'stale-after' },
    { ai: (m, cb) => cb({ content: [] }), reason: 'malformed-draft' }
  ]) { const f = fixture(scenario); const c = f.api.confirm(f.api.prepare(request()), { confirmed: true }); const out = await f.api.execute(c); assert.equal(out.reason, scenario.reason); assert.equal(f.events.filter(x => x.startsWith('fail:')).length, 1); assert.equal(f.events.filter(x => x.startsWith('complete:')).length, 0); assert.equal(JSON.stringify(out).includes('private'), false); }
  let resolve; const f = fixture({ ai: () => new Promise(r => { resolve = r; }) }); const c = f.api.confirm(f.api.prepare(request()), { confirmed: true }); const pending = f.api.execute(c); await new Promise(r => setImmediate(r)); assert.equal(f.api.cancel(c, 'user-cancel').status, 'cancelled'); resolve({ content: 'late' }); assert.equal((await pending).reason, 'ai-cancelled'); assert.equal(f.events.filter(x => x.startsWith('fail:')).length, 1); assert.equal(f.events.filter(x => x.startsWith('complete:')).length, 0);
});
test('timeout, lifecycle null/throw and replay never complete or save', async () => { let resolve; const f = fixture({ timeoutMs: 5, ai: () => new Promise(r => { resolve = r; }) }); const c = f.api.confirm(f.api.prepare(request()), { confirmed: true }); const out = await f.api.execute(c); assert.equal(out.reason, 'ai-cancelled'); resolve({ content: 'late' }); assert.equal(f.events.filter(x => x.startsWith('fail:')).length, 1); assert.equal(f.events.filter(x => x.startsWith('complete:')).length, 0); const bad = fixture({ create: () => null }); const q = bad.api.confirm(bad.api.prepare(request()), { confirmed: true }); assert.equal((await bad.api.execute(q)).reason, 'lifecycle-failed'); assert.equal(bad.events.includes('ai'), false); const replay = fixture(); const r = replay.api.confirm(replay.api.prepare(request()), { confirmed: true }); await replay.api.execute(r); assert.equal((await replay.api.execute(r)).reason, 'invalid-confirmed-state'); assert.equal(replay.events.filter(x => x === 'create').length, 1); });
test('public projection excludes raw context, messages, lifecycle and save handles', () => { const f = fixture(); const p = f.api.prepare(request()); const json = JSON.stringify(f.api.project(p)); assert.equal(/private|ClinicalContext|createActionRun|saveSupervision|executor|messages/.test(json), false); });
