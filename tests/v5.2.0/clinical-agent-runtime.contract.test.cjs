const test = require('node:test');
const assert = require('node:assert/strict');
const Runtime = require('../../app/js/clinical-agent-runtime.js');
const fs = require('fs'); const vm = require('vm');
const draft = JSON.stringify({ facts: 'draft [s1]', inferences: '', hypotheses: '' });
function fixture() {
  const calls = { build: [], exec: 0, ai: 0, persist: 0 };
  const workflow = { prepare(r) { return { ok: true, runId: r.runId, taskId: r.taskId || (r.text.includes('督导') ? 'supervision-question-builder' : 'session-review'), status: 'awaiting-confirmation', snapshotKey: r.snapshotKey, sources: r.sources }; }, confirm(s, c) { return c && c.confirmed === true ? { ...s, ok: true, status: 'running', outputDisposition: 'draft' } : { ok: false, reason: 'confirmation-required' }; }, cancel(s) { return { ...s, ok: false, status: 'cancelled', reason: 'cancelled' }; }, isWorkflowState(v) { return !!v; } };
  const adapter = { create(r) { calls.build.push(r.taskId); if (r.sources && r.sources[0] && r.sources[0].id === 'bad') return { ok: false, reason: 'source-mismatch' }; return { ok: true, status: 'awaiting-confirmation', runId: r.runId, taskId: r.taskId, snapshotKey: r.snapshotKey, sources: r.sources }; }, async execute(s, o) { calls.exec++; if (o.isCancelled && o.isCancelled()) return { ok: false, reason: 'cancelled' }; return { ok: true, snapshotKey: s.snapshotKey, taskId: s.taskId, sources: s.sources, draft: { summary: 'draft' } }; } };
  return { calls, workflow, adapter, runtime: Runtime.withDependencies({ workflow, adapter }) };
}
function req(text = '请做会谈复盘', taskId) { return { text, taskId, runId: 'run-1', snapshotKey: 'snap-1', sources: [{ kind: taskId === 'supervision-question-builder' ? 'supervision' : 'session', id: 's1' }], inputText: text }; }
test('browser UMD passes root into factory and resolves global adapter/workflow', () => {
  const source = fs.readFileSync(require.resolve('../../app/js/clinical-agent-runtime.js'), 'utf8');
  const root = { ClinicalAgentWorkflow: { prepare: () => ({ ok:true }), confirm: () => ({ ok:true }), cancel: () => ({ ok:false }), isWorkflowState: () => true }, ClinicalAgentAdapter: { withDependencies: () => ({ create: () => ({ ok:true }), execute: async () => ({ ok:true }) }) }, ClinicalContext: { build: () => ({}), isSnapshotCurrent: () => true }, AI: { send: () => {} } };
  vm.runInNewContext(source, root, { filename: 'clinical-agent-runtime.js' });
  assert.equal(typeof root.ClinicalAgentRuntime.fromGlobals, 'function');
  assert.doesNotThrow(() => root.ClinicalAgentRuntime.fromGlobals({}));
});
test('prepare prefers canonical clinical inputText over command text', () => {
  const f = fixture(); const seen = []; f.adapter.create = r => { seen.push(r.inputText); return { ok:true, runId:r.runId, taskId:r.taskId, snapshotKey:r.snapshotKey, sources:r.sources }; };
  f.runtime.prepare({ ...req('生成整体印象'), inputText: '合成临床材料：关系焦虑。' });
  assert.deepEqual(seen, ['合成临床材料：关系焦虑。']);
  f.runtime.prepare({ ...req('仅命令文本'), inputText: undefined });
  assert.equal(seen[1], '仅命令文本');
});
test('positive session and supervision lifecycle binds handles', async () => { const f = fixture(); let p = f.runtime.prepare(req()); let c = f.runtime.confirm(p, { confirmed: true }); let r = await f.runtime.execute(c); assert.equal(r.status, 'draft-ready'); assert.equal(f.calls.exec, 1); p = f.runtime.prepare(req('督导问题生成', 'supervision-question-builder')); assert.equal(f.runtime.confirm(p, { confirmed: true }).status, 'running'); assert.deepEqual(f.calls.build, ['session-review', 'supervision-question-builder']); });
test('confirmation, admission, cancellation and replay fail closed', async () => { const f = fixture(); const p = f.runtime.prepare(req()); assert.equal(f.runtime.confirm(p, { confirmed: false }).reason, 'confirmation-required'); assert.equal(f.calls.exec, 0); const bad = f.runtime.prepare(req()); bad && f.runtime.cancel(bad); assert.equal((await f.runtime.execute(bad)).reason, 'invalid-confirmed-state'); const rejected = f.runtime.prepare({ ...req(), sources: [{ kind: 'session', id: 'bad' }] }); assert.equal(rejected.reason, 'source-mismatch'); assert.equal(f.calls.exec, 0); });
test('adapter errors, cancellation and metadata projection remain private', async () => { const f = fixture(); const p = f.runtime.prepare(req()); const c = f.runtime.confirm(p, { confirmed: true }); const r = await f.runtime.execute(c, { isCancelled: () => true }); assert.equal(r.reason, 'ai-cancelled'); assert.equal(f.runtime.project(c).draft, undefined); assert.equal(JSON.stringify(r).includes('executor'), false); });
test('fromGlobals calls AI.send through the real adapter factory and normalizes callback/promise failures', async () => {
  const base = fixture(); let sends = 0; let seenMessages; let seenOptions;
  const context = { build(task) { assert.equal(task, 'session-review'); return { ok: true, task, outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [{ kind: 'session', id: 's1' }], messages: [{ role: 'user', content: 'clinical' }] }; }, isSnapshotCurrent: () => true };
  const ai = { send(messages, cb, options) { sends++; seenMessages = messages; seenOptions = options; cb({ content: draft }); } };
  const rt = Runtime.fromGlobals({ workflow: base.workflow, ClinicalContext: context, AI: ai, adapter: { withDependencies: deps => require('../../app/js/clinical-agent-adapter.js').withDependencies(deps) } });
  const p = rt.prepare(req()); const c = rt.confirm(p, { confirmed: true }); const out = await rt.execute(c); assert.equal(out.status, 'draft-ready'); assert.equal(sends, 1); assert.equal(seenMessages.find(message => message.role === 'user').content, 'clinical'); assert.match(seenMessages.find(message => message.role === 'system').content, /会谈复盘/); assert.equal(seenOptions.taskId, 'session-review');
  for (const send of [(m, cb) => cb({ error: 'secret' }), (m, cb) => Promise.reject(new Error('secret')), (m, cb) => cb({ interrupted: true })]) { const failing = Runtime.fromGlobals({ workflow: base.workflow, ClinicalContext: context, AI: { send } , adapter: { withDependencies: deps => require('../../app/js/clinical-agent-adapter.js').withDependencies(deps) } }); const q = failing.confirm(failing.prepare(req()), { confirmed: true }); const r = await failing.execute(q); assert.ok(['ai-failed', 'ai-cancelled'].includes(r.reason)); assert.equal(JSON.stringify(r).includes('secret'), false); }
});

