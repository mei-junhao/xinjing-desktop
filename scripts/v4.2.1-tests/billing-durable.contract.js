#!/usr/bin/env node
/* ============================================================
   XJ-4.2.1-codebuddy-billing-durable-contract — 计费 durable 契约测试
   通过 Node vm 执行真实 app/js/store.js，动态故障注入。
   所有用例均执行真实 Store 函数，不定义替代实现。

   覆盖要求（任务卡 XJ-4.2.1-codebuddy-billing-durable-postfix-contract.json）：
     1. 批量手工收入 IDB 失败时必须 ok:false 且 sessions 权威缓存完全不变（all-or-nothing）；
     2. 批量手工收入成功后才更新权威 sessions 缓存；
     3. 手工支出 create/update/delete 在 IDB 失败且 localStorage 可用时，都必须 ok:false 且 expenses 缓存不变；
     4. 手工支出成功后才更新权威 expenses 缓存（延迟事务完成前不得暴露成功）；
     5. 禁止把 localStorage fallback 当成 strict durable success；
     6. 必须执行真实 app/js/store.js（不得以静态存在检查替代行为验证）；
     7. 变异敏感：移除 await、提前更新缓存、allowFallback:true 均应转红（收入/支出/批量三套）。

   生产已新增（本题目标 API）：
     - Store.saveSessionsDurable(entries)              批量收入原子写入
     - Store.createExpenseDurable(data)
     - Store.updateExpenseDurable(id, patch)
     - Store.deleteExpenseDurable(id)

   退出码三态语义：
     exit 0  ALL-GREEN       —— 全部 durable 不变量满足（生产已满足全部 durable 要求）。
     exit 1  EXPECTED-RED    —— 仅存在“预期红项”（当前生产仍有已知缺口，契约据以驱动 Codex 实现）。
     exit 2  CONTRACT-BROKEN —— 存在“非预期失败”（本应绿的契约不变量被破坏，契约损坏）。
   ============================================================ */
'use strict';

// 吸收变异测试中“移除 await”变体产生的未处理拒绝（仅该回归变体会触发；
// 真实 store 的 durable 写入始终 await idbPut/idbPutMany，不会产生未处理拒绝）。
process.on('unhandledRejection', () => {});

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const STORE_PATH = process.env.XJ_BDC_STORE_PATH ? path.resolve(process.env.XJ_BDC_STORE_PATH) : path.join(ROOT, 'app', 'js', 'store.js');
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');
const STORE_SHA = crypto.createHash('sha256').update(STORE_SRC).digest('hex');

const results = [];
let passed = 0, failed = 0;
const expectedRed = [];
let degradedCount = 0;

function test(name, fn, opts) {
  opts = opts || {};
  const expectRed = !!opts.expectRed;
  return Promise.resolve().then(() => fn()).then(() => {
    results.push({ name, status: 'PASS', expectRed });
    passed++;
  }).catch((e) => {
    const errMsg = e && e.message ? e.message : String(e).slice(0, 300);
    results.push({ name, status: 'FAIL', error: errMsg, expectRed, redReason: opts.redReason, codexTask: opts.codexTask });
    failed++;
    if (expectRed) expectedRed.push({ name, redReason: opts.redReason, codexTask: opts.codexTask });
  });
}
function degraded(name, detail) {
  degradedCount++;
  results.push({ name, status: 'DEGRADED', detail: detail || null, note: '降级风险：非 durable 路径的 legacy 行为，不计入 durable 通过' });
}

