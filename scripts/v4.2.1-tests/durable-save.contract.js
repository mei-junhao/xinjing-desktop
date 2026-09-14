#!/usr/bin/env node
/* ============================================================
   XJ-4.2.1-codebuddy-durable-post-hardening-tests — durable-save 契约测试（后置硬化）
   通过 Node vm 执行真实 app/js/store.js，动态故障注入测试。
   所有 C3/C3B/C3-idb/C4/C4-fail/C5/M6/M7 必须执行真实 Store 函数，不定义替代实现。
   冻结契约要点（严格 IndexedDB 写入，allowFallback:false）：
     - 双失败(IDB+LS) 或 仅 IDB 失败(LS 可用) 时，saveSessionDurable 必须 ok:false，
       旧权威缓存不变，新会话不得进入权威缓存，草稿可恢复，切换被阻断。
     - importAll 在 IDB 失败时必须 reject，旧 cache 保持不变。
     - 「IDB 失败但 localStorage 成功」只是 legacy 降级风险（Store._put 默认 fallback），
       严格 durable API 已不再使用此路径，必须独立标记 degraded，不计入 durable PASS。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const results = [];
let passed = 0, failed = 0, degradedCount = 0;
function test(name, fn) {
  return Promise.resolve().then(() => fn()).then(() => {
    results.push({ name, status: 'PASS' }); passed++;
  }).catch((e) => {
    results.push({ name, status: 'FAIL', error: e && e.message ? e.message : String(e).slice(0, 200) }); failed++;
  });
}
function note(msg) { results.push({ name: '[NOTE]', status: 'INFO', note: msg }); }
function degraded(name, detail) {
  degradedCount++;
  results.push({ name, status: 'DEGRADED', detail: detail || null, note: '降级风险：非 durable IndexedDB 成功，不计入 durable C3 通过' });
}

// ===== 合成 fixture（synthetic=true，无真实临床/支付数据） =====
const CLIENT_A = { id: 'synth-c-001', name: 'TestA', status: 'active', billing: { feePerSession: 300, billingMode: 'per-session' }, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z', firstVisitDate: '2026-07-19' };
const SESSION_OLD = { id: 'synth-s-old', clientId: 'synth-c-001', sessionNumber: 1, date: '2026-07-01', type: 'individual', billing: { fee: 300, paid: true }, hasTranscript: true, hasSoap: true, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' };
const EXPORT_BASE = { version: '2.0.0', exportedAt: '2026-07-19T00:00:00.000Z', clients: [CLIENT_A], sessions: [SESSION_OLD], supervisions: [], supervisorIdentities: [], masterConversations: [], expenses: [], materialWorkspaces: [], clinicalActionRuns: [], settings: { apiConfig: {}, version: '1.0.0' } };
const BAD_SESSION = { id: 'synth-s-badref', clientId: 'synth-c-non-existent', sessionNumber: 1, date: '2026-07-19' };
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'js', 'store.js'), 'utf8');

// ===== Sandbox =====
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

function loadStore(sb) {
  const ctx = vm.createContext(Object.create(null));
  Object.assign(ctx, {
    localStorage: sb.localStorage, indexedDB: sb.indexedDB,
    window: { __XJ__: sb.__XJ__, __XJ_API__: sb.__XJ_API__, indexedDB: sb.indexedDB, location: { pathname: '/index.html' }, addEventListener: () => {}, requestAnimationFrame: () => {}, matchMedia: () => ({ matches: false }) },
    document: { querySelector: () => null, addEventListener: () => {}, createElement: () => ({ style: {} }) },
    navigator: { userAgent: 'test' },
    console, setTimeout, setImmediate, Promise,
    URL, URLSearchParams, TextDecoder,
    location: { pathname: '/index.html', origin: 'http://localhost', href: 'http://localhost/index.html' },
  });
  const script = new vm.Script(STORE_SRC + '\n; globalThis.__StoreUnderTest = Store;');
  script.runInNewContext(ctx);
  return ctx.__StoreUnderTest;
}

// 双失败/单失败沙箱中 importAll 无法落库（LS 也失败），改用同步写缓存的公开 API 播种旧权威数据。
// 注意：store.js 仅导出 createClient/createSession（saveClient/saveSession 为内部函数）。
function seedSync(Store) {
  Store.createClient(JSON.parse(JSON.stringify(CLIENT_A)));
  Store.createSession(JSON.parse(JSON.stringify(SESSION_OLD)));
}

// ===== S1-S5: Static checks =====
function staticTests() {
  test('S1: node --check store.js', () => { require('child_process').execSync('node --check app/js/store.js', { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' }); });
  test('S2: DB_VERSION', () => { if (!STORE_SRC.includes('DB_VERSION')) throw new Error('missing'); });
  test('S3: persist fire-and-forget', () => { const m = STORE_SRC.match(/function persist\((\w+)\)\s*\{([^}]+)\}/); if (!m || m[2].includes('await idbPut')) throw new Error('not fire-and-forget'); });
  test('S4: _dbAvailable', () => { if (!STORE_SRC.includes('_dbAvailable')) throw new Error('missing'); });
  test('S5: durable APIs', () => { ['saveSessionDurable', 'createSessionDurable', 'canSwitchSession', 'getSessionRecoveryDraft', 'idbPutMany', 'getImportQuarantine'].forEach((a) => { if (!STORE_SRC.includes(a)) throw new Error(a + ' missing'); }); });
  test('S6: strict durable (allowFallback:false)', () => {
    if (!/await idbPut\('sessions'[\s\S]*?\{\s*allowFallback:\s*false\s*\}/.test(STORE_SRC)) throw new Error('saveSessionDurable 未使用严格 allowFallback:false');
    if (!/await idbPutMany\([\s\S]*?\{\s*allowFallback:\s*false\s*\}/.test(STORE_SRC)) throw new Error('importAll 未使用严格 allowFallback:false');
  });
  test('S7: durable delete and billing clear use strict batch persistence', () => {
    const deleteStart = STORE_SRC.indexOf('async function deleteSessionsDurable');
    const clearStart = STORE_SRC.indexOf('async function clearBillingDataDurable');
    if (deleteStart < 0 || clearStart < 0) throw new Error('durable delete APIs missing');
    const deleteSlice = STORE_SRC.slice(deleteStart, clearStart);
    const clearSlice = STORE_SRC.slice(clearStart, clearStart + 2200);
    if (!deleteSlice.includes("['sessions', next.nextSessions]") || !deleteSlice.includes("['supervisions', next.nextSupervisions]") || !deleteSlice.includes("['materialWorkspaces', next.nextMaterials]") || !deleteSlice.includes('allowFallback: false')) throw new Error('session delete cascade is not strict and atomic');
    if (!clearSlice.includes("['clients', nextClients]") || !clearSlice.includes("['expenses', nextExpenses]") || !clearSlice.includes('allowFallback: false')) throw new Error('billing clear is not strict and atomic');
    const masterStart = STORE_SRC.indexOf('async function deleteMasterConversationDurable');
    if (masterStart < 0) throw new Error('durable master conversation delete API missing');
    const masterSlice = STORE_SRC.slice(masterStart, masterStart + 1200);
    if (!masterSlice.includes("idbPut('masterConversations'") || !masterSlice.includes('allowFallback: false')) throw new Error('master conversation delete is not strict');
  });
}

function durableDeleteFixture() {
  const fixture = JSON.parse(JSON.stringify(EXPORT_BASE));
  fixture.clients[0].billing.monthlyPayments = [{ id: 'synth-payment-001', amount: 300, month: '2026-07' }];
  fixture.supervisions = [{ id: 'synth-sv-001', clientId: 'synth-c-001', sessionIds: ['synth-s-old'], createdAt: '2026-07-01T00:00:00.000Z' }];
  fixture.materialWorkspaces = [{ id: 'synth-mat-001', title: 'synthetic.txt', clientId: 'synth-c-001', sessionId: 'synth-s-old', source: { name: 'synthetic.txt' }, parseStatus: 'ready', extractedText: 'synthetic', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }];
  fixture.expenses = [{ id: 'synth-expense-001', category: 'course', date: '2026-07-01', amount: 100, description: 'synthetic' }];
  return fixture;
}

async function runD1() {
  await test('D1: strict session delete failure retains sessions and all cascade references', async () => {
    const sb = buildSandbox();
    const Store = loadStore(sb);
    await Store.importAll(JSON.stringify(durableDeleteFixture()));
    sb.state.failMode = 'idbPut';
    const result = await Store.deleteSessionDurable('synth-s-old');
    if (result.ok !== false || !result.error || result.error.code !== 'XJ_DURABLE_SESSION_DELETE_FAILED') throw new Error('D1: strict delete did not report durable failure');
    if (!Store.getSession('synth-s-old')) throw new Error('D1: failed delete changed authoritative session cache');
    if ((Store.getSupervisions()[0].sessionIds || []).indexOf('synth-s-old') < 0) throw new Error('D1: failed delete changed supervision reference');
    if (Store.getMaterialWorkspace('synth-mat-001').sessionId !== 'synth-s-old') throw new Error('D1: failed delete changed material reference');
  });
}

async function runD2() {
  await test('D2: session delete waits for transaction before exposing cascade cache changes', async () => {
    const sb = buildSandbox();
    const Store = loadStore(sb);
    await Store.importAll(JSON.stringify(durableDeleteFixture()));
    let releaseTransaction;
    sb.state.txGate = new Promise((resolve) => { releaseTransaction = resolve; });
    const deleting = Store.deleteSessionDurable('synth-s-old');
    if (!Store.getSession('synth-s-old')) throw new Error('D2: session cache changed before transaction completed');
    if ((Store.getSupervisions()[0].sessionIds || []).indexOf('synth-s-old') < 0) throw new Error('D2: supervision cache changed before transaction completed');
    if (Store.getMaterialWorkspace('synth-mat-001').sessionId !== 'synth-s-old') throw new Error('D2: material cache changed before transaction completed');
    const race = await Promise.race([deleting.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))]);
    if (race !== 'timeout') throw new Error('D2: delete resolved before the transaction completed');
    releaseTransaction();
    const result = await deleting;
    if (!result.ok || Store.getSession('synth-s-old')) throw new Error('D2: session deletion did not commit after transaction completion');
    if ((Store.getSupervisions()[0].sessionIds || []).length !== 0) throw new Error('D2: committed delete retained supervision reference');
    if (Store.getMaterialWorkspace('synth-mat-001').sessionId !== '') throw new Error('D2: committed delete retained material reference');
  });
}

async function runD3() {
  await test('D3: billing clear failure retains billable sessions, monthly settlements, and expenses', async () => {
    const sb = buildSandbox();
    const Store = loadStore(sb);
    await Store.importAll(JSON.stringify(durableDeleteFixture()));
    sb.state.failMode = 'idbPut';
    const result = await Store.clearBillingDataDurable();
    if (result.ok !== false || !result.error || result.error.code !== 'XJ_DURABLE_BILLING_CLEAR_FAILED') throw new Error('D3: billing clear did not report durable failure');
    if (!Store.getSession('synth-s-old')) throw new Error('D3: failed billing clear removed session');
    if (!(Store.getClient('synth-c-001').billing.monthlyPayments || []).length) throw new Error('D3: failed billing clear removed monthly settlement');
    if (Store.getExpenses().length !== 1) throw new Error('D3: failed billing clear removed expense');
  });
}

async function runD4() {
  await test('D4: billing clear commits all billing changes together after strict transaction', async () => {
    const sb = buildSandbox();
    const Store = loadStore(sb);
    await Store.importAll(JSON.stringify(durableDeleteFixture()));
    const result = await Store.clearBillingDataDurable();
    if (!result.ok || result.deletedSessionCount !== 1) throw new Error('D4: billing clear did not commit expected session count');
    if (Store.getSession('synth-s-old')) throw new Error('D4: billing clear retained billable session');
    if ((Store.getClient('synth-c-001').billing.monthlyPayments || []).length !== 0) throw new Error('D4: billing clear retained monthly settlement');
    if (Store.getExpenses().length !== 0) throw new Error('D4: billing clear retained expense');
  });
}

async function runD5() {
  await test('D5: master conversation delete reports failure and commits cache change only after strict transaction', async () => {
    const conversation = { id: 'synth-master-001', masterKeys: ['winnicott'], mode: 'single', messages: [{ role: 'user', content: 'synthetic prompt' }], createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' };
    const fixture = Object.assign({}, EXPORT_BASE, { masterConversations: [conversation] });
    const failedSandbox = buildSandbox();
    const failedStore = loadStore(failedSandbox);
    await failedStore.importAll(JSON.stringify(fixture));
    failedSandbox.state.failMode = 'idbPut';
    const failed = await failedStore.deleteMasterConversationDurable(conversation.id);
    if (failed.ok !== false || failedStore.getMasterConversation(conversation.id) === null) throw new Error('D5: failed master delete changed authoritative cache');

    const delayedSandbox = buildSandbox();
    const delayedStore = loadStore(delayedSandbox);
    await delayedStore.importAll(JSON.stringify(fixture));
    let releaseTransaction;
    delayedSandbox.state.txGate = new Promise((resolve) => { releaseTransaction = resolve; });
    const deleting = delayedStore.deleteMasterConversationDurable(conversation.id);
    if (!delayedStore.getMasterConversation(conversation.id)) throw new Error('D5: master delete changed cache before transaction completion');
    const race = await Promise.race([deleting.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))]);
    if (race !== 'timeout') throw new Error('D5: master delete resolved before transaction completion');
    releaseTransaction();
    const result = await deleting;
    if (!result.ok || delayedStore.getMasterConversation(conversation.id)) throw new Error('D5: master delete did not commit after transaction completion');
  });
}

// ===== C3: 双失败(IDB+LS) → saveSessionDurable.ok===false，权威缓存不变/草稿保留/切换被阻 =====
async function runC3() {
  await test('C3: 双失败(IDB+LS) 直接调用真实 Store.saveSessionDurable → ok:false 且权威缓存不变/草稿保留/切换被阻', async () => {
    const sb = buildSandbox({ failMode: 'both' });
    const Store = loadStore(sb);
    seedSync(Store);
    if (!Store.getClient('synth-c-001')) throw new Error('C3: seed client missing');
    const oldSession = Store.getSession('synth-s-old');
    if (!oldSession) throw new Error('C3: old session missing after seed');

    const newSession = { id: 'synth-s-c3', clientId: 'synth-c-001', sessionNumber: 99, date: '2026-07-19', billing: { fee: 300, paid: false }, transcript: 'C3-draft' };
    const result = await Store.saveSessionDurable(newSession);
    if (result.ok !== false) throw new Error('C3: 期望 ok:false（durable 失败），得到 ok:' + result.ok);
    if (!Store.getSession('synth-s-old')) throw new Error('C3: 旧权威会话丢失');
    if (Store.getSession('synth-s-c3')) throw new Error('C3: 新会话泄漏进入权威缓存');
    const draft = Store.getSessionRecoveryDraft('synth-c-001', 'synth-s-c3');
    if (!draft || draft.transcript !== 'C3-draft') throw new Error('C3: 恢复草稿未保留');
    const sw = Store.canSwitchSession('synth-c-001', 'synth-s-c3');
    if (sw.allowed !== false) throw new Error('C3: canSwitchSession 未阻断（allowed=' + sw.allowed + '）');
  });
}

// ===== C3B: 真实触发失败路径 → getSessionSaveError 记录 + 草稿可恢复 + 切换被阻断 =====
async function runC3B() {
  await test('C3B: 真实触发失败路径 → getSessionSaveError 记录 + 草稿可恢复 + 切换被阻断(assertCanSwitchSession 抛错)', async () => {
    const sb = buildSandbox({ failMode: 'both' });
    const Store = loadStore(sb);
    seedSync(Store);
    const result = await Store.saveSessionDurable({ id: 'synth-s-c3b', clientId: 'synth-c-001', sessionNumber: 7, date: '2026-07-19', transcript: 'C3B-draft' });
    if (result.ok !== false) throw new Error('C3B: 期望失败路径 ok:false，得到 ' + result.ok);
    const err = Store.getSessionSaveError('synth-c-001', 'synth-s-c3b');
    if (!err || !err.draft || err.draft.transcript !== 'C3B-draft') throw new Error('C3B: getSessionSaveError/草稿 缺失');
    const draft = Store.getSessionRecoveryDraft('synth-c-001', 'synth-s-c3b');
    if (!draft || draft.transcript !== 'C3B-draft') throw new Error('C3B: 恢复草稿不可恢复');
    const sw = Store.canSwitchSession('synth-c-001', 'synth-s-c3b');
    if (sw.allowed !== false) throw new Error('C3B: 切换未阻断');
    let threw = false;
    try { Store.assertCanSwitchSession('synth-c-001', 'synth-s-c3b'); } catch (e) { threw = !!(e && e.code === 'XJ_UNSAVED_SESSION_DRAFT'); }
    if (!threw) throw new Error('C3B: assertCanSwitchSession 未阻断');
  });
}

// ===== C3-idb: 仅 IDB 失败、localStorage 可用 → 真实 Store.saveSessionDurable 必须 ok:false =====
async function runC3IdbOnly() {
  await test('C3 (仅IDB失败, LS可用): 真实 Store.saveSessionDurable 必须 ok:false，旧权威不变/草稿保留/切换被阻', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' }); // 仅 IDB 失败；localStorage 可用
    const Store = loadStore(sb);
    seedSync(Store);
    if (!Store.getClient('synth-c-001')) throw new Error('C3-idb: seed client missing');
    if (!Store.getSession('synth-s-old')) throw new Error('C3-idb: old session missing after seed');
    const newSession = { id: 'synth-s-c3idb', clientId: 'synth-c-001', sessionNumber: 99, date: '2026-07-19', billing: { fee: 300, paid: false }, transcript: 'C3-idb-draft' };
    const result = await Store.saveSessionDurable(newSession);
    // 严格 IndexedDB：IDB 失败即 ok:false（不再以 LS 成功冒充 durable）。
    if (result.ok !== false) throw new Error('C3-idb: 期望 ok:false（durable 失败，IDB 失败不可被 LS 兜底冒充），得到 ok:' + result.ok);
    if (!Store.getSession('synth-s-old')) throw new Error('C3-idb: 旧权威会话丢失');
    if (Store.getSession('synth-s-c3idb')) throw new Error('C3-idb: 新会话泄漏进入权威缓存');
    const draft = Store.getSessionRecoveryDraft('synth-c-001', 'synth-s-c3idb');
    if (!draft || draft.transcript !== 'C3-idb-draft') throw new Error('C3-idb: 恢复草稿未保留');
    const sw = Store.canSwitchSession('synth-c-001', 'synth-s-c3idb');
    if (sw.allowed !== false) throw new Error('C3-idb: canSwitchSession 未阻断');
  });
}

// ===== C3-DEGRADED: legacy 降级风险探针（仅调用真实 Store._put 默认 fallback，不调用严格 durable API） =====
async function runC3Degraded() {
  const sb = buildSandbox({ failMode: 'idbPut' }); // 仅 IDB 失败；localStorage 可用
  const Store = loadStore(sb);
  // 严格 durable API（saveSessionDurable/importAll）已改为 allowFallback:false，IDB 失败即 ok:false，
  // 不再以 LS 成功冒充 durable。此处仅调用真实 Store._put 的默认 fallback（allowFallback 默认 true），
  // 验证 legacy 回退路径仍存在但只是降级风险：IDB 失败 → 回退 localStorage 成功（非 durable IDB 成功）。
  let legacyOk = false;
  try {
    await Store._put('sessions', []); // 默认 allowFallback=true：IDB 失败后回退 localStorage
    legacyOk = true;
  } catch (e) {
    legacyOk = false;
  }
  degraded('C3-DEGRADED: 仅 IDB 失败→真实 Store._put 默认 fallback 回退 LS 成功（legacy 降级风险；严格 durable API 不再使用此路径；不计入 durable C3 通过）', { legacyFallbackOk: legacyOk });
  if (!legacyOk) {
    results.push({ name: 'C3-DEGRADED-CHECK', status: 'FAIL', error: 'legacy fallback 期望成功（IDB 失败但 LS 可用），实际失败' });
    failed++;
  }
}

// ===== C4: importAll 缓存更新延迟到事务完成后（50ms 内未完成；完成后新缓存生效） =====
async function runC4() {
  await test('C4: importAll 缓存更新延迟到事务完成后（50ms 内未完成；完成后新缓存生效）', async () => {
    const count = (STORE_SRC.match(/async function importAll/g) || []).length;
    if (count < 1) throw new Error('importAll not found');
    const lastIdx = STORE_SRC.lastIndexOf('async function importAll');
    const activeSlice = STORE_SRC.slice(lastIdx, lastIdx + 2000);
    if (!activeSlice.includes('idbPutMany')) throw new Error('活跃 importAll 未使用 idbPutMany');

    // 事务完成延迟 120ms（>50ms），用于证明缓存更新被延迟。
    const sb = buildSandbox({ txDelay: 150 });
    const Store = loadStore(sb);
    // 先播种一个「导入前已存在」的会话，用于证明缓存更新被延迟（importAll 会整体替换缓存）。
    Store.createClient(JSON.parse(JSON.stringify(CLIENT_A)));
    Store.createSession({ id: 'synth-s-pre', clientId: 'synth-c-001', sessionNumber: 0, date: '2026-06-01', transcript: 'pre' });
    if (!Store.getSession('synth-s-pre')) throw new Error('C4: 预置会话未写入缓存');

    const fixture = JSON.parse(JSON.stringify(EXPORT_BASE));
    fixture.sessions.push({ id: 'synth-c-001-NEW', clientId: 'synth-c-001', sessionNumber: 2, date: '2026-07-20', hasTranscript: true });
    const importPromise = Store.importAll(JSON.stringify(fixture));

    // 在 await importPromise 前断言缓存未变：预置会话仍在，新会话尚未进入权威缓存。
    if (!Store.getSession('synth-s-pre')) throw new Error('C4: 事务完成前预置会话丢失（缓存更新未延迟）');
    if (Store.getSession('synth-c-001-NEW')) throw new Error('C4: 事务完成前新会话已泄漏进入缓存（缓存更新未延迟）');

    // 50ms 内 Promise.race 若不是 timeout 必须失败。
    const race = await Promise.race([
      importPromise.then(() => 'done', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('timeout'), 50)),
    ]);
    if (race !== 'timeout') throw new Error('C4: importAll 在 50ms 内完成（缓存更新未延迟），违反 durable 延迟契约 (race=' + race + ')');

    // 事务完成后才断言新缓存生效（预置会话被整体替换）。
    await importPromise;
    if (!Store.getSession('synth-c-001-NEW')) throw new Error('C4: 事务完成后新会话未进入缓存');
    if (Store.getSession('synth-s-pre')) throw new Error('C4: 事务完成后预置会话未被替换');
  });
}

// ===== C4-fail: IDB 失败时 真实 Store.importAll 必须 reject，旧 cache 保持不变 =====
async function runC4Fail() {
  await test('C4 (IDB失败): 真实 Store.importAll 必须 reject 且旧 cache 保持不变', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' }); // 仅 IDB 失败；localStorage 可用
    const Store = loadStore(sb);
    seedSync(Store);
    if (!Store.getSession('synth-s-old')) throw new Error('C4-fail: 预置旧会话缺失');
    const fixture = JSON.parse(JSON.stringify(EXPORT_BASE));
    fixture.sessions.push({ id: 'synth-s-c4fail', clientId: 'synth-c-001', sessionNumber: 5, date: '2026-07-19' });
    let rejected = false;
    try {
      await Store.importAll(JSON.stringify(fixture));
    } catch (e) {
      rejected = true;
    }
    if (!rejected) throw new Error('C4-fail: importAll 在 IDB 失败时未 reject');
    // 旧 cache 保持不变：预置会话仍在，新会话未进入权威缓存。
    if (!Store.getSession('synth-s-old')) throw new Error('C4-fail: 旧权威会话丢失');
    if (Store.getSession('synth-s-c4fail')) throw new Error('C4-fail: 新会话泄漏进入权威缓存');
  });
}

// ===== C5: 导入未知 clientId → session 不进入权威缓存，quarantine 含稳定记录 =====
async function runC5() {
  await test('C5: 真实 Store.importAll 导入未知 clientId → 不进入权威缓存且 quarantine 含稳定记录', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const fixture = JSON.parse(JSON.stringify(EXPORT_BASE));
    fixture.sessions.push(BAD_SESSION);
    const result = await Store.importAll(JSON.stringify(fixture));

    if (Store.getSession('synth-s-badref')) throw new Error('C5: 未知 clientId 会话泄漏进入权威缓存');
    const q = Store.getImportQuarantine();
    const hit = q.find((x) => x && x.entityId === 'synth-s-badref');
    if (!hit) throw new Error('C5: quarantine 未包含该记录 (size=' + q.length + ')');
    if (typeof hit.id !== 'string' || !hit.id) throw new Error('C5: quarantine 记录缺少稳定 id');
    if (hit.collection !== 'sessions' || hit.reason !== 'missing-or-unknown-client') throw new Error('C5: quarantine 元数据错误');
    if (hit.clientId !== 'synth-c-non-existent' || !hit.importedAt) throw new Error('C5: quarantine 稳定字段缺失');
    const hit2 = (result.quarantine || []).find((x) => x && x.entityId === 'synth-s-badref');
    if (!hit2) throw new Error('C5: result.quarantine 未包含该记录');
  });
}

// ===== M6: 删除 importAll 的关键 await → 缓存更新不再延迟 → C4（及本测试）变红 =====
async function runM6() {
  await test('M6: await-removal 变异敏感（importAll 缓存更新延迟被破坏即被检出）', async () => {
    const mutated = STORE_SRC.replace(
      'await idbPutMany(importKeys.map((key) => [key, next[key]]), { allowFallback: false });',
      'idbPutMany(importKeys.map((key) => [key, next[key]]), { allowFallback: false }); /* mut:await-rm */'
    );
    if (mutated === STORE_SRC) throw new Error('M6: 变异 no-op（未匹配到 await idbPutMany）');
    const sb = buildSandbox({ txDelay: 200 });
    const ctx = vm.createContext(Object.create(null));
    Object.assign(ctx, { localStorage: sb.localStorage, indexedDB: sb.indexedDB, window: { __XJ__: sb.__XJ__, __XJ_API__: sb.__XJ_API__, indexedDB: sb.indexedDB, location: { pathname: '/index.html' }, addEventListener: () => {}, requestAnimationFrame: () => {}, matchMedia: () => ({ matches: false }) }, document: { querySelector: () => null, addEventListener: () => {}, createElement: () => ({ style: {} }) }, navigator: { userAgent: 'test' }, console, setTimeout, setImmediate, Promise, URL, URLSearchParams, TextDecoder, location: { pathname: '/index.html', origin: 'http://localhost', href: 'http://localhost/index.html' } });
    new vm.Script(mutated + '\n; globalThis.__StoreUnderTest = Store;').runInNewContext(ctx);
    const MStore = ctx.__StoreUnderTest;
    await MStore.importAll(JSON.stringify({ version: '2.0.0', clients: [], sessions: [], supervisions: [], supervisorIdentities: [], masterConversations: [], expenses: [], materialWorkspaces: [], clinicalActionRuns: [], settings: { apiConfig: {} } }));
    const p = MStore.importAll(JSON.stringify(JSON.parse(JSON.stringify(EXPORT_BASE))));
    const race = await Promise.race([p.then(() => 'done', () => 'rejected'), new Promise((r) => setTimeout(() => r('timeout'), 50))]);
    if (race === 'timeout') throw new Error('M6: 变异未被检出（仍是延迟缓存，await 实际仍在）');
    await p;
  });
}

