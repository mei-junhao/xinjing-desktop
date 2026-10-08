/* ============================================================
 * F4 降级态契约回归（app/js/store.js · F4-1 … F4-5 + 三项补证）
 *
 * 判卷依据（唯一需求来源）：
 *   qa/task-scratch/XJ-5.1.19-f1-f7-final-acceptance-001/reviews-r1c/f4-f5-round3.md
 *   §1.2 F4 扣分账 / §1.3 / §9「我没能验证什么」
 * 用例 id 与复审者探针的 S14 / S15 / S16 / S18 语义逐条对齐，另加 S19（F4-4）、
 * S20（F4-5）、E1/E2/E3（三项欠账）。
 *
 * 严格 fake IndexedDB（本轮硬要求，逐条实现并在 F0.* 用例里自证）：
 *   1. get / getAll 一律 structuredClone → 不存在「共享引用蒙混过关」
 *   2. 一个事务内多次 put 只在事务收尾时触发**一次** oncomplete
 *   3. tx.abort() 丢弃整个暂存区 → 整体回滚，绝不留一半
 *   4. readonly 事务里 put/delete 直接抛错
 *   5. 同一 object store 上的 readwrite 事务**串行**（真实 IDB 行为；上一轮夹具缺这条，
 *      导致 S18.concurrent-same-key 出现「两窗口都拿到同一 pre-image」的假红）
 *   6. 每个事务记录 gets / puts，用来断言「读-改-写在同一事务」而不是假定
 *   7. localStorage 为同源共享的权威档，get / set 各自原子、可注入配额异常，
 *      并可在「本窗口读完之后 / 写完之前」投递另一窗口的一次整值写（毫秒级交错）
 *
 * 运行：node scripts/f4-degraded-contract.test.cjs [--out=<file>] [--only=<子串>]
 *       node scripts/f4-degraded-contract.test.cjs --mutations   反向变异自证
 *       node scripts/f4-degraded-contract.test.cjs --mutation=<id>  单条变异
 * 全部为合成数据，不含真实病例 / 真实供应商 / 生产账号。
 * ============================================================ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const rawAssert = require('node:assert/strict');

const STORE_PATH = path.join(__dirname, '../app/js/store.js');
const SOURCE = fs.readFileSync(STORE_PATH, 'utf8');
const OUT_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-f4-degraded-evidence-'));

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

let CURRENT_TRANSFORM = null;
function loadSource() { return CURRENT_TRANSFORM ? CURRENT_TRANSFORM(SOURCE) : SOURCE; }

// ------------------------------------------------------------
// 严格 fake IndexedDB + 同源共享 localStorage
// ------------------------------------------------------------
function makeOrigin() {
  return {
    rows: new Map(),        // IndexedDB kv object store（durable 真值）
    ls: new Map(),          // 同源共享 localStorage（降级影子档）
    lsOps: [],              // 每一次 localStorage 变更（set / remove）都记一条 —— 「零写入」不能靠比对字节判定
    txLog: [],
    completeFires: [],      // 每次真正调用 tx.oncomplete 的 {id, mode, puts} —— 「一事务只有一次 complete」必须是**量出来的**
    holder: null,           // 当前持有 store 的 readwrite 事务
    waiters: [],
    failPut: null,          // (key) => true 时 put 抛错
    failLS: null,           // (key) => true 时 setItem 抛 QuotaExceededError
    failLSRemove: null,     // (key) => true 时 removeItem 抛错（隐私模式 / 存储被禁）
    afterGet: null,         // 一次性交错钩子：本窗口读完之后
    afterSet: null,         // 一次性交错钩子：本窗口写完之后
  };
}

function makeLocalStorage(origin, who) {
  const map = origin.ls;
  const fire = (hookName, info) => {
    const hook = origin[hookName];
    if (!hook) return;
    origin[hookName] = null;                 // 一次性，避免自己递归
    try { hook(info); } catch (e) { /* 交错脚本自身的错不该污染被测件 */ }
  };
  return {
    get length() { return map.size; },
    key: (i) => { const keys = Array.from(map.keys()); return i < keys.length ? keys[i] : null; },
    getItem(k) {
      const value = map.has(k) ? map.get(k) : null;   // 先取快照再放钩子 = 真实交错
      fire('afterGet', { key: k, by: who });
      return value;
    },
    setItem(k, v) {
      if (origin.failLS && origin.failLS(k)) {
        const error = new Error('injected quota failure for ' + k);
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(k, String(v));
      origin.lsOps.push({ op: 'set', key: k, by: who });
      fire('afterSet', { key: k, by: who });
    },
    removeItem(k) {
      if (origin.failLSRemove && origin.failLSRemove(k)) {
        const error = new Error('injected removeItem failure for ' + k);
        error.name = 'QuotaExceededError';
        throw error;                      // 真 removeItem 抛错时条目不会被删掉
      }
      map.delete(k);
      origin.lsOps.push({ op: 'remove', key: k, by: who });
    },
    clear() { map.clear(); },
  };
}

function makeIDB(origin, counters, opts) {
  const rows = origin.rows;

  function acquire(tx) {
    if (tx.mode !== 'readwrite') return Promise.resolve();
    if (!origin.holder || origin.holder === tx) { origin.holder = tx; return Promise.resolve(); }
    return new Promise((resolve) => { origin.waiters.push({ tx, resolve }); });
  }
  function release(tx) {
    if (origin.holder !== tx) return;
    origin.holder = null;
    while (origin.waiters.length) {
      const waiter = origin.waiters.shift();
      if (waiter.tx.done || waiter.tx.aborted) continue;
      origin.holder = waiter.tx;
      waiter.resolve();
      return;
    }
  }
  function closeCounters(tx) {
    if (tx.mode === 'readwrite' && !tx.counted) { tx.counted = true; counters.open -= 1; }
  }

  function abortTx(tx, error) {
    if (tx.aborted || tx.done) return;
    tx.aborted = true;
    tx.error = error || new Error('transaction aborted');
    tx.staged.clear();                        // 整体回滚：暂存区全丢
    origin.txLog.push({ id: tx.id, mode: tx.mode, gets: tx.gets.slice(), puts: tx.puts.slice(), issued: tx.issued.slice(), outcome: 'abort', completes: 0 });
    closeCounters(tx);
    release(tx);
    if (typeof tx.onabort === 'function') queueMicrotask(() => { if (tx.onabort) tx.onabort(); });
  }

  function commitTx(tx) {
    if (tx.done || tx.aborted) return;
    acquire(tx).then(() => {
      if (tx.done || tx.aborted) return;
      tx.done = true;
      tx.staged.forEach((row, key) => {
        if (row.__xjdel) rows.delete(key);
        else rows.set(key, structuredClone(row));
      });
      const rec = { id: tx.id, mode: tx.mode, gets: tx.gets.slice(), puts: tx.puts.slice(), issued: tx.issued.slice(), outcome: 'complete', completes: 0 };
      origin.txLog.push(rec);
      origin.completeFires.push(rec);
      closeCounters(tx);
      release(tx);
      if (typeof tx.oncomplete === 'function') queueMicrotask(() => {
        if (!tx.oncomplete) return;
        // 计数「oncomplete 真的被调了几次」，而不是「txLog 里这条事务记了几次」——
        // 后者是结构性恒真（每事务只 push 一条），前者才测得住「多次 put 各自触发」。
        rec.completes += 1;
        tx.oncomplete();
      });
    });
  }

  function scheduleCheck(tx) {
    setImmediate(() => { if (!tx.done && !tx.aborted && tx.pending === 0) commitTx(tx); });
  }

  let seq = 0;
  function begin(mode) {
    const tx = {
      id: ++seq, mode, gets: [], puts: [], issued: [], staged: new Map(), pending: 0,
      aborted: false, done: false, counted: false, error: null,
      oncomplete: null, onabort: null, onerror: null,
      abort() { abortTx(tx, tx.error || new Error('aborted by implementation')); },
      objectStore() { return objectStore; },
    };
    if (mode === 'readwrite') {
      counters.open += 1;
      if (counters.open > counters.maxOpen) counters.maxOpen = counters.open;
    }
    function request(kind, arg) {
      tx.pending += 1;
      const req = { kind, result: undefined, error: null, onsuccess: null, onerror: null };
      const serve = () => {
        if (tx.aborted || tx.done) { finish(); return; }
        if (kind === 'get') {
          const source = tx.staged.has(arg.key) ? tx.staged.get(arg.key) : rows.get(arg.key);
          tx.gets.push(arg.key);
          req.result = source && !source.__xjdel ? structuredClone(source) : undefined;   // 深拷贝
        } else if (kind === 'getAll') {
          const merged = new Map(rows);
          tx.staged.forEach((row, key) => { if (row.__xjdel) merged.delete(key); else merged.set(key, row); });
          tx.gets.push('*');
          req.result = Array.from(merged.values()).map((row) => structuredClone(row));
        } else if (kind === 'delete') {
          tx.puts.push('del:' + arg.key);
          tx.staged.set(arg.key, { key: arg.key, __xjdel: true });
        } else if (kind === 'put') {
          tx.puts.push(arg.row.key);
          tx.staged.set(arg.row.key, structuredClone(arg.row));     // 只暂存，提交才可见
        }
        finish();
      };
      const finish = () => {
        tx.pending -= 1;
        if (req.onsuccess) req.onsuccess.call(req, { target: req });
        if (tx.pending === 0) commitTx(tx);
      };
      acquire(tx).then(serve);
      return req;
    }
    const objectStore = {
      get: (key) => request('get', { key }),
      getAll: () => request('getAll', null),
      delete(key) {
        if (mode === 'readonly') throw new Error('FakeIDB: delete in readonly transaction');
        tx.issued.push('del:' + key);            // 同步记账：产品「发出了」这条写请求（puts 是异步 serve 才记的）
        return request('delete', { key });
      },
      put(row) {
        if (mode === 'readonly') throw new Error('FakeIDB: put in readonly transaction');
        tx.issued.push(row.key);                 // 同上：注入失败时也要留下「曾经发出这条 put」的痕迹
        if (opts.failPut && opts.failPut(row.key)) {
          const error = new Error('injected put failure for ' + row.key);
          error.name = 'ConstraintError';
          throw error;
        }
        return request('put', { row });
      },
    };
    scheduleCheck(tx);
    return tx;
  }

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction(storeName, mode) { return begin(mode || 'readonly'); },
  };
  const indexedDB = {
    open() {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (opts.unavailable) {
          req.error = Object.assign(new Error('IndexedDB unavailable'), { name: opts.errName || 'SecurityError' });
          if (req.onerror) req.onerror({ target: req });
        } else {
          req.result = db;
          if (req.onsuccess) req.onsuccess({ target: req });
        }
      });
      return req;
    },
    deleteDatabase() { const q = {}; queueMicrotask(() => { if (q.onsuccess) q.onsuccess(); }); return q; },
  };
  return { indexedDB, db };
}