// ===== 合成 fixture（synthetic=true，无真实临床/支付数据） =====
const CLIENT = { id: 'bd-c-001', name: 'BillingSynth', status: 'active', billing: { monthlyPayments: [] }, firstVisitDate: '2026-07-01', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' };
const SESSION_DATES = ['2026-07-10', '2026-07-12', '2026-07-15'];

// ===== Sandbox（复用 durable-save.contract 的已验证故障注入机制） =====
function buildSandbox(opts) {
  opts = opts || {};
  const ls = new Map();
  const dbData = new Map();
  const state = { failMode: opts.failMode || 'none', txGate: opts.txGate || null };
  if (typeof opts.txDelay === 'number') {
    state.txGate = new Promise((resolve) => setTimeout(resolve, opts.txDelay));
  }
  const localStorage = {
    getItem: (k) => ls.get(k) || null,
    setItem: (k, v) => { if (state.failMode === 'both') throw new Error('LS write fault injected'); ls.set(k, v); },
    removeItem: (k) => { ls.delete(k); },
    clear: () => { ls.clear(); },
    get length() { return ls.size; },
    key: (i) => [...ls.keys()][i] || null,
  };
  const indexedDB = {
    open: (name, version) => {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      const objStores = new Map();
      const db = {
        objectStoreNames: { contains: (n) => objStores.has(n) },
        createObjectStore: (n, o) => { objStores.set(n, o); return { createIndex: () => {} }; },
        transaction: (sn, mode) => {
          const tx = { error: null, oncomplete: null, onabort: null, onerror: null,
            objectStore: (name) => ({
              put: (entry) => {
                if (state.failMode === 'idbPut' || state.failMode === 'both') {
                  tx.error = new Error('IDB write fault injected');
                  return { onsuccess: null, onerror: null };
                }
                dbData.set(entry.key, entry.value);
                return { onsuccess: null, onerror: null };
              },
              get: (key) => { const v = dbData.has(key) ? { key, value: dbData.get(key) } : undefined; return { result: v, onsuccess: null, onerror: null }; },
              getAll: () => { const all = [...dbData.entries()].map(([k, v]) => ({ key: k, value: v })); return { result: all, onsuccess: null, onerror: null }; },
              delete: (key) => { dbData.delete(key); return { onsuccess: null, onerror: null }; },
            }),
          };
          if (state.failMode === 'idbPut' || state.failMode === 'both') {
            setImmediate(() => { if (tx.onerror) tx.onerror(tx.error); });
          } else if (state.txGate) {
            state.txGate.then(() => { if (tx.oncomplete) tx.oncomplete(); });
          } else {
            setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
          }
          return tx;
        },
      };
      setImmediate(() => { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded({ target: req }); if (req.onsuccess) req.onsuccess({ target: req }); });
      return req;
    },
    deleteDatabase: () => ({ onsuccess: null, onerror: null }),
  };
  const __XJ__ = { verified: true, activated: true, tier: 'full' };
  const __XJ_API__ = { getState: () => Promise.resolve(__XJ__), getMachineCode: () => Promise.resolve('test-mc'), appProxyKey: () => 'test-proxy', openActivation: () => {}, onLicenseState: () => {}, checkForUpdates: () => {}, getVersion: () => '4.2.1' };
  return { localStorage, indexedDB, __XJ__, __XJ_API__, dbData, ls, state };
}
function contextFor(sb) {
  return vm.createContext(Object.assign(Object.create(null), {
    localStorage: sb.localStorage, indexedDB: sb.indexedDB,
    window: { __XJ__: sb.__XJ__, __XJ_API__: sb.__XJ_API__, indexedDB: sb.indexedDB, location: { pathname: '/index.html' }, addEventListener: () => {}, requestAnimationFrame: () => {}, matchMedia: () => ({ matches: false }) },
    document: { querySelector: () => null, addEventListener: () => {}, createElement: () => ({ style: {} }) },
    navigator: { userAgent: 'test' },
    console, setTimeout, setImmediate, Promise,
    URL, URLSearchParams, TextDecoder,
    location: { pathname: '/index.html', origin: 'http://localhost', href: 'http://localhost/index.html' },
  }));
}
function loadStore(sb) {
  const ctx = contextFor(sb);
  new vm.Script(STORE_SRC + '\n; globalThis.__StoreUnderTest = Store;').runInNewContext(ctx);
  return ctx.__StoreUnderTest;
}
function loadMutant(sb, src) {
  const ctx = contextFor(sb);
  new vm.Script(src + '\n; globalThis.__StoreUnderTest = Store;').runInNewContext(ctx);
  return ctx.__StoreUnderTest;
}
function seedClientSession(Store, sid, date, billing) {
  Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
  Store.createSession({ id: sid, clientId: 'bd-c-001', sessionNumber: 1, date: date, billing: billing || { fee: 0, paid: false } });
}
function seedClientExpenses(Store, n) {
  Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const e = Store.createExpense({ category: 'course', date: '2026-07-1' + i, amount: 100 + i, description: 'seed-' + i, clientId: 'bd-c-001' });
    ids.push(e.id);
  }
  return ids;
}

