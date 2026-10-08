#!/usr/bin/env node
/* ============================================================
   XJ-4.2.1-codebuddy-import-integrity-contract — 导入完整性契约测试（Post-fix 证据与覆盖收口）
   通过 Node vm 执行真实 app/js/store.js（prepareImport / importAll），不克隆生产实现；
   主 T1-T4 与新增 T5（material/supervision）、T6（malformed 隔离）、T7（quarantine 字段）
   全部真实执行 Store。

   契约三态语义（退出码，由尾部按实际结果动态判定）：
     exit 0  ALL-GREEN       —— 无非预期失败且无非预期红项（生产缺陷已修复，门禁/控制组全绿）。
     exit 1  EXPECTED-RED    —— 仅存在「预期红项」：当前生产仍含已知缺陷（契约据此驱动修复）。
     exit 2  CONTRACT-BROKEN —— 存在「非预期失败」：本应绿的契约不变量被破坏（契约损坏）。

   历史缺陷（已于 store.js b8fbfbe 修复，仅作记录）：
     缺陷A「校验读取旧 cache」：clinicalActionRuns 经 isValidClinicalActionRun 过滤，
        读取【当前旧 cache】而非【导入包 next 集合】。→ 已改为针对导入包 clinicalLookup 校验。
     缺陷B「静默 filter 丢弃」：无效 run 被 .filter(...) 静默剔除，不进 importQuarantine。
        → 已改为 normalize 后按 clinicalActionRunValidationError 隔离，无法 normalize 也隔离。

   当前阶段随尾部动态打印：生产修复前 T1/T2/T3 为 EXPECTED-RED；修复后（ce61a180 →
   b8fbfbe）T1-T4 全绿，三态经 XJ_IIC_STORE_PATH 副本实测成立。本契约随生产重构需维护：
   变异门禁依赖 prepareImport 签名与其出口 return next; 两个稳定锚点。

   不削弱任何断言；T1-T4 / 控制组 / 变异敏感性 / exit 0/1/2 语义保持不变。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
// 默认读取真实生产 store.js；测试可用 XJ_IIC_STORE_PATH 指向临时副本以模拟
// 「生产修复后 / 生产回归」状态，从而验证契约三态（exit 1 / 0 / 2）。不改变默认行为。
const STORE_PATH = process.env.XJ_IIC_STORE_PATH ? path.resolve(process.env.XJ_IIC_STORE_PATH) : path.join(ROOT, 'app', 'js', 'store.js');
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');
const STORE_SHA = crypto.createHash('sha256').update(STORE_SRC).digest('hex');
const F = require(path.join(ROOT, 'tests', 'fixtures', 'v4.2.1-import-integrity', 'fixtures.js'));

const results = [];
let passed = 0, failed = 0;
const expectedRed = []; // 记录「预期红项」名称
function test(name, fn, opts) {
  opts = opts || {};
  return Promise.resolve().then(() => fn()).then(() => {
    results.push({ name, status: 'PASS', expectRed: !!opts.expectRed });
    passed++;
  }).catch((e) => {
    results.push({ name, status: 'FAIL', error: e && e.message ? e.message : String(e).slice(0, 300), expectRed: !!opts.expectRed });
    failed++;
    if (opts.expectRed) expectedRed.push(name);
  });
}

// ===== vm 沙箱：可注入 IndexedDB 写失败 =====
function buildSandbox(opts) {
  opts = opts || {};
  const ls = new Map();
  const dbData = new Map();
  const state = { failMode: opts.failMode || 'none' };

  const localStorage = {
    getItem: (k) => ls.get(k) || null,
    setItem: (k, v) => { if (state.failMode === 'both') throw new Error('LS write fault injected'); ls.set(k, v); },
    removeItem: (k) => { ls.delete(k); },
    clear: () => { ls.clear(); },
    get length() { return ls.size; },
    key: (i) => [...ls.keys()][i] || null,
  };

  const indexedDB = {
    open: () => {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      const objStores = new Map();
      const db = {
        objectStoreNames: { contains: (n) => objStores.has(n) },
        createObjectStore: (n, o) => { objStores.set(n, o); return { createIndex: () => {} }; },
        transaction: () => {
          const tx = { error: null, oncomplete: null, onabort: null, onerror: null,
            objectStore: () => ({
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

function loadStoreFrom(src, sb) {
  const ctx = vm.createContext(Object.create(null));
  Object.assign(ctx, {
    localStorage: sb.localStorage, indexedDB: sb.indexedDB,
    window: { __XJ__: sb.__XJ__, __XJ_API__: sb.__XJ_API__, indexedDB: sb.indexedDB, location: { pathname: '/index.html' }, addEventListener: () => {}, requestAnimationFrame: () => {}, matchMedia: () => ({ matches: false }) },
    document: { querySelector: () => null, addEventListener: () => {}, createElement: () => ({ style: {} }) },
    navigator: { userAgent: 'test' },
    console, setTimeout, setImmediate, Promise, URL, URLSearchParams, TextDecoder,
    location: { pathname: '/index.html', origin: 'http://localhost', href: 'http://localhost/index.html' },
  });
  new vm.Script(src + '\n; globalThis.__StoreUnderTest = Store;').runInNewContext(ctx);
  return ctx.__StoreUnderTest;
}
function loadStore(sb) { return loadStoreFrom(STORE_SRC, sb); }

function runIds(Store, filters) { return Store.getClinicalActionRuns(filters || {}).map((r) => r.id); }
function quarantineRunHits(Store) { return Store.getImportQuarantine().filter((x) => x && x.collection === 'clinicalActionRuns'); }

// ============================================================
// 静态检查
// ============================================================
function staticTests() {
  test('S1: node --check store.js', () => { require('child_process').execSync('node --check app/js/store.js', { cwd: ROOT, stdio: 'pipe' }); });
  test('S2: import 相关 API 存在', () => {
    ['prepareImport', 'importAll', 'getImportQuarantine', 'getClinicalActionRuns', 'importQuarantineRecord'].forEach((a) => { if (!STORE_SRC.includes(a)) throw new Error(a + ' missing'); });
  });
  test('S3: importAll 严格批写 allowFallback:false', () => {
    if (!/await idbPutMany\([\s\S]*?\{\s*allowFallback:\s*false\s*\}/.test(STORE_SRC)) throw new Error('importAll 未使用严格 allowFallback:false');
  });
}

// ============================================================
// T1: 自洽导入包（新 client + 新 session + 合法 run）→ 合法 run 必须保留，
//     且校验不得读取旧 cache（cache 为空也应保留）。 —— 预期红（缺陷A）
// ============================================================
async function runT1() {
  await test('T1: 导入新 client+新 session+引用它们的合法 run → 合法 run 必须保留（校验针对导入包而非旧 cache）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb); // 全新 Store，旧 cache 为空
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.LEGAL_RUN] });
    const result = await Store.importAll(JSON.stringify(pkg));
    if (result.ok !== true) throw new Error('T1: importAll 应成功 (ok=' + result.ok + ')');
    const ids = runIds(Store, { clientId: 'iic-c-001' });
    if (!ids.includes('iic-run-legal')) throw new Error('T1: 合法 run 未保留（被静默丢弃）——校验读取了空的旧 cache，而非导入包 next 集合。ids=' + JSON.stringify(ids));
    const q = quarantineRunHits(Store);
    if (q.find((x) => x.entityId === 'iic-run-legal')) throw new Error('T1: 合法 run 被误隔离');
  }, { expectRed: true });
}

// ============================================================
// T2: run 引用未知对象（clientId / sessionId / sources）→ 必须进入
//     importQuarantine（collection: clinicalActionRuns），不得静默丢弃。 —— 预期红（缺陷B）
// ============================================================
async function runT2() {
  await test('T2a: run 引用未知 clientId → 必须进入 importQuarantine，不得静默丢弃', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.RUN_UNKNOWN_CLIENT] });
    await Store.importAll(JSON.stringify(pkg));
    if (runIds(Store).includes('iic-run-badclient')) throw new Error('T2a: 无效 run 泄漏进入权威缓存');
    const hit = quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badclient');
    if (!hit) throw new Error('T2a: 无效 run 被静默丢弃，未进入 importQuarantine（缺陷B）');
    if (!hit.id || !hit.reason || !hit.importedAt) throw new Error('T2a: quarantine 记录缺少稳定字段');
  }, { expectRed: true });

  await test('T2b: run.origin.sessionId 引用未知 session → 必须进入 importQuarantine', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.RUN_UNKNOWN_SESSION] });
    await Store.importAll(JSON.stringify(pkg));
    if (runIds(Store).includes('iic-run-badsession')) throw new Error('T2b: 无效 run 泄漏进入权威缓存');
    if (!quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badsession')) throw new Error('T2b: 无效 run 被静默丢弃（缺陷B）');
  }, { expectRed: true });

  await test('T2c: run.sources 引用未知 session → 必须进入 importQuarantine', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.RUN_UNKNOWN_SOURCE] });
    await Store.importAll(JSON.stringify(pkg));
    if (runIds(Store).includes('iic-run-badsource')) throw new Error('T2c: 无效 run 泄漏进入权威缓存');
    if (!quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badsource')) throw new Error('T2c: 无效 run 被静默丢弃（缺陷B）');
  }, { expectRed: true });
}

// ============================================================
// T3: 混合导入（1 合法 + 3 无效）→ 稳定分流：合法保留、无效全部隔离。 —— 预期红
// ============================================================
async function runT3() {
  await test('T3: 混合导入稳定分流（合法保留 + 无效全部进 importQuarantine）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({
      clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION],
      clinicalActionRuns: [F.LEGAL_RUN, F.RUN_UNKNOWN_CLIENT, F.RUN_UNKNOWN_SESSION, F.RUN_UNKNOWN_SOURCE],
    });
    await Store.importAll(JSON.stringify(pkg));
    const ids = runIds(Store);
    if (!ids.includes('iic-run-legal')) throw new Error('T3: 合法 run 未保留');
    ['iic-run-badclient', 'iic-run-badsession', 'iic-run-badsource'].forEach((bad) => {
      if (ids.includes(bad)) throw new Error('T3: 无效 run 泄漏进入权威缓存: ' + bad);
    });
    const qids = quarantineRunHits(Store).map((x) => x.entityId);
    ['iic-run-badclient', 'iic-run-badsession', 'iic-run-badsource'].forEach((bad) => {
      if (!qids.includes(bad)) throw new Error('T3: 无效 run 未进入 importQuarantine: ' + bad + '（qids=' + JSON.stringify(qids) + '）');
    });
    if (runIds(Store).length !== 1) throw new Error('T3: 权威缓存应仅保留 1 条合法 run，实际 ' + runIds(Store).length);
  }, { expectRed: true });
}

// ============================================================
// T4: IndexedDB 批量写失败 → importAll reject，旧权威 cache 不变。 —— 预期绿（已满足）
// ============================================================
async function runT4() {
  await test('T4: IndexedDB 批量写失败 → importAll reject 且旧权威 cache 不变', async () => {
    const sb = buildSandbox({ failMode: 'idbPut' });
    const Store = loadStore(sb);
    Store.createClient(F.clone(F.NEW_CLIENT));
    Store.createSession(F.clone(F.NEW_SESSION));
    if (!Store.getSession('iic-s-001')) throw new Error('T4: 预置会话缺失');
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [Object.assign(F.clone(F.NEW_SESSION), { id: 'iic-s-NEW', sessionNumber: 2 })] });
    let rejected = false;
    try { await Store.importAll(JSON.stringify(pkg)); } catch (e) { rejected = true; }
    if (!rejected) throw new Error('T4: importAll 在 IDB 失败时未 reject');
    if (!Store.getSession('iic-s-001')) throw new Error('T4: 旧权威会话丢失');
    if (Store.getSession('iic-s-NEW')) throw new Error('T4: 新会话泄漏进入权威缓存');
  });
}

// ============================================================
// 控制组（真实 Store，当前应为绿）：证明测试骨架正确并与 T1/T2 形成对照。
// ============================================================
async function runControls() {
  // CTRL-1: 无效 SESSION（未知 client）当前即被正确隔离 → 证明 quarantine 机制本身可用，
  //         与 T2（run 被静默丢弃）形成对照，说明测试对「隔离 vs 静默丢弃」敏感。
  await test('CTRL-1: 无效 session（未知 client）被正确隔离（quarantine 机制可用，对照 T2）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [{ id: 'iic-s-orphan', clientId: 'iic-c-GHOST', sessionNumber: 9, date: '2026-07-19' }] });
    await Store.importAll(JSON.stringify(pkg));
    if (Store.getSession('iic-s-orphan')) throw new Error('CTRL-1: 孤儿 session 泄漏');
    const hit = Store.getImportQuarantine().find((x) => x.collection === 'sessions' && x.entityId === 'iic-s-orphan');
    if (!hit) throw new Error('CTRL-1: 孤儿 session 未被隔离');
  });

  // CTRL-2: 预先把 client/session 播入旧 cache 后再导入同一合法 run，当前实现会保留该 run，
  //         证明「run 校验读取旧 cache」（缺陷A）：结果依赖旧 cache 内容，而契约要求
  //         结果只依赖导入包自身。与 T1（空 cache 下同一 run 被丢弃）形成对照。
  await test('CTRL-2: 预置旧 cache 后合法 run 被保留（暴露缺陷A：校验依赖旧 cache，对照 T1）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    Store.createClient(F.clone(F.NEW_CLIENT));
    Store.createSession(F.clone(F.NEW_SESSION));
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.LEGAL_RUN] });
    await Store.importAll(JSON.stringify(pkg));
    if (!runIds(Store).includes('iic-run-legal')) throw new Error('CTRL-2: 预置旧 cache 后合法 run 仍未保留（与缺陷A假设不符）');
  });
}

// ============================================================
// T5: material / supervision 引用（Post-fix 覆盖，当前应为绿）。
//     合法 material/supervision 引用必须保留；未知或错配 materialId/supervisionId
//     以及对应 sources 必须进入 clinicalActionRuns quarantine。
// ============================================================
async function runT5() {
  // T5a: 同一导入包内合法 material + supervision 引用 → 合法 run 必须保留。
  await test('T5a: 导入包内合法 material+supervision 引用 → run 必须保留（不进 quarantine）', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({
      clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION, F.NEW_SESSION_B],
      materialWorkspaces: [F.NEW_MATERIAL], supervisions: [F.NEW_SUPERVISION],
      clinicalActionRuns: [F.LEGAL_RUN_MS],
    });
    const result = await Store.importAll(JSON.stringify(pkg));
    if (result.ok !== true) throw new Error('T5a: importAll 应成功 (ok=' + result.ok + ')');
    if (!runIds(Store, { clientId: 'iic-c-001' }).includes('iic-run-ms')) throw new Error('T5a: 合法 material/supervision run 未保留');
    if (quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-ms')) throw new Error('T5a: 合法 run 被误隔离');
  });

  // T5b: 引用未知 materialId → 必须进 quarantine（reason=unknown-or-mismatched-material）。
  await test('T5b: run 引用未知 materialId → 必须进 quarantine', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.RUN_UNKNOWN_MATERIAL] });
    await Store.importAll(JSON.stringify(pkg));
    if (runIds(Store).includes('iic-run-badmaterial')) throw new Error('T5b: 无效 run 泄漏进入权威缓存');
    const hit = quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badmaterial');
    if (!hit) throw new Error('T5b: 引用未知 materialId 的 run 未隔离');
    if (hit.reason !== 'unknown-or-mismatched-material') throw new Error('T5b: reason 应为 unknown-or-mismatched-material，实际 ' + hit.reason);
  });

  // T5c: 引用已知但错配的 materialId（material 绑定另一 session）→ 必须进 quarantine。
  await test('T5c: run 引用错配 materialId（material 绑定其它 session）→ 必须进 quarantine', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({
      clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION, F.NEW_SESSION_B],
      materialWorkspaces: [F.NEW_MATERIAL], clinicalActionRuns: [F.RUN_MISMATCH_MATERIAL],
    });
    await Store.importAll(JSON.stringify(pkg));
    if (runIds(Store).includes('iic-run-mismatchmaterial')) throw new Error('T5c: 错配 material run 泄漏进入权威缓存');
    const hit = quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-mismatchmaterial');
    if (!hit) throw new Error('T5c: 错配 material run 未隔离');
    if (hit.reason !== 'unknown-or-mismatched-material') throw new Error('T5c: reason 应为 unknown-or-mismatched-material，实际 ' + hit.reason);
  });

  // T5d: 引用未知 supervisionId → 必须进 quarantine（reason=unknown-or-mismatched-supervision）。
  await test('T5d: run 引用未知 supervisionId → 必须进 quarantine', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.RUN_UNKNOWN_SUPERVISION] });
    await Store.importAll(JSON.stringify(pkg));
    if (runIds(Store).includes('iic-run-badsupervision')) throw new Error('T5d: 无效 run 泄漏进入权威缓存');
    const hit = quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badsupervision');
    if (!hit) throw new Error('T5d: 引用未知 supervisionId 的 run 未隔离');
    if (hit.reason !== 'unknown-or-mismatched-supervision') throw new Error('T5d: reason 应为 unknown-or-mismatched-supervision，实际 ' + hit.reason);
  });

  // T5e: origin 合法但 sources 引用未知 material → 必须进 quarantine（reason=unknown-or-mismatched-source）。
  await test('T5e: run.sources 引用未知 material → 必须进 quarantine', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.RUN_UNKNOWN_MATERIAL_SOURCE] });
    await Store.importAll(JSON.stringify(pkg));
    if (runIds(Store).includes('iic-run-badmatsource')) throw new Error('T5e: 无效 run 泄漏进入权威缓存');
    const hit = quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badmatsource');
    if (!hit) throw new Error('T5e: sources 引用未知 material 的 run 未隔离');
    if (hit.reason !== 'unknown-or-mismatched-source') throw new Error('T5e: reason 应为 unknown-or-mismatched-source，实际 ' + hit.reason);
  });
}

// ============================================================
// T6: 无法 normalize 的 malformed task/shape → 必须进 quarantine，不得静默丢弃。
// ============================================================
async function runT6() {
  await test('T6: 无法 normalize 的 malformed run（未知 task / 非对象）→ 必须进 quarantine，不得静默丢弃', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({
      clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION],
      clinicalActionRuns: [F.RUN_BAD_TASK, F.RUN_BAD_SHAPE],
    });
    await Store.importAll(JSON.stringify(pkg));
    // 二者都不得进入权威 cache（不得静默保留）。
    if (runIds(Store).includes('iic-run-badtask')) throw new Error('T6: 无法 normalize 的 run 泄漏进入权威缓存');
    // 二者都必须进入 clinicalActionRuns quarantine（不得静默丢弃）。
    const q = quarantineRunHits(Store);
    const byTask = q.find((x) => x.entityId === 'iic-run-badtask');
    if (!byTask) throw new Error('T6: 未知 task 的 malformed run 未隔离（被静默丢弃）');
    if (byTask.reason !== 'invalid-shape-or-task') throw new Error('T6: 未知 task run 的 reason 应为 invalid-shape-or-task，实际 ' + byTask.reason);
    const byShape = q.find((x) => x.reason === 'invalid-shape-or-task' && x.entityId === '');
    if (!byShape) throw new Error('T6: 非对象 malformed run 未隔离（被静默丢弃）');
  });
}

// ============================================================
// T7: 对 normalized 无效 run 断言 quarantine 记录的关键字段
//     entityId / reason / clientId / sessionId / importedAt。
// ============================================================
async function runT7() {
  await test('T7: normalized 无效 run 的 quarantine 记录含 entityId/reason/clientId/sessionId/importedAt', async () => {
    const sb = buildSandbox({});
    const Store = loadStore(sb);
    const pkg = F.buildPackage({
      clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION],
      clinicalActionRuns: [F.RUN_Q_UNKNOWN_CLIENT, F.RUN_Q_UNKNOWN_SESSION, F.RUN_Q_UNKNOWN_MATERIAL, F.RUN_Q_BAD_TASK],
    });
    await Store.importAll(JSON.stringify(pkg));
    const q = quarantineRunHits(Store);
    function hitOf(id) {
      const h = q.find((x) => x.entityId === id);
      if (!h) throw new Error('T7: 缺少 quarantine 记录 entityId=' + id + '（qids=' + q.map((x) => x.entityId) + '）');
      return h;
    }
    function assertShape(h, expReason, expClient, expSession) {
      if (h.reason !== expReason) throw new Error('T7: entityId=' + h.entityId + ' reason 应为 ' + expReason + '，实际 ' + h.reason);
      if (typeof h.clientId !== 'string') throw new Error('T7: entityId=' + h.entityId + ' clientId 非 string');
      if (typeof h.sessionId !== 'string') throw new Error('T7: entityId=' + h.entityId + ' sessionId 非 string');
      if (typeof h.importedAt !== 'string' || h.importedAt.length === 0) throw new Error('T7: entityId=' + h.entityId + ' importedAt 缺失');
      if (expClient !== undefined && h.clientId !== expClient) throw new Error('T7: entityId=' + h.entityId + ' clientId 应为 ' + expClient + '，实际 ' + h.clientId);
      if (expSession !== undefined && h.sessionId !== expSession) throw new Error('T7: entityId=' + h.entityId + ' sessionId 应为 ' + expSession + '，实际 ' + h.sessionId);
    }
    assertShape(hitOf('iic-run-q-uc'), 'unknown-client', 'iic-c-UNKNOWN', '');
    assertShape(hitOf('iic-run-q-us'), 'unknown-or-mismatched-session', 'iic-c-001', 'iic-s-GHOST');
    assertShape(hitOf('iic-run-q-um'), 'unknown-or-mismatched-material', 'iic-c-001', 'iic-s-001');
    assertShape(hitOf('iic-run-q-bt'), 'invalid-shape-or-task', 'iic-c-001', 'iic-s-001');
  });
}

// ============================================================
// 变异敏感（源级）：建立「修复参照实现」为绿基线，再逐一注入两种变异使其转红，
// 证明测试对「继续使用旧 cache」与「静默 filter 丢弃」两种变异敏感。
// 修复参照仅用于变异测试，不用于 T1-T4（T1-T4 执行真实未改 store.js）。
// ============================================================
// 修复参照/变异块：以「针对导入包 next 集合校验 + 无效者隔离」为正确基线，
// 通过注入块完整接管 clinicalActionRuns 字段与 clinicalActionRuns 隔离。
// 不依赖任何旧缺陷整行：唯一稳定锚点为 function prepareImport(data) { 与其函数体出口 return next;
// （经花括号配对精确定位 prepareImport 自身出口，避免命中其它函数）。
const HELPER_SRC = [
  '    function __iicValidateRun(run, cIds, sIds, mIds, svIds) {',
  '      var o = run.origin;',
  '      if (!o.clientId || !run.sources.length) return false;',
  '      if (o.clientId && !cIds.has(o.clientId)) return false;',
  '      if (o.sessionId && !sIds.has(o.sessionId)) return false;',
  '      if (o.materialId && !mIds.has(o.materialId)) return false;',
  '      if (o.supervisionId && !svIds.has(o.supervisionId)) return false;',
  '      return run.sources.every(function (src) {',
  "        if (src.kind === 'client') return cIds.has(src.id);",
  "        if (src.kind === 'session') return sIds.has(src.id);",
  "        if (src.kind === 'material') return mIds.has(src.id);",
  "        if (src.kind === 'supervision') return svIds.has(src.id);",
  "        return src.kind === 'userdocs' && /^retrieval:[A-Za-z0-9_-]+$/.test(src.id);",
  '      });',
  '    }',
].join('\n');

// 在 prepareImport 函数体内注入校验块，完整接管 clinicalActionRuns 字段与其隔离。
// variant: 'corrected'（针对 next 校验+隔离）/ 'mut-cache'（变异：读旧 cache）/ 'mut-drop'（变异：静默丢弃）。
// 无论生产当前含缺陷还是已修复，本函数都生成等价可控的变体源码（不替换任何旧缺陷整行）。
function buildVariantSrc(variant) {
  let keepExpr, quarantineInvalid;
  if (variant === 'mut-cache') {
    keepExpr = 'isValidClinicalActionRun(run)'; // 变异：继续读取旧 cache 判断合法性
    quarantineInvalid = true;
  } else if (variant === 'mut-drop') {
    keepExpr = '__iicValidateRun(run, __iicCIds, __iicSIds, __iicMIds, __iicSvIds)';
    quarantineInvalid = false; // 变异：静默丢弃，不进 quarantine
  } else {
    keepExpr = '__iicValidateRun(run, __iicCIds, __iicSIds, __iicMIds, __iicSvIds)';
    quarantineInvalid = true; // 正确基线：针对 next 校验 + 隔离
  }
  const qLine = quarantineInvalid
    ? "      else __iicQ.push(importQuarantineRecord('clinicalActionRuns', run, 'unknown-reference'));"
    : '      /* mut-drop: 变异点——无效 run 静默丢弃，不进 importQuarantine */';
  const block = [
    '    // == XJ 变异门禁注入块：完整接管 clinicalActionRuns 字段与隔离 ==',
    '    var __iicCIds = new Set(next.clients.map(function (c) { return String(c && c.id || \'\'); }).filter(Boolean));',
    '    var __iicSIds = new Set(next.sessions.map(function (s) { return String(s && s.id || \'\'); }).filter(Boolean));',
    '    var __iicMIds = new Set(next.materialWorkspaces.map(function (m) { return String(m && m.id || \'\'); }).filter(Boolean));',
    '    var __iicSvIds = new Set(next.supervisions.map(function (s) { return String(s && s.id || \'\'); }).filter(Boolean));',
    '    var __iicRuns = Array.isArray(data.clinicalActionRuns) ? data.clinicalActionRuns.map(normalizeClinicalActionRun).filter(Boolean) : [];',
    '    var __iicQ = [];',
    '    next.clinicalActionRuns = [];',
    '    __iicRuns.forEach(function (run) {',
    '      if (' + keepExpr + ') next.clinicalActionRuns.push(run);',
    qLine,
    '    });',
    "    var __iicQBase = (typeof quarantine !== 'undefined') ? quarantine.filter(function (q) { return !(q && q.collection === 'clinicalActionRuns'); }) : [];",
    '    next.importQuarantine = __iicQ.concat(__iicQBase);',
    '    return next;',
  ].join('\n');

  const sig = 'function prepareImport(data) {';
  const sigIdx = STORE_SRC.indexOf(sig);
  if (sigIdx < 0) throw new Error('buildVariantSrc: 找不到 prepareImport 锚点');
  // 1) 注入 helper（仅依赖稳定函数签名锚点，不依赖缺陷整行）。
  let src = STORE_SRC.slice(0, sigIdx) + sig + '\n' + HELPER_SRC + '\n' + STORE_SRC.slice(sigIdx + sig.length);
  // 2) 仅替换 prepareImport 函数体自身的 return next;（花括号配对精确定位其出口）。
  const openBrace = src.indexOf('{', sigIdx);
  let depth = 0, end = -1;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(openBrace, end);
  const retAnchor = 'return next;';
  const retRel = body.lastIndexOf(retAnchor);
  if (retRel < 0) throw new Error('buildVariantSrc: prepareImport 内找不到 return next; 锚点');
  const absRet = openBrace + retRel;
  src = src.slice(0, absRet) + '\n' + block + src.slice(absRet + retAnchor.length);
  return src;
}