// ------------------------------------------------------------
// 一个「窗口」= 一个独立 Store 实例，共享同一个 origin
// ------------------------------------------------------------
function makeWindow(src, origin, opts) {
  opts = opts || {};
  const counters = { open: 0, maxOpen: 0, reloads: 0 };
  const listeners = { message: [] };
  const win = {
    ClinicalTaskValidators: { normalizeClinicalTask: (x) => x, hasClinicalBodyField: () => false },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] || []).filter((candidate) => candidate !== fn);
    },
    localStorage: makeLocalStorage(origin, opts.tag || 'w'),
    location: { reload() { counters.reloads += 1; } },
  };
  const idb = makeIDB(origin, counters, opts);
  win.indexedDB = idb.indexedDB;
  const document = {
    body: { appendChild() {}, removeChild() {} },
    createElement() {
      const iframe = { style: {}, parentNode: null, contentWindow: { __frame: true } };
      let assigned = '';
      Object.defineProperty(iframe, 'src', {
        get() { return assigned; },
        set(value) {
          assigned = value;
          const matched = /^http:\/\/127\.0\.0\.1:(\d+)\/migrate-helper\.html$/.exec(value);
          if (!matched) return;
          const port = matched[1];
          setTimeout(() => {
            listeners.message.slice().forEach((fn) => fn({
              origin: 'http://127.0.0.1:' + port,
              source: iframe.contentWindow,
              data: { __xj_migrate: true, data: (opts.legacyPorts || {})[port] || null },
            }));
          }, 0);
        },
      });
      return iframe;
    },
  };
  const sandbox = {
    window: win,
    document,
    console: { log() {}, info() {}, warn() {}, error() {} },
    Date, structuredClone, Promise, Error, JSON, Math, Array, Object, String, Number,
    Boolean, Set, Map, RegExp, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
    queueMicrotask, encodeURIComponent, decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;
  sandbox.localStorage = win.localStorage;
  sandbox.indexedDB = win.indexedDB;
  sandbox.location = win.location;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.Store = Store;', sandbox);
  return { Store: sandbox.Store, win, counters, sandbox, origin };
}

const flush = (n) => new Promise((resolve) => {
  let k = n == null ? 8 : n;
  const step = () => { if (k-- > 0) setImmediate(step); else resolve(); };
  step();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 降级写会排一个「下一轮宏任务」的延迟复核，所以 settle 比 flush 多等一拍
const settle = async (n) => { await sleep(2); await flush(n == null ? 8 : n); };

// ------------------------------------------------------------
// 归档读数与稳定化
// ------------------------------------------------------------
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
const VOLATILE_KEYS = new Set(['createdAt', 'updatedAt', 'appliedAt', 'restoredAt', 'version', 'storeRevision', 'at', 'modifiedAt']);
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((k) => { if (!VOLATILE_KEYS.has(k)) out[k] = stripVolatile(value[k]); });
    return out;
  }
  return value;
}
function archive(origin, key, degraded) {
  if (degraded) {
    const raw = origin.ls.get('xj2_' + key);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); } catch (e) { return '<unparsable>'; }
  }
  const row = origin.rows.get(key);
  return row ? row.value : undefined;
}
function fullSnapshot(origin, degraded) {
  if (degraded) {
    const out = {};
    Array.from(origin.ls.keys()).filter((k) => k.startsWith('xj2_')).sort().forEach((k) => {
      let value;
      try { value = JSON.parse(origin.ls.get(k)); } catch (e) { value = '<unparsable>'; }
      out[k.slice(4)] = value;
    });
    return stable(out);
  }
  const out = {};
  Array.from(origin.rows.keys()).sort().forEach((k) => { out[k] = origin.rows.get(k).value; });
  return stable(out);
}
function canonArchive(origin, key, degraded) { return stable(stripVolatile(archive(origin, key, degraded) || [])); }
function idsOf(list) { return (list || []).map((x) => x && x.id).filter(Boolean).sort(); }
function diagnosticsOf(W) { return W.Store.getStorageDiagnostics(); }
function diagCodes(W) { return diagnosticsOf(W).map((d) => d.code + ':' + (d.collection || '')); }
function findDiag(list, code, collection) {
  return list.filter((d) => d.code === code && (!collection || d.collection === collection));
}

// ------------------------------------------------------------
// 用例登记
// ------------------------------------------------------------
const CASES = [];
function test(name, fn) { CASES.push({ name, fn }); }

// ============ F0：夹具自身的自证（断言必须可能为假，先把尺子校准） ============
test('F0.fake-get-returns-deep-copy', async () => {
  const origin = makeOrigin();
  origin.rows.set('clients', { key: 'clients', value: [{ id: 'c1', name: '原值' }] });
  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle();
  const read = await W.Store._get('clients');
  read[0].name = '被我改掉了';
  assert.equal(origin.rows.get('clients').value[0].name, '原值', 'get 必须返回深拷贝，改副本不许污染库');
});

test('F0.fake-one-oncomplete-per-transaction', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle();
  await W.Store.importAll(JSON.stringify({
    clients: [{ id: 'c1', name: '甲' }, { id: 'c2', name: '乙' }],
    sessions: [], supervisions: [], supervisorIdentities: [], expenses: [], masterConversations: [], settings: {},
  }));
  await settle();
  const multi = origin.txLog.filter((t) => t.puts.filter((p) => p === 'clients' || p === 'expenses' || p === 'settings').length > 1);
  assert.ok(multi.length >= 1, 'premise: 夹具里存在一次事务多次 put');
  // 注意：原断言是 `multi.every(t => t.outcome === 'complete')` —— 那测的是「这条事务没被记成 abort」，
  // 而 txLog 每条事务结构上只 push 一次，所以它**永远不可能因为「多次 put 各自触发 oncomplete」而红**
  // （名不副实的自证）。这里改成交量：数 oncomplete 真被调了几次。
  assert.ok(multi.every((t) => t.completes === 1),
    '一次事务多次 put 只能触发一次 oncomplete，实得：' + JSON.stringify(multi.map((t) => [t.id, t.puts.length, t.completes])));
  assert.equal(origin.completeFires.reduce((n, t) => n + t.completes, 0) >= multi.length, true,
    'premise: completes 计数确实在被增量写入（不是结构性 0/1 常量）');
});

test('F0.fake-abort-rolls-back-everything', async () => {
  const origin = makeOrigin();
  origin.rows.set('clients', { key: 'clients', value: [{ id: 'keep', name: '原样' }] });
  // 关键：失败必须发生在**同一事务已经写成过至少一条**之后，否则「abort 不整体回滚」这种
  // 夹具缺陷根本 observable（上一版用「唯一一条 put 就抛错」的注入，暂存区本来就是空的，
  // 把 abortTx 的回滚拆掉用例照样绿 —— 那是没有牙齿的自证）。
  const W = makeWindow(loadSource(), origin, { failPut: (k) => k === 'settings' });
  await W.Store.hydrate();
  await settle();
  const before = fullSnapshot(origin, false);
  const imported = await W.Store.importAll(JSON.stringify({
    clients: [{ id: 'new-c', name: '导入的来访者' }],
    sessions: [], supervisions: [], supervisorIdentities: [], expenses: [], masterConversations: [],
    settings: { theme: '导入的设置' },
  }));
  await settle(16);
  const aborted = origin.txLog.filter((t) => t.outcome === 'abort');
  assert.ok(imported && imported.ok === false, 'premise: 导入必须整体失败');
  assert.ok(aborted.length >= 1, 'premise: 出现了 abort 的事务');
  assert.ok(aborted.some((t) => (t.issued || []).filter((p) => p !== 'settings').length >= 1),
    'premise: 失败前该事务已经发出过别的写入（否则回滚断言是空转）：'
      + JSON.stringify(aborted.map((t) => [t.gets.length, t.issued, t.puts])));
  assert.equal(fullSnapshot(origin, false), before,
    '事务失败必须整体回滚：已 staged 的写入一条都不许留在盘上');
  assert.deepEqual(idsOf(archive(origin, 'clients', false) || []), ['keep'], '已 staged 的 clients 写入必须被回滚');
});

test('F0.fake-readwrite-transactions-serialize', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { tag: 'A' });
  const B = makeWindow(loadSource(), origin, { tag: 'B' });
  await A.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  origin.txLog.length = 0;
  const mk = (key) => ({
    mode: 'multi-school', archiveKey: key, supervisorName: '合成多学派', clientId: 'c1',
    sessionIds: [], content: '正文', schools: ['sup-winnicott'], analyses: [], createdAt: '2026-01-01T00:00:00.000Z',
  });
  const race = await Promise.all([
    A.Store.saveAiSupervisionDurable(mk('ak-race')),
    B.Store.saveAiSupervisionDurable(mk('ak-race')),
  ]);
  await settle();
  const rows = archive(origin, 'supervisions', false) || [];
  assert.equal(race.every((r) => r && r.ok === true), true, '两个窗口都必须拿到明确结果', race);
  assert.equal(rows.length, 1, '同 archiveKey 并发只留一行');
  assert.equal(race.filter((r) => r.reused === true).length, 1, '且恰好一个报 reused（说明 readwrite 事务被串行化了）');
});

