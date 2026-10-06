const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(agentCore, shortenSessionTimeout = false) {
  const timers = {
    setTimeout(fn, ms, ...args) { return setTimeout(fn, shortenSessionTimeout && ms === 300000 ? 5 : ms, ...args); },
    clearTimeout
  };
  const logs = [];
  const vmConsole = { log: (...args) => logs.push(['log', ...args]), warn: (...args) => logs.push(['warn', ...args]), error: (...args) => logs.push(['error', ...args]) };
  const context = {
    console: vmConsole, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, Promise, Date, JSON, Math,
    AI: {}, Store: {}, App: { aiUnlocked: () => true },
    window: { AgentCore: agentCore, AgentTools: { TOOL_REGISTRY: {
      read_tool: { kind: 'read', schema: { function: { description: 'read' } } },
      write_tool: { kind: 'write', schema: { function: { description: 'write' } } }
    } } }
  };
  vm.runInNewContext(fs.readFileSync('app/js/agent-api.js', 'utf8'), context, { filename: 'agent-api.js' });
  context.window.XJAgent._testLogs = logs;
  return context.window.XJAgent;
}

test('known provider errors never leak raw message into VM console logs', async () => {
  const secret = 'provider-secret-clinical-text';
  const errors = [];
  const agent = load({ runRound() { return Promise.reject({ code: 'MODEL_TIMEOUT', message: secret }); } });
  const s = agent.createSession({ idleTimeout: 0, onError: value => errors.push(value) });
  const result = await s.send('timeout');
  assert.equal(result.ok, false);
  assert.equal(result.error, '操作超时');
  assert.equal(result.code, 'MODEL_TIMEOUT');
  assert.deepEqual(errors, ['操作超时']);
  assert.equal(JSON.stringify(agent._testLogs).includes(secret), false);
  assert.equal(agent._testLogs.some(entry => entry[0] === 'error' && String(entry[1]).includes('MODEL_TIMEOUT')), true);
});

test('unknown session errors never leak raw message or object into result, callback, or VM logs', async () => {
  for (const thrown of [new Error('unknown-provider-secret-clinical'), { detail: 'unknown-object-secret-clinical' }]) {
    const errors = [];
    const agent = load({ runRound() { return Promise.reject(thrown); } });
    const s = agent.createSession({ idleTimeout: 0, onError: value => errors.push(value) });
    const result = await s.send('unknown');
    const serialized = JSON.stringify({ result, errors, logs: agent._testLogs });
    assert.equal(result.ok, false);
    assert.equal(result.error, '模型调用失败');
    assert.equal(result.code, 'MODEL_ERROR');
    assert.deepEqual(errors, ['模型调用失败']);
    assert.equal(serialized.includes('unknown-provider-secret-clinical'), false);
    assert.equal(serialized.includes('unknown-object-secret-clinical'), false);
    assert.equal(agent._testLogs.some(entry => entry[0] === 'error' && String(entry[1]).includes('MODEL_ERROR')), true);
  }
});

test('Session forwards ordered content-only stream callbacks and suppresses late callbacks', async () => {
  const events = [];
  let emitLate;
  const agent = load({ runRound(messages, confirm, progress, event, onDelta, onReasoning) {
    assert.equal(typeof onDelta, 'function'); assert.equal(typeof onReasoning, 'function');
    events.push('run'); onDelta('partial', { secret: 'hidden' }); events.push('delta');
    onReasoning('thinking', { payload: 'hidden' }); events.push('reasoning');
    emitLate = () => { onDelta('late'); onReasoning('late-reasoning'); };
    return Promise.resolve({ reply: 'final', messages: messages.concat({ role: 'assistant', content: 'final' }) });
  } });
  const seen = []; const s = agent.createSession({ idleTimeout: 0, onDelta: v => seen.push(['delta', v]), onReasoning: v => seen.push(['reasoning', v]) });
  const result = await s.send('hello');
  assert.equal(result.ok, true); assert.equal(result.data, 'final');
  assert.deepEqual(events, ['run', 'delta', 'reasoning']);
  assert.deepEqual(seen, [['delta', 'partial'], ['reasoning', 'thinking']]);
  assert.equal(JSON.stringify(seen).includes('secret'), false);
  emitLate(); assert.deepEqual(seen, [['delta', 'partial'], ['reasoning', 'thinking']]);
  s.close(); emitLate(); assert.deepEqual(seen, [['delta', 'partial'], ['reasoning', 'thinking']]);
});