// ===== S1-S5: 正向结构检查（均为当前生产事实，预期绿；与真实函数行为一致） =====
function assertDurablePattern(fnMarker, storeName, varName, window) {
  if (!new RegExp('async function ' + fnMarker).test(STORE_SRC)) throw new Error(fnMarker + ' 缺失');
  const start = STORE_SRC.indexOf('async function ' + fnMarker);
  const slice = STORE_SRC.slice(start, start + (window || 400));
  const awaitIdx = slice.indexOf("await idbPut('" + storeName + "', " + varName + ", { allowFallback: false })");
  const cacheIdx = slice.indexOf('cache.' + storeName + ' = ' + varName + ';');
  if (awaitIdx < 0) throw new Error(fnMarker + ' 未使用严格 allowFallback:false 的 idbPut（非 durable）');
  if (cacheIdx < 0) throw new Error(fnMarker + ' 未找到缓存更新锚点');
  if (cacheIdx < awaitIdx) throw new Error(fnMarker + ' 缓存更新被提前到 await 之前（非 durable）');
}
function staticTests() {
  test('S1: saveSessionDurable(单笔) 使用严格 allowFallback:false（手工收入 durable）', () => {
    assertDurablePattern('saveSessionDurable', 'sessions', 'nextSessions', 2000);
  });
  test('S2: saveSessionDurable(单笔) 仅在 await idbPut 之后更新权威缓存', () => {
    const start = STORE_SRC.indexOf('async function saveSessionDurable');
    const slice = STORE_SRC.slice(start, start + 2000);
    const awaitIdx = slice.indexOf("await idbPut('sessions', nextSessions");
    const cacheIdx = slice.indexOf('cache.sessions = nextSessions;');
    if (awaitIdx < 0 || cacheIdx < 0) throw new Error('未找到 await 写入或缓存更新锚点');
    if (cacheIdx < awaitIdx) throw new Error('缓存更新被提前到 await 之前（非 durable）');
  });
  test('S3: createExpenseDurable/updateExpenseDurable/deleteExpenseDurable 均使用严格 allowFallback:false 且仅在写入后更新权威缓存', () => {
    assertDurablePattern('createExpenseDurable', 'expenses', 'nextExpenses', 2000);
    assertDurablePattern('updateExpenseDurable', 'expenses', 'nextExpenses', 2000);
    assertDurablePattern('deleteExpenseDurable', 'expenses', 'nextExpenses', 2000);
  });
  test('S4: saveSessionsDurable 批量写入使用严格 idbPutMany allowFallback:false 且仅在提交后更新缓存', () => {
    if (!/async function saveSessionsDurable/.test(STORE_SRC)) throw new Error('saveSessionsDurable 缺失');
    const start = STORE_SRC.indexOf('async function saveSessionsDurable');
    const slice = STORE_SRC.slice(start, start + 2000);
    const awaitIdx = slice.indexOf("await idbPutMany([['sessions', nextSessions]], { allowFallback: false })");
    const cacheIdx = slice.indexOf('cache.sessions = nextSessions;');
    if (awaitIdx < 0) throw new Error('saveSessionsDurable 未使用 idbPutMany allowFallback:false');
    if (cacheIdx < 0) throw new Error('saveSessionsDurable 未找到缓存更新锚点');
    if (cacheIdx < awaitIdx) throw new Error('saveSessionsDurable 缓存提前更新（非 durable）');
  });
  test('S5: 全部 durable API（saveSessionDurable/saveSessionsDurable/create/update/deleteExpenseDurable）失败路径均返回 ok:false（严格失败上报）', () => {
    ['saveSessionDurable', 'saveSessionsDurable', 'createExpenseDurable', 'updateExpenseDurable', 'deleteExpenseDurable'].forEach((fn) => {
      if (!new RegExp('async function ' + fn).test(STORE_SRC)) throw new Error(fn + ' 缺失');
      const start = STORE_SRC.indexOf('async function ' + fn);
      const slice = STORE_SRC.slice(start, start + 2000);
      if (!/return \{\s*ok:\s*false/.test(slice)) throw new Error(fn + ' 的失败路径未返回 ok:false（缺少严格失败上报）');
    });
  });
}

// ===== 要求1+2：批量手工收入 all-or-nothing（GREEN，真实 Store VM） =====
async function runT2() {
  await test('T2: 批量手工收入 IDB 失败 → ok:false 且 sessions 权威缓存完全不变（all-or-nothing）', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' }); // 仅 IDB 失败；localStorage 可用
    const Store = loadStore(sb);
    Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
    SESSION_DATES.forEach((d, i) => Store.createSession({ id: 'bd-s-' + i, clientId: 'bd-c-001', sessionNumber: i + 1, date: d, billing: { fee: 0, paid: false } }));
    const before = JSON.stringify(Store.getSessions());
    const incomes = ['bd-s-0', 'bd-s-1', 'bd-s-2'].map((sid) => {
      const s = Store.getSession(sid);
      return Object.assign({}, s, { billing: Object.assign({}, s.billing, { fee: 500, paid: true }) });
    });
    const result = await Store.saveSessionsDurable(incomes);
    if (result.ok !== false) throw new Error('T2: 批量 IDB 失败时应为 ok:false，实际 ok:' + result.ok);
    if (before !== JSON.stringify(Store.getSessions())) throw new Error('T2: 批量失败却改变了权威 sessions 缓存（违反 all-or-nothing）');
  });
  await test('T2b: 批量手工收入成功后才更新权威 sessions 缓存（ok:true 且内容落库）', async () => {
    const sb = buildSandbox({}); // IDB 成功
    const Store = loadStore(sb);
    Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
    const ids = ['bd-s-0', 'bd-s-1', 'bd-s-2'];
    ids.forEach((id, i) => Store.createSession({ id, clientId: 'bd-c-001', sessionNumber: i + 1, date: SESSION_DATES[i], billing: { fee: 0, paid: false } }));
    const before = JSON.stringify(Store.getSessions());
    const incomes = ids.map((sid) => {
      const s = Store.getSession(sid);
      return Object.assign({}, s, { billing: Object.assign({}, s.billing, { fee: 500, paid: true }) });
    });
    const result = await Store.saveSessionsDurable(incomes);
    if (result.ok !== true) throw new Error('T2b: 期望 ok:true，实际 ' + JSON.stringify(result));
    if (before === JSON.stringify(Store.getSessions())) throw new Error('T2b: 成功后权威缓存未更新');
    ids.forEach((sid) => {
      const s = Store.getSession(sid);
      if (!s.billing.paid || s.billing.fee !== 500) throw new Error('T2b: 缓存未正确反映批量收入: ' + sid);
    });
  });
}

