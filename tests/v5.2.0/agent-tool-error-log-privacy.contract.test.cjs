const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(toolInvoke) {
  const logs = [];
  const registry = { read_tool: { kind: 'read', schema: { function: { description: 'read' } } }, write_tool: { kind: 'write', schema: { function: { description: 'write' } } } };
  const context = { console: { log: (...a) => logs.push(['log', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) }, setTimeout, clearTimeout, Promise, Date, JSON, Math,
    AI: {}, Store: {}, App: { aiUnlocked: () => true }, window: { AgentCore: {}, AgentTools: { TOOL_REGISTRY: registry, invoke: toolInvoke } } };
  vm.runInNewContext(fs.readFileSync('app/js/agent-api.js', 'utf8'), context, { filename: 'agent-api.js' });
  context.window.XJAgent._testLogs = logs;
  return context.window.XJAgent;
}

function assertPrivate(result, secret, code) {
  assert.equal(result.ok, false); assert.equal(result.code, code);
  assert.equal(JSON.stringify(result).includes(secret), false);
}

test('invokeTool low-level failures keep safe result and VM logs', async () => {
  const secret = 'tool-secret-clinical';
  const agent = load(() => { throw new Error(secret); });
  const args = {}; Object.defineProperty(args, 'secret', { enumerable: true, get() { throw new Error('top-level-' + secret); } });
  const top = await agent.invokeTool('read_tool', { args });
  assertPrivate(top, secret, 'SYS_INTERNAL_ERROR');
  agent.setWriteGuard(async () => { throw new Error('guard-write-secret-clinical'); });
  const guard = await agent.invokeTool('write_tool', { args: { value: 'x' }, allowWrite: true });
  assertPrivate(guard, secret, 'SEC_WRITE_DENIED');
  const sync = await agent.invokeTool('read_tool', { args: { value: 'x' } });
  assertPrivate(sync, secret, 'TOOL_ERROR');
  assert.equal(JSON.stringify(agent._testLogs).includes(secret), false);
  assert.equal(JSON.stringify(agent._testLogs).includes('guard-write-secret-clinical'), false);
});

test('rejected tool promise and unknown object stay private while success and timeout preserve contracts', async () => {
  const secret = 'rejected-tool-secret';
  const agent = load(() => Promise.reject({ detail: secret }));
  const rejected = await agent.invokeTool('read_tool', { args: { value: 'x' } });
  assertPrivate(rejected, secret, 'TOOL_ERROR');
  assert.equal(JSON.stringify(agent._testLogs).includes(secret), false);
  const success = load(() => Promise.resolve({ ok: true, data: { value: 1 } }));
  assert.deepEqual(await success.invokeTool('read_tool', { args: { value: 'x' } }), { ok: true, data: { value: 1 } });
  const timeout = load(() => new Promise(() => {}));
  const timed = await timeout.invokeTool('read_tool', { args: { value: 'x' }, timeout: 5 });
  assertPrivate(timed, 'never-secret', 'TOOL_TIMEOUT');
});
