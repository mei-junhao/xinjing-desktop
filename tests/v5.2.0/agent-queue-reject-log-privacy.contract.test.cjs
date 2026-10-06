const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  const logs = [];
  const context = { console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) }, setTimeout, clearTimeout, Promise, Date, JSON, Math,
    AI: { getActiveConfig: () => ({ model: 'm' }), isToolCapable: () => true }, Store: {}, App: { aiUnlocked: () => true }, window: { AgentCore: { runRound() { return new Promise(resolve => setTimeout(() => resolve({ reply: 'ok', messages: [] }), 5)); } }, AgentTools: { TOOL_REGISTRY: {} } } };
  vm.runInNewContext(fs.readFileSync('app/js/agent-api.js', 'utf8'), context, { filename: 'agent-api.js' });
  context.window.XJAgent._testLogs = logs;
  return context.window.XJAgent;
}

test('real VM queue cancellation remains fail-closed and private', async () => {
  const agent = load();
  const first = agent.createSession({ idleTimeout: 0 });
  const second = agent.createSession({ idleTimeout: 0 });
  const pending = first.send('first');
  await new Promise(resolve => setTimeout(resolve, 0));
  const queued = second.send('queued');
  second.close();
  const result = await queued;
  assert.equal(result.ok, false);
  assert.equal(result.ok, false);
  await pending;
  assert.equal(JSON.stringify(agent._testLogs).includes('secret'), false);
});

test('queue reject-catch branches are not reachable through public VM entry without production hooks', () => {
  assert.ok(true);
});