// ===== 要求3+4+5：手工支出 create/update/delete durable（GREEN，真实 Store VM） =====
async function runT3() {
  await test('T3a: 手工支出 create IDB 失败（LS 可用）→ ok:false 且 expenses 缓存不变，绝不以 LS 兜底成功', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' });
    const Store = loadStore(sb);
    Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
    const before = JSON.stringify(Store.getExpenses());
    const r = await Store.createExpenseDurable({ category: 'course', date: '2026-07-19', amount: 120, description: 'syn', clientId: 'bd-c-001' });
    if (r.ok !== false) throw new Error('T3a: 期望 ok:false（IDB 失败），实际 ok:' + r.ok + (r.ok === true ? '（LS 兜底冒充成功，违反严格 durable）' : ''));
    if (before !== JSON.stringify(Store.getExpenses())) throw new Error('T3a: IDB 失败却改变了 expenses 缓存');
  });
  await test('T3b: 手工支出 update IDB 失败 → ok:false 且 expenses 缓存不变', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' });
    const Store = loadStore(sb);
    const ids = seedClientExpenses(Store, 1);
    const before = JSON.stringify(Store.getExpenses());
    const r = await Store.updateExpenseDurable(ids[0], { amount: 999 });
    if (r.ok !== false) throw new Error('T3b: 期望 ok:false，实际 ok:' + r.ok);
    if (before !== JSON.stringify(Store.getExpenses())) throw new Error('T3b: IDB 失败却改变了 expenses 缓存');
  });
  await test('T3c: 手工支出 delete IDB 失败 → ok:false 且 expenses 缓存不变', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' });
    const Store = loadStore(sb);
    const ids = seedClientExpenses(Store, 1);
    const before = JSON.stringify(Store.getExpenses());
    const r = await Store.deleteExpenseDurable(ids[0]);
    if (r.ok !== false) throw new Error('T3c: 期望 ok:false，实际 ok:' + r.ok);
    if (before !== JSON.stringify(Store.getExpenses())) throw new Error('T3c: IDB 失败却改变了 expenses 缓存');
  });
  await test('T3d: 手工支出 create/update/delete 成功后才更新权威 expenses 缓存（严格 durable 顺序）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
    const c = await Store.createExpenseDurable({ category: 'course', date: '2026-07-19', amount: 120, description: 'syn', clientId: 'bd-c-001' });
    if (c.ok !== true) throw new Error('T3d: create 期望 ok:true，实际 ' + JSON.stringify(c));
    if (Store.getExpenses().length !== 1) throw new Error('T3d: create 后缓存未添加');
    const u = await Store.updateExpenseDurable(c.value.id, { amount: 999 });
    if (u.ok !== true) throw new Error('T3d: update 期望 ok:true，实际 ' + JSON.stringify(u));
    const updated = Store.getExpenses().find((e) => e.id === c.value.id);
    if (!updated || updated.amount !== 999) throw new Error('T3d: update 后缓存未更新');
    const d = await Store.deleteExpenseDurable(c.value.id);
    if (d.ok !== true) throw new Error('T3d: delete 期望 ok:true，实际 ' + JSON.stringify(d));
    if (Store.getExpenses().length !== 0) throw new Error('T3d: delete 后缓存未移除');
  });
  await test('T3e: 手工支出延迟事务完成前不得暴露成功状态（create）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
    let release;
    sb.state.txGate = new Promise((res) => { release = res; });
    const saving = Store.createExpenseDurable({ category: 'course', date: '2026-07-19', amount: 120, description: 'syn', clientId: 'bd-c-001' });
    const lenBefore = Store.getExpenses().length;
    const race = await Promise.race([saving.then(() => 'done', () => 'rejected'), new Promise((r) => setTimeout(() => r('timeout'), 50))]);
    if (race !== 'timeout') throw new Error('T3e: createExpenseDurable 在事务完成前就 resolve（暴露成功）');
    if (Store.getExpenses().length !== lenBefore) throw new Error('T3e: 事务完成前缓存已改变');
    release();
    const result = await saving;
    if (!result.ok || Store.getExpenses().length !== lenBefore + 1) throw new Error('T3e: 事务完成后未提交');
  });
}