test('fromGlobals forwards onDelta through runtime and suppresses cancellation/late callbacks', async () => {
  const base = fixture(); const context = { build: () => ({ ok:true, task:'session-review', outputMode:'preview-only', snapshot:{key:'snap-1'}, sources:[{kind:'session',id:'s1'}], messages:[{role:'user',content:'synthetic'}] }), isSnapshotCurrent:() => true };
  const events = [];
  const ai = { send(messages, cb, options) { events.push('send'); options.onDelta('partial', 'partial'); events.push('delta'); cb({ content:draft, providerSecret:'hidden' }); } };
  const rt = Runtime.fromGlobals({ workflow: base.workflow, ClinicalContext: context, AI: ai, adapter:{withDependencies:d=>require('../../app/js/clinical-agent-adapter.js').withDependencies(d)} });
  const c = rt.confirm(rt.prepare(req()), {confirmed:true});
  const run = rt.execute(c, { onDelta: value => events.push('ui:' + value) });
  assert.deepEqual(events, ['send', 'ui:partial', 'delta', 'ui:' + draft]);
  const out = await run;
  assert.equal(out.status, 'draft-ready');
  assert.deepEqual(events, ['send', 'ui:partial', 'delta', 'ui:' + draft]);
  assert.equal(JSON.stringify(out).includes('providerSecret'), false);

  let resolve; const late = [];
  const pendingAi = { send(messages, cb) { resolve = cb; } };
  const cancelledRt = Runtime.fromGlobals({ workflow: base.workflow, ClinicalContext: context, AI: pendingAi, adapter:{withDependencies:d=>require('../../app/js/clinical-agent-adapter.js').withDependencies(d)} });
  const c2 = cancelledRt.confirm(cancelledRt.prepare(req()), {confirmed:true});
  const pending = cancelledRt.execute(c2, { onDelta: value => late.push(value) });
  cancelledRt.cancel(c2, 'user-cancel');
  resolve({ content:'late' });
  assert.equal((await pending).reason, 'ai-cancelled');
  assert.deepEqual(late, []);
});
test('pending execution timeout and runtime cancel reject late success', async () => {
  let resolve;
  const f = fixture();
  f.adapter.execute = () => new Promise(r => { resolve = r; });
  const p = f.runtime.prepare(req());
  const c = f.runtime.confirm(p, { confirmed: true });
  const pending = f.runtime.execute(c, { timeoutMs: 10 });
  const timed = await pending;
  assert.equal(timed.reason, 'ai-cancelled');
  resolve({ ok: true, draft: 'late', snapshotKey: 'snap-1', sources: c.sources });
  assert.equal((await pending).reason, 'ai-cancelled');
  const p2 = f.runtime.prepare(req());
  const c2 = f.runtime.confirm(p2, { confirmed: true });
  let resolve2;
  f.adapter.execute = () => new Promise(r => { resolve2 = r; });
  const run = f.runtime.execute(c2);
  assert.equal(f.runtime.cancel(c2, 'user-cancel').status, 'cancelled');
  resolve2({ ok: true, draft: 'late', snapshotKey: 'snap-1', sources: c2.sources });
  assert.equal((await run).reason, 'ai-cancelled');
});

