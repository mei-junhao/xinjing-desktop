const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const root = require('node:path').resolve(__dirname, '../..');
const apiSource = fs.readFileSync(require('node:path').join(root, 'app/js/agent-api.js'), 'utf8');

function scripts(file) {
  return [...fs.readFileSync(require('node:path').join(root, 'app', file), 'utf8').matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
}

function loadApi(registry) {
  const context = {
    window: {}, console: { log() {}, warn() {}, error() {} },
    AI: { getActiveConfig: () => ({ model: 'synthetic' }), isToolCapable: () => true },
    Store: {}, App: { aiUnlocked: () => true }, setTimeout, clearTimeout, Promise, Date,
    AgentTools: { TOOL_REGISTRY: registry, invoke: async (name, args) => registry[name].execute(args) },
    AgentCore: { runRound: async messages => ({ reply: 'ok', messages }) }
  };
  context.window.AgentTools = context.AgentTools;
  context.window.AgentCore = context.AgentCore;
  vm.runInNewContext(apiSource, context, { filename: 'agent-api.js' });
  return context.window.XJAgent;
}

test('target pages load XJAgent exactly once after tool/core dependencies', () => {
  for (const page of ['index.html', 'chat-home.html']) {
    const list = scripts(page);
    assert.equal(list.filter(x => x === 'js/agent-api.js').length, 1, page);
    assert.ok(list.indexOf('js/agent-tools.js') < list.indexOf('js/agent-api.js'), page);
    assert.ok(list.indexOf('js/agent-core.js') < list.indexOf('js/agent-api.js'), page);
  }
});

test('real facade exposes safe session and tool behavior', async () => {
  const registry = {
    'read.note': { kind: 'read', schema: { function: { description: 'read' } }, execute: async () => ({ ok: true, data: 'read' }) },
    'write.note': { kind: 'write', schema: { function: { description: 'write' } }, execute: async () => ({ ok: true }) }
  };
  const api = loadApi(registry);
  assert.equal(api.getAvailabilityReason(), null);
  for (const key of ['chat', 'createSession', 'invokeTool', 'listTools', 'getAvailabilityReason', 'ERR']) assert.ok(api[key]);
  assert.deepEqual(await api.invokeTool('read.note', { args: {} }), { ok: true, data: 'read' });
  const denied = await api.invokeTool('write.note', { args: {} });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, api.ERR.SEC_WRITE_DENIED);
  api.setWriteGuard(() => true);
  assert.equal((await api.invokeTool('write.note', { args: {}, allowWrite: true })).ok, true);
  const session = api.createSession({ allowWrite: false });
  const sent = await session.send('hello');
  assert.equal(sent.ok, true);
  session.close();
  assert.equal((await session.send('after close')).ok, false);
  const failure = await api.invokeTool('missing.tool', { args: {} });
  assert.equal(failure.ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(failure, 'executor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(failure, 'payload'), false);
});

test('write confirmation remains fail-closed when guard throws', async () => {
  const api = loadApi({ 'write.note': { kind: 'write', execute: async () => ({ ok: true }) } });
  api.setWriteGuard(() => { throw new Error('private'); });
  const result = await api.invokeTool('write.note', { args: {}, allowWrite: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, api.ERR.SEC_WRITE_DENIED);
  assert.equal(result.error.includes('private'), false);
});