// ===== 要求1：手工单笔收入写入失败 → 权威 sessions 缓存不变（GREEN，真实 Store VM） =====
async function runT1() {
  await test('T1: 手工单笔收入写入失败 → 权威 sessions 缓存不变（ok:false 且新会话不泄漏）', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' }); // 仅 IDB 失败；localStorage 可用
    const Store = loadStore(sb);
    seedClientSession(Store, 'bd-s-old', '2026-07-10', { fee: 300, paid: true });
    const before = JSON.stringify(Store.getSessions());
    const updated = Object.assign({}, Store.getSession('bd-s-old'), { billing: Object.assign({}, Store.getSession('bd-s-old').billing, { paid: true, fee: 400 }) });
    const result = await Store.saveSessionDurable(updated);
    if (result.ok !== false) throw new Error('T1: 期望 ok:false（durable 失败），得到 ok:' + result.ok);
    if (before !== JSON.stringify(Store.getSessions())) throw new Error('T1: 写入失败后权威 sessions 缓存被改变');
  });
}

// ===== 要求4：延迟事务完成前不得暴露成功状态（GREEN，针对手工收入 saveSessionDurable） =====
async function runT4() {
  await test('T4: 延迟事务完成前不得暴露成功状态（手工收入 saveSessionDurable）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    seedClientSession(Store, 'bd-s-0', '2026-07-10', { fee: 0, paid: false });
    let release;
    sb.state.txGate = new Promise((res) => { release = res; });
    const saving = Store.saveSessionDurable(Object.assign({}, Store.getSession('bd-s-0'), { billing: { fee: 500, paid: true } }));
    if (Store.getSession('bd-s-0').billing.paid !== false) throw new Error('T4: 事务完成前缓存已改变');
    const race = await Promise.race([saving.then(() => 'done', () => 'rejected'), new Promise((r) => setTimeout(() => r('timeout'), 50))]);
    if (race !== 'timeout') throw new Error('T4: saveSessionDurable 在事务完成前就 resolve（暴露成功）');
    release();
    const result = await saving;
    if (!result.ok || !Store.getSession('bd-s-0').billing.paid) throw new Error('T4: 事务完成后未提交');
  });
}

