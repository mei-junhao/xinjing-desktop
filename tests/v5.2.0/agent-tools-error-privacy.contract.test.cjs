const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SECRET = 'synthetic-provider-secret-036';

function load(overrides = {}, source = fs.readFileSync('app/js/agent-tools.js', 'utf8')) {
  const logs = [];
  const client = { id: 'c1', name: '合成来访者', createdAt: '2026-01-01', billing: { monthlyPayments: [{ month: '2026-10', amount: 20 }] } };
  let supervision = { id: 'sv1', content: '合成督导内容' };
  const store = {
    getClients: () => [client],
    getClient: id => id === 'c1' ? client : null,
    getSessions: () => [{ clientId: 'c1', date: '2026-10-01', billing: { fee: 100, paid: false } }],
    getSessionsByClient: id => id === 'c1' ? [{ id: 's1', clientId: 'c1', date: '2026-10-01', billing: { fee: 100, paid: false } }] : [],
    isBillableSession: session => !!session.billing,
    createClientDurable: async () => {
      if (overrides.createClient) return overrides.createClient();
      return { ok: false, error: { message: SECRET + '-create-client-result' } };
    },
    createSessionDurable: async () => {
      if (overrides.createSession) return overrides.createSession();
      return { ok: false, error: { message: SECRET + '-create-session-result' } };
    },
    updateClientDurable: async () => {
      if (overrides.updateClient) return overrides.updateClient();
      return { ok: false, error: { message: SECRET + '-update-client-result' } };
    },
    saveAiSupervisionDurable: async value => {
      if (overrides.saveSupervision) return overrides.saveSupervision(value);
      supervision = { id: 'sv1', ...value };
      return { ok: true, value: supervision };
    },
    getSupervision: id => id === 'sv1' ? supervision : null,
    updateSupervisionDurable: async () => {
      if (overrides.updateSupervision) return overrides.updateSupervision();
      return { ok: false, error: { message: SECRET + '-update-supervision-result' } };
    },
    getMasterConversation: id => overrides.getMasterConversation ? overrides.getMasterConversation(id) : null,
    saveMasterConversationDurable: async () => ({ ok: true })
  };
  const supervisionCore = {
    runImpression: async () => overrides.runImpression ? overrides.runImpression() : { chatMessages: [{ role: 'system', content: 'synthetic' }, { role: 'assistant', content: '合成整体印象' }] },
    runRound: async () => overrides.runRound ? overrides.runRound() : { chatMessages: [{ role: 'assistant', content: '合成整体印象' }, { role: 'user', content: '合成问题' }, { role: 'assistant', content: '合成回复' }], reply: '合成回复' }
  };
  const mastersCore = {
    openOrCreateConv: async () => overrides.openMaster ? overrides.openMaster() : { id: 'm1', title: '合成大师', mode: '1v1', masterKeys: ['winnicott'], messages: [] },
    callMaster: async () => overrides.callMaster ? overrides.callMaster() : { content: '合成回复' },
    maybeSummarize: () => {}
  };
  const api = {
    fileRead: async () => ({ ok: true, content: 'synthetic', path: 'synthetic.txt', size: 9 }),
    fileWrite: async () => ({ ok: true, path: 'synthetic.txt', bytes: 1 }),
    fileGetWorkdir: async () => ({ ok: true, workdir: 'synthetic-workdir' })
  };
  const context = {
    Store: store,
    SupervisionCore: supervisionCore,
    MastersCore: mastersCore,
    getMasterByKey: key => ({ key }),
    MASTERS: [{ key: 'winnicott' }],
    window: { MASTERS: [{ key: 'winnicott' }], __XJ_API__: api },
    console: {
      log: (...args) => logs.push(['log', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args])
    },
    Promise,
    Date,
    JSON,
    Math,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(source, context);
  return { invoke: context.window.AgentTools.invoke, logs, store, api, setSupervision: value => { supervision = value; } };
}

function serialized(value) {
  return JSON.stringify(value);
}

function assertNoSecret(value) {
  assert.equal(serialized(value).includes(SECRET), false, serialized(value));
}

test('confirmed read-handler Store failures hide Error and unknown-object text', async () => {
  for (const failure of [new Error(SECRET), { message: SECRET, token: SECRET }]) {
    const logs = [];
    const Store = {
      getClients() { throw failure; },
      getSessions() { throw failure; },
      getSupervisions() { throw failure; },
      getClient() { throw failure; }
    };
    const context = { Store, window: {}, console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }, Promise, Date, JSON, Math, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync('app/js/agent-tools.js', 'utf8'), context);
    for (const name of ['billing.summary', 'billing.reminder', 'agent.configure_api', 'client.query', 'session.query', 'supervision.query', 'stats.overview']) {
      const result = await context.window.AgentTools.invoke(name, {});
      assert.equal(result.ok, false);
      assert.equal(result.error, '工具执行失败');
      assertNoSecret(result);
    }
    assertNoSecret(logs);
  }
});

