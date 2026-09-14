'use strict';
/*
 * G2-c expected-red 探针：验证 G1 缺口矩阵中 6 项关键缺口在当前生产字节上真实存在。
 * 语义：每个探针断言"期望的已修复行为"。断言失败 = EXPECTED_RED CONFIRMED（缺口真实存在）；
 *       断言通过 = UNEXPECTED GREEN（缺口已不存在，需复查分类）。
 * 宿主：D:/xinjing-electron-ext-5.0.0-goal-20260808（隔离副本）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../../..');
const STORE_PATH = path.join(ROOT, 'app/js/store.js');

/* ---------- vm store harness（复用 durable-clinical-task-session-template-store 模式） ---------- */
function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    key(index) { return Array.from(values.keys())[index] || null; },
    get length() { return values.size; },
  };
}
function createIndexedDB(seed) {
  const records = new Map(Object.entries(seed || {}).map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: (_name, mode) => {
      const pending = [];
      let scheduled = false;
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      function scheduleWrite() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          pending.forEach((op) => {
            if (op.type === 'put') records.set(op.key, JSON.parse(JSON.stringify(op.value)));
            else records.delete(op.key);
          });
          if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
        }, 0);
      }
      tx.objectStore = () => ({
        get(key) {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          setTimeout(() => {
            request.result = records.has(String(key)) ? { key: String(key), value: JSON.parse(JSON.stringify(records.get(String(key)))) } : undefined;
            if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
          }, 0);
          return request;
        },
        getAll() {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          setTimeout(() => {
            request.result = Array.from(records, ([key, value]) => ({ key, value: JSON.parse(JSON.stringify(value)) }));
            if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
          }, 0);
          return request;
        },
        put(record) { pending.push({ type: 'put', key: String(record.key), value: record.value }); if (mode === 'readwrite') scheduleWrite(); return { onsuccess: null, onerror: null }; },
        delete(key) { pending.push({ type: 'delete', key: String(key) }); if (mode === 'readwrite') scheduleWrite(); return { onsuccess: null, onerror: null }; },
      });
      return tx;
    },
  };
  return {
    open() {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        request.result = db;
        if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded({ target: request });
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      }, 0);
      return request;
    },
    read(key) { return JSON.parse(JSON.stringify(records.get(String(key)))); },
  };
}
function loadStore(options) {
  options = options || {};
  const indexedDB = options.indexedDB || createIndexedDB(options.seed);
  const scope = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Set,
    Object, Array, String, Number, Boolean, Error, RegExp, Uint8Array, TextEncoder,
    localStorage: memoryStorage(), indexedDB,
    location: { reload() {} },
    XJEntitlements: { canUse: () => true, featureAllowed: () => true },
    module: { exports: {} },
  };
  scope.window = scope;
  vm.createContext(scope);
  // store.js 依赖 window.ClinicalTaskValidators（纯 IIFE，运行后自动挂到 window）
  const validatorsSource = fs.readFileSync(path.join(ROOT, 'app/js/clinical-task-validators.js'), 'utf8');
  vm.runInContext(validatorsSource, scope, { filename: 'clinical-task-validators.js' });
  if (!scope.window.ClinicalTaskValidators) throw new Error('validators did not attach to window');
  const source = options.storeSource || fs.readFileSync(STORE_PATH, 'utf8');
  vm.runInContext(source + '\n;globalThis.__store = Store;', scope, { filename: STORE_PATH });
  return { Store: scope.__store, indexedDB };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* ---------- 探针 ---------- */
const probes = [];

probes.push({
  id: 'P01_GAP01_delete_semantics',
  name: 'GAP-01 逻辑删除预览(collect some) 与物理删除(deleteClient every) 对跨 client 督导语义一致',
  async run() {
    const { Store } = loadStore();
    await Store.hydrate();
    await Store.createClientDurable({ id: 'client-a', name: 'A' });
    await Store.createClientDurable({ id: 'client-b', name: 'B' });
    await Store.createSessionDurable({ id: 'session-a1', clientId: 'client-a', sessionNumber: 1 });
    await Store.createSessionDurable({ id: 'session-b1', clientId: 'client-b', sessionNumber: 1 });
    // 督导同时关联 client-a 的 session 与 client-b 的 session
    const sv = await Store.saveSupervisionDurable({ id: 'sup-x', clientId: 'client-a', sessionIds: ['session-a1', 'session-b1'], title: 'cross' });
    assert.strictEqual(sv.ok, true, 'supervision durable save must succeed');
    // 逻辑删除预览：删除 client-a 时应纳入该督导
    const preview = Store.previewDeletionImpact({ targetType: 'client', targetId: 'client-a' });
    assert.ok(preview && preview.ok === true, 'previewDeletionImpact must be available');
    const previewValue = preview.value || {};
    const previewIncludesSup = (previewValue.affected && previewValue.affected.supervisions || []).some((s) => s.id === 'sup-x');
    // 物理删除 client-a
    Store.deleteClient('client-a');
    await sleep(5);
    const remainingSup = Store.getSupervisions().filter((s) => s.id === 'sup-x');
    // 期望：预览与物理删除结果一致（要么都删，要么都留）
    assert.strictEqual(previewIncludesSup, remainingSup.length === 0, 'preview/some vs physical/every must agree');
  },
});

