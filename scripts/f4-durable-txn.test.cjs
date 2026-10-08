/* ============================================================
 * F4 durable 事务 / 并发回归（app/js/store.js 单写入者契约）
 * 契约：qa/task-scratch/XJ-5.1.19-f1-f7-final-acceptance-001/reports/f4-fix-contract.md
 *
 * 严格 fake IndexedDB：
 *   - 每个 readwrite 事务记录自己的 gets/puts；一次 read-modify-write 只允许一个事务
 *   - 多次 put 只在事务收尾时触发一次 oncomplete（不会各自触发）
 *   - put 写失败 → 事务 abort：暂存写盘全部丢弃，只触发 onabort
 *   - get/put 结果深拷贝，杜绝「同对象引用」蒙混过关
 *
 * 覆盖：跨窗口 lost update、字段级 patch 不回退、记录被删不复活、abort 回滚、
 *       降级标志不被污染、删除 preview CAS、import 回滚、同步 API intent 化。
 *
 * 运行：node scripts/f4-durable-txn.test.cjs
 *       node scripts/f4-durable-txn.test.cjs --mutation   反向变异自证（期望转红）
 *       node scripts/f4-durable-txn.test.cjs --only=<子串>
 * 全部为合成数据，不含真实病例 / 真实供应商 / 生产账号。
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('node:fs');
const vm = require('node:vm');
const rawAssert = require('node:assert/strict');

const STORE_PATH = path.join(__dirname, '../app/js/store.js');
const STORE_SOURCE = fs.readFileSync(STORE_PATH, 'utf8');

let assertionCount = 0;
const assert = new Proxy(rawAssert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === 'function') {
      return function counted(...args) { assertionCount += 1; return value.apply(target, args); };
    }
    return value;
  },
  apply(target, thisArg, args) { assertionCount += 1; return target(...args); },
});

// 反向变异时注入的源码变换（runMutations 设置，freshStore 消费）
let CURRENT_TRANSFORM = null;

// ------------------------------------------------------------
// 严格 fake IndexedDB
// ------------------------------------------------------------
function createFixture(initial) {
  const rows = new Map();
  Object.keys(initial || {}).forEach((key) => {
    rows.set(key, { key, value: structuredClone(initial[key]) });
  });
  const state = { rows, txs: [], totalPuts: 0, failPutNumber: 0, reloads: 0, storage: new Map() };

  function commitStaged(tx) {
    tx.staged.forEach((row, key) => {
      if (row.__deleted) state.rows.delete(key);
      else state.rows.set(key, structuredClone(row));
    });
  }

  function beginTx(mode) {
    const tx = {
      mode, gets: [], puts: [], staged: new Map(), error: null,
      aborted: false, done: false,
      oncomplete: null, onabort: null, onerror: null,
      abort() { abortTx(tx, new Error('transaction aborted by implementation')); },
    };
    state.txs.push(tx);
    let pending = 0;
    // 模拟真实 IndexedDB：一个任务结束时若无待发请求则自动提交（否则空事务永不结束）。
    queueMicrotask(() => { completeTx(tx); });

    function abortTx(target, error) {
      if (target.aborted || target.done) return;
      target.aborted = true;
      target.error = error;
      target.staged.clear();
      queueMicrotask(() => { if (typeof target.onabort === 'function') target.onabort(); });
    }

    function completeTx(target) {
      if (target.aborted || target.done || pending > 0) return;
      target.done = true;
      commitStaged(target);
      queueMicrotask(() => { if (typeof target.oncomplete === 'function') target.oncomplete(); });
    }

    function request(kind, args) {
      pending += 1;
      const req = { kind, result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (tx.aborted || tx.done) { pending -= 1; completeTx(tx); return; }
        // 夹具钩子：在本次请求应答之后触发，用来模拟「另一窗口紧随其后提交」。
        // 被测件拿到的已经是应答时刻的快照，所以钩子里的写入相对它就是「陈旧 cache + 新鲜库」，
        // 这正是双窗口 lost update 的真实形成方式（不是靠放宽断言凑出来的场景）。
        if (typeof state.onServed === 'function') {
          queueMicrotask(() => {
            if (tx.aborted) return;
            try { state.onServed({ kind, key: args && args.key, tx }); } catch (ignored) {}
          });
        }
        if (kind === 'get' || kind === 'getAll' || kind === 'delete' || kind === 'put') {
          if (kind === 'get') {
            const source = tx.staged.has(args.key) ? tx.staged.get(args.key) : state.rows.get(args.key);
            tx.gets.push(args.key);
            req.result = source && !source.__deleted ? structuredClone(source) : undefined;
            pending -= 1;
            if (req.onsuccess) req.onsuccess.call(req, { target: req });
          } else if (kind === 'getAll') {
            const merged = new Map(state.rows);
            tx.staged.forEach((row, key) => { if (row.__deleted) merged.delete(key); else merged.set(key, row); });
            req.result = Array.from(merged.values()).map((row) => structuredClone(row));
            pending -= 1;
            if (req.onsuccess) req.onsuccess.call(req, { target: req });
          } else if (kind === 'delete') {
            tx.staged.set(args.key, { key: args.key, __deleted: true });
            pending -= 1;
            if (req.onsuccess) req.onsuccess.call(req, { target: req });
          } else {
            tx.puts.push(args.row.key);
            state.totalPuts += 1;
            if (state.failPutNumber && state.totalPuts === state.failPutNumber) {
              req.error = new Error('injected IndexedDB write failure');
              pending -= 1;
              if (req.onerror) req.onerror.call(req, { target: req });
              abortTx(tx, req.error);
              return;
            }
            tx.staged.set(args.row.key, { key: args.row.key, value: structuredClone(args.row.value) });
            pending -= 1;
            if (req.onsuccess) req.onsuccess.call(req, { target: req });
          }
          completeTx(tx);
          return;
        }
        pending -= 1;
        abortTx(tx, new Error('unsupported fake request ' + kind));
      });
      return req;
    }

    tx.objectStore = () => ({
      put: (row) => request('put', { row }),
      get: (key) => request('get', { key }),
      delete: (key) => request('delete', { key }),
      getAll: () => request('getAll', {}),
    });
    return tx;
  }

  const fakeDb = {
    objectStoreNames: { contains: () => true },
    transaction: (name, mode) => beginTx(mode || 'readonly'),
  };
  const indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => { req.result = fakeDb; if (req.onsuccess) req.onsuccess({ target: req }); });
      return req;
    },
  };
  const storage = state.storage;
  const localStorage = {
    get length() { return storage.size; },
    key(i) { const keys = Array.from(storage.keys()); return i < keys.length ? keys[i] : null; },
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  return { state, indexedDB, localStorage, fakeDb };
}

function diskRows(state) {
  const out = {};
  state.rows.forEach((row, key) => { out[key] = structuredClone(row.value); });
  return out;
}

// ------------------------------------------------------------
// 装载 store.js（可变异）
// ------------------------------------------------------------
function clinicalTaskValidatorsStub() {
  return {
    normalizeClinicalTask(value) {
      if (!value || typeof value !== 'object') return null;
      if (!value.id || !value.clientId || !value.originSessionId) return null;
      return Object.assign({
        status: 'open', createdBy: 'manual', sourceRefs: [], goal: '', body: '',
        acceptanceCriteria: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }, value, { sourceRefs: Array.isArray(value.sourceRefs) ? value.sourceRefs.slice() : [] });
    },
    hasClinicalBodyField(value) { return !!(value && typeof value === 'object' && value.body); },
  };
}

function loadStore(fixture) {
  const reloads = () => { fixture.state.reloads += 1; };
  const sandbox = {
    JSON, Date, Math, Promise, console, setTimeout, clearTimeout, queueMicrotask, structuredClone,
    indexedDB: fixture.indexedDB,
    localStorage: fixture.localStorage,
    location: { reload: reloads },
    document: { createElement: () => ({ style: {}, contentWindow: {} }), body: { appendChild() {} } },
  };
  sandbox.window = Object.assign({}, sandbox, {
    ClinicalTaskValidators: clinicalTaskValidatorsStub(),
    location: { reload: reloads },
  });
  vm.createContext(sandbox);
  let source = STORE_SOURCE;
  if (CURRENT_TRANSFORM) {
    const mutated = CURRENT_TRANSFORM.transform(source);
    if (mutated === source) throw new Error('变异未命中 store.js 源码：' + CURRENT_TRANSFORM.id);
    source = mutated;
  }
  vm.runInContext(source + '\nthis.__Store = Store;', sandbox);
  return { store: sandbox.__Store, state: fixture.state };
}

async function settle(rounds) {
  for (let i = 0; i < (rounds || 30); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

async function freshStore(seed, options) {
  const opt = options || {};
  const initial = Object.assign({ __xj_dedup_v4: { done: true, at: 1, removed: 0 } }, seed || {});
  const fixture = createFixture(initial);
  Object.keys(opt.local || {}).forEach((k) => fixture.state.storage.set(k, opt.local[k]));
  const loaded = loadStore(fixture);
  const env = {
    store: loaded.store,
    state: fixture.state,
    fixture,
    ctx: {},
    disk: () => diskRows(fixture.state),
    failNextPut: () => { fixture.state.failPutNumber = fixture.state.totalPuts + 1; },
    failPutNumber: (n) => { fixture.state.failPutNumber = fixture.state.totalPuts + n; },
    resetFail: () => { fixture.state.failPutNumber = 0; },
    externalWrite: (key, value) => { fixture.state.rows.set(key, { key, value: structuredClone(value) }); },
    txCount: () => fixture.state.txs.length,
    writeTxs: () => fixture.state.txs.filter((tx) => tx.puts.length > 0),
    putsOf: (key) => fixture.state.txs.filter((tx) => tx.puts.indexOf(key) >= 0).length,
    flush: () => settle(60),
    diskOf: (key) => structuredClone(fixture.state.rows.has(key) ? fixture.state.rows.get(key).value : undefined),
  };
  // 启动期并发夹具：在「本窗口读到某个键之后、写回之前」让另一窗口提交。
  if (typeof opt.onServed === 'function') {
    fixture.state.onServed = (info) => { opt.onServed(env, info, env.ctx); };
  }
  await loaded.store.hydrate();
  await settle();
  return env;
}

// ------------------------------------------------------------
// 用例注册表
// ------------------------------------------------------------
const CASES = [];
function test(name, fn, kills, options) {
  CASES.push({ name, fn, kills: kills || [], options: options || null });
}

const CLIENT_ID = 'synthetic-client-1';
const OTHER_CLIENT_ID = 'synthetic-client-2';

function seedClient(id, name, extra) {
  return Object.assign({
    id, name, alias: '', gender: 'unknown', birthDate: '', phone: '', email: '',
    firstVisitDate: '', status: 'active', tags: [], notes: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }, extra || {});
}
function seedSession(id, clientId, extra) {
  return Object.assign({
    id, clientId, sessionNumber: 1, date: '2026-03-01', startTime: '', endTime: '', durationMinutes: 50,
    transcript: '', soap: { subjective: '', objective: '', assessment: '', plan: '' },
    dap: { data: '', assessment: '', plan: '' }, reflection: '', summary: '', isConfirmed: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }, extra || {});
}

// ============================================================
// 阶段 1：clients / sessions
// ============================================================
test('clients: 他窗口新增记录必须存活于 createClientDurable 之后', async (env) => {
  env.externalWrite('clients', [...env.store.getClients(), seedClient(OTHER_CLIENT_ID, '合成乙')]);
  const created = await env.store.createClientDurable({ name: '合成丙' });
  assert.equal(created.ok, true, 'createClientDurable 必须成功');
  const names = env.diskOf('clients').map((c) => c.name).sort();
  assert.deepEqual(names, ['合成丙', '合成乙', '合成甲'], '磁盘必须同时保留他窗口记录');
  assert.equal(env.store.getClients().some((c) => c.name === '合成乙'), true, 'cache 提交后也必须含他窗口记录');
}, ['M1']);

test('clients: updateClientDurable 不回退他窗口对同一记录另一字段的改动', async (env) => {
  const current = env.diskOf('clients')[0];
  env.externalWrite('clients', [Object.assign({}, current, { phone: '139-0000-0000', updatedAt: '2026-02-02T00:00:00.000Z' })]);
  const patched = await env.store.updateClientDurable(CLIENT_ID, { notes: '本窗口补充备注' });
  assert.equal(patched.ok, true, '字段级 patch 必须成功');
  const stored = env.diskOf('clients')[0];
  assert.equal(stored.phone, '139-0000-0000', '他窗口的 phone 不得被本窗口 cache 回退');
  assert.equal(stored.notes, '本窗口补充备注', '本窗口的 notes 必须写入');
  assert.equal(patched.value.phone, '139-0000-0000', '返回值必须是 DB 合并后的记录');
}, ['M1']);

test('clients: updateClientDurable 目标被他窗口删除 → XJ_DURABLE_RECORD_GONE 且零写入', async (env) => {
  env.externalWrite('clients', [seedClient(OTHER_CLIENT_ID, '合成乙')]);
  const cacheBefore = env.store.getClients().map((c) => c.id).sort();
  const writesBefore = env.writeTxs().length;
  const gone = await env.store.updateClientDurable(CLIENT_ID, { notes: '不该复活' });
  assert.equal(gone.ok, false, '记录已消失时不得报成功');
  assert.equal(gone.error.code, 'XJ_DURABLE_RECORD_GONE');
  assert.deepEqual(env.diskOf('clients').map((c) => c.id), [OTHER_CLIENT_ID], '磁盘不得复活该记录');
  assert.deepEqual(env.store.getClients().map((c) => c.id).sort(), cacheBefore, '失败提交不得改写本窗口 cache');
  assert.equal(env.store.getClients().find((c) => c.id === CLIENT_ID).notes, '', '本窗口 cache 不得被写成半成品');
  assert.equal(env.writeTxs().length, writesBefore, 'gone 路径必须零写入');
}, []);

test('clients: 一次 durable 写只开一个 readwrite 事务且读写同键', async (env) => {
  const before = env.writeTxs().length;
  await env.store.updateClientDurable(CLIENT_ID, { notes: '单事务检查' });
  const writes = env.writeTxs();
  assert.equal(writes.length - before, 1, 'read-modify-write 必须在同一个事务内完成');
  const tx = writes[writes.length - 1];
  assert.deepEqual(tx.gets, ['clients'], '事务内必须先读 clients');
  assert.deepEqual(tx.puts, ['clients'], '事务内只写 clients');
}, ['M4']);

test('clients: 注入 abort → 磁盘与 cache 等于注入前、降级标志不动、后续仍可写', async (env) => {
  await env.store.updateClientDurable(CLIENT_ID, { notes: '注入前的既有值' });
  const diskBefore = env.diskOf('clients');
  const cacheBefore = env.store.getClients()[0].notes;
  const backendBefore = env.store.storageInfo().backend;
  env.failNextPut();
  const failed = await env.store.updateClientDurable(CLIENT_ID, { notes: '注入的改动' });
  assert.equal(failed.ok, false, '事务失败不得报成功');
  assert.equal(failed.error.code, 'XJ_DURABLE_CLIENT_UPDATE_FAILED');
  assert.deepEqual(env.diskOf('clients'), diskBefore, '失败事务不得留下任何改动');
  assert.equal(env.store.getClients()[0].notes, cacheBefore, '失败事务不得污染 cache');
  assert.equal(env.store.storageInfo().backend, backendBefore, '一次事务失败绝不能翻转 _dbAvailable');
  env.resetFail();
  const after = await env.store.updateClientDurable(CLIENT_ID, { notes: '恢复后的写入' });
  assert.equal(after.ok, true, '失败后该 renderer 仍必须能 durable 写入');
  assert.equal(env.diskOf('clients')[0].notes, '恢复后的写入');
}, ['M3']);

test('supervisions: updateSupervisionDurable 对同 ID 的陈旧缓存只合并本次字段', async (env) => {
  const earlier = env.diskOf('supervisions')[0];
  env.externalWrite('supervisions', [Object.assign({}, earlier, { conclusion: '他窗口的新结论' })]);
  const updated = await env.store.updateSupervisionDurable('synthetic-sup', { content: '本窗口的新正文' });
  assert.equal(updated.ok, true, '同 ID 字段级更新应成功');
  const stored = env.diskOf('supervisions')[0];
  assert.equal(stored.content, '本窗口的新正文', '本窗口修改的正文必须落盘');
  assert.equal(stored.conclusion, '他窗口的新结论', '他窗口对同 ID 的其他字段不得回退');
  assert.equal(updated.value.conclusion, '他窗口的新结论', '返回值必须是事务内合并后的记录');
}, []);

test('supervisions: updateSupervisionDurable 目标已删除时不复活', async (env) => {
  env.externalWrite('supervisions', []);
  const putsBefore = env.putsOf('supervisions');
  const updated = await env.store.updateSupervisionDurable('synthetic-sup', { content: '不得复活' });
  assert.equal(updated.ok, false, '被其他窗口删除的记录不得报更新成功');
  assert.equal(updated.error.code, 'XJ_DURABLE_RECORD_GONE');
  assert.deepEqual(env.diskOf('supervisions'), [], '磁盘不得复活已删除的记录');
  assert.equal(env.putsOf('supervisions'), putsBefore, '已删除记录不得产生写入');
}, []);

test('sessions: 他窗口新增会谈必须存活于 saveSessionDurable 之后', async (env) => {
  const external = seedSession('external-session-other-window', OTHER_CLIENT_ID, { transcript: '他窗口会谈' });
  env.externalWrite('sessions', [...env.diskOf('sessions'), external]);
  const saved = await env.store.saveSessionDurable({ id: 'synthetic-session-1', clientId: CLIENT_ID, date: '2026-03-01', transcript: '本窗口改过的逐字稿' });
  assert.equal(saved.ok, true, 'saveSessionDurable 必须成功');
  const ids = env.diskOf('sessions').map((s) => s.id);
  assert.equal(ids.includes(external.id), true, '他窗口新增会谈不得被整档覆盖抹掉');
  assert.equal(env.diskOf('sessions').find((s) => s.id === 'synthetic-session-1').transcript, '本窗口改过的逐字稿');
  assert.equal(env.store.getSessions().find((s) => s.id === 'synthetic-session-1').hasTranscript, true, '报告标记必须保留');
}, ['M1']);

test('sessions: saveSessionsDurable 批量 patch 不回退他窗口非账务字段', async (env) => {
  const stored = env.diskOf('sessions')[0];
  env.externalWrite('sessions', [Object.assign({}, stored, {
    transcript: '他窗口的逐字稿', billing: { fee: 0, paid: false, note: '他窗口备注' },
  })]);
  const batch = await env.store.saveSessionsDurable([{
    id: 'synthetic-session-1', clientId: CLIENT_ID, billing: { fee: 800, paid: true },
  }]);
  assert.equal(batch.ok, true, '批量账务保存必须成功');
  const after = env.diskOf('sessions')[0];
  assert.equal(after.transcript, '他窗口的逐字稿', '非账务字段不得回退');
  assert.equal(after.billing.note, '他窗口备注', '同对象其他字段不得回退');
  assert.equal(after.billing.fee, 800, '账务字段必须写入');
  assert.equal(after.billing.paid, true);
  assert.equal(batch.value[0].transcript, '他窗口的逐字稿', '返回值必须是 DB 合并后的记录');
}, ['M1']);

test('sessions: saveSessionsDurable 批量目标被他窗口删除 → 整批零写入', async (env) => {
  env.externalWrite('sessions', [env.diskOf('sessions')[0]]);
  const writesBefore = env.writeTxs().length;
  const failed = await env.store.saveSessionsDurable([
    { id: 'synthetic-session-1', clientId: CLIENT_ID, transcript: '改甲' },
    { id: 'synthetic-session-2', clientId: CLIENT_ID, transcript: '改乙' },
  ]);
  assert.equal(failed.ok, false, '批次里有记录被删 → 不得报成功');
  assert.equal(env.diskOf('sessions').find((s) => s.id === 'synthetic-session-1').transcript, '甲', '磁盘不得写入');
  assert.equal(env.store.getSessions().find((s) => s.id === 'synthetic-session-1').transcript, '甲', 'cache 也不得变');
  assert.equal(env.writeTxs().length, writesBefore, 'gone 批次不得产生写入事务');
}, []);

test('sessions: saveBillingBatchDurable 不回退他窗口新增记录与非账务字段', async (env) => {
  const clinical = seedSession('clinical-session-other-window', OTHER_CLIENT_ID, { transcript: '他窗口临床会谈' });
  const billable = env.diskOf('sessions')[0];
  env.externalWrite('sessions', [Object.assign({}, billable, { transcript: '他窗口写入的内容' }), clinical]);
  const staleSessions = env.store.getSessions().map((s) => (s.id === billable.id
    ? Object.assign({}, s, { billing: { fee: 300, paid: true } }) : s));
  const saved = await env.store.saveBillingBatchDurable({ sessions: staleSessions, clients: env.store.getClients(), expenses: [] });
  assert.equal(saved.ok, true, '账务批次必须成功');
  const ids = env.diskOf('sessions').map((s) => s.id);
  assert.equal(ids.includes(clinical.id), true, '他窗口新增会谈不得被账务批次抹掉');
  const stored = env.diskOf('sessions').find((s) => s.id === billable.id);
  assert.equal(stored.billing.paid, true, '账务字段必须落盘');
  assert.equal(stored.transcript, '他窗口写入的内容', '非账务字段必须保持 DB 值');
}, ['M1']);

test('sessions: deleteSessionsDurable 不误删他窗口新增记录', async (env) => {
  const externalSession = seedSession('external-session-keep', OTHER_CLIENT_ID, { date: '2026-03-03' });
  const externalSupervision = { id: 'external-supervision-keep', clientId: OTHER_CLIENT_ID, sessionIds: ['other-session'], conclusion: '他窗口督导' };
  env.externalWrite('sessions', [...env.diskOf('sessions'), externalSession]);
  env.externalWrite('supervisions', [{ id: 'synthetic-sup', clientId: CLIENT_ID, sessionIds: ['synthetic-session-1', 'other-session'] }, externalSupervision]);
  const removed = await env.store.deleteSessionsDurable(['synthetic-session-1']);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.deletedSessionIds, ['synthetic-session-1']);
  assert.equal(env.diskOf('sessions').map((s) => s.id).includes(externalSession.id), true, '他窗口会谈不得被删除');
  assert.equal(env.diskOf('supervisions').some((s) => s.id === externalSupervision.id), true, '他窗口督导不得被删除');
  assert.deepEqual(env.diskOf('supervisions').find((s) => s.id === 'synthetic-sup').sessionIds, ['other-session']);
}, ['M1']);

test('sessions: clearBillingDataDurable 保留他窗口新增临床会谈', async (env) => {
  const externalClinical = seedSession('external-clinical-session', OTHER_CLIENT_ID, { date: '2026-03-04', transcript: '他窗口临床会谈' });
  env.externalWrite('sessions', [...env.diskOf('sessions'), externalClinical]);
  const cleared = await env.store.clearBillingDataDurable();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.deletedSessionCount, 1);
  const ids = env.diskOf('sessions').map((s) => s.id);
  assert.equal(ids.includes(externalClinical.id), true, '清账不得抹掉他窗口临床会谈');
  assert.equal(ids.includes('synthetic-session-1'), false, '账务会谈必须被清掉');
  assert.deepEqual(env.diskOf('clients')[0].billing.monthlyPayments, [], '月结必须清空');
  assert.equal(env.diskOf('expenses').length, 0);
}, ['M1']);

// ============================================================
// 阶段 2：clinicalTasks / masterConversations / expenses / settings
// ============================================================
const TASK_BASE = {
  id: 'synthetic-task-1', clientId: CLIENT_ID, originSessionId: 'synthetic-session-1',
  goal: '合成目标', body: '合成临床正文', acceptanceCriteria: '合成验收', status: 'open', createdBy: 'manual',
  sourceRefs: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

test('tasks: createClinicalTaskDurable 保留他窗口新增任务', async (env) => {
  const external = Object.assign({}, TASK_BASE, { id: 'external-task-other-window', goal: '他窗口任务' });
  env.externalWrite('clinicalTasks', [structuredClone(TASK_BASE), external]);
  const created = await env.store.createClinicalTaskDurable({
    id: 'synthetic-task-2', clientId: CLIENT_ID, originSessionId: 'synthetic-session-1',
    goal: '本窗口任务', body: '本窗口正文', acceptanceCriteria: '本窗口验收',
  });
  assert.equal(created.ok, true, 'createClinicalTaskDurable 必须成功');
  const ids = env.diskOf('clinicalTasks').map((t) => t.id);
  assert.equal(ids.includes(external.id), true, '他窗口新增任务不得被整档覆盖抹掉');
  assert.equal(ids.includes('synthetic-task-2'), true);
}, ['M1']);

test('tasks: updateClinicalTaskDurable 不回退他窗口对其他字段的改动', async (env) => {
  const stored = env.diskOf('clinicalTasks')[0];
  env.externalWrite('clinicalTasks', [Object.assign({}, stored, { goal: '他窗口改过的目标' })]);
  const patched = await env.store.updateClinicalTaskDurable(TASK_BASE.id, { body: '本窗口改过的正文' });
  assert.equal(patched.ok, true, '任务字段级 patch 必须成功');
  const after = env.diskOf('clinicalTasks')[0];
  assert.equal(after.goal, '他窗口改过的目标', '他窗口的 goal 不得被本窗口 cache 回退');
  assert.equal(after.body, '本窗口改过的正文', '本窗口的 body 必须写入');
  assert.equal(patched.value.goal, '他窗口改过的目标', '返回值必须是 DB 合并后的任务');
}, ['M1']);

test('tasks: 任务被他窗口删除 → 失败且磁盘不复活', async (env) => {
  env.externalWrite('clinicalTasks', []);
  const failed = await env.store.updateClinicalTaskDurable(TASK_BASE.id, { body: '不该复活' });
  assert.equal(failed.ok, false, '任务已消失时不得报成功');
  assert.equal(failed.error.code, 'XJ_DURABLE_CLINICAL_TASK_UPDATE_FAILED');
  assert.match(failed.error.message, /XJ_DURABLE_RECORD_GONE/);
  assert.deepEqual(env.diskOf('clinicalTasks'), [], '磁盘不得复活该任务');
}, []);

test('masters: saveMasterConversationDurable 保留他窗口新增对话', async (env) => {
  const mine = { id: 'synthetic-conv-1', mode: '1v1', masterKeys: ['m-a'], title: '合成甲', messages: [] };
  env.externalWrite('masterConversations', [Object.assign({}, mine, { updatedAt: '2026-01-01T00:00:00.000Z' }),
    { id: 'external-conv-other-window', mode: '1v1', masterKeys: ['m-b'], title: '他窗口对话', messages: [] }]);
  const saved = await env.store.saveMasterConversationDurable(Object.assign({}, mine, { title: '本窗口改过的标题' }));
  assert.equal(saved.ok, true);
  const ids = env.diskOf('masterConversations').map((c) => c.id);
  assert.equal(ids.includes('external-conv-other-window'), true, '他窗口对话不得被抹掉');
  assert.equal(env.diskOf('masterConversations').find((c) => c.id === mine.id).title, '本窗口改过的标题');
}, ['M1']);

test('masters: deleteMasterConversationDurable 只删自己的记录', async (env) => {
  const external = { id: 'external-conv-keep', mode: '1v1', title: '保留', messages: [] };
  env.externalWrite('masterConversations', [
    { id: 'synthetic-conv-1', mode: '1v1', title: '合成甲', messages: [] }, external]);
  const removed = await env.store.deleteMasterConversationDurable('synthetic-conv-1');
  assert.equal(removed.ok, true);
  assert.deepEqual(env.diskOf('masterConversations').map((c) => c.id), ['external-conv-keep'], '他窗口对话必须存活');
  const again = await env.store.deleteMasterConversationDurable('synthetic-conv-1');
  assert.equal(again.ok, true, 'DB 里已不存在的记录不得报失败');
  assert.equal(!!again.deleted, false, '重复删除不得声称删掉了一条');
}, ['M1']);

test('expenses: createExpenseDurable 与 updateExpenseDurable 并发保留 + 字段级 patch', async (env) => {
  const external = { id: 'external-expense', category: 'course', date: '2026-04-01', amount: 222, description: '他窗口支出' };
  env.externalWrite('expenses', [Object.assign({}, env.diskOf('expenses')[0], { description: '他窗口描述' }), external]);
  const created = await env.store.createExpenseDurable({ category: 'group', amount: 111, date: '2026-04-02' });
  assert.equal(created.ok, true);
  assert.equal(env.diskOf('expenses').some((e) => e.id === external.id), true, '他窗口支出不得被新增抹掉');
  const patched = await env.store.updateExpenseDurable('synthetic-expense', { amount: 999 });
  assert.equal(patched.ok, true);
  const stored = env.diskOf('expenses').find((e) => e.id === 'synthetic-expense');
  assert.equal(stored.description, '他窗口描述', '他窗口的 description 不得回退');
  assert.equal(stored.amount, 999, '本窗口的 amount 必须写入');
}, ['M1']);

test('expenses: deleteExpenseDurable 按 id 过滤，不复活不抹除', async (env) => {
  env.externalWrite('expenses', [
    { id: 'synthetic-expense', category: 'other', amount: 1, date: '2026-04-01' },
    { id: 'external-expense', category: 'other', amount: 2, date: '2026-04-01' },
  ]);
  const removed = await env.store.deleteExpenseDurable('synthetic-expense');
  assert.equal(removed.ok, true);
  assert.equal(removed.deleted, true);
  assert.deepEqual(env.diskOf('expenses').map((e) => e.id), ['external-expense']);
}, ['M1']);

test('expenses: updateExpenseDurable 目标被他窗口删除 → XJ_DURABLE_RECORD_GONE 零写入', async (env) => {
  env.externalWrite('expenses', []);
  const writesBefore = env.writeTxs().length;
  const gone = await env.store.updateExpenseDurable('synthetic-expense', { amount: 1 });
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'XJ_DURABLE_RECORD_GONE');
  assert.deepEqual(env.diskOf('expenses'), [], '磁盘不得复活支出');
  assert.equal(env.writeTxs().length, writesBefore, 'gone 路径必须零写入');
}, []);

test('settings: saveSettingsDurable 只合并本次 patch 的键', async (env) => {
  env.externalWrite('settings', { apiConfig: { baseUrl: 'https://synthetic.invalid' }, version: '1.0.0', promptGovernance: { writingStyleEnabled: true } });
  const saved = await env.store.saveSettingsDurable({ aiModelSelection: { tier: 'flagship' } });
  assert.equal(saved.ok, true);
  const stored = env.diskOf('settings');
  assert.deepEqual(stored.aiModelSelection, { tier: 'flagship' }, '本次 patch 必须落盘');
  assert.equal(stored.promptGovernance.writingStyleEnabled, true, '他窗口写入的其他设置键不得被回退');
  assert.deepEqual(stored.apiConfig, { baseUrl: 'https://synthetic.invalid' }, '他窗口的 apiConfig 不得被 cache 覆盖');
}, ['M1']);

// ============================================================
// 阶段 3：逻辑删除 CAS / import / 降级标志
// ============================================================
function deletionSeed() {
  return {
    clients: [seedClient(CLIENT_ID, '合成甲'), seedClient(OTHER_CLIENT_ID, '合成乙')],
    sessions: [seedSession('synthetic-session-1', CLIENT_ID, { billing: { fee: 300, paid: false } })],
    supervisions: [{ id: 'synthetic-sup', clientId: CLIENT_ID, sessionIds: ['synthetic-session-1'], conclusion: '合成督导' }],
    materialWorkspaces: [], clinicalTasks: [], clinicalActionRuns: [], expenses: [],
    deletionBatches: [], deletionQuarantine: [],
  };
}

test('deletion: preview→apply 端到端（无并发）打 tombstone 且生成 batch', async (env) => {
  const preview = env.store.previewDeletionImpact({ targetType: 'client', targetId: CLIENT_ID });
  assert.equal(preview.ok, true);
  const applied = await env.store.createDeletionBatch({ targetType: 'client', targetId: CLIENT_ID, previewHash: preview.value.previewHash });
  assert.equal(applied.ok, true, '无并发时事务内重算的 previewHash 必须与 cache 派生的一致：' + (applied.error && applied.error.code));
  assert.equal(env.diskOf('clients')[0].__xjDeletionTombstone.status, 'tombstoned', 'tombstone 必须落盘');
  assert.equal(env.diskOf('deletionBatches').length, 1);
  assert.equal(env.store.getClients().some((c) => c.id === CLIENT_ID), false, ' tombstoned 客户不得出现在 getClients');
  assert.equal(env.store.getClients().some((c) => c.id === OTHER_CLIENT_ID), true);
}, []);

test('deletion: 过期 previewHash → XJ_DELETION_PREVIEW_STALE 且零写入', async (env) => {
  const preview = env.store.previewDeletionImpact({ targetType: 'client', targetId: CLIENT_ID });
  assert.equal(preview.ok, true);
  // 他窗口在本窗口取完 preview 之后新增了一条来访者 → storeRevision 变了。
  env.externalWrite('clients', [...env.store.getClients(), seedClient('synthetic-client-3', '合成丙')]);
  const writesBefore = env.writeTxs().length;
  const diskBefore = JSON.stringify(env.disk());
  const stale = await env.store.createDeletionBatch({ targetType: 'client', targetId: CLIENT_ID, previewHash: preview.value.previewHash });
  assert.equal(stale.ok, false, '过期 preview 不得报成功');
  assert.equal(stale.error.code, 'XJ_DELETION_PREVIEW_STALE');
  assert.equal(JSON.stringify(env.disk()), diskBefore, 'STALE 路径必须零写入');
  assert.equal(env.writeTxs().length, writesBefore, 'STALE 路径不得产生写入事务');
  assert.equal(env.diskOf('deletionBatches').length, 0);
}, ['M2']);

test('deletion: 同 previewHash 重复 apply 幂等，不产生第二条 batch', async (env) => {
  const preview = env.store.previewDeletionImpact({ targetType: 'client', targetId: CLIENT_ID });
  const first = await env.store.createDeletionBatch({ targetType: 'client', targetId: CLIENT_ID, previewHash: preview.value.previewHash });
  assert.equal(first.ok, true);
  const writesAfterFirst = env.writeTxs().length;
  const second = await env.store.createDeletionBatch({ targetType: 'client', targetId: CLIENT_ID, previewHash: preview.value.previewHash });
  assert.equal(second.ok, true, '幂等重放必须成功');
  assert.equal(second.value.batchId, first.value.batchId);
  assert.equal(env.diskOf('deletionBatches').length, 1, '不得产生第二条 batch');
  assert.equal(env.writeTxs().length, writesAfterFirst, '幂等重放必须零写入');
}, []);

test('deletion: restore 事务内重读，恢复 tombstone 并保留他窗口新增记录', async (env) => {
  const preview = env.store.previewDeletionImpact({ targetType: 'client', targetId: CLIENT_ID });
  const applied = await env.store.createDeletionBatch({ targetType: 'client', targetId: CLIENT_ID, previewHash: preview.value.previewHash });
  assert.equal(applied.ok, true);
  const external = seedClient('synthetic-client-3', '合成丙');
  env.externalWrite('clients', [...env.diskOf('clients'), external]);
  const restored = await env.store.restoreDeletionBatch(applied.value.batchId);
  assert.equal(restored.ok, true, '恢复必须成功：' + (restored.error && restored.error.message));
  assert.equal(env.diskOf('clients').find((c) => c.id === CLIENT_ID).__xjDeletionTombstone, undefined, 'tombstone 必须被移除');
  assert.equal(env.diskOf('clients').some((c) => c.id === external.id), true, '他窗口新增来访者不得被恢复流程抹掉');
  assert.equal(env.diskOf('deletionBatches')[0].status, 'restored');
}, ['M1']);

test('import: 注入 abort → 数据库保持导入前状态', async (env) => {
  const payload = JSON.parse(await env.store.exportAll());
  payload.clients = payload.clients.map((c) => Object.assign({}, c, { notes: '导入带来的备注' }));
  const diskBefore = JSON.stringify(env.disk());
  // 导入要写 13 个键：让第 5 个 put 失败，验证前 4 个也被整事务回滚。
  env.failPutNumber(5);
  const result = await env.store.importAll(JSON.stringify(payload));
  assert.equal(result.ok, false, '导入事务失败不得报成功');
  assert.equal(result.error.code, 'XJ_IMPORT_DURABLE_FAILED');
  assert.equal(JSON.stringify(env.disk()), diskBefore, '数据库必须逐键等于导入前');
  assert.equal(env.store.storageInfo().backend, 'IndexedDB（GB 级容量）', '导入失败不得翻转降级标志');
  env.resetFail();
  const retry = await env.store.importAll(JSON.stringify(payload));
  assert.equal(retry.ok, true, '失败后必须可重放导入');
  assert.equal(env.diskOf('clients').every((c) => c.notes === '导入带来的备注'), true);
}, []);

test('import: 备份未提及的集合保持 DB 值，不用 cache 整档覆盖', async (env) => {
  // 模拟旧版/部分备份：完全不带 supervisions 与 expenses 字段。
  const payload = JSON.parse(await env.store.exportAll());
  delete payload.supervisions;
  delete payload.expenses;
  // 他窗口在本窗口 cache 之后新增了一条督导与一条支出。
  env.externalWrite('supervisions', [...env.store.getSupervisions(), { id: 'external-sup', clientId: OTHER_CLIENT_ID, sessionIds: [], conclusion: '他窗口督导' }]);
  env.externalWrite('expenses', [{ id: 'external-expense', category: 'other', amount: 1, date: '2026-04-01' }]);
  const imported = await env.store.importAll(JSON.stringify(payload));
  assert.equal(imported.ok, true, '部分备份导入必须成功');
  assert.equal(env.diskOf('supervisions').some((s) => s.id === 'external-sup'), true, '备份未提及的集合必须保持 DB 值而不是被 cache 覆盖');
  assert.equal(env.diskOf('expenses').some((e) => e.id === 'external-expense'), true, '备份未提及的支出集合必须保持 DB 值');
}, ['M1']);

test('durable: _put（KV 原语）事务失败也不得永久降级', async (env) => {
  const backendBefore = env.store.storageInfo().backend;
  env.failNextPut();
  let thrown = null;
  try { await env.store._put('activities', [{ id: 'synthetic-activity' }]); } catch (e) { thrown = e; }
  assert.ok(thrown, '_put 失败必须抛出而不是静默成功');
  assert.equal(env.store.storageInfo().backend, backendBefore, '一次事务失败绝不能翻转 _dbAvailable');
  env.resetFail();
  await env.store._put('activities', [{ id: 'synthetic-activity-2' }]);
  assert.deepEqual(env.diskOf('activities'), [{ id: 'synthetic-activity-2' }], '失败后 KV 写仍必须可用');
}, []);

// ============================================================
// 阶段 4：同步 API 的 intent 化（不整档覆盖）
// ============================================================
test('sync: createClient 保留他窗口新增来访者', async (env) => {
  env.externalWrite('clients', [...env.store.getClients(), seedClient('synthetic-client-3', '合成丙')]);
  env.store.createClient({ name: '本窗口新建' });
  await env.flush();
  const names = env.diskOf('clients').map((c) => c.name).sort();
  assert.equal(names.length, 4, 'seed 两档 + 他窗口一档 + 本窗口新建一档 全部共存');
  assert.equal(names.includes('合成丙'), true, '同步新建不得抹掉他窗口来访者');
  assert.equal(names.includes('本窗口新建'), true);
  assert.equal(env.store.getClient(CLIENT_ID).name, '合成甲', '同步读 API 行为不变');
  assert.equal(env.diskOf('clients').some((c) => c.name === '合成丙'), true, '磁盘必须含他窗口记录（cache 未合并是他窗口视图的已知遗留，见报告 §6）');
}, ['M1']);

test('sync: updateClient 字段级 patch 不回退他窗口改动', async (env) => {
  const current = env.diskOf('clients')[0];
  env.externalWrite('clients', [Object.assign({}, current, { phone: '138-0000-0000' })]);
  env.store.updateClient(CLIENT_ID, { notes: '同步补充备注' });
  await env.flush();
  const stored = env.diskOf('clients')[0];
  assert.equal(stored.phone, '138-0000-0000', '他窗口的 phone 不得被同步路径回退');
  assert.equal(stored.notes, '同步补充备注', '同步改动必须落盘');
}, ['M1']);

test('sync: deleteSession 按 id 过滤，保留他窗口新增会谈', async (env) => {
  const external = seedSession('external-session-keep', OTHER_CLIENT_ID);
  env.externalWrite('sessions', [...env.store.getSessions(), external]);
  assert.equal(env.store.deleteSession('synthetic-session-1'), true);
  await env.flush();
  assert.deepEqual(env.diskOf('sessions').map((s) => s.id), [external.id], '只删指定 id，他窗口会谈必须存活');
}, ['M1']);

test('sync: saveMasterConversation 与 deleteMasterConversation 不整档覆盖', async (env) => {
  const external = { id: 'external-conv-keep', mode: '1v1', title: '他窗口对话', messages: [] };
  env.externalWrite('masterConversations', [...env.store.getMasterConversations(), external]);
  env.store.saveMasterConversation({ id: 'synthetic-conv-1', mode: '1v1', title: '同步改过的标题', messages: [] });
  await env.flush();
  assert.equal(env.diskOf('masterConversations').some((c) => c.id === external.id), true, '同步保存不得抹掉他窗口对话');
  assert.equal(env.diskOf('masterConversations').find((c) => c.id === 'synthetic-conv-1').title, '同步改过的标题');
  env.store.deleteMasterConversation('synthetic-conv-1');
  await env.flush();
  assert.deepEqual(env.diskOf('masterConversations').map((c) => c.id), [external.id], '同步删除只按 id 过滤');
}, ['M1']);

test('sync: createExpense / updateExpense / deleteExpense 保留他窗口记录', async (env) => {
  const external = { id: 'external-expense', category: 'course', amount: 7, date: '2026-04-05' };
  env.externalWrite('expenses', [...env.store.getExpenses(), external]);
  env.store.createExpense({ category: 'other', amount: 3, date: '2026-04-06' });
  env.store.updateExpense('synthetic-expense', { amount: 42 });
  await env.flush();
  assert.equal(env.diskOf('expenses').some((e) => e.id === external.id), true, '同步支出写入不得抹掉他窗口支出');
  assert.equal(env.diskOf('expenses').find((e) => e.id === 'synthetic-expense').amount, 42);
  env.store.deleteExpense('synthetic-expense');
  await env.flush();
  assert.equal(env.diskOf('expenses').some((e) => e.id === 'synthetic-expense'), false, '同步删除必须落盘');
  assert.equal(env.diskOf('expenses').filter((e) => e.amount === 7).length, 1, '他窗口支出仍在');
}, ['M1']);

test('sync: saveSettings 浅合并，不覆盖他窗口设置键', async (env) => {
  env.externalWrite('settings', { apiConfig: { baseUrl: 'https://other-window.invalid' }, version: '1.0.0', promptGovernance: { writingStyleEnabled: false } });
  env.store.saveSettings({ aiModelSelection: { tier: 'pro' } });
  await env.flush();
  const stored = env.diskOf('settings');
  assert.deepEqual(stored.aiModelSelection, { tier: 'pro' });
  assert.equal(stored.promptGovernance.writingStyleEnabled, false, '同步保存设置不得回退他窗口设置键');
  assert.deepEqual(stored.apiConfig, { baseUrl: 'https://other-window.invalid' }, '同步保存设置不得覆盖他窗口 apiConfig');
}, ['M1']);

test('sync: updateSupervision 原位修改前保留基线并合并同 ID 异字段', async (env) => {
  const sameRecord = env.store.getSupervision('synthetic-sup');
  assert.equal(sameRecord, env.store.getSupervisions()[0], '更新目标是 cache 原位引用，测试必须覆盖真实引用路径');
  const earlier = env.diskOf('supervisions')[0];
  env.externalWrite('supervisions', [Object.assign({}, earlier, { conclusion: '他窗口的新结论' })]);
  const updated = env.store.updateSupervision('synthetic-sup', { content: '本窗口的新正文' });
  assert.equal(updated, sameRecord, '同步接口仍返回原位更新的缓存引用');
  await env.flush();
  const stored = env.diskOf('supervisions')[0];
  assert.equal(stored.content, '本窗口的新正文', '同步更新必须持久化正文');
  assert.equal(stored.conclusion, '他窗口的新结论', '保存前的基线必须独立于原位修改，避免整条覆盖');
}, []);

test('sync: updateSupervision 目标已删除时不复活', async (env) => {
  env.externalWrite('supervisions', []);
  const putsBefore = env.putsOf('supervisions');
  env.store.updateSupervision('synthetic-sup', { content: '不得复活' });
  await env.flush();
  assert.deepEqual(env.diskOf('supervisions'), [], '同步更新不得复活已删除记录');
  assert.equal(env.putsOf('supervisions'), putsBefore, '同步更新目标已删时不得写盘');
}, []);

test('sync: updateSupervision 持久化失败必须回滚内存，不得内存领先磁盘（红-先行）', async (env) => {
  const contentBefore = env.store.getSupervision('synthetic-sup').content;
  const conclusionBefore = env.store.getSupervision('synthetic-sup').conclusion;
  const diskBefore = env.diskOf('supervisions');
  env.failNextPut();
  env.store.updateSupervision('synthetic-sup', { content: '未落盘的本窗口正文' });
  await env.flush();
  assert.deepEqual(env.diskOf('supervisions'), diskBefore, '失败的写入不得改磁盘');
  assert.equal(env.store.getSupervision('synthetic-sup').content, contentBefore,
    '持久化失败后内存读数必须回到磁盘版本：不得把未保存的编辑显示成已保存');
  assert.equal(env.store.getSupervision('synthetic-sup').conclusion, conclusionBefore,
    '回滚只应撤销本次失败写入，不得顺手改掉其他字段');
}, ['M8']);

test('sync: updateSupervision 返回的活引用提交后必须与 cache 同视图（红-先行）', async (env) => {
  const sameRecord = env.store.getSupervision('synthetic-sup');
  const earlier = env.diskOf('supervisions')[0];
  env.externalWrite('supervisions', [Object.assign({}, earlier, { conclusion: '他窗口提交的新结论' })]);
  const returned = env.store.updateSupervision('synthetic-sup', { content: '本窗口正文' });
  await env.flush();
  const cached = env.store.getSupervision('synthetic-sup');
  assert.equal(cached.conclusion, '他窗口提交的新结论', '他窗口字段必须已并入 cache');
  assert.equal(returned.conclusion, cached.conclusion,
    '调用方继续持有的返回引用不得在提交后停在脱钩旧视图（同一 id 只能有一个真相）');
  assert.equal(returned.content, cached.content, '本次字段改动必须在两个视图上同时可见');
}, ['M8']);

test('sync: updateSupervision 同字段并发是后写覆盖、无版本冲突检测（显式钉住）', async (env) => {
  const earlier = env.diskOf('supervisions')[0];
  env.externalWrite('supervisions', [Object.assign({}, earlier, { content: '他窗口先写的正文' })]);
  env.store.updateSupervision('synthetic-sup', { content: '本窗口后提交的正文' });
  await env.flush();
  assert.equal(env.diskOf('supervisions')[0].content, '本窗口后提交的正文',
    '同字段并发＝后提交者覆盖（本卡显式接受该策略；改策略必须同时改这条）');
  assert.equal(env.store.getSupervision('synthetic-sup').content, '本窗口后提交的正文',
    '内存与磁盘对同字段的结论必须一致');
}, []);

test('sync: createSupervision 保留他窗口督导记录', async (env) => {
  const external = { id: 'external-sup-keep', clientId: OTHER_CLIENT_ID, sessionIds: [], conclusion: '他窗口督导' };
  env.externalWrite('supervisions', [...env.store.getSupervisions(), external]);
  env.store.createSupervision({ clientId: CLIENT_ID, conclusion: '本窗口督导结论', sessionIds: ['synthetic-session-1'] });
  await env.flush();
  const list = env.diskOf('supervisions');
  assert.equal(list.some((s) => s.id === external.id), true, '同步督导不得抹掉他窗口督导');
  assert.equal(list.filter((s) => s.clientId === CLIENT_ID).length, 1);
}, ['M1']);

test('sync: undoBatch 按 id 过滤撤销，保留他窗口记录', async (env) => {
  const external = seedSession('external-session-keep', OTHER_CLIENT_ID, { batchId: 'other-batch' });
  env.externalWrite('sessions', [...env.store.getSessions(), external]);
  env.externalWrite('expenses', [...env.store.getExpenses(), { id: 'external-expense', batchId: 'other-batch', amount: 6 }]);
  const undone = env.store.undoBatch('synthetic-batch');
  await env.flush();
  assert.equal(undone.sessions, 1);
  assert.equal(undone.expenses, 1);
  assert.deepEqual(env.diskOf('sessions').map((s) => s.id).sort(), ['external-session-keep', 'synthetic-session-1'], '撤销只清本批次 id');
  assert.deepEqual(env.diskOf('expenses').map((e) => e.id), ['external-expense'], '他批次支出必须保留');
}, ['M1']);

test('sync: createClinicalActionRun / updateClinicalActionRun 保留他窗口溯源记录', async (env) => {
  const run = env.store.createClinicalActionRun({
    task: 'report-ai-fill', status: 'pending',
    origin: { clientId: CLIENT_ID }, sources: [{ kind: 'client', id: CLIENT_ID, label: '合成来源', chars: 12, truncated: false }],
    snapshot: { clientId: CLIENT_ID }, output: { kind: '', ref: '' }, error: '',
  });
  assert.ok(run, '合法动作记录必须创建成功');
  const external = { id: 'external-run', task: 'report-ai-fill', status: 'succeeded', origin: { clientId: OTHER_CLIENT_ID }, sources: [{ kind: 'client', id: OTHER_CLIENT_ID, label: '合成', chars: 5, truncated: false }], snapshot: {}, output: {}, error: '', createdAt: '2026-01-01T00:00:00.000Z' };
  env.externalWrite('clinicalActionRuns', [...env.diskOf('clinicalActionRuns'), external]);
  env.store.updateClinicalActionRun(run.id, { status: 'succeeded' });
  await env.flush();
  const list = env.diskOf('clinicalActionRuns');
  assert.equal(list.some((item) => item.id === external.id), true, '同步动作溯源写入不得抹掉他窗口记录');
  assert.equal(list.find((item) => item.id === run.id).status, 'succeeded');
}, ['M1']);

test('api-shape: 同步读 API 的签名与返回形状不变', async (env) => {
  env.store.createClient({ name: '合成读形状' });
  await env.flush();
  assert.equal(Array.isArray(env.store.getClients()), true);
  assert.equal(typeof env.store.getClient(CLIENT_ID).id, 'string');
  assert.equal(Array.isArray(env.store.getSessions()), true);
  assert.equal(Array.isArray(env.store.getSessionsByClient(CLIENT_ID)), true);
  assert.equal(env.store.getSessionsByClient(CLIENT_ID).length, 1);
  assert.equal(env.store.getSession('synthetic-session-1').clientId, CLIENT_ID);
  assert.equal(typeof env.store.getSettings().version, 'string');
  assert.equal(typeof env.store.getStats().totalClients, 'number');
}, []);

// ============================================================
// 阶段 5：残留整档覆盖点的收口（启动期旧版大字段迁移 / deleteSession 材料解除关联 / 设置降级分支）
// ============================================================
const LEGACY_SESSION_ID = 'synthetic-session-1';
const LEGACY_BLOB_KEY = 'clients_blob_synthetic-session-1:transcript';
const LEGACY_TRANSCRIPT = '旧版逐字稿（合成）';

// 旧版会谈：大字段是 null（不是空串），才会被 mergeLegacyBlobs 认定为「需要补回」。
function legacySeed() {
  return {
    clients: [seedClient(CLIENT_ID, '合成甲')],
    sessions: [{
      id: LEGACY_SESSION_ID, clientId: CLIENT_ID, sessionNumber: 1, date: '2026-03-01',
      transcript: null, soap: null, dap: null, reflection: null, summary: null,
      notes: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    supervisions: [], materialWorkspaces: [],
  };
}
// 双窗口的真实形成方式：本窗口 hydrate 读到 sessions 之后、启动期迁移写回之前，
// 另一窗口提交了一次 sessions（新增一条会谈 + 改了同一条会谈的另一个字段）。
function competingSessionsWrite(getNext) {
  return (env, info, ctx) => {
    if (ctx.competed || info.kind !== 'get' || info.key !== 'sessions') return;
    ctx.competed = true;
    env.externalWrite('sessions', getNext(env));
  };
}

test('migrate: 启动期旧版大字段合并以 DB 当前值为底，不回退他窗口会谈与他窗口字段', async (env) => {
  const ids = env.diskOf('sessions').map((s) => s.id).sort();
  assert.deepEqual(ids, ['external-session-legacy', LEGACY_SESSION_ID], '他窗口新增会谈不得被启动期迁移整档覆盖抹掉');
  const mine = env.diskOf('sessions').find((s) => s.id === LEGACY_SESSION_ID);
  assert.equal(mine.transcript, LEGACY_TRANSCRIPT, '旧版大字段必须合并进 DB 当前记录');
  assert.equal(mine.notes, '他窗口改过的备注', '同一条会谈上他窗口写的另一个字段不得被本窗口 cache 回退');
  assert.equal(mine.hasTranscript, true, '报告标记必须按合并后的内容重算');
  assert.equal(mine.date, '2026-03-05', '他窗口改过的 date 不得回退');
  assert.equal(env.diskOf(LEGACY_BLOB_KEY), undefined, '合并成功后旧 blob 键必须清理');
  assert.equal(env.state.storage.has('xj2_sessions'), false, '启动期迁移绝不许落 localStorage 降级');
  assert.equal(env.store.storageInfo().backend, 'IndexedDB（GB 级容量）', '迁移不得翻转降级标志');
  assert.equal(env.store.getSessions().some((s) => s.id === 'external-session-legacy'), true, '提交后的 cache 必须等于库内容');
}, ['M5a', 'M5b', 'M1'], {
  seed: legacySeed,
  local: { 'xj_blob_synthetic-session-1:transcript': LEGACY_TRANSCRIPT },
  onServed: competingSessionsWrite((env) => {
    const stale = env.diskOf('sessions')[0];
    return [
      Object.assign({}, stale, { notes: '他窗口改过的备注', date: '2026-03-05' }),
      Object.assign({}, stale, { id: 'external-session-legacy', clientId: OTHER_CLIENT_ID, transcript: '他窗口新增会谈' }),
    ];
  }),
});

test('migrate: 目标会谈已被他窗口删除 → 迁移不复活、sessions 键零写入，但孤儿 blob 键仍清理', async (env) => {
  assert.deepEqual(env.diskOf('sessions'), [], '他窗口已删除的会谈不得被启动期迁移复活');
  assert.equal(env.putsOf('sessions'), 0, '没有任何可合并内容时必须零写入');
  assert.equal(env.diskOf(LEGACY_BLOB_KEY), undefined, '库里没有对应会谈 → blob 键当孤儿清理');
  assert.equal(env.store.storageInfo().backend, 'IndexedDB（GB 级容量）', '失败路径不得翻转降级标志');
}, ['M5a', 'M5b', 'M1'], {
  seed: legacySeed,
  local: { 'xj_blob_synthetic-session-1:transcript': LEGACY_TRANSCRIPT },
  onServed: competingSessionsWrite(() => []),
});

test('migrate: 字段已有正式内容时不覆盖，且因此零写入', async (env) => {
  assert.equal(env.diskOf('sessions')[0].transcript, '本窗口已有正式逐字稿', '已有内容绝不被旧 blob 覆盖');
  assert.equal(env.putsOf('sessions'), 0, '一条都没合并 → 不得产生 sessions 写入');
  assert.equal(env.diskOf(LEGACY_BLOB_KEY), undefined, '被丢弃的旧 blob 键仍要清理');
}, [], {
  seed: () => {
    const seed = legacySeed();
    seed.sessions[0].transcript = '本窗口已有正式逐字稿';
    return seed;
  },
  local: { 'xj_blob_synthetic-session-1:transcript': LEGACY_TRANSCRIPT },
});

function seedMaterial(id, sessionId, extra) {
  return Object.assign({
    id, sessionId, clientId: CLIENT_ID, title: '合成材料', extractedText: '合成正文',
    parseStatus: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }, extra || {});
}

test('sync: deleteSession 解除材料关联必须按记录 patch，不整档覆盖 materialWorkspaces', async (env) => {
  const external = seedMaterial('external-material-keep', 'other-session', { title: '他窗口新建材料' });
  env.externalWrite('materialWorkspaces', [
    Object.assign({}, env.diskOf('materialWorkspaces')[0], { title: '他窗口改过的标题' }), external,
  ]);
  assert.equal(env.store.deleteSession(LEGACY_SESSION_ID), true);
  await env.flush();
  const list = env.diskOf('materialWorkspaces');
  const mine = list.find((m) => m.id === 'synthetic-material-1');
  assert.equal(mine.sessionId, '', '本窗口的解除关联必须落盘');
  assert.equal(mine.title, '他窗口改过的标题', '同一条材料上他窗口写的标题不得被 cache 回退');
  assert.equal(list.some((m) => m.id === external.id), true, '他窗口新建材料不得被整档覆盖抹掉');
  assert.equal(list.find((m) => m.id === external.id).sessionId, 'other-session', '他窗口材料的关联不得被改动');
  assert.equal(env.store.getMaterialWorkspace('synthetic-material-1').sessionId, '', '本窗口 cache 语义不变');
}, ['M6', 'M1']);

test('sync: deleteSession 无材料关联时不产生任何 materialWorkspaces 写入', async (env) => {
  const other = seedMaterial('other-material', 'other-session');
  env.externalWrite('materialWorkspaces', [other]);
  assert.equal(env.store.deleteSession(LEGACY_SESSION_ID), true);
  await env.flush();
  assert.deepEqual(env.diskOf('materialWorkspaces').map((m) => m.id), ['other-material'], '无关材料不得被触碰');
  assert.equal(env.putsOf('materialWorkspaces'), 0, '没有任何解除关联意图时必须零写入');
}, []);

test('settings: 空 patch 在 IndexedDB 可用时必须零写入（不得把本窗口陈旧设置灌回库）', async (env) => {
  env.externalWrite('settings', {
    apiConfig: { baseUrl: 'https://other-window.invalid' }, version: '1.0.0', aiModelSelection: { tier: 'ultra' },
  });
  const writesBefore = env.writeTxs().length;
  env.store.saveSettings({});
  await env.flush();
  const stored = env.diskOf('settings');
  assert.equal(stored.aiModelSelection.tier, 'ultra', '空 patch 不得用本窗口 cache 的 free 覆盖他窗口的 ultra');
  assert.deepEqual(stored.apiConfig, { baseUrl: 'https://other-window.invalid' }, '空 patch 不得回退他窗口的 apiConfig');
  assert.equal(env.writeTxs().length, writesBefore, '空 patch 必须零写入');
  assert.equal(env.store.getSettings().aiModelSelection.tier, 'free', '同步读 API 仍返回本窗口 cache（语义不变）');
}, ['M7']);

test('settings: 事务失败不得翻转降级标志，之后的设置写仍走事务', async (env) => {
  const backendBefore = env.store.storageInfo().backend;
  env.failNextPut();
  env.store.saveSettings({ theme: 'dark' });
  await env.flush();
  assert.equal(env.store.storageInfo().backend, backendBefore, '一次事务失败绝不能把该 renderer 永久降级');
  assert.equal(env.diskOf('settings').theme, undefined, '失败的提交不得留下任何磁盘改动');
  assert.equal(env.state.storage.has('xj2_settings'), false, '事务失败绝不许改走 localStorage 降级分支');
  env.resetFail();
  const after = await env.store.saveSettingsDurable({ theme: 'light' });
  assert.equal(after.ok, true, '失败后本窗口仍必须能 durable 写');
  assert.equal(env.diskOf('settings').theme, 'light', '之后的写入必须落到 IndexedDB');
}, ['M3']);

// ============================================================
// 反向变异定义（契约 §5 + 单事务补充）
// ============================================================
const MUTATIONS = [
  {
    id: 'M1-cache-array-overwrite',
    key: 'M1',
    description: 'commitInTx 的 mutate 不再收到事务内 DB 快照，而是收到本窗口 cache → 恢复「cache 拼 next 整档覆盖」',
    needle: 'next = mutate(values, out) || {};',
    replacement: 'next = mutate(Object.assign({}, cache), out) || {};',
  },
  {
    id: 'M3-no-abort-rollback',
    key: 'M3',
    description: '去掉事务失败的回滚纪律：abort 后仍把 next 同步进 cache，并按旧缺陷把 _dbAvailable 永久置 false',
    needle: "          const wrapped = error instanceof Error ? error : new Error(String((error && error.message) || error || 'IndexedDB transaction failed'));",
    replacement: '          if (next) Object.keys(next).forEach((key) => { cache[key] = next[key]; });\n          _dbAvailable = false;\n' +
      "          const wrapped = error instanceof Error ? error : new Error(String((error && error.message) || error || 'IndexedDB transaction failed'));",
  },
  {
    id: 'M4-two-transactions',
    key: 'M4',
    description: '把写回从读事务里挪到另一个 readwrite 事务 → read-modify-write 不再原子，且写失败不会再让本次提交失败',
    needle: '              if (Object.prototype.hasOwnProperty.call(next, key)) objectStore.put({ key, value: next[key] });',
    replacement: "              if (Object.prototype.hasOwnProperty.call(next, key)) db.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, value: next[key] });",
  },
  {
    id: 'M2-stale-preview',
    key: 'M2',
    description: 'createDeletionBatch 的 previewHash 改为用本窗口 cache 重算（放弃事务内 DB 快照 CAS）',
    needle: 'const preview = buildDeletionPreview(snapshot, targetType, targetId);',
    replacement: 'const preview = buildDeletionPreview(deletionSnapshot(cache), targetType, targetId);',
  },
  {
    id: 'M5a-legacy-blob-persist-cache',
    key: 'M5a',
    description: '启动期旧版大字段迁移回到 persist(\'sessions\')：库里读回来的记录仍被本窗口 cache 整条 upsert 覆盖（他窗口字段回退）',
    needle: "      await commitInTx(['sessions'], mergeIntoDbSessions, { syncCache: true });",
    replacement: "      persist('sessions');",
  },
  {
    id: 'M5b-legacy-blob-cache-archive',
    key: 'M5b',
    description: '启动期旧版大字段迁移的合并底从「事务内 DB 当前 sessions」换回本窗口 cache（HEAD 原形：整档覆盖，抹掉他窗口新增会谈）',
    needle: '      const list = Array.isArray(values.sessions) ? values.sessions : [];',
    replacement: '      const list = Array.isArray(cache.sessions) ? cache.sessions : [];',
  },
  {
    id: 'M6-delete-session-material-archive',
    key: 'M6',
    description: "deleteSession 解除材料关联回到 persist('materialWorkspaces')（cache 覆盖，回退他窗口字段）",
    needle: "    materialPairs.forEach((pair) => persistRecordIntent('materialWorkspaces', pair.next, pair.base));",
    replacement: "    persist('materialWorkspaces');",
  },
  {
    id: 'M7-empty-settings-patch-writes',
    key: 'M7',
    description: 'saveSettings 的空 patch 重新落盘（回到 !_dbAvailable || !keys.length 分支）→ 本窗口陈旧设置被灌回 DB',
    needle: '    } else if (keys.length) {',
    replacement: '    } else {',
  },
  {
    id: 'M8-sync-supervision-memory-only',
    key: 'M8',
    description: '同步 updateSupervision 回到「只改内存、提交结果一概不回写」：失败不回滚、成功后不把磁盘版本并回活引用',
    needle: 'persistSupervisionPatch(id, base, candidate).then((saved) => {',
    replacement: 'persistSupervisionPatch(id, base, candidate).then((saved) => { void saved; return;',
  },
];

function mutationById(id) {
  const found = MUTATIONS.find((m) => m.id === id);
  if (!found) throw new Error('未知变异 ' + id);
  return found;
}

// ============================================================
// 种子：每个用例自带最小合成数据
// ============================================================
function seedBase() {
  return { clients: [seedClient(CLIENT_ID, '合成甲')] };
}

function syncSeed(name) {
  const clients = [seedClient(CLIENT_ID, '合成甲'), seedClient(OTHER_CLIENT_ID, '合成乙')];
  const sessions = [seedSession('synthetic-session-1', CLIENT_ID)];
  if (name.includes('saveMasterConversation')) {
    return { clients, sessions, masterConversations: [{ id: 'synthetic-conv-1', mode: '1v1', title: '合成甲', messages: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] };
  }
  if (name.includes('createExpense')) {
    return { clients, sessions, expenses: [{ id: 'synthetic-expense', category: 'other', amount: 100, date: '2026-04-01', description: '合成支出', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] };
  }
  if (name.includes('saveSettings')) return { clients, sessions, settings: { apiConfig: {}, version: '1.0.0' } };
  if (name.includes('deleteSession')) {
    return {
      clients, sessions, supervisions: [],
      materialWorkspaces: [seedMaterial('synthetic-material-1', 'synthetic-session-1')],
    };
  }
  if (name.includes('updateSupervision')) return { clients, sessions, supervisions: [{ id: 'synthetic-sup', clientId: CLIENT_ID, sessionIds: [], content: '原正文', conclusion: '原结论', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] };
  if (name.includes('createSupervision')) return { clients, sessions, supervisions: [] };
  if (name.includes('ClinicalActionRun')) return { clients, sessions, clinicalActionRuns: [] };
  if (name.includes('undoBatch')) {
    return {
      clients,
      sessions: [seedSession('synthetic-session-1', CLIENT_ID), seedSession('batch-session-a', CLIENT_ID, { batchId: 'synthetic-batch' })],
      expenses: [{ id: 'batch-expense-a', batchId: 'synthetic-batch', amount: 5 }],
      supervisions: [],
    };
  }
  return { clients, sessions };
}

function seedFor(name) {
  const clients = [seedClient(CLIENT_ID, '合成甲')];  if (name.startsWith('sessions:')) {
    const transcript = name.includes('整批零写入') ? '甲' : '';
    const sessions = [seedSession('synthetic-session-1', CLIENT_ID, { transcript })];
    if (name.includes('批量目标被他窗口删除')) sessions.push(seedSession('synthetic-session-2', CLIENT_ID, { transcript: '乙', date: '2026-03-02' }));
    if (name.includes('clearBillingData')) {
      return {
        clients: [seedClient(CLIENT_ID, '合成甲', { billing: { monthlyPayments: [{ id: 'mp1', month: '2026-03', amount: 500 }] } })],
        sessions: [seedSession('synthetic-session-1', CLIENT_ID, { billing: { fee: 500, paid: false } })],
        expenses: [{ id: 'synthetic-expense', amount: 100, category: 'other', date: '2026-03-01' }],
        supervisions: [], materialWorkspaces: [],
      };
    }
    return {
      clients,
      sessions,
      supervisions: name.includes('deleteSessionsDurable') ? [{ id: 'synthetic-sup', clientId: CLIENT_ID, sessionIds: ['synthetic-session-1', 'other-session'] }] : [],
      materialWorkspaces: [],
    };
  }
  if (name.startsWith('sync:') || name.startsWith('api-shape:')) return syncSeed(name);
  if (name.startsWith('supervisions:')) return {
    clients,
    supervisions: [{ id: 'synthetic-sup', clientId: CLIENT_ID, sessionIds: [], content: '原正文', conclusion: '原结论', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  };
  if (name.startsWith('deletion:') || name.startsWith('import:') || name.startsWith('durable:')) return deletionSeed();
  if (name.startsWith('tasks:')) {
    return Object.assign(seedBase(), {
      sessions: [seedSession('synthetic-session-1', CLIENT_ID)],
      clinicalTasks: [structuredClone(TASK_BASE)],
    });
  }
  if (name.startsWith('masters:')) {
    return Object.assign(seedBase(), {
      masterConversations: [{ id: 'synthetic-conv-1', mode: '1v1', masterKeys: ['m-a'], title: '合成甲', messages: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
  }
  if (name.startsWith('expenses:')) {
    return Object.assign(seedBase(), {
      expenses: [{ id: 'synthetic-expense', category: 'other', amount: 100, date: '2026-04-01', description: '合成支出', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
  }
  if (name.startsWith('settings:')) {
    // aiModelSelection 是本窗口 hydrate 时的旧值：用来证明「空 patch / 失败提交」不会把它灌回库。
    return Object.assign(seedBase(), { settings: { apiConfig: {}, version: '1.0.0', aiModelSelection: { tier: 'free' } } });
  }
  if (name.startsWith('clients:') && name.includes('被他窗口删除')) {
    return { clients: [seedClient(CLIENT_ID, '合成甲'), seedClient(OTHER_CLIENT_ID, '合成乙')] };
  }
  if (name.startsWith('clients:')) return { clients };
  return { clients };
}

async function runCase(item, envOptions) {
  const options = Object.assign({}, item.options || {}, envOptions || {});
  const seed = typeof options.seed === 'function' ? options.seed() : seedFor(item.name);
  const env = await freshStore(seed, options);
  await item.fn(env);
}

function headTail(message) {
  return String(message || '').split('\n').filter((line) => line.trim() !== '').slice(0, 8).join('\n           ');
}

async function runCases(list) {
  const failures = [];
  for (const item of list) {
    const before = assertionCount;
    try {
      // eslint-disable-next-line no-await-in-loop
      await runCase(item);
      console.log('ok   - ' + item.name + ' (' + (assertionCount - before) + ' 断言)');
    } catch (e) {
      failures.push(item.name);
      console.log('FAIL - ' + item.name);
      console.log('       ' + headTail(e && e.message));
    }
  }
  console.log('CASES: total=' + list.length + ' passed=' + (list.length - failures.length) + ' failed=' + failures.length +
    ' assertions=' + assertionCount);
  if (failures.length) process.exitCode = 1;
  return failures;
}

async function runMutations() {
  console.log('=== 反向变异自证：期望每条变异让对应用例转红 ===');
  let survivors = 0;
  for (const mutation of MUTATIONS) {
    if (!mutation.needle) {
      console.log('SKIP     - ' + mutation.id + '（变异点尚未接线）');
      survivors += 1;
      continue;
    }
    CURRENT_TRANSFORM = {
      id: mutation.id,
      transform: (source) => source.split(mutation.needle).join(mutation.replacement),
    };
    const targets = CASES.filter((c) => c.kills.includes(mutation.key));
    let killed = null;
    for (const item of targets) {
      assertionCount = 0;
      try {
        // eslint-disable-next-line no-await-in-loop
        await runCase(item);
      } catch (e) {
        killed = { name: item.name, message: e && e.message };
        break;
      }
    }
    CURRENT_TRANSFORM = null;
    if (killed) {
      console.log('KILLED   - ' + mutation.id + ' → 用例转红：' + killed.name);
      console.log('           红在：' + headTail(killed.message));
    } else {
      survivors += 1;
      console.log('SURVIVED - ' + mutation.id + ' 未被任何用例抓到（覆盖用例 ' + targets.length + ' 个）');
    }
  }
  console.log('MUTATIONS: total=' + MUTATIONS.length + ' survivors=' + survivors);
  if (survivors) process.exitCode = 1;
}

async function main() {
  const arg = process.argv[2] || '';
  if (arg === '--mutation' || arg === '--mutations') return runMutations();
  if (arg.startsWith('--only=')) return runCases(CASES.filter((c) => c.name.includes(arg.slice(7))));
  return runCases(CASES);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