async function importLegalAndBad(Store) {
  const pkg = F.buildPackage({ clients: [F.NEW_CLIENT], sessions: [F.NEW_SESSION], clinicalActionRuns: [F.LEGAL_RUN, F.RUN_UNKNOWN_CLIENT] });
  await Store.importAll(JSON.stringify(pkg));
}

async function runMutationSensitivity() {
  // 前置：确认变异门禁注入有效（不依赖旧缺陷整行；无论生产含缺陷或已修复均成立）。
  await test('MUT-PRE: 变异门禁注入有效（corrected/mut-cache/mut-drop 两两不同且均含注入标记、可编译）', async () => {
    const corrected = buildVariantSrc('corrected');
    const mutCache = buildVariantSrc('mut-cache');
    const mutDrop = buildVariantSrc('mut-drop');
    if (corrected.indexOf('__iicValidateRun') < 0) throw new Error('MUT-PRE: corrected 未注入 helper');
    if (mutCache.indexOf('isValidClinicalActionRun(run)') < 0) throw new Error('MUT-PRE: mut-cache 未注入变异');
    if (mutDrop.indexOf('/* mut-drop:') < 0) throw new Error('MUT-PRE: mut-drop 未注入变异');
    // 三个变体必须两两不同（若某替换 no-op 则门禁失效）。
    const uniq = new Set([corrected, mutCache, mutDrop]);
    if (uniq.size !== 3) throw new Error('MUT-PRE: 三个变体未两两不同（注入 no-op，门禁失效）');
    // 均可编译。
    [corrected, mutCache, mutDrop].forEach((s, i) => { try { new vm.Script(s); } catch (e) { throw new Error('MUT-PRE: 变体#' + i + ' 语法错误 ' + e.message); } });
  });

  // 绿基线：修复参照下 T1（合法保留，空 cache）与 T2（无效隔离）应全绿。
  await test('MUT-BASE: 修复参照为绿基线（空 cache 合法 run 保留 + 无效 run 隔离）', async () => {
    const sb = buildSandbox({});
    const Store = loadStoreFrom(buildVariantSrc('corrected'), sb);
    await importLegalAndBad(Store);
    if (!runIds(Store).includes('iic-run-legal')) throw new Error('MUT-BASE: 合法 run 未保留');
    if (runIds(Store).includes('iic-run-badclient')) throw new Error('MUT-BASE: 无效 run 泄漏');
    if (!quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badclient')) throw new Error('MUT-BASE: 无效 run 未隔离');
  });

  // 变异A「继续使用旧 cache」：绿基线上注入该变异后，空 cache 合法 run 必须再次被丢弃 → 检出。
  await test('MUT-CACHE: 对「继续使用旧 cache」变异敏感（合法 run 在空 cache 下被丢弃即检出）', async () => {
    const sb = buildSandbox({});
    const Store = loadStoreFrom(buildVariantSrc('mut-cache'), sb);
    await importLegalAndBad(Store);
    // 变异使校验读旧 cache（空）→ 合法 run 被丢弃。测试检出：断言「应保留」将失败⇒此处反向确认变异被检出。
    if (runIds(Store).includes('iic-run-legal')) throw new Error('MUT-CACHE: 变异未生效（合法 run 仍保留）——补丁可能未命中变异点');
  });

  // 变异B「静默 filter 丢弃」：绿基线上注入该变异后，无效 run 不再进 quarantine → 检出。
  await test('MUT-DROP: 对「静默 filter 丢弃」变异敏感（无效 run 不入 quarantine 即检出）', async () => {
    const sb = buildSandbox({});
    const Store = loadStoreFrom(buildVariantSrc('mut-drop'), sb);
    await importLegalAndBad(Store);
    if (!runIds(Store).includes('iic-run-legal')) throw new Error('MUT-DROP: 合法 run 应保留（该变异只改无效分支）');
    if (quarantineRunHits(Store).find((x) => x.entityId === 'iic-run-badclient')) throw new Error('MUT-DROP: 变异未生效（无效 run 仍进 quarantine）');
  });
}

// ============================================================
(async () => {
  console.log('=== XJ-4.2.1 import-integrity contract (codebuddy, post-fix) ===\n');
  staticTests();
  await runT1();
  await runT2();
  await runT3();
  await runT4();
  await runControls();
  await runT5();
  await runT6();
  await runT7();
  await runMutationSensitivity();

  console.log('----------------------------------------');
  results.forEach((r) => {
    const icon = r.status === 'PASS' ? '[PASS]' : '[FAIL]';
    // PASS 用例不显示 EXPECTED-RED 标签（缺陷已修复时为绿）；仅失败且预期红才标注。
    const tag = (r.expectRed && r.status === 'FAIL') ? ' (EXPECTED-RED)' : (r.expectRed ? ' (regression-watch)' : '');
    console.log(icon + tag + ' ' + r.name);
    if (r.error) console.log('       ' + r.error);
  });
  console.log('----------------------------------------');
  console.log('Passed: ' + passed + ' | Failed: ' + failed);
  console.log('Expected-red 命中: ' + expectedRed.length + ' 项 → ' + JSON.stringify(expectedRed));
  console.log('========================================\n');
  console.log('task_id: XJ-4.2.1-codebuddy-import-integrity-contract');
  console.log('current_store_sha256: ' + STORE_SHA);
  const phase = expectedRed.length > 0 ? 'EXPECTED-RED' : (failed > 0 ? 'CONTRACT-BROKEN' : 'ALL-GREEN');
  console.log('contract_phase: ' + phase);
  console.log('注：不宣称 release-ready；仅验证导入完整性相关不变量。');

  // 退出码语义：存在非预期失败 → CONTRACT-BROKEN(exit 2)；
  // 否则存在预期红项 → EXPECTED-RED(exit 1)；否则全绿 → ALL-GREEN(exit 0)。
  const unexpectedFailures = results.filter((r) => r.status === 'FAIL' && !r.expectRed);
  if (unexpectedFailures.length > 0) {
    console.log('\n[CONTRACT-BROKEN] 存在非预期失败：' + unexpectedFailures.map((r) => r.name).join('; '));
    process.exit(2);
  }
  if (expectedRed.length > 0) {
    console.log('\n[EXPECTED-RED] 契约检出预期红项（' + expectedRed.length + ' 项）：当前生产仍含已知缺陷，驱动修复中。');
    process.exit(1);
  }
  console.log('\n[ALL-GREEN] 契约全绿（生产缺陷已修复，门禁/控制组全绿）。');
  process.exit(0);
})();