// ===== M7: 删除 saveSessionDurable 的失败状态记录 → 草稿不再可恢复 → 被检出 =====
async function runM7() {
  await test('M7: draft-recording 变异敏感（saveSessionDurable 失败状态记录被破坏即被检出）', async () => {
    const mutated = STORE_SRC.replace(
      'sessionSaveErrors.set(scope, failure);',
      '/* sessionSaveErrors.set(scope, failure); */ /* mut: draft recording removed */'
    );
    if (mutated === STORE_SRC) throw new Error('M7: 变异 no-op（未匹配到 sessionSaveErrors.set）');
    const sb = buildSandbox({ failMode: 'both' });
    const ctx = vm.createContext(Object.create(null));
    Object.assign(ctx, { localStorage: sb.localStorage, indexedDB: sb.indexedDB, window: { __XJ__: sb.__XJ__, __XJ_API__: sb.__XJ_API__, indexedDB: sb.indexedDB, location: { pathname: '/index.html' }, addEventListener: () => {}, requestAnimationFrame: () => {}, matchMedia: () => ({ matches: false }) }, document: { querySelector: () => null, addEventListener: () => {}, createElement: () => ({ style: {} }) }, navigator: { userAgent: 'test' }, console, setTimeout, setImmediate, Promise, URL, URLSearchParams, TextDecoder, location: { pathname: '/index.html', origin: 'http://localhost', href: 'http://localhost/index.html' } });
    new vm.Script(mutated + '\n; globalThis.__StoreUnderTest = Store;').runInNewContext(ctx);
    const MStore = ctx.__StoreUnderTest;
    MStore.createClient(JSON.parse(JSON.stringify(CLIENT_A)));
    MStore.createSession(JSON.parse(JSON.stringify(SESSION_OLD)));
    const result = await MStore.saveSessionDurable({ id: 'synth-s-m7', clientId: 'synth-c-001', sessionNumber: 99, date: '2026-07-19', billing: { fee: 300, paid: false }, transcript: 'M7-draft' });
    if (result.ok !== false) throw new Error('M7: 变异后 saveSessionDurable 未走失败路径 (ok=' + result.ok + ')');
    const draft = MStore.getSessionRecoveryDraft('synth-c-001', 'synth-s-m7');
    if (draft) throw new Error('M7: 变异未被检出（草稿仍被记录）');
  });
}