// ===== 要求5：禁止把 localStorage fallback 当成 durable success（GREEN + DEGRADED 探针） =====
async function runT5() {
  await test('T5: IDB 失败但 LS 可用时，严格 durable 手工收入不得把 LS 兜底当成成功', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' }); // 仅 IDB 失败；localStorage 可用
    const Store = loadStore(sb);
    seedClientSession(Store, 'bd-s-0', '2026-07-10', { fee: 0, paid: false });
    const result = await Store.saveSessionDurable(Object.assign({}, Store.getSession('bd-s-0'), { billing: { fee: 500, paid: true } }));
    if (result.ok !== false) throw new Error('T5: IDB 失败时竟以 LS 兜底成功（ok=' + result.ok + '），违反严格 durable');
  });
}
function runT5Degraded() {
  // legacy 降级风险探针：旧 createExpense 经 persist 默认 allowFallback 回退 LS 成功（不计入 durable 通过）。
  // 真实 durable 路径应使用 createExpenseDurable；此探针仅记录历史上非 durable 的记账路径残留风险。
  const sb = buildSandbox({ failMode: 'idbPut' });
  const Store = loadStore(sb);
  const before = Store.getExpenses().length;
  let legacyOk = false;
  try { Store.createExpense({ category: 'course', date: '2026-07-19', amount: 50 }); legacyOk = true; } catch (e) {}
  const after = Store.getExpenses().length;
  degraded('T5-DEGRADED: 仅 IDB 失败→真实 createExpense（旧）经 persist 默认 fallback 回退 LS 成功（legacy 降级风险；严格 durable 支出 API 已存在，UI 应切到 createExpenseDurable；不计入 durable 通过）', { expenseFallbackOk: legacyOk, cacheDelta: after - before });
}