test('S18.different-archiveKey-concurrent-both-kept', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { tag: 'A' });
  const B = makeWindow(loadSource(), origin, { tag: 'B' });
  await A.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  const mk = (key) => ({
    mode: 'multi-school', archiveKey: key, supervisorName: '合成多学派', clientId: 'c1',
    sessionIds: [], content: '正文' + key, schools: ['sup-winnicott'], analyses: [], createdAt: '2026-01-01T00:00:00.000Z',
  });
  await Promise.all([
    A.Store.saveAiSupervisionDurable(mk('ak-1')),
    B.Store.saveAiSupervisionDurable(mk('ak-2')),
  ]);
  await settle();
  const keys = (archive(origin, 'supervisions', false) || []).map((r) => r.archiveKey).sort();
  assert.deepEqual(keys, ['ak-1', 'ak-2'], '不同 archiveKey 并发归档互不覆盖');
});

// ============ F4-1：降级态督导必须落盘（不得 throw 后冒充成功） ============
const SUPERVISION_OPS = (S) => {
  const one = S.createSupervision({ supervisorName: '真人督导', content: '正文一', conclusion: '结论一' });
  S.createSupervision({ id: 'sv-fixed', supervisorName: '固定号', content: '正文二', conclusion: '结论二' });
  S.updateSupervision('sv-fixed', { conclusion: '改过的结论' });
  S.deleteSupervision(one.id);
  return one.id;
};

test('S15.degraded-supervision-persisted', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  const sv = W.Store.createSupervision({ supervisorName: '合成督导', content: '正文', conclusion: '结论' });
  await settle();
  assert.ok(sv && sv.id, 'premise: 同步 API 返回了记录（看起来像成功）');
  const rows = archive(origin, 'supervisions', true);
  assert.ok(Array.isArray(rows), '降级态督导必须写进共享 xj2_supervisions');
  assert.ok(rows.some((r) => r.id === sv.id), '记录本体必须在盘上');
  assert.equal(diagnosticsOf(W).length, 0, '真的落盘了就不该留诊断：' + JSON.stringify(diagCodes(W)));
});

test('S15.degraded-supervision-survives-restart', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true });
  await A.Store.hydrate();
  await settle();
  SUPERVISION_OPS(A.Store);
  await settle(16);
  const B = makeWindow(loadSource(), origin, { unavailable: true });
  await B.Store.hydrate();
  await settle(16);
  const rows = archive(origin, 'supervisions', true) || [];
  assert.equal(idsOf(rows).join(','), 'sv-fixed', '重启后只剩没被删的那条：删除与新增都落到了盘上');
  assert.equal(rows.find((r) => r.id === 'sv-fixed').conclusion, '改过的结论', '字段级更新也落到了盘上');
  assert.deepEqual(idsOf(B.Store.getSupervisions()), ['sv-fixed'], '新窗口水合后看到的就是盘上的样子');
});

test('S15.degraded-vs-durable-supervision-same-spec', async () => {
  const runs = {};
  for (const mode of ['durable', 'degraded']) {
    const origin = makeOrigin();
    const W = makeWindow(loadSource(), origin, mode === 'degraded' ? { unavailable: true } : {});
    await W.Store.hydrate();
    await settle();
    const mk = (key) => ({
      mode: 'multi-school', archiveKey: key, supervisorName: '多学派', clientId: 'c1', sessionIds: [],
      content: '正文', schools: ['sup-winnicott'], analyses: [], createdAt: '2026-01-01T00:00:00.000Z',
    });
    SUPERVISION_OPS(W.Store);
    await W.Store.saveAiSupervisionDurable(mk('ak-x'));
    await W.Store.saveAiSupervisionDurable(mk('ak-x'));
    await W.Store.saveAiSupervisionDurable(mk('ak-y'));
    await settle(16);
    runs[mode] = stripVolatile(archive(origin, 'supervisions', mode === 'degraded') || []);
  }
  const shape = (list) => list.map((r) => ({
    conclusion: r.conclusion, supervisorName: r.supervisorName,
    archiveKey: r.archiveKey || '', mode: r.mode || '',
  })).sort((a, b) => stable(a).localeCompare(stable(b)));
  assert.deepEqual(shape(runs.degraded), shape(runs.durable),
    '降级与 durable 的督导终态档案必须同规格（同记录集、同字段、同 archiveKey 幂等判定）');
  assert.equal(shape(runs.degraded).length, 3, 'premise: 3 条（1 条真人 + 2 个不同 archiveKey）');
  assert.equal(shape(runs.degraded).filter((r) => r.archiveKey === 'ak-x').length, 1, '同 archiveKey 只留一行');
});

test('S15.degraded-supervision-archiveKey-idempotent', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  const mk = () => ({
    mode: 'multi-school', archiveKey: 'ak-1', supervisorName: '多学派', clientId: 'c1', sessionIds: [],
    content: '正文', schools: ['sup-winnicott'], analyses: [], createdAt: '2026-01-01T00:00:00.000Z',
  });
  const first = await W.Store.saveAiSupervisionDurable(mk());
  const second = await W.Store.saveAiSupervisionDurable(mk());
  await settle();
  assert.equal(first.ok, true, '降级首次归档必须成功');
  assert.equal(second.ok, true, '第二次也不报错');
  assert.equal(second.reused, true, '同 archiveKey 第二次必须报 reused（幂等判定与 durable 同规格）');
  assert.equal((archive(origin, 'supervisions', true) || []).length, 1, '盘上只有一行');
});

test('S15.degraded-supervision-cross-window-add-no-clobber', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  const B = makeWindow(loadSource(), origin, { unavailable: true, tag: 'B' });
  await A.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  const a = A.Store.createSupervision({ id: 'sa', supervisorName: 'A 的督导', content: 'x', conclusion: 'y' });
  await settle();
  const b = B.Store.createSupervision({ id: 'sb', supervisorName: 'B 的督导', content: 'x', conclusion: 'y' });
  await settle();
  assert.ok(a && b, 'premise: 两个窗口都各自返回了记录');
  assert.deepEqual(idsOf(archive(origin, 'supervisions', true) || []), ['sa', 'sb'],
    'B 的归档不得把 A 刚落盘的督导整档抹掉');
});

test('S15.degraded-supervision-session-cleanup-lands', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  W.Store.createSupervision({ id: 'sv1', supervisorName: '督导', content: '', conclusion: '', sessionIds: ['sx', 'keep'] });
  await settle();
  W.Store.deleteSession('sx');
  await settle(16);
  const rows = archive(origin, 'supervisions', true) || [];
  assert.deepEqual(rows.find((r) => r.id === 'sv1').sessionIds, ['keep'],
    '会谈删除后的督导解除关联必须落到降级档案里（否则重启复活旧关联）');
});

test('S15.degraded-supervision-write-failure-is-honest', async () => {
  const origin = makeOrigin();
  origin.failLS = (k) => k === 'xj2_supervisions';
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  const result = await W.Store.saveSupervisionDurable({ id: 'svfail', supervisorName: '写不进', content: '', conclusion: '' });
  await settle();
  assert.equal(result.ok, false, '降级写失败必须返回 ok:false，不得冒充成功');
  assert.equal(result.error && result.error.code, 'XJ_DEGRADED_SUPERVISION_SAVE_FAILED');
  assert.equal(archive(origin, 'supervisions', true), undefined, '没落盘就是没落盘');
  assert.ok(findDiag(diagnosticsOf(W), 'XJ_DEGRADED_WRITE_FAILED', 'supervisions').length >= 1,
    '失败必须进诊断台账：' + JSON.stringify(diagCodes(W)));
});

test('S15.durable-supervision-persisted-control', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle();
  const sv = W.Store.createSupervision({ supervisorName: '合成督导', content: '正文', conclusion: '结论' });
  await settle();
  assert.ok((archive(origin, 'supervisions', false) || []).some((r) => r.id === sv.id), 'durable 侧同 API 必须照常落盘');
  assert.equal(origin.ls.has('xj2_supervisions'), false, 'durable 侧绝不许碰降级影子档');
});

// ============ F4-2：降级 settings 与 durable 同规格（只合并本次键） ============
async function settingsScenario(degraded) {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, degraded ? { unavailable: true, tag: 'A' } : { tag: 'A' });
  await A.Store.hydrate();
  await settle();
  const B = makeWindow(loadSource(), origin, degraded ? { unavailable: true, tag: 'B' } : { tag: 'B' });
  await B.Store.hydrate();
  await settle();
  A.Store.saveSettings({ theme: 'light', apiConfig: { tier: 'old' } });
  await settle();
  B.Store.saveSettings({ apiConfig: { tier: 'new' }, betaFlag: { owner: 'B' } });
  await settle();
  A.Store.saveSettings({ locale: 'zh-CN' });
  await settle();
  return { value: archive(origin, 'settings', degraded) || {}, origin, A, B };
}

test('S14.settings-cross-window-same-spec-as-durable', async () => {
  const durable = await settingsScenario(false);
  const degraded = await settingsScenario(true);
  assert.equal(stable(stripVolatile(degraded.value)), stable(stripVolatile(durable.value)),
    '降级 settings 终态必须与 durable 逐键同规格：' + stable(degraded.value) + ' vs ' + stable(durable.value));
  assert.equal(degraded.value.apiConfig.tier, 'new', '后写入的陈旧窗口不得把另一窗口的 apiConfig 回滚成 old');
  assert.equal(degraded.value.theme, 'light');
  assert.equal(degraded.value.locale, 'zh-CN');
  assert.deepEqual(degraded.value.betaFlag, { owner: 'B' });
});