test('billing partial failures keep their result contract without nested exception text', async () => {
  const { invoke } = load();
  const result = await invoke('billing.add_record', { records: [{ clientId: 'c1', date: '2026-10-06', fee: 120 }] });
  assert.equal(result.ok, true);
  assert.equal(result.data.added, 0);
  assert.equal(result.data.skipped, 1);
  assert.match(result.data.details[0].reason, /落库失败/);
  assertNoSecret(result);

  const createFailure = await invoke('billing.add_record', { records: [{ clientName: '新合成来访者', date: '2026-10-06', fee: 120 }] });
  assert.equal(createFailure.ok, true);
  assert.equal(createFailure.data.details[0].reason, '来访者「新合成来访者」新建失败');
  assertNoSecret(createFailure);

  for (const failure of [
    async () => { throw new Error(SECRET); },
    async () => { throw { message: SECRET, token: SECRET }; }
  ]) {
    const rejected = load({ createClient: failure });
    const result = await rejected.invoke('billing.add_record', { records: [{ clientName: '新合成来访者', date: '2026-10-06', fee: 120 }] });
    assert.equal(result.ok, true);
    assert.equal(result.data.details[0].reason, '来访者「新合成来访者」新建失败');
    assertNoSecret(result);
  }

  for (const failure of [
    async () => { throw new Error(SECRET); },
    async () => { throw { message: SECRET, token: SECRET }; }
  ]) {
    const rejected = load({ createSession: failure });
    const result = await rejected.invoke('billing.add_record', { records: [{ clientId: 'c1', date: '2026-10-06', fee: 120 }] });
    assert.equal(result.ok, true);
    assert.equal(result.data.details[0].reason, '落库失败：持久化失败');
    assertNoSecret(result);
  }
});

test('monthly settle and client update hide returned and thrown storage errors', async () => {
  for (const overrides of [
    {},
    { updateClient: async () => { throw new Error(SECRET); } },
    { updateClient: async () => { throw { message: SECRET, token: SECRET }; } }
  ]) {
    const { invoke } = load(overrides);
    const result = await invoke('billing.monthly_settle', { clientId: 'c1', month: '2026-11', amount: 25 });
    assert.equal(result.ok, false);
    assertNoSecret(result);
    const append = await invoke('billing.monthly_settle', { clientId: 'c1', month: '2026-10', amount: 25 });
    assert.equal(append.ok, false);
    assertNoSecret(append);
  }

  const resultFailure = load();
  const returned = await resultFailure.invoke('client.update', { clientId: 'c1', patch: { note: '合成备注' } });
  assert.equal(returned.error, '更新失败');
  assertNoSecret(returned);
  for (const failure of [
    async () => { throw new Error(SECRET); },
    async () => { throw { message: SECRET, token: SECRET }; }
  ]) {
    const storeFailure = load({ updateClient: failure });
    const thrown = await storeFailure.invoke('client.update', { clientId: 'c1', patch: { note: '合成备注' } });
    assert.equal(thrown.error, '更新失败');
    assertNoSecret(thrown);
  }
});