test('fromGlobals propagates per-execution abort signals without cross-talk', async () => {
  const base = fixture(); const context = { build: () => ({ ok:true, task:'session-review', outputMode:'preview-only', snapshot:{key:'snap-1'}, sources:[{kind:'session',id:'s1'}], messages:[{role:'user',content:'x'}] }), isSnapshotCurrent:()=>true };
  const seen = []; const resolvers = [];
  const ai = { send(m, cb, o) { seen.push(o.signal); resolvers.push(cb); } };
  const rt = Runtime.fromGlobals({ workflow: base.workflow, ClinicalContext: context, AI: ai, adapter:{withDependencies:d=>require('../../app/js/clinical-agent-adapter.js').withDependencies(d)} });
  const c1 = rt.confirm(rt.prepare(req()), {confirmed:true}); const c2 = rt.confirm(rt.prepare({...req(), runId:'run-2'}), {confirmed:true});
  const p1 = rt.execute(c1); const p2 = rt.execute(c2); assert.equal(seen.length,2); assert.notEqual(seen[0], seen[1]); rt.cancel(c1); assert.equal(seen[0].aborted,true); assert.equal(seen[1].aborted,false); resolvers[0]({content:'late'}); resolvers[1]({content:draft}); assert.equal((await p1).reason,'ai-cancelled'); assert.equal((await p2).status,'draft-ready');
});

test('全局运行时默认超时生效，单次执行可显式覆盖', async () => {
  const base = fixture();
  const context = { build: () => ({ ok: true, task: 'session-review', outputMode: 'preview-only', snapshot: { key: 'snap-1' }, sources: [{ kind: 'session', id: 's1' }], messages: [{ role: 'user', content: 'synthetic' }] }), isSnapshotCurrent: () => true };
  let callback, signal;
  const rt = Runtime.fromGlobals({ workflow: base.workflow, ClinicalContext: context, adapter: require('../../app/js/clinical-agent-adapter.js'), timeoutMs: 10, AI: { send(_messages, cb, options) { callback = cb; signal = options.signal; } } });
  const timed = rt.confirm(rt.prepare(req()), { confirmed: true });
  assert.equal((await rt.execute(timed)).reason, 'ai-cancelled');
  assert.equal(signal.aborted, true);
  callback({ content: draft });
  assert.equal((await rt.execute(timed)).reason, 'invalid-confirmed-state');
  const overridden = rt.confirm(rt.prepare({ ...req(), runId: 'override-timeout' }), { confirmed: true });
  let settled = false;
  const pending = rt.execute(overridden, { timeoutMs: 0 }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false);
  assert.equal(signal.aborted, false);
  callback({ content: draft });
  assert.equal((await pending).status, 'draft-ready');
});