test('S14b.durable-settings-cross-window-control', async () => {
  const durable = await settingsScenario(false);
  assert.equal(durable.value.apiConfig.tier, 'new', '对照：durable 侧本来就不该回滚');
  assert.equal(durable.value.theme, 'light');
});

test('S14d.settings-degraded-empty-patch-zero-write', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  origin.ls.set('xj2_settings', JSON.stringify({ apiConfig: { tier: 'other-window' } }));
  const before = origin.ls.get('xj2_settings');
  origin.lsOps.length = 0;
  W.Store.saveSettings({});
  W.Store.saveSettings(null);
  await settle();
  // 「零写入」不能靠比对字节判定：把读回来的档原样序列化写回去，字节也不变，
  // 于是「空 patch 也走一遍读-合并-写」这种旁路在该断言下是**测不出来**的（前任变异
  // F4-2-settings-degraded-empty-patch-writes 正是这样活下来的）。这里改成交量。
  const writes = origin.lsOps.filter((o) => o.key === 'xj2_settings');
  assert.deepEqual(writes, [], '降级态空 patch 必须零次 localStorage 写（与 durable 同规格），实得：' + JSON.stringify(writes));
  assert.equal(origin.ls.get('xj2_settings'), before, '并且盘上内容一字不变');
});

test('S14e.settings-degraded-late-writer-keeps-foreign-key', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  await A.Store.hydrate();
  await settle();
  const B = makeWindow(loadSource(), origin, { unavailable: true, tag: 'B' });
  await B.Store.hydrate();
  await settle();
  B.Store.saveSettings({ betaFlag: { owner: 'B' } });
  await settle();
  A.Store.saveSettings({ theme: 'dark' });
  await settle();
  const value = archive(origin, 'settings', true) || {};
  assert.deepEqual(value.betaFlag, { owner: 'B' }, 'A 的迟到写入不得抹掉只有 B 设过的键');
});

// ============ F4-3：降级写失败必须可见（诊断台账 / 返回值），不得报成功 ============
test('S16.quota-failure-visible', async () => {
  const origin = makeOrigin();
  origin.failLS = (k) => k === 'xj2_supervisorIdentities';
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  W.Store.createSupervisorIdentity({ id: 'q1', name: 'Q', prompt: 'p' });
  await settle();
  const diagnostics = diagnosticsOf(W);
  assert.ok(diagnostics.length > 0, '降级配额失败必须进诊断台账，实得：' + JSON.stringify(diagnostics));
  assert.ok(findDiag(diagnostics, 'XJ_DEGRADED_WRITE_FAILED', 'supervisorIdentities').length >= 1,
    '台账里必须点名是哪个集合：' + JSON.stringify(diagCodes(W)));
  assert.deepEqual(idsOf(archive(origin, 'supervisorIdentities', true) || []), [], '没落盘就不许出现在档案里');
});

test('S16b.quota-failure-supervision-visible', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  origin.failLS = (k) => k === 'xj2_supervisions';
  W.Store.createSupervision({ id: 'svq', supervisorName: '配额', content: '', conclusion: '' });
  await settle();
  assert.ok(findDiag(diagnosticsOf(W), 'XJ_DEGRADED_WRITE_FAILED', 'supervisions').length >= 1,
    '同步督导 API 的降级写失败必须留痕：' + JSON.stringify(diagCodes(W)));
  assert.equal(archive(origin, 'supervisions', true), undefined);
});

test('S16c.quota-failure-settings-visible', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  origin.failLS = (k) => k === 'xj2_settings';
  W.Store.saveSettings({ apiConfig: { tier: 'x' } });
  await settle();
  assert.ok(findDiag(diagnosticsOf(W), 'XJ_DEGRADED_WRITE_FAILED', 'settings').length >= 1,
    '设置降级写失败必须留痕：' + JSON.stringify(diagCodes(W)));
});

test('S16d.kv-put-failure-visible', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { failPut: (k) => k === 'draft:1' });
  await W.Store.hydrate();
  await settle();
  let rejected = null;
  try { await W.Store._put('draft:1', { version: 1, fields: {} }); } catch (e) { rejected = e; }
  assert.ok(rejected, '_put 的事务级失败必须上抛（consult-notes 自己有 .catch）');
  assert.ok(findDiag(diagnosticsOf(W), 'XJ_KV_WRITE_FAILED', 'draft:1').length >= 1,
    '并且进诊断台账：' + JSON.stringify(diagCodes(W)));
});

test('S16e.durable-intent-failure-diagnostic', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { failPut: (k) => k === 'supervisorIdentities' });
  await W.Store.hydrate();
  await settle();
  W.Store.createSupervisorIdentity({ id: 'df1', name: 'D', prompt: 'p' });
  await settle();
  assert.ok(findDiag(diagnosticsOf(W), 'XJ_DURABLE_INTENT_WRITE_FAILED', 'supervisorIdentities').length >= 1,
    'durable 侧同步 intent 失败同样必须留痕：' + JSON.stringify(diagCodes(W)));
  assert.equal(W.Store.storageInfo().backend.indexOf('IndexedDB') >= 0, true, '一次事务失败不得把窗口永久降级');
});

test('S16f.degraded-corrupt-archive-is-reported-not-clobbered', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  origin.ls.set('xj2_supervisorIdentities', '{坏掉的 JSON');
  W.Store.createSupervisorIdentity({ id: 'cc1', name: 'C', prompt: 'p' });
  await settle();
  assert.ok(findDiag(diagnosticsOf(W), 'XJ_DEGRADED_ARCHIVE_UNPARSABLE', 'supervisorIdentities').length >= 1,
    '共享档案坏了必须点名，而不是悄悄整档替换：' + JSON.stringify(diagCodes(W)));
  assert.equal(origin.ls.get('xj2_supervisorIdentities'), '{坏掉的 JSON', '读不回来时不许借机覆盖别人的档案');
});

// ============ F4-4：_put 走同一原语（单写入者队列 + 单事务 + 失败可见） ============
test('S16g.kv-put-degraded-failure-visible', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  origin.failLS = (k) => k === 'xj2_activities';
  origin.failLSRemove = (k) => k === 'xj2_user_memory_profile';
  let putRejected = null;
  try { await W.Store._put('activities', [{ id: 'a1' }]); } catch (e) { putRejected = e; }
  assert.ok(putRejected, '降级态 _put 撞配额必须上抛（调用方 memory.js 只有 console.error，台账要能兜住）');
  let delRejected = null;
  try { await W.Store._del('user_memory_profile'); } catch (e) { delRejected = e; }
  assert.ok(delRejected, '降级态 _del 失败同样不得被吞掉');
  const diagnostics = diagnosticsOf(W);
  assert.ok(findDiag(diagnostics, 'XJ_DEGRADED_WRITE_FAILED', 'activities').length >= 1,
    '写失败要按集合点名进台账：' + JSON.stringify(diagCodes(W)));
  assert.ok(findDiag(diagnostics, 'XJ_DEGRADED_REMOVE_FAILED', 'user_memory_profile').length >= 1,
    '删失败也要点名：' + JSON.stringify(diagCodes(W)));
  assert.equal(origin.ls.has('xj2_activities'), false, '没落盘就是没落盘，影子档里不许凭空多出一条');
});

test('S19.kv-put-shares-single-writer-queue', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle();
  W.counters.open = 0;
  W.counters.maxOpen = 0;
  await Promise.all([
    W.Store._put('activities', [{ id: 'a1' }]),
    W.Store.createExpenseDurable({ id: 'e1', amount: 3, category: 'other', date: '2024-01-01' }),
    W.Store._put('user_memory_profile', { name: '合成' }),
    W.Store.saveSupervisionDurable({ id: 'svq', supervisorName: '队列', content: '', conclusion: '' }),
  ]);
  await settle();
  assert.equal(W.counters.maxOpen, 1, '同一窗口内 readwrite 事务必须一次只开一个（全部走 queueStoreWrite）');
  const rw = origin.txLog.filter((t) => t.mode === 'readwrite');
  assert.ok(rw.length >= 4, 'premise: 这一把至少开出 4 个 readwrite 事务（4 个并发写各自一个），实得 ' + rw.length);
  assert.equal(rw.every((t) => t.puts.length >= 1), true,
    '排进队列的每个 readwrite 事务都必须真的带写操作（空事务 = 有谁被旁路了）：'
      + JSON.stringify(rw.map((t) => [t.id, t.gets, t.puts, t.outcome])));
  assert.ok(archive(origin, 'activities', false), 'KV 写仍然成功');
  assert.deepEqual(idsOf(archive(origin, 'expenses', false) || []), ['e1']);
});

test('S19b.kv-put-is-whole-value-contract', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle();
  await W.Store._put('activities', [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]);
  await W.Store._put('activities', [{ id: 'a3' }]);          // memory.js 的滚动窗口裁剪
  await settle();
  assert.deepEqual(idsOf(archive(origin, 'activities', false) || []), ['a3'],
    '_put 契约就是整值替换：被裁掉的旧条目不得被并档复活');
});

test('S19c.kv-mutate-is-cross-window-rmw', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { tag: 'A' });
  const B = makeWindow(loadSource(), origin, { tag: 'B' });
  await A.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  await A.Store._put('activities', ['seed']);
  await settle();
  // 两个窗口各自「读-改-写」追加一条：事务内 RMW 必须两条都在
  await Promise.all([
    A.Store._mutate('activities', (current) => (Array.isArray(current) ? current.slice() : []).concat('from-a')),
    B.Store._mutate('activities', (current) => (Array.isArray(current) ? current.slice() : []).concat('from-b')),
  ]);
  await settle();
  const stored = archive(origin, 'activities', false) || [];
  assert.deepEqual(stored.slice().sort(), ['from-a', 'from-b', 'seed'],
    '_mutate 是事务内 RMW：两个窗口的追加都存活（_put 的整值替换做不到，所以契约上区分开）');
});