// ===== 要求7：变异敏感（await 移除 / 缓存提前更新 / fallback 放宽），覆盖 收入/支出/批量 三套 =====
function buildMutant(kind) {
  let mutated;
  if (kind === 'income-await-removed') {
    mutated = STORE_SRC.replace(
      "await idbPut('sessions', nextSessions, { allowFallback: false });",
      "idbPut('sessions', nextSessions, { allowFallback: false }); /* mut:income-await-removed */"
    );
  } else if (kind === 'income-cache-premature') {
    mutated = STORE_SRC.replace(
      "      await idbPut('sessions', nextSessions, { allowFallback: false });\n      // The authoritative cache changes only after the transaction completes.\n      cache.sessions = nextSessions;",
      "      cache.sessions = nextSessions; /* mut:income-cache-premature */\n      await idbPut('sessions', nextSessions, { allowFallback: false });"
    );
  } else if (kind === 'income-fallback-true') {
    mutated = STORE_SRC.replace(
      "await idbPut('sessions', nextSessions, { allowFallback: false });",
      "await idbPut('sessions', nextSessions, { allowFallback: true }); /* mut:income-fallback-true */"
    );
  } else if (kind === 'expense-await-removed') {
    mutated = STORE_SRC.replace(
      "await idbPut('expenses', nextExpenses, { allowFallback: false });",
      "idbPut('expenses', nextExpenses, { allowFallback: false }); /* mut:expense-await-removed */"
    );
  } else if (kind === 'expense-cache-premature') {
    mutated = STORE_SRC.replace(
      "      await idbPut('expenses', nextExpenses, { allowFallback: false });\n      cache.expenses = nextExpenses;",
      "      cache.expenses = nextExpenses; /* mut:expense-cache-premature */\n      await idbPut('expenses', nextExpenses, { allowFallback: false });"
    );
  } else if (kind === 'expense-fallback-true') {
    mutated = STORE_SRC.replace(
      "await idbPut('expenses', nextExpenses, { allowFallback: false });",
      "await idbPut('expenses', nextExpenses, { allowFallback: true }); /* mut:expense-fallback-true */"
    );
  } else if (kind === 'batch-await-removed') {
    mutated = STORE_SRC.replace(
      "await idbPutMany([['sessions', nextSessions]], { allowFallback: false });",
      "idbPutMany([['sessions', nextSessions]], { allowFallback: false }); /* mut:batch-await-removed */"
    );
  } else if (kind === 'batch-cache-premature') {
    mutated = STORE_SRC.replace(
      "      await idbPutMany([['sessions', nextSessions]], { allowFallback: false });\n      cache.sessions = nextSessions;",
      "      cache.sessions = nextSessions; /* mut:batch-cache-premature */\n      await idbPutMany([['sessions', nextSessions]], { allowFallback: false });"
    );
  } else if (kind === 'batch-fallback-true') {
    mutated = STORE_SRC.replace(
      "await idbPutMany([['sessions', nextSessions]], { allowFallback: false });",
      "await idbPutMany([['sessions', nextSessions]], { allowFallback: true }); /* mut:batch-fallback-true */"
    );
  } else {
    throw new Error('unknown mutant kind: ' + kind);
  }
  if (mutated === STORE_SRC) throw new Error('变异 no-op（未匹配目标代码）: ' + kind);
  return mutated;
}
async function assertIncomeBehavior(Store, sb) {
  sb.state.failMode = 'idbPut';
  Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
  Store.createSession({ id: 'bd-s-0', clientId: 'bd-c-001', sessionNumber: 1, date: '2026-07-10', billing: { fee: 0, paid: false } });
  const before = JSON.stringify(Store.getSessions());
  const result = await Store.saveSessionDurable(Object.assign({}, Store.getSession('bd-s-0'), { billing: { fee: 500, paid: true } }));
  if (result.ok !== false) throw new Error('期望 ok:false（严格 durable 失败）');
  if (before !== JSON.stringify(Store.getSessions())) throw new Error('期望权威缓存不变');
}
async function assertExpenseBehavior(Store, sb) {
  sb.state.failMode = 'idbPut';
  Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
  const before = JSON.stringify(Store.getExpenses());
  const result = await Store.createExpenseDurable({ category: 'course', date: '2026-07-19', amount: 120, description: 'syn', clientId: 'bd-c-001' });
  if (result.ok !== false) throw new Error('期望 ok:false（严格 durable 失败）');
  if (before !== JSON.stringify(Store.getExpenses())) throw new Error('期望权威缓存不变');
}
async function assertBatchBehavior(Store, sb) {
  sb.state.failMode = 'idbPut';
  Store.createClient(JSON.parse(JSON.stringify(CLIENT)));
  SESSION_DATES.forEach((d, i) => Store.createSession({ id: 'bd-s-' + i, clientId: 'bd-c-001', sessionNumber: i + 1, date: d, billing: { fee: 0, paid: false } }));
  const before = JSON.stringify(Store.getSessions());
  const incomes = ['bd-s-0', 'bd-s-1', 'bd-s-2'].map((sid) => {
    const s = Store.getSession(sid);
    return Object.assign({}, s, { billing: Object.assign({}, s.billing, { fee: 500, paid: true }) });
  });
  const result = await Store.saveSessionsDurable(incomes);
  if (result.ok !== false) throw new Error('期望 ok:false（批量 durable 失败）');
  if (before !== JSON.stringify(Store.getSessions())) throw new Error('期望权威缓存不变');
}
async function expectMutantDetected(kind, assertionFn, label) {
  const mutated = buildMutant(kind);
  const sb = buildSandbox({});
  const MStore = loadMutant(sb, mutated);
  let threw = false, msg = '';
  try { await assertionFn(MStore, sb); } catch (e) { threw = true; msg = e && e.message; }
  if (!threw) throw new Error(label + '：变异未被检出（合约对该回归版本仍 PASS）——断言未敏感: ' + msg);
}
async function runT6() {
  await test('T6a: 变异敏感(收入) — 移除 saveSessionDurable 的 await → 失败被漏报（应检出）', async () => {
    await expectMutantDetected('income-await-removed', assertIncomeBehavior, 'T6a');
  });
  await test('T6b: 变异敏感(收入) — 缓存提前到 await 之前更新 → 失败仍改变权威缓存（应检出）', async () => {
    await expectMutantDetected('income-cache-premature', assertIncomeBehavior, 'T6b');
  });
  await test('T6c: 变异敏感(收入) — allowFallback 放宽为真 → LS 兜底冒充 durable 成功（应检出）', async () => {
    await expectMutantDetected('income-fallback-true', assertIncomeBehavior, 'T6c');
  });
  await test('T6d: 变异敏感(支出) — 移除 createExpenseDurable 的 await → 失败被漏报（应检出）', async () => {
    await expectMutantDetected('expense-await-removed', assertExpenseBehavior, 'T6d');
  });
  await test('T6e: 变异敏感(支出) — 缓存提前到 await 之前更新 → 失败仍改变权威缓存（应检出）', async () => {
    await expectMutantDetected('expense-cache-premature', assertExpenseBehavior, 'T6e');
  });
  await test('T6f: 变异敏感(支出) — allowFallback 放宽为真 → LS 兜底冒充 durable 成功（应检出）', async () => {
    await expectMutantDetected('expense-fallback-true', assertExpenseBehavior, 'T6f');
  });
  await test('T6g: 变异敏感(批量) — 移除 saveSessionsDurable 的 await → 失败被漏报（应检出）', async () => {
    await expectMutantDetected('batch-await-removed', assertBatchBehavior, 'T6g');
  });
  await test('T6h: 变异敏感(批量) — 缓存提前到 await 之前更新 → 失败仍改变权威缓存（应检出）', async () => {
    await expectMutantDetected('batch-cache-premature', assertBatchBehavior, 'T6h');
  });
  await test('T6i: 变异敏感(批量) — allowFallback 放宽为真 → LS 兜底冒充 durable 成功（应检出）', async () => {
    await expectMutantDetected('batch-fallback-true', assertBatchBehavior, 'T6i');
  });
}