test('terminal failure closes stream and preserves write confirmation gate', async () => {
  let late; const seen = []; let confirms = 0;
  const agent = load({ runRound(messages, onConfirm, p, e, onDelta, onReasoning) {
    late = () => { onDelta('late'); onReasoning('late'); onConfirm({ function: { name: 'write_tool' } }, { value: 'x' }); };
    return Promise.resolve({ error: 'provider secret should stay private' });
  } });
  const s = agent.createSession({ idleTimeout: 0, allowWrite: true, onDelta: v => seen.push(v), onReasoning: v => seen.push(v), onConfirm: async () => { confirms++; return { ok: true }; } });
  const result = await s.send('please write');
  assert.equal(result.ok, false); assert.equal(result.code, 'MODEL_ERROR'); assert.equal(JSON.stringify(result).includes('provider secret'), false);
  late(); assert.deepEqual(seen, []);
  assert.equal(confirms, 0);
  late(); assert.equal(confirms, 0);
});

test('pre-terminal event and confirmation remain available', async () => {
  const seen = []; let confirms = 0; let release;
  const agent = load({ runRound(messages, onConfirm, p, onEvent) {
    onEvent({ type: 'tool_call', name: 'write_tool', args: { value: 'x' } });
    release = () => onConfirm({ function: { name: 'write_tool' } }, { value: 'x' });
    return new Promise(resolve => setTimeout(() => resolve({ reply: 'ok', messages }), 5));
  } });
  const s = agent.createSession({ idleTimeout: 0, allowWrite: true, onToolCall: v => seen.push(v), onConfirm: async () => { confirms++; return { ok: true }; } });
  const pending = s.send('write');
  const confirmation = await new Promise(resolve => setTimeout(() => resolve(release()), 0));
  assert.equal((await confirmation).ok, true); assert.equal(confirms, 1); assert.equal(seen.length, 1);
  await pending;
});

test('Session.close suppresses all callbacks while runRound remains pending', async () => {
  let emitLate;
  const seen = []; let confirms = 0; let settle;
  const agent = load({ runRound(messages, onConfirm, progress, onEvent, onDelta, onReasoning) {
    emitLate = () => {
      onEvent({ type: 'tool_call', name: 'write_tool', args: {} });
      onConfirm({ function: { name: 'write_tool' } }, {});
      onDelta('late-delta'); onReasoning('late-reasoning');
    };
    return new Promise(resolve => { settle = resolve; });
  } });
  const s = agent.createSession({ idleTimeout: 0, allowWrite: true,
    onToolCall: v => seen.push(v), onDelta: v => seen.push(v), onReasoning: v => seen.push(v),
    onConfirm: async () => { confirms++; return { ok: true }; } });
  const pending = s.send('pending');
  await new Promise(resolve => setTimeout(resolve, 0));
  s.close(); emitLate();
  assert.deepEqual(seen, []); assert.equal(confirms, 0);
  assert.equal(s._closed, true);
  settle({ reply: 'ignored', messages: [] });
  await pending;
});

test('timeout-shaped terminal rejection suppresses all late callbacks', async () => {
  let emitLate;
  const seen = []; let confirms = 0; const errors = [];
  const agent = load({ runRound(messages, onConfirm, progress, onEvent, onDelta, onReasoning) {
    emitLate = () => {
      onEvent({ type: 'tool_call', name: 'write_tool', args: {} });
      onConfirm({ function: { name: 'write_tool' } }, {});
      onDelta('late-delta'); onReasoning('late-reasoning');
    };
    return Promise.reject({ code: 'MODEL_TIMEOUT', message: 'provider timeout secret' });
  } });
  const s = agent.createSession({ idleTimeout: 0, allowWrite: true,
    onToolCall: v => seen.push(v), onDelta: v => seen.push(v), onReasoning: v => seen.push(v),
    onError: e => errors.push(e), onConfirm: async () => { confirms++; return { ok: true }; } });
  const result = await s.send('timeout');
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('provider timeout secret'), false);
  assert.deepEqual(errors, ['操作超时']);
  assert.equal(JSON.stringify(errors).includes('provider timeout secret'), false);
  emitLate();
  assert.deepEqual(seen, []); assert.equal(confirms, 0);
});