test('S19d.kv-put-degraded-writes-shadow-and-adopts', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle();
  await W.Store._put('user_memory_profile', { name: '降级画像' });
  await settle();
  assert.deepEqual(JSON.parse(origin.ls.get('xj2_user_memory_profile')), { name: '降级画像' }, '降级 _put 必须落影子档');
  const D = makeWindow(loadSource(), origin, {});
  await D.Store.hydrate();
  await settle();
  assert.deepEqual(archive(origin, 'user_memory_profile', false), { name: '降级画像' },
    'IndexedDB 恢复后，KV 影子档也要被回迁（否则记忆/草稿在降级期写的一律蒸发）');
  assert.equal(origin.ls.has('xj2_user_memory_profile'), false, '回迁后影子档必须清除，避免下次再并一遍');
  void D;
});

// ============ F4-5：migrateOldPorts 单事务 + 纳入队列 ============
const LEGACY_PAYLOAD = {
  clients: [{ id: 'legacy-c1', name: '旧端口来访者', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }],
  supervisions: [{ id: 'legacy-s1', supervisorName: '旧端口督导', content: 'c', conclusion: 'x', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }],
  settings: { theme: 'legacy' },
};

function migrateWindow(src, origin, extraOpts) {
  return makeWindow(src, origin, Object.assign({ tag: 'M', legacyPorts: { '9001': LEGACY_PAYLOAD } }, extraOpts || {}));
}

test('S20.migrate-old-ports-read-modify-write-in-one-transaction', async () => {
  const origin = makeOrigin();
  origin.rows.set('clients', { key: 'clients', value: [{ id: 'cur', name: '当前端口来访者' }] });
  const W = migrateWindow(loadSource(), origin);
  await W.Store.hydrate();
  await settle();
  origin.txLog.length = 0;
  W.counters.open = 0;
  W.counters.maxOpen = 0;
  await W.Store._migrateOldPorts(['9001']);
  await settle();
  const writeTxs = origin.txLog.filter((t) => t.mode === 'readwrite' && t.puts.includes('clients'));
  assert.equal(writeTxs.length, 1, '迁移只允许一个 readwrite 事务：' + JSON.stringify(origin.txLog.map((t) => [t.mode, t.gets, t.puts, t.outcome])));
  assert.equal(writeTxs[0].gets.includes('*'), true, '读当前库必须发生在同一个事务里（read-modify-write 同事务）');
  assert.ok(writeTxs[0].puts.includes('supervisions'), '合并结果由同一事务写回');
  assert.equal(W.counters.maxOpen, 1);
  const clients = idsOf(archive(origin, 'clients', false) || []);
  assert.deepEqual(clients, ['cur', 'legacy-c1'].sort(), '旧端口记录并入、当前端口记录不回退');
});

test('S20b.migrate-concurrent-window-does-not-lose-data', async () => {
  const origin = makeOrigin();
  origin.rows.set('clients', { key: 'clients', value: [{ id: 'cur', name: '当前端口来访者' }] });
  const M = migrateWindow(loadSource(), origin, { tag: 'M' });
  const B = makeWindow(loadSource(), origin, { tag: 'B' });
  await M.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  // 启动期：M 正在「读当前库 → 合并 → 写回」，B 同时在写自己的新记录
  const results = await Promise.allSettled([
    M.Store._migrateOldPorts(['9001']),
    B.Store.createClientDurable({ id: 'b-concurrent', name: '并发窗口新增' }),
    B.Store.createExpenseDurable({ id: 'b-exp', amount: 1, category: 'other', date: '2024-01-01' }),
  ]);
  await settle(20);
  const failure = results.find((r) => r.status === 'rejected');
  assert.equal(failure, undefined, '并发下迁移与写入都必须成功：' + JSON.stringify(results.map((r) => r.status)));
  const clients = idsOf(archive(origin, 'clients', false) || []);
  assert.ok(clients.includes('b-concurrent'), '另一窗口在迁移读/写之间提交的记录不得被整档覆盖抹掉');
  assert.ok(clients.includes('legacy-c1'), '旧端口带来的记录也不许丢');
  assert.ok(clients.includes('cur'), '本端口原有记录不许丢');
  assert.deepEqual(idsOf(archive(origin, 'expenses', false) || []), ['b-exp'], '迁移没碰的集合必须原样保留');
});

test('S20c.migrate-shares-single-writer-queue', async () => {
  const origin = makeOrigin();
  const M = migrateWindow(loadSource(), origin, { tag: 'M' });
  await M.Store.hydrate();
  await settle();
  M.counters.open = 0;
  M.counters.maxOpen = 0;
  await Promise.all([
    M.Store._migrateOldPorts(['9001']),
    M.Store.createClientDurable({ id: 'same-window', name: '同窗口并发写' }),
    M.Store.saveSupervisionDurable({ id: 'sv-m', supervisorName: '归档', content: '', conclusion: '' }),
  ]);
  await settle();
  assert.equal(M.counters.maxOpen, 1, 'migrateOldPorts 必须与同窗口其它 durable 写共用 queueStoreWrite');
  assert.ok(idsOf(archive(origin, 'clients', false) || []).includes('same-window'));
  assert.ok(idsOf(archive(origin, 'supervisions', false) || []).includes('sv-m'));
  assert.ok(idsOf(archive(origin, 'clients', false) || []).includes('legacy-c1'));
});

test('S20d.migrate-failure-rolls-back-and-reports', async () => {
  const origin = makeOrigin();
  origin.rows.set('clients', { key: 'clients', value: [{ id: 'cur', name: '原值' }] });
  const M = migrateWindow(loadSource(), origin, { failPut: (k) => k === 'supervisions' });
  await M.Store.hydrate();
  await settle();
  const before = fullSnapshot(origin, false);
  let rejected = null;
  try { await M.Store._migrateOldPorts(['9001']); } catch (e) { rejected = e; }
  await settle();
  assert.ok(rejected, '迁移写失败必须 reject，不得部分成功');
  assert.equal(fullSnapshot(origin, false), before, '失败必须整体回滚：' + fullSnapshot(origin, false));
  assert.ok(findDiag(diagnosticsOf(M), 'XJ_LEGACY_PORT_MIGRATION_FAILED').length >= 1,
    '并且进诊断台账：' + JSON.stringify(diagCodes(M)));
});

test('S20e.migrate-degraded-window-fails-loudly', async () => {
  const origin = makeOrigin();
  const M = migrateWindow(loadSource(), origin, { unavailable: true });
  await M.Store.hydrate();
  await settle();
  let rejected = null;
  try { await M.Store._migrateOldPorts(['9001']); } catch (e) { rejected = e; }
  assert.ok(rejected, '降级态没有可合并的 durable 库，必须失败而不是静默跳过');
  assert.ok(findDiag(diagnosticsOf(M), 'XJ_LEGACY_PORT_MIGRATION_SKIPPED').length >= 1);
});

// ============ 证据项①：毫秒级并发下的降级态行为 ============
test('E1a.degraded-write-overwritten-after-landing-heals', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  await A.Store.hydrate();
  await settle();
  // 交错方向①：A 写完的那一刻，另一窗口把它那份「不含 from-a」的整档补写落地。
  // 这是 localStorage 下唯一能被**写入方自己**事后发现的交错：回读校验必须看见
  // 「我的记录不见了」，于是重新读-合并-再写，把对方的整档并回来。
  origin.afterSet = (info) => {
    if (info.by !== 'A' || info.key !== 'xj2_supervisorIdentities') return;
    origin.ls.set('xj2_supervisorIdentities', JSON.stringify([
      { id: 'seed', name: '两窗口共有的旧记录', prompt: 'p' },
      { id: 'from-b', name: '迟到的整档写', prompt: 'p' },
    ]));
  };
  A.Store.createSupervisorIdentity({ id: 'from-a', name: 'A 的督导师', prompt: 'p' });
  await settle(20);
  const ids = idsOf(archive(origin, 'supervisorIdentities', true) || []);
  assert.ok(ids.includes('from-a'), 'A 必须通过回读校验 + 重试把自己的记录补回来，实得：' + ids.join(','));
  assert.ok(ids.includes('from-b'), 'A 的重试不得再把 B 刚落的整档抹掉（必须在新值上合并）');
  assert.ok(ids.includes('seed'), '原有记录一条都不许少');
  const reported = diagnosticsOf(A).filter((d) => d.code === 'XJ_DEGRADED_WRITE_SUPERSEDED');
  assert.equal(reported.length, 0, '自愈成功就不该再报丢数据：' + JSON.stringify(diagCodes(A)));
});

test('E1b.degraded-clobber-between-read-and-write-is-reported', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  const B = makeWindow(loadSource(), origin, { unavailable: true, tag: 'B' });
  await A.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  // 交错方向②：B 的整值写落在「A 读完、还没写」之间 → A 是最后写入者，把 B 挤掉，
  // 而 A 自己看不见（盘上就是 A 写的值）。此时必须由**被挤掉的一方** B 报告，不得静默。
  origin.afterGet = (info) => {
    if (info.by !== 'A' || info.key !== 'xj2_supervisorIdentities') return;
    B.Store.createSupervisorIdentity({ id: 'from-b', name: 'B 的督导师', prompt: 'p' });
  };
  A.Store.createSupervisorIdentity({ id: 'from-a', name: 'A 的督导师', prompt: 'p' });
  await settle(24);
  const ids = idsOf(archive(origin, 'supervisorIdentities', true) || []);
  assert.ok(ids.includes('from-a'), 'A 是最后写入者，它的记录在盘上');
  const reported = diagnosticsOf(B).filter((d) => d.code === 'XJ_DEGRADED_WRITE_SUPERSEDED');
  assert.ok(reported.length >= 1,
    'localStorage 没有 CAS，这一方向无法自愈；但「B 的写被覆盖」必须成为可观测事实，实得诊断：'
      + JSON.stringify(diagCodes(B)));
  assert.equal(reported[0].collection, 'supervisorIdentities');
  assert.equal(reported[0].entityId, 'from-b', '台账要点对上具体丢了哪一条');
});