test('supervision and masters failures hide raw text and keep only safe structured metadata', async () => {
  const metadataFailure = async () => ({ error: SECRET, errorCode: 'STAGE_TIMEOUT', code: 'XJ_AI_INPUT_BUDGET_EXCEEDED', stage: 'route', failedSegments: [1, 2], totalSegments: 3, totalChars: 10, limitChars: 20, truncated: false, transportState: 'manual-only', token: SECRET });
  const errorFailure = async () => {
    const error = new Error(SECRET);
    error.errorCode = 'STAGE_TIMEOUT';
    error.code = 'XJ_AI_INPUT_BUDGET_EXCEEDED';
    error.stage = 'route';
    error.failedSegments = [1, 2];
    error.totalSegments = 3;
    error.totalChars = 10;
    error.limitChars = 20;
    error.truncated = false;
    error.transportState = 'manual-only';
    throw error;
  };
  const objectFailure = async () => { throw { message: SECRET, token: SECRET }; };
  for (const [failure, keepsMetadata] of [[metadataFailure, true], [errorFailure, true], [objectFailure, false]]) {
    const start = load({ runImpression: failure });
    const started = await start.invoke('supervision.start', { supervisorName: 'nvwa', material: '足够长度的合成督导材料内容' });
    assert.equal(started.ok, false);
    assert.match(started.error, /督导启动失败/);
    assertNoSecret(started);
    if (keepsMetadata) {
      assert.equal(started.errorCode, 'STAGE_TIMEOUT');
      assert.equal(started.code, 'XJ_AI_INPUT_BUDGET_EXCEEDED');
      assert.equal(started.stage, 'route');
      assert.deepEqual(Array.from(started.failedSegments), [1, 2]);
      assert.equal(started.totalSegments, 3);
      assert.equal(started.totalChars, 10);
      assert.equal(started.limitChars, 20);
      assert.equal(started.truncated, false);
      assert.equal(started.transportState, 'manual-only');
      assert.equal(Object.hasOwn(started, 'token'), false);
    } else {
      assert.equal(Object.hasOwn(started, 'errorCode'), false);
      assert.equal(Object.hasOwn(started, 'token'), false);
    }

    const ask = load({ runRound: failure });
    ask.setSupervision({ id: 'sv1', content: '合成督导内容' });
    const asked = await ask.invoke('supervision.ask', { sessionId: 'sv1', question: '合成追问' });
    assert.equal(asked.ok, false);
    assert.match(asked.error, /督导追问失败/);
    assertNoSecret(asked);

    const open = load({ callMaster: failure });
    const opened = await open.invoke('masters.open', { masterId: 'winnicott', topic: '合成主题' });
    assert.equal(opened.ok, false);
    assert.match(opened.error, /大师对话|大师对话请求失败/);
    assertNoSecret(opened);

    const messages = [];
    const message = load({ callMaster: failure, getMasterConversation: () => ({ id: 'm1', mode: '1v1', masterKeys: ['winnicott'], messages }) });
    const sent = await message.invoke('masters.message', { sessionId: 'm1', message: '合成消息' });
    assert.equal(sent.ok, false);
    assert.match(sent.error, /大师消息发送失败/);
    assertNoSecret(sent);
  }
});

test('supervision persistence rejection logs a fixed label and preserves the success result shape', async () => {
  const { invoke, logs } = load({ updateSupervision: async () => { throw new Error(SECRET); } });
  const started = await invoke('supervision.start', { supervisorName: 'nvwa', material: '足够长度的合成督导材料内容' });
  assert.equal(started.ok, true);
  const asked = await invoke('supervision.ask', { sessionId: started.data.sessionId, question: '合成追问' });
  assert.equal(asked.ok, true);
  assert.deepEqual(Object.keys(asked.data).sort(), ['reply', 'sessionId']);
  assertNoSecret(logs);
});