test('chat preserves stream options through temporary Session', async () => {
  const seen = [];
  const agent = load({ runRound(messages, a, b, c, onDelta, onReasoning) { onDelta('d'); onReasoning('r'); return Promise.resolve({ reply: 'ok', messages }); } });
  const result = await agent.chat('hi', { idleTimeout: 0, onDelta: v => seen.push(v), onReasoning: v => seen.push(v) });
  assert.equal(result.data, 'ok'); assert.deepEqual(seen, ['d', 'r']);
});

test('close during pending session confirmation fails closed and never executes write', async () => {
  let releaseConfirm; let writeExecuted = 0; let confirmStarted;
  const started = new Promise(resolve => { confirmStarted = resolve; });
  const agent = load({ runRound(messages, onConfirm) {
    return Promise.resolve(onConfirm({ function: { name: 'write_tool' } }, { value: 'x' }))
      .then(decision => { if (decision.ok) writeExecuted++; return { reply: 'done', messages }; });
  } });
  const session = agent.createSession({ idleTimeout: 0, allowWrite: true, onConfirm: async () => {
    confirmStarted(); return new Promise(resolve => { releaseConfirm = resolve; });
  } });
  const pending = session.send('write'); await started; session.close(); releaseConfirm({ ok: true });
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(writeExecuted, 0);
});

test('close during pending fallback writeGuard fails closed and never executes write', async () => {
  let releaseGuard; let writeExecuted = 0; let guardStarted;
  const started = new Promise(resolve => { guardStarted = resolve; });
  const agent = load({ runRound(messages, onConfirm) {
    return Promise.resolve(onConfirm({ function: { name: 'write_tool' } }, { value: 'x' }))
      .then(decision => { if (decision.ok) writeExecuted++; return { reply: 'done', messages }; });
  } });
  agent.setWriteGuard(async () => { guardStarted(); return new Promise(resolve => { releaseGuard = resolve; }); });
  const session = agent.createSession({ idleTimeout: 0, allowWrite: true });
  const pending = session.send('write'); await guardStarted; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof releaseGuard, 'function'); session.close(); releaseGuard(true);
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(writeExecuted, 0);
});

test('shortened session timeout rejects late session confirmation', async () => {
  let releaseConfirm; let writeExecuted = 0; let confirmStarted;
  const started = new Promise(resolve => { confirmStarted = resolve; });
  const agent = load({ runRound(messages, onConfirm) {
    return Promise.resolve(onConfirm({ function: { name: 'write_tool' } }, { value: 'x' }))
      .then(decision => { if (decision.ok) writeExecuted++; return { reply: 'done', messages }; });
  } }, true);
  const session = agent.createSession({ idleTimeout: 0, allowWrite: true, onConfirm: async () => {
    confirmStarted(); return new Promise(resolve => { releaseConfirm = resolve; });
  } });
  const pending = session.send('write'); await started;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_TIMEOUT');
  assert.equal(result.error, '操作超时（300000ms）');
  releaseConfirm({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writeExecuted, 0);
});

test('shortened session timeout rejects late fallback writeGuard confirmation', async () => {
  let releaseGuard; let writeExecuted = 0; let guardStarted;
  const started = new Promise(resolve => { guardStarted = resolve; });
  const agent = load({ runRound(messages, onConfirm) {
    return Promise.resolve(onConfirm({ function: { name: 'write_tool' } }, { value: 'x' }))
      .then(decision => { if (decision.ok) writeExecuted++; return { reply: 'done', messages }; });
  } }, true);
  agent.setWriteGuard(async () => { guardStarted(); return new Promise(resolve => { releaseGuard = resolve; }); });
  const session = agent.createSession({ idleTimeout: 0, allowWrite: true });
  const pending = session.send('write'); await guardStarted;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_TIMEOUT');
  assert.equal(result.error, '操作超时（300000ms）');
  releaseGuard(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writeExecuted, 0);
});