test('E1c.degraded-interleave-never-resurrects-a-delete', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  const B = makeWindow(loadSource(), origin, { unavailable: true, tag: 'B' });
  await A.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  A.Store.createSupervisorIdentity({ id: 'doomed', name: '待删', prompt: 'p' });
  await settle();
  // B 在 A 的删除「读之后、写之前」插进来：A 的删除意图必须仍然成立
  origin.afterGet = (info) => {
    if (info.by !== 'A' || info.key !== 'xj2_supervisorIdentities') return;
    B.Store.createSupervisorIdentity({ id: 'from-b', name: 'B', prompt: 'p' });
  };
  A.Store.deleteSupervisorIdentity('doomed');
  await settle(24);
  const ids = idsOf(archive(origin, 'supervisorIdentities', true) || []);
  assert.ok(!ids.includes('doomed'), '删除不得被任何一方的重试/延迟复核还原成复活，实得：' + ids.join(','));
  const C = makeWindow(loadSource(), origin, { unavailable: true, tag: 'C' });
  await C.Store.hydrate();
  await settle();
  assert.equal(C.Store.getSupervisorIdentities().some((r) => r.id === 'doomed'), false, '重启后也不复活');
});

test('E1d.degraded_repeated_interleave_has_no_silent_loss', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  const B = makeWindow(loadSource(), origin, { unavailable: true, tag: 'B' });
  await A.Store.hydrate();
  await B.Store.hydrate();
  await settle();
  // 连续 4 轮把交错投到 expenses 上：A 每次读完就让 B 的整值写插进来，
  // 于是 A 作为最后写入者会把 B 挤掉。契约要求：**凡是丢的记录，台账必须点名**。
  for (let i = 0; i < 4; i += 1) {
    origin.afterGet = (info) => {
      if (info.by !== 'A' || info.key !== 'xj2_expenses') return;
      B.Store.createExpense({ id: 'b' + i, amount: i, category: 'other', date: '2024-01-01' });
    };
    A.Store.createExpense({ id: 'a' + i, amount: 100 + i, category: 'other', date: '2024-01-01' });
    await settle(8);
  }
  origin.afterGet = null;
  await settle(24);
  const ids = idsOf(archive(origin, 'expenses', true) || []);
  assert.equal(ids.filter((id) => id.charAt(0) === 'a').length, 4, 'A 作为最后写入者，4 条都必须在：' + ids.join(','));
  const missing = ['b0', 'b1', 'b2', 'b3'].filter((id) => ids.indexOf(id) < 0);
  const reported = diagnosticsOf(A).concat(diagnosticsOf(B))
    .filter((d) => d.code === 'XJ_DEGRADED_WRITE_SUPERSEDED' && d.entityId)
    .map((d) => String(d.entityId));
  assert.ok(missing.length > 0, 'premise: 这个交错方向确实会丢（localStorage 没有 CAS）');
  assert.ok(missing.every((id) => reported.indexOf(id) >= 0),
    '每一条被挤掉的记录都必须进诊断台账（丢了却没人说 = 谎报成功）：missing='
      + missing.join(',') + ' reported=' + reported.join(','));
});

/* E1e —— 第 4 轮复审 P3（变异 m13 的补杀日程）：外部窗口把「已删记录」整值写回来。
   persistRemoveIntent 交给 commitDegradedArchive 的 holds 谓词含义是「我删掉的那些 id
   仍然不在共享档案里」。之前所有用例排的日程里，回读时刻 holds 从不在「档案里仍有该 id」
   时被调用（E1c 走 afterGet：交错发生在读之前，A 仍是最后写入者），于是把 holds 改成恒真
   （m13）在本套件里没有任何可观察差别 —— 复审者判定为「条件等价」。这条用例专门制造那个
   差别：把对方窗口的陈旧整值写投在 **A 写完与 A 回读之间**。
     · 基线：回读 != 刚写的整值 且 holds(verified) 为假 → 重试 → 删除重新落盘，
             对方的新记录（from-foreign）同时保住；
     · m13：holds 恒真 → 接受被复活的档案、当场认定删除成功、不再重试 → 'gone' 留在盘上。
   注入必须自证发生（injected === 1）：没发生就判红，绝不判绿。
   E1f 是控制腿：同样的删除、不注入，必须干净落盘 —— 证明 E1e 的红不是夹具坏了。 */
test('E1e.degraded-delete-survives-foreign-resurrection-write', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  await A.Store.hydrate();
  await settle();
  A.Store.createExpense({ id: 'gone', amount: 1, category: 'other', date: '2024-01-01' });
  A.Store.createExpense({ id: 'keep', amount: 2, category: 'other', date: '2024-01-01' });
  await settle();
  const before = idsOf(archive(origin, 'expenses', true) || []);
  assert.deepEqual(before, ['gone', 'keep'], 'premise: 删除前两条都在共享档案里');
  const FOREIGN = [{ id: 'gone', amount: 1, category: 'other', date: '2024-01-01' },
    { id: 'keep', amount: 2, category: 'other', date: '2024-01-01' },
    { id: 'from-foreign', amount: 3, category: 'other', date: '2024-01-01' }];
  let injected = 0;
  const inject = (info) => {
    if (info.key !== 'xj2_expenses') { origin.afterSet = inject; return; }   // 不许被无关写吞掉
    if (info.by !== 'A') return;                                             // 别人的写不重启
    injected += 1;
    origin.afterSet = null;                                                  // 只干扰一次
    origin.ls.set('xj2_expenses', JSON.stringify(FOREIGN));                  // 陈旧整值写：把 gone 带回来
  };
  origin.afterSet = inject;
  A.Store.deleteExpense('gone');
  await settle(30);
  origin.afterSet = null;
  assert.equal(injected, 1, '注入自证：外部整值写必须真的落在 A 的「写完」与「回读」之间，否则本条不算测到（injected=' + injected + '）');
  const ids = idsOf(archive(origin, 'expenses', true) || []);
  assert.ok(ids.indexOf('gone') < 0, '删除意图不得被外部陈旧整值写悄悄抹掉（m13 的 holds 恒真正是在这里失守），实得：' + ids.join(','));
  assert.ok(ids.indexOf('from-foreign') >= 0, '重新主张删除时也不许把对方新增的那条挤掉，实得：' + ids.join(','));
  assert.ok(ids.indexOf('keep') >= 0, '无关记录保持在场');
});

test('E1f.control-delete-lands-without-foreign-write', async () => {
  const origin = makeOrigin();
  const A = makeWindow(loadSource(), origin, { unavailable: true, tag: 'A' });
  await A.Store.hydrate();
  await settle();
  A.Store.createExpense({ id: 'gone', amount: 1, category: 'other', date: '2024-01-01' });
  A.Store.createExpense({ id: 'keep', amount: 2, category: 'other', date: '2024-01-01' });
  await settle();
  A.Store.deleteExpense('gone');
  await settle(30);
  const ids = idsOf(archive(origin, 'expenses', true) || []);
  assert.deepEqual(ids, ['keep'], '控制腿：没有外部整值写时同一删除必须干净落盘（否则 E1e 的红是夹具坏了，不是产品问题）');
  assert.equal(findDiag(diagnosticsOf(A), 'XJ_DEGRADED_WRITE_SUPERSEDED').length, 0, '控制腿不该留下「被覆盖」诊断');
});

// ============ 证据项②：xj2_* → IndexedDB 的回迁 ============
test('E2.degraded-archives-adopt-into-indexeddb', async () => {
  const origin = makeOrigin();
  const D = makeWindow(loadSource(), origin, { unavailable: true });
  await D.Store.hydrate();
  await settle();
  D.Store.createClient({ id: 'dc1', name: '降级期来访者' });
  D.Store.createSupervision({ id: 'dsv1', supervisorName: '降级期督导', content: '正文', conclusion: '结论' });
  D.Store.saveSettings({ apiConfig: { tier: 'byok' } });
  await settle(16);
  assert.ok(origin.ls.size > 0, 'premise: 降级期只写了影子档');

  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle(16);
  assert.ok(idsOf(archive(origin, 'clients', false) || []).includes('dc1'), '降级期写的 clients 必须回迁进 IndexedDB');
  assert.ok(idsOf(archive(origin, 'supervisions', false) || []).includes('dsv1'), '督导集合同样要回迁（F4-1 的闭环）');
  assert.deepEqual((archive(origin, 'settings', false) || {}).apiConfig, { tier: 'byok' }, '设置也要回迁');
  assert.equal(origin.ls.has('xj2_clients'), false, '回迁成功后影子档必须清掉，避免下次再并一遍');
  assert.equal(W.Store.getClient('dc1').name, '降级期来访者', '新窗口读到的就是回迁后的数据');
});

test('E2b.adoption-merges-without-overwriting-db-values', async () => {
  const origin = makeOrigin();
  origin.rows.set('clients', { key: 'clients', value: [
    { id: 'both', name: '库里的新版本', phone: 'db-only-field', updatedAt: '2026-02-02T00:00:00.000Z' },
    { id: 'db-only', name: '只有库里有', updatedAt: '2026-01-01T00:00:00.000Z' },
  ] });
  origin.rows.set('settings', { key: 'settings', value: { apiConfig: { tier: 'db-new' }, theme: 'db-theme' } });
  origin.ls.set('xj2_clients', JSON.stringify([
    { id: 'both', name: '影子档的旧版本', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'shadow-only', name: '只有影子档里有', updatedAt: '2026-01-01T00:00:00.000Z' },
  ]));
  origin.ls.set('xj2_settings', JSON.stringify({ apiConfig: { tier: 'shadow-old' }, locale: 'zh-CN' }));
  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle(16);
  const clients = archive(origin, 'clients', false) || [];
  assert.deepEqual(idsOf(clients).sort(), ['both', 'db-only', 'shadow-only'].sort(),
    '回迁是并集：库里独有的和影子档独有的都要在');
  assert.equal(clients.find((c) => c.id === 'both').name, '库里的新版本', '同 id 冲突时以库为准（回迁绝不覆盖）');
  assert.equal(clients.find((c) => c.id === 'both').phone, 'db-only-field', '库里那条的其它字段一个字都不许动');
  const settings = archive(origin, 'settings', false) || {};
  assert.equal(settings.apiConfig.tier, 'db-new', '同名设置键以库为准');
  assert.equal(settings.locale, 'zh-CN', '库里没有的键才从影子档补进来');
  assert.equal(settings.theme, 'db-theme');
});

