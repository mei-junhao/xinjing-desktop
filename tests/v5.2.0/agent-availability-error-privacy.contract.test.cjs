const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(overrides = {}) {
  const logs = [];
  const context = { console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) }, setTimeout, clearTimeout, Promise, Date, JSON, Math,
    AI: overrides.AI || {}, Store: {}, App: overrides.App || { aiUnlocked: () => true }, window: { AgentCore: overrides.AgentCore || { runRound: () => Promise.resolve({ reply: 'ok', messages: [] }) }, AgentTools: { TOOL_REGISTRY: {} } } };
  vm.runInNewContext(fs.readFileSync('app/js/agent-api.js', 'utf8'), context, { filename: 'agent-api.js' });
  context.window.XJAgent._testLogs = logs;
  return context.window.XJAgent;
}

test('availability dependency throws stay private while normal paths remain stable', () => {
  const secret = 'availability-secret-clinical';
  for (const overrides of [
    { App: { aiUnlocked() { throw new Error(secret); } } },
    { AI: { getActiveConfig() { throw new Error(secret); }, isToolCapable() { return true; } } },
    { AI: { getActiveConfig() { return { model: 'm' }; }, isToolCapable() { throw new Error(secret); } } }
  ]) {
    const agent = load(overrides);
    const result = agent.getAvailabilityReason();
    assert.equal(typeof result, 'string');
    assert.equal(result.includes(secret), false);
    assert.equal(JSON.stringify(agent._testLogs).includes(secret), false);
  }
  assert.equal(load({ App: { aiUnlocked: () => false } }).getAvailabilityReason(), '授权已失效，请重新激活');
  assert.match(load({ AI: { getActiveConfig: () => ({ model: 'unsupported' }), isToolCapable: () => false } }).getAvailabilityReason(), /unsupported/);
});

test('chat Session construction failure is safe and successful chat remains unchanged', async () => {
  const secret = 'session-constructor-secret';
  const bad = load();
  const options = {};
  Object.defineProperty(options, 'maxSteps', { get() { throw new Error(secret); } });
  const result = await bad.chat('hello', options);
  assert.equal(result.ok, false); assert.equal(result.code, 'SYS_INTERNAL_ERROR');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(bad._testLogs).includes(secret), false);
  const good = load();
  const success = await good.chat('hello');
  assert.equal(success.ok, true); assert.equal(success.data, 'ok');
});