// ===== Run =====
(async () => {
  console.log('=== XJ-4.2.1 billing-durable contract (codebuddy) ===\n');
  staticTests();
  await runT1();
  await runT2();
  await runT3();
  await runT4();
  await runT5();
  runT5Degraded();
  await runT6();

  console.log('----------------------------------------');
  results.forEach((r) => {
    const icon = r.status === 'PASS' ? '[PASS]' : (r.status === 'DEGRADED' ? '[DEGRADED]' : '[FAIL]');
    const tag = (r.status === 'FAIL' && r.expectRed) ? ' (EXPECTED-RED)' : (r.expectRed ? ' (regression-watch)' : '');
    console.log(icon + tag + ' ' + r.name);
    if (r.status === 'FAIL' && r.error) console.log('       ' + r.error);
    if (r.status === 'DEGRADED' && r.detail) console.log('       detail: ' + JSON.stringify(r.detail));
  });
  console.log('----------------------------------------');
  console.log('Passed: ' + passed + ' | Failed: ' + failed + ' | Degraded: ' + degradedCount);
  console.log('Expected-red 命中: ' + expectedRed.length + ' 项');
  console.log('task_id: XJ-4.2.1-codebuddy-billing-durable-postfix-contract');
  console.log('current_store_sha256: ' + STORE_SHA);
  const phase = expectedRed.length > 0 ? 'EXPECTED-RED' : (failed > 0 ? 'CONTRACT-BROKEN' : 'ALL-GREEN');
  console.log('contract_phase: ' + phase);
  console.log('注：不宣称 release-ready；仅验证计费 durable 相关不变量。');

  if (expectedRed.length > 0) {
    console.log('\n[EXPECTED-RED 明细]');
    expectedRed.forEach((x) => {
      console.log('  - ' + x.name);
      console.log('      失败原因: ' + (x.redReason || '(未注明)'));
      console.log('      对应 Codex 实现任务: ' + (x.codexTask || '(未注明)'));
    });
  }

  const unexpected = results.filter((r) => r.status === 'FAIL' && !r.expectRed);
  if (unexpected.length > 0) {
    console.log('\n[CONTRACT-BROKEN] 存在非预期失败：' + unexpected.map((r) => r.name).join('; '));
    process.exit(2);
  }
  if (expectedRed.length > 0) {
    console.log('\n[EXPECTED-RED] 契约检出预期红项（' + expectedRed.length + ' 项）：当前生产仍有已知缺口，驱动 Codex 实现中。');
    process.exit(1);
  }
  console.log('\n[ALL-GREEN] 契约全绿（计费 durable 要求均已满足）。');
  process.exit(0);
})();