probes.push({
  id: 'P02_GAP02_sourceref_persistence',
  name: 'GAP-02 material workspace 的 sourceRef 经 normalize 后保留（不丢）',
  async run() {
    const { Store } = loadStore();
    await Store.hydrate();
    const item = Store.createMaterialWorkspace({
      title: 'mat-src', source: { name: 'a.txt', ext: 'txt', size: 10 },
      clientId: 'c1', sessionId: 's1',
      sourceRef: { id: 'ref-1', sessionId: 's1' },
    });
    assert.ok(item, 'createMaterialWorkspace must return item');
    assert.ok(item.sourceRef && item.sourceRef.id === 'ref-1', 'sourceRef must survive normalize');
  },
});

probes.push({
  id: 'P03_GAP10_stale_persistence_marker',
  name: 'GAP-10 视图模型 PERSISTENCE_STATUS 不再是 EXPECTED_RED',
  async run() {
    const taskVM = require(path.join(ROOT, 'app/js/clinical-task-view-model.js'));
    const templateVM = require(path.join(ROOT, 'app/js/session-template-view-model.js'));
    assert.notStrictEqual(taskVM.PERSISTENCE_STATUS, 'EXPECTED_RED', 'task view-model must not carry EXPECTED_RED');
    assert.notStrictEqual(templateVM.PERSISTENCE_STATUS, 'EXPECTED_RED', 'template view-model must not carry EXPECTED_RED');
  },
});

probes.push({
  id: 'P04_GAP05_typed_feed_adapter',
  name: 'GAP-05 main.js 已具备 typed feed 适配器（update-integrity 生产集成）',
  async run() {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const hasTypedFeed = /typed[\s_-]?feed|feedAuthority|XJ_FEED|updateFeedAdapter/i.test(src);
    assert.ok(hasTypedFeed, 'main.js must contain typed feed adapter integration');
  },
});

probes.push({
  id: 'P05_GAP07_money_fail_closed',
  name: 'GAP-07 官方 money-per-request 在空价格目录下 fail-closed（无价格快照不扣费）',
  async run() {
    // 契约 v3 定义默认 envelope balanceMinor:1000 为初始值（非缺陷）；
    // 关键安全属性是：空价格目录下 quote/reserve/settle 必须 fail-closed 且 envelope 不突变。
    const testFile = path.join(ROOT, 'tests/v5.0.0-production/commercial-empty-catalog-fail-closed.test.js');
    const src = fs.readFileSync(testFile, 'utf8');
    // 探测生产实现：quote 对未知/空目录模型返回 fail，且 reserve 前余额校验存在
    const corePath = path.join(ROOT, 'app/js/commercial-billing-core.js');
    const core = fs.readFileSync(corePath, 'utf8');
    const hasUnknownModelReject = /return fail\('unknown-model'\)/.test(core);
    const hasReserveBalanceGate = /insufficient-balance/.test(core);
    const testCoversEmptyCatalog = /empty map|no fixture model/.test(src);
    assert.ok(hasUnknownModelReject, 'quote must reject unknown/empty-catalog model');
    assert.ok(hasReserveBalanceGate, 'reserve must gate on available balance');
    assert.ok(testCoversEmptyCatalog, 'empty-catalog fail-closed test must exist');
  },
});

probes.push({
  id: 'P06_GAP08_xjsup_runtime_expected_red',
  name: 'GAP-08 受控督导包契约状态不再停留 runtime-expected-red',
  async run() {
    const contractPath = path.join(ROOT, 'docs/agent-coordination/v5.0.0/contracts/v4.4-controlled-supervision-package-v1.md');
    const src = fs.readFileSync(contractPath, 'utf8');
    const stillExpectedRed = /runtime-expected-red|EXPECTED_RED/i.test(src);
    assert.ok(!stillExpectedRed, 'contract must not remain in runtime-expected-red state');
  },
});

/* ---------- runner（验收/回归模式） ----------
 * 修复前：全部缺口 EXPECTED_RED（缺口真实存在）。
 * 修复后：已修复缺口转 UNEXPECTED_GREEN（即 GREEN=已满足）；未修复缺口保持 EXPECTED_RED。
 * 本 runner 输出状态清单并返回各缺口修复状态，供 G3-G7 验收引用。
 */
(async () => {
  let expectedRed = 0;
  let unexpectedGreen = 0;
  const results = [];
  for (const probe of probes) {
    try {
      await probe.run();
      unexpectedGreen += 1;
      results.push(`  [GREEN_FIXED] ${probe.id} ${probe.name}`);
    } catch (err) {
      expectedRed += 1;
      results.push(`  [EXPECTED_RED_OPEN] ${probe.id} ${probe.name} :: ${err.message}`);
    }
  }
  console.log('=== G2-c gap probes (acceptance mode) ===');
  results.forEach((line) => console.log(line));
  console.log(`\nGREEN_FIXED=${unexpectedGreen} EXPECTED_RED_OPEN=${expectedRed} TOTAL=${probes.length}`);
})().catch((err) => { console.error(err); process.exit(2); });