test('E2c.adoption-is-one-shot-and-idempotent', async () => {
  const origin = makeOrigin();
  const D = makeWindow(loadSource(), origin, { unavailable: true });
  await D.Store.hydrate();
  await settle();
  D.Store.createClient({ id: 'one-shot', name: '只并一次' });
  await settle();
  const first = makeWindow(loadSource(), origin, {});
  await first.Store.hydrate();
  await settle(16);
  const hashAfterFirst = canonArchive(origin, 'clients', false);
  const second = makeWindow(loadSource(), origin, {});
  await second.Store.hydrate();
  await settle(16);
  const hashAfterSecond = canonArchive(origin, 'clients', false);
  assert.equal(hashAfterSecond, hashAfterFirst, '连续两次 durable 启动不得把同一条记录并两遍');
  assert.equal(idsOf(archive(origin, 'clients', false) || []).filter((id) => id === 'one-shot').length, 1);
});

test('E2d.adoption-failure-keeps-shadow-for-retry', async () => {
  const origin = makeOrigin();
  origin.ls.set('xj2_clients', JSON.stringify([{ id: 'retry-me', name: '回迁失败要留着' }]));
  const failing = makeWindow(loadSource(), origin, { failPut: (k) => k === 'clients' });
  await failing.Store.hydrate();
  await settle(16);
  assert.equal(origin.ls.get('xj2_clients') != null, true, '回迁事务失败时影子档必须原样保留，下次启动还能重试');
  const ok = makeWindow(loadSource(), origin, {});
  await ok.Store.hydrate();
  await settle(16);
  assert.ok(idsOf(archive(origin, 'clients', false) || []).includes('retry-me'), '下一次启动回迁成功');
});

test('E2e.durably-deleted-record-does-not-come-back-via-shadow', async () => {
  const origin = makeOrigin();
  const D = makeWindow(loadSource(), origin, { unavailable: true });
  await D.Store.hydrate();
  await settle();
  D.Store.createClient({ id: 'gone-for-good', name: '已删' });
  D.Store.createClient({ id: 'stay', name: '保留' });
  await settle();
  const adopter = makeWindow(loadSource(), origin, {});
  await adopter.Store.hydrate();
  await settle(16);
  adopter.Store.deleteClient('gone-for-good');
  await settle(16);
  const next = makeWindow(loadSource(), origin, {});
  await next.Store.hydrate();
  await settle(16);
  assert.deepEqual(idsOf(archive(origin, 'clients', false) || []), ['stay'],
    '回迁是一次性的：durable 侧删掉的记录不得被历史影子档复活');
  assert.ok(!next.Store.getClient('gone-for-good'), '重启后也不复活');
});

// ============ 证据项③：reload 风暴后集合 hash 稳定 ============
test('E3.durable-reload-storm-hash-stable', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, {});
  await W.Store.hydrate();
  await settle(16);
  W.Store.createClient({ id: 'st1', name: '重启风暴' });
  await W.Store.createSupervisionDurable({ id: 'stsv', supervisorName: '督导', content: 'c', conclusion: 'x' });
  await settle(16);
  const baseline = fullSnapshot(origin, false);
  for (let round = 1; round <= 6; round += 1) {
    const R = makeWindow(loadSource(), origin, {});
    await R.Store.hydrate();
    await settle(16);
    assert.equal(fullSnapshot(origin, false), baseline, '第 ' + round + ' 次重启后归档 hash 必须逐字节不变');
    assert.equal(R.counters.reloads, 0, '稳定态不得再触发去重刷新');
  }
});

test('E3b.degraded-reload-storm-hash-stable', async () => {
  const origin = makeOrigin();
  const W = makeWindow(loadSource(), origin, { unavailable: true });
  await W.Store.hydrate();
  await settle(16);
  W.Store.createClient({ id: 'dg1', name: '降级重启风暴' });
  W.Store.createSupervision({ id: 'dgsv', supervisorName: '督导', content: 'c', conclusion: 'x' });
  await settle(16);
  const baseline = fullSnapshot(origin, true);
  for (let round = 1; round <= 5; round += 1) {
    const R = makeWindow(loadSource(), origin, { unavailable: true });
    await R.Store.hydrate();
    await settle(16);
    assert.equal(fullSnapshot(origin, true), baseline, '降级态连续重启第 ' + round + ' 轮影子档 hash 必须不变');
    assert.ok(idsOf(R.Store.getClients()).includes('dg1'), '每条记录都还在');
  }
});

test('E3c.degraded-durable-cycles-converge', async () => {
  const origin = makeOrigin();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const D = makeWindow(loadSource(), origin, { unavailable: true, tag: 'D' + cycle });
    await D.Store.hydrate();
    await settle(16);
    D.Store.createClient({ id: 'cy' + cycle, name: '第 ' + cycle + ' 轮降级新增' });
    await settle(16);
    const W = makeWindow(loadSource(), origin, { tag: 'W' + cycle });
    await W.Store.hydrate();
    await settle(16);
  }
  const ids = idsOf(archive(origin, 'clients', false) || []);
  assert.deepEqual(['cy0', 'cy1', 'cy2'].filter((id) => ids.includes(id)).length, 3, '每轮降级新增都并进库且不掉');
  const settled = fullSnapshot(origin, false);
  const tail = makeWindow(loadSource(), origin, {});
  await tail.Store.hydrate();
  await settle(20);
  assert.equal(fullSnapshot(origin, false), settled, '混合循环收敛后 hash 稳定');
});