test('stable validation, unknown tool wording, success shape and file permission guidance remain intact', async () => {
  const { invoke, api } = load();
  assert.equal((await invoke('client.update', {})).error, '需提供 clientId + patch');
  assert.equal((await invoke('supervision.start', { supervisorName: 'bad', material: '足够长度的合成督导材料内容' })).error, 'supervisorName 只能是 nvwa 或 cangjie');
  assert.equal((await invoke('unknown.synthetic', {})).error, '未知工具：unknown.synthetic');

  const ok = await invoke('billing.summary', {});
  assert.equal(ok.ok, true);
  assert.equal(ok.data.clientCount, 1);
  assert.equal(ok.data.receivable, 100);

  api.fileWrite = async () => ({ ok: false, code: 'XJ_FILE_PERMISSION', message: '仅工作文件夹内可写入；请先开启完全无限制。', path: 'synthetic.txt' });
  const denied = await invoke('file.write', { path: 'synthetic.txt', content: 'x' });
  assert.equal(denied.error, '仅工作文件夹内可写入；请先开启完全无限制。');
  assert.equal(denied.code, 'XJ_FILE_PERMISSION');

  const opened = await invoke('masters.open', { masterId: 'winnicott' });
  assert.equal(opened.ok, true);
  assert.deepEqual(Object.keys(opened.data).sort(), ['firstReply', 'masterName', 'sessionId']);
  const sent = await invoke('masters.message', { sessionId: opened.data.sessionId, message: '合成消息' });
  assert.equal(sent.ok, true);
  assert.deepEqual(Object.keys(sent.data).sort(), ['reply', 'sessionId']);
});

test('only allowlisted structured failure metadata survives projection', async () => {
  const { invoke } = load({ runImpression: async () => ({ error: SECRET, errorCode: 'bad ' + SECRET, code: SECRET, stage: SECRET, transportState: SECRET, failedSegments: [1, -2, 3.5, SECRET], totalSegments: -1, totalChars: Infinity, limitChars: 20, truncated: 'false', token: SECRET }) });
  const result = await invoke('supervision.start', { supervisorName: 'nvwa', material: '足够长度的合成督导材料内容' });
  assertNoSecret(result);
  assert.equal(result.error, '督导启动失败');
  assert.equal(Object.hasOwn(result, 'errorCode'), false);
  assert.equal(Object.hasOwn(result, 'code'), false);
  assert.equal(Object.hasOwn(result, 'stage'), false);
  assert.equal(Object.hasOwn(result, 'transportState'), false);
  assert.deepEqual(Array.from(result.failedSegments), [1]);
  assert.equal(Object.hasOwn(result, 'totalSegments'), false);
  assert.equal(Object.hasOwn(result, 'totalChars'), false);
  assert.equal(result.limitChars, 20);
  assert.equal(Object.hasOwn(result, 'truncated'), false);
});

test('raw toolFailure error projection mutation is detected by the same real entry contract', async () => {
  const source = fs.readFileSync('app/js/agent-tools.js', 'utf8');
  const safeProjection = "const out = { ok: false, error: fallbackText || '调用失败' };";
  assert.equal(source.includes(safeProjection), true);
  const mutated = source.replace(safeProjection, "const out = { ok: false, error: src.error || fallbackText || '调用失败' };");
  const { invoke } = load({ runImpression: async () => ({ error: SECRET }) }, mutated);
  const result = await invoke('supervision.start', { supervisorName: 'nvwa', material: '足够长度的合成督导材料内容' });
  assert.equal(result.error, SECRET);
  assert.notEqual(result.error, '督导启动失败');
  assert.throws(() => assertNoSecret(result), assert.AssertionError);
});