// ===== Run =====
(async () => {
  console.log('=== XJ-4.2.1 durable-save contract (codebuddy post-hardening) ===\n');
  staticTests();
  await runC3();
  await runC3B();
  await runC3IdbOnly();
  await runC3Degraded();
  await runC4();
  await runC4Fail();
  await runC5();
  await runD1();
  await runD2();
  await runD3();
  await runD4();
  await runD5();
  await runM6();
  await runM7();

  console.log('\n========================================');
  results.forEach((r) => {
    const icon = r.status === 'PASS' ? '[PASS]' : r.status === 'FAIL' ? '[FAIL]' : r.status === 'DEGRADED' ? '[DEGRADED]' : '[INFO]';
    console.log(icon + ' ' + r.name);
    if (r.error) console.log('       ' + r.error);
    if (r.note) console.log('       ' + r.note);
  });
  console.log('----------------------------------------');
  console.log('Passed: ' + passed + ' | Failed: ' + failed + ' | Degraded: ' + degradedCount);
  console.log('========================================\n');
  console.log('task_id: XJ-4.2.1-codebuddy-durable-post-hardening-tests');
  console.log('base_commit: a0de48f78c186ebf1347b88af5a6ff5aa3407276');
  console.log('contract_id: XJ-4.2.1-durable-save-v1');
  console.log('C3/C3B/C3-idb/C4/C4-fail/C5/M6/M7: 真实 Store 经 vm 动态故障注入');
  console.log('C3-DEGRADED: legacy 降级风险探针（仅 Store._put 默认 fallback）→ 独立降级标记，不计入 durable PASS');
  console.log('注：本测试仅验证契约，不宣称 release-ready。');
  if (failed > 0) { console.log('\n[EXIT 1]'); process.exit(1); }
  console.log('[EXIT 0]');
  process.exit(0);
})();