// ------------------------------------------------------------
// 反向变异：把每条修复旁路回去，对应用例必须转红
// ------------------------------------------------------------
const MUTATIONS = [
  {
    id: 'F4-1-degraded-supervision-throws',
    fixes: 'F4-1',
    description: '降级态督导写回「直接 throw」—— 即上一版缺陷原形',
    needle: '        return persistSupervisionsDegraded((rows) => applySupervisionSnapshot(rows, sv, archiveKey));',
    replacement: "        throw new Error('IndexedDB unavailable for durable persistence');",
  },
  {
    id: 'F4-1b-degraded-supervision-delete-throws',
    fixes: 'F4-1',
    description: '降级态督导删除仍 throw（删除不落盘 → 重启复活）',
    needle: '        return persistSupervisionsDegraded((rows) => supervisionRemovalStep(rows, id));',
    replacement: "        throw new Error('IndexedDB unavailable for durable persistence');",
  },
  {
    id: 'F4-2-settings-degraded-whole-cache',
    fixes: 'F4-2',
    description: '降级 settings 回到「把本窗口整份陈旧 cache 灌回共享档案」',
    needle: '        value: Object.assign({}, current, picked),',
    replacement: '        value: cloneRecord(cache.settings),',
  },
  {
    id: 'F4-2-settings-degraded-empty-patch-writes',
    fixes: 'F4-2',
    description: '降级 settings 空 patch 也写盘（与 durable 不同规格）',
    needle: '    if (!keys.length) return;\n    const committed = commitDegradedArchive(\'settings\'',
    replacement: '    const committed = commitDegradedArchive(\'settings\'',
  },
  {
    id: 'F4-3-degraded-write-failure-silent',
    fixes: 'F4-3',
    description: '降级写失败只 break，不进诊断台账（静默丢数据）',
    needle: "        recordStorageDiagnostic('XJ_DEGRADED_WRITE_FAILED', {\n          collection: key, entityId: entity ? entity.id : '', name: failureName(e), message: failureText(e),\n        });\n        failure = e;",
    replacement: '        failure = e;',
  },
  {
    id: 'F4-3-intent-failure-no-diagnostic',
    fixes: 'F4-3',
    description: 'durable intent 写失败不留诊断（同步 API 无从分辨）',
    needle: "      recordStorageDiagnostic('XJ_DURABLE_INTENT_WRITE_FAILED', {\n        collection: key, name: failureName(e), message: failureText(e),\n      });",
    replacement: '      void e;',
  },
  {
    id: 'F4-3-kv-put-no-diagnostic',
    fixes: 'F4-3 / F4-4',
    description: '_put 事务失败不留诊断台账（只剩调用方自己吞掉的 catch）',
    needle: "          recordStorageDiagnostic('XJ_KV_WRITE_FAILED', { collection: key, name: failureName(e), message: failureText(e) });",
    replacement: '          void e;',
  },
  /* ---- 以下两条来自第 4 轮复审点名（reviews-r1e/f4-f5-round4.md P3-4 / P3）----
     复审者自己的 r4 夹具跑这两条时是 SURVIVOR，原因是**他那套夹具里没有对应判据**：
       · m3 打的是通用降级写原语 writeKvDegraded（store.js:257-266，_put/_del/_mutate 的共用出口），
         他的 T3* 全系走的是督导归档（store.js:311-320）；
       · m13 打的是删除意图的 holds 谓词，他的 strict 夹具从未排出「外部窗口复活已删记录」的日程。
     本套件把这两档判据补齐（S16g 与 E1c 系列），所以这两条变异在这里必须是 KILLED；
     锚点与替换文本逐字沿用复审者的定义（needle 唯一性由文件末尾的 count!==1 硬门把守）。 */
  {
    id: 'R4-m3-generic-degraded-write-swallowed',
    fixes: 'F4-3（通用降级写原语）',
    description: 'writeKvDegraded 的失败既不上抛也不留痕（= 复审 m3：通用降级写被静默吞掉）',
    needle: "      recordStorageDiagnostic('XJ_DEGRADED_WRITE_FAILED', {\n        collection: key, name: failureName(e), message: failureText(e),\n      });\n      throw e;",
    replacement: '      void key; void e;',
  },
  {
    id: 'R4-m13-remove-holds-always-true',
    fixes: '证据项①（删除意图的 holds 谓词）',
    description: '删除意图的 holds 恒真（= 复审 m13：外部窗口把已删记录整值写回来时不再重试/不再报失败）',
    needle: '      { holds: (actual) => Array.from(targets).every((id) => archiveLacksRecordId(actual, id)) });',
    replacement: '      { holds: () => true });',
  },
  {
    id: 'E1-verify-removed',
    fixes: 'F4-3 / 证据项①',
    description: '去掉降级写的「写后回读校验」：写完就直接认定成功',
    needle: '      if (valuesEqual(verified, next)) {\n        scheduleDegradedAudit(key, holds, entity);\n        return { ok: true, value: next, attempts: attempt };\n      }',
    replacement: '      void verified;\n      if (true) {\n        scheduleDegradedAudit(key, holds, entity);\n        return { ok: true, value: next, attempts: attempt };\n      }',
  },
  {
    id: 'E1-retry-disabled',
    fixes: '证据项①',
    description: '回读发现意图被挤掉后不再重试（放弃自愈），只留下失败结论',
    needle: "      if (!holds(verified)) {\n        failure = new Error('Degraded write for ' + key + ' was overwritten by another window');\n        continue;\n      }",
    replacement: "      if (!holds(verified)) {\n        failure = new Error('Degraded write for ' + key + ' was overwritten by another window');\n        break;\n      }",
  },
  {
    id: 'E1-deferred-audit-removed',
    fixes: '证据项①',
    description: '去掉延迟复核：被另一窗口整值写覆盖时不再有任何留痕',
    needle: "      if (holds(actual)) return;\n      recordStorageDiagnostic('XJ_DEGRADED_WRITE_SUPERSEDED', {\n        collection: key,\n        entityId: entity ? String(entity.id) : '',",
    replacement: '      void holds;\n      if (true) return;\n      recordStorageDiagnostic(\'XJ_DEGRADED_WRITE_SUPERSEDED\', {\n        collection: key,\n        entityId: entity ? String(entity.id) : \'\',',
  },
  {
    id: 'F4-4-put-bypasses-queue',
    fixes: 'F4-4',
    description: '_put/_del 回到直通 idbPut（不进 queueStoreWrite，可与其它 durable 写交错）',
    needle: '  function commitKvWrite(key, value) {\n    return queueStoreWrite(async () => {',
    replacement: '  function commitKvWrite(key, value) {\n    return (async () => {',
  },
  {
    id: 'F4-4-put-degraded-swallowed',
    fixes: 'F4-4',
    description: '_put 降级分支失败被吞（配额耗尽 = 静默丢数据）',
    needle: "        if (value === undefined) removeKvDegraded(key);\n        else writeKvDegraded(key, value);\n        return;",
    replacement: '        try {\n          if (value === undefined) localStorage.removeItem(\'xj2_\' + key);\n          else localStorage.setItem(\'xj2_\' + key, JSON.stringify(value));\n        } catch (ignored) {}\n        return;',
  },
  {
    id: 'F4-5-migrate-two-transactions',
    fixes: 'F4-5',
    description: '迁移写回拆到「另一个」 readwrite 事务（RMW 不再同事务）',
    needle: '            all.forEach((k) => objectStore.put({ key: k, value: merged[k] }));',
    replacement: "            all.forEach((k) => { tx.abort(); db.transaction(STORE, 'readwrite').objectStore(STORE).put({ key: k, value: merged[k] }); });",
  },
  {
    id: 'F4-5-migrate-not-in-queue',
    fixes: 'F4-5',
    description: '迁移不纳入 queueStoreWrite（启动期与并发写不共享互斥）',
    needle: '    const written = await queueStoreWrite(async () => {',
    replacement: '    const written = await (async () => {',
  },
  {
    id: 'E2-adoption-disabled',
    fixes: '证据项②',
    description: '关掉 xj2_* → IndexedDB 的回迁（降级期数据永远留在影子档）',
    needle: '      await adoptDegradedArchives();',
    replacement: '      void adoptDegradedArchives;',
  },
  {
    id: 'E2b-adoption-overwrites-db',
    fixes: '证据项②',
    description: '回迁改成整档覆盖（另一窗口的库里现值被影子档回滚）',
    needle: '      return { value: out, added: out.length - base.length };',
    replacement: '      return { value: incoming.slice(), added: incoming.length };',
  },
  {
    id: 'E2c-shadow-not-cleared',
    fixes: '证据项②',
    description: '回迁后不清影子档（下一次启动可把 durable 侧已删记录重新并回来）',
    needle: "      pending.forEach((key) => {\n        try { localStorage.removeItem('xj2_' + key); }",
    replacement: '      pending.forEach((key) => {\n        try { void 0; }',
  },
];

MUTATIONS.forEach((mutation) => {
  const count = SOURCE.split(mutation.needle).length - 1;
  if (count !== 1) {
    throw new Error('变异锚点不唯一（count=' + count + '）:: ' + mutation.id + ' :: ' + mutation.needle.slice(0, 60));
  }
});

// ------------------------------------------------------------
// 跑全量 + 变异裁决
// ------------------------------------------------------------
async function runAll(onlyFilter) {
  const out = [];
  assertionCount = 0;
  for (const testCase of CASES) {
    if (onlyFilter && testCase.name.indexOf(onlyFilter) < 0) { out.push({ name: testCase.name, skipped: true }); continue; }
    const before = assertionCount;
    let entry = { name: testCase.name, ok: true };
    try {
      await testCase.fn();
    } catch (error) {
      const detail = [String((error && error.message) || error).split('\n')[0].slice(0, 300)];
      if (error && (error.actual !== undefined || error.expected !== undefined)) {
        detail.push('actual=' + JSON.stringify(error.actual) + ' expected=' + JSON.stringify(error.expected));
      }
      entry = { name: testCase.name, ok: false, error: detail.join(' | ').slice(0, 500) };
    }
    entry.assertions = assertionCount - before;
    if (!entry.ok && entry.assertions === 0) entry.error = 'ZERO-ASSERTION: ' + entry.error;
    out.push(entry);
    const line = (entry.ok ? 'ok   - ' : 'FAIL - ') + entry.name + ' (' + entry.assertions + ' 断言)';
    console.log(line);
    if (!entry.ok) console.log('           红在：' + entry.error);
  }
  return out;
}

async function runMutations() {
  const baseline = await runAll('');
  const green = new Set(baseline.filter((r) => r.ok).map((r) => r.name));
  console.log('\n==== 反向变异（把修复旁路回去，对应用例必须转红）====\n');
  let survivors = 0;
  for (const mutation of MUTATIONS) {
    CURRENT_TRANSFORM = (source) => {
      const count = source.split(mutation.needle).length - 1;
      if (count !== 1) throw new Error('锚点在运行时不唯一 count=' + count);
      return source.split(mutation.needle).join(mutation.replacement);
    };
    let results = [];
    try {
      results = await runAllSilently();
    } catch (error) {
      CURRENT_TRANSFORM = null;
      console.log('ERROR    - ' + mutation.id + ' :: 源码改写后无法执行：' + (error && error.message));
      survivors += 1;
      continue;
    }
    CURRENT_TRANSFORM = null;
    const killed = results.filter((r) => green.has(r.name) && !r.ok);
    if (killed.length) {
      console.log('KILLED   - ' + mutation.id + ' [' + mutation.fixes + '] → ' + killed.length + ' 条转红');
      killed.slice(0, 4).forEach((r) => console.log('           红在：' + r.name + ' :: ' + r.error));
    } else {
      survivors += 1;
      console.log('SURVIVED - ' + mutation.id + ' [' + mutation.fixes + '] 没有任何用例转红 ⇒ 该修复没被断言看住');
    }
    mutation.killedBy = killed.map((r) => r.name);
    mutation.survivor = killed.length === 0;
  }
  console.log('MUTATIONS: total=' + MUTATIONS.length + ' survivors=' + survivors);
  return { mutations: MUTATIONS.map(({ id, fixes, description, killedBy, survivor }) => ({ id, fixes, description, killedBy, survivor })), survivors };
}

async function runAllSilently() {
  const out = [];
  for (const testCase of CASES) {
    try {
      await testCase.fn();
      out.push({ name: testCase.name, ok: true });
    } catch (error) {
      out.push({ name: testCase.name, ok: false, error: String((error && error.message) || error).split('\n')[0].slice(0, 240) });
    }
  }
  return out;
}

(async () => {
  const argList = process.argv.slice(2);
  const only = (argList.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');
  const md5 = crypto.createHash('md5').update(fs.readFileSync(STORE_PATH)).digest('hex');
  if (argList.includes('--mutations')) {
    const summary = await runMutations();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'f4-degraded-mutation-summary.json'), JSON.stringify({ md5ofStore: md5, ...summary }, null, 2));
    process.exitCode = summary.survivors === 0 ? 0 : 1;
    return;
  }
  const results = await runAll(only);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  console.log('CASES: total=' + results.filter((r) => !r.skipped).length
    + ' passed=' + (results.filter((r) => !r.skipped).length - failed.length)
    + ' failed=' + failed.length + ' assertions=' + assertionCount);
  console.log('md5 app/js/store.js = ' + md5);
  if (argList.includes('--json')) {
    const out = (argList.find((a) => a.startsWith('--out=')) || '').replace('--out=', '');
    const payload = JSON.stringify({ md5ofStore: md5, results }, null, 2);
    if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, payload); }
    else console.log(payload);
  }
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('HARNESS ERROR ' + ((error && error.stack) || error));
  process.exitCode = 2;
});
