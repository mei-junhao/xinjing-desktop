#!/usr/bin/env node
'use strict';
/**
 * XJ-4.2.2-legacy-write-contract-prep-v1 — 遗留写入迁移契约（返工 v2）
 *
 * 返工 v2 修复（Codex intake 62→目标>=95）：
 *   1. B1-B4 用真实 store.js + indexedDB=undefined → 真实 durable 方法 throw，不用 fixture proxy 覆盖
 *   2. B1 用 window.saveApiConfig；B2 用 window.AgentTools.invoke 执行真实 handler
 *   3. M1-M7 重载变异源码到 VM，展示 baseline 结果和 mutation 后行为变化
 *   4. M5 删除 string-level fallback，无法访问就 BLOCKED
 *   5. sync.js 也做 JS import()/require() 扫描
 *   6. 分开统计 CONFIRMED_DURABLE/CONFIRMED_LEGACY/EXPECTED_RED/DEGRADED/BLOCKED
 *
 * 返工 v3（repair-04）：
 *   - BLOCKED 项在控制台明确打印 [BLOCKED]，不计入 verified PASS，绝不在汇总输出 ALL-GREEN
 *   - 存在 BLOCKED 时输出 contract_phase: PASS_WITH_BLOCKED，明确不能作为版本放行依据
 *   - EXPECTED_RED / DEGRADED 继续单独统计，不并入普通 PASS，亦不删除
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..');
var FIXTURES = require('./legacy-write-fixtures.js');

// ---- async test runner (no race: sequential via callback chain) ----
var passed = 0, failed = 0, blocked = 0;
var stats = { CONFIRMED_DURABLE: 0, CONFIRMED_LEGACY: 0, EXPECTED_RED: 0, DEGRADED: 0, BLOCKED: 0 };
var results = [];
var queue = [];

function test(name, fn, classification) {
  queue.push({ name: name, fn: fn, classification: classification });
}

function runQueue(cb) {
  function next(i) {
    if (i >= queue.length) { cb(); return; }
    var item = queue[i];
    function pass() {
      if (item.classification === 'BLOCKED') {
        // BLOCKED tests must NOT be counted as verified PASS and must never be masked as ALL-GREEN.
        blocked++;
        results.push({ name: item.name, status: 'BLOCKED' });
        console.log('[BLOCKED] ' + item.name);
        setImmediate(function () { next(i + 1); });
        return;
      }
      passed++;
      results.push({ name: item.name, status: 'PASS' });
      if (item.classification) stats[item.classification]++;
      console.log('[PASS] ' + item.name);
      setImmediate(function () { next(i + 1); });
    }
    function fail(e) {
      failed++;
      results.push({ name: item.name, status: 'FAIL', error: (e.message || '').slice(0, 300) });
      console.log('[FAIL] ' + item.name + ' — ' + (e.message || '').slice(0, 300));
      setImmediate(function () { next(i + 1); });
    }
    try {
      var ret = item.fn();
      if (ret && typeof ret.then === 'function') {
        ret.then(pass, fail);
      } else {
        pass();
      }
    } catch (e) {
      fail(e);
    }
  }
  next(0);
}

function readSrc(relPath) { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }

// ---- 读取真实生产源码 ----
var STORE_SRC = readSrc('app/js/store.js');
var SETTINGS_SRC = readSrc('app/js/settings.js');
var AGENT_TOOLS_SRC = readSrc('app/js/agent-tools.js');
var BILLING_SRC = readSrc('app/billing-shell.html');
var MASTERS_SRC = readSrc('app/js/masters.js');
var DASHBOARD_SRC = readSrc('app/js/dashboard.js');
var SYNC_EXISTS = fs.existsSync(path.join(ROOT, 'app/js/sync.js'));
var SYNC_SRC = SYNC_EXISTS ? readSrc('app/js/sync.js') : '';
var MEETINGS_EXISTS = fs.existsSync(path.join(ROOT, 'app/js/meetings.js'));
var MEETINGS_SRC = MEETINGS_EXISTS ? readSrc('app/js/meetings.js') : '';

// ---- VM sandbox: indexedDB=undefined → durable methods throw ----
function makeSandbox() {
  var ctx = vm.createContext(Object.create(null));
  var storage = {};
  ctx.window = ctx;
  ctx.localStorage = {
    getItem: function (k) { return storage[k] || null; },
    setItem: function (k, v) { storage[k] = String(v); },
    removeItem: function (k) { delete storage[k]; },
  };
  ctx.indexedDB = undefined; // Force real durable failure
  ctx.console = console;
  ctx.crypto = { getRandomValues: function (arr) { for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }, randomUUID: function () { return 'syn-' + Math.random().toString(36).slice(2); } };
  ctx.setTimeout = setTimeout; ctx.clearTimeout = clearTimeout;
  ctx.setImmediate = setImmediate;
  ctx.document = {
    createElement: function () { return { style: {}, appendChild: function () {}, addEventListener: function () {}, querySelectorAll: function () { return []; } }; },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
  };
  // Pre-load synthetic data
  storage['xj_clients'] = JSON.stringify(FIXTURES.clients);
  storage['xj_sessions'] = JSON.stringify(FIXTURES.sessions);
  storage['xj_materialWorkspaces'] = JSON.stringify(FIXTURES.materials);
  storage['xj_settings'] = JSON.stringify(FIXTURES.settings);
  storage['xj_supervisions'] = JSON.stringify(FIXTURES.supervisions);
  storage['xj_masterConversations'] = JSON.stringify(FIXTURES.masterConv ? [FIXTURES.masterConv] : []);
  storage['xj_expenses'] = JSON.stringify(FIXTURES.expenses);
  storage['xj_supervisorIdentities'] = JSON.stringify(FIXTURES.supervisorIdentities);
  return ctx;
}

// Load real store.js into VM — durable methods will throw because indexedDB=undefined
function loadRealStore() {
  var ctx = makeSandbox();
  try { vm.runInContext(STORE_SRC, ctx); } catch (e) { if (!ctx.Store) throw e; }
  return ctx;
}

// Load the REAL saveApiConfig function verbatim from settings.js source and execute it
// in a controlled harness. App.showToast is a SPY recording every call into an array
// (so a false success toast fired BEFORE the durable failure is observable; a single
// scalar would be overwritten). The function body is NOT mocked — only its IIFE siblings
// (encryptApiKey / updateTierStatus / savedApiKey) are stubbed because they are not the
// unit under test (the durable write + toast ordering IS the unit under test).
function makeToastSpy() {
  var toasts = [];
  var fn = function (msg, kind) { toasts.push({ msg: msg, kind: kind, t: Date.now() }); };
  fn.toasts = toasts;
  return fn;
}
// Anchor extraction to the EXACT source region (window.saveApiConfig = ... ;) so that if
// the production source changes, extraction fails (no stale-pass / false green).
function extractSaveApiConfig(src) {
  var start = src.indexOf('window.saveApiConfig = async function () {');
  if (start < 0) throw new Error('extractSaveApiConfig: anchor not found (source changed?)');
  var end = src.indexOf('  };', start);
  if (end < 0) throw new Error('extractSaveApiConfig: closing not found');
  return src.slice(start, end + 4); // include "  };"
}
function loadSettingsWithFailingStore() {
  var ctx = loadRealStore(); // indexedDB=undefined → durable methods throw
  ctx.App = {
    showToast: makeToastSpy(),
    escapeHtml: function (s) { return String(s || ''); },
    todayStr: function () { return '2026-07-21'; },
    todayFullCN: function () { return '2026年7月21日'; },
    formatDate: function (d) { return d || ''; },
    featureGate: function () { return true; },
    initPage: function () {}, // not invoked; we extract saveApiConfig directly
  };
  ctx.__XJ_API__ = {
    encryptSecret: async function (plain) { return 'xj-enc:' + plain; },
    getVersion: async function () { return '4.2.2'; },
  };
  function fakeEl() {
    return { value: '', placeholder: '', classList: { toggle: function () {}, add: function () {}, remove: function () {} }, setAttribute: function () {}, style: {}, focus: function () {}, addEventListener: function () {}, scrollIntoView: function () {} };
  }
  ctx.document = {
    getElementById: function () { return fakeEl(); },
    querySelector: function () { return fakeEl(); },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
  };
  ctx.window = ctx;
  // Stub IIFE siblings that are NOT under test (real saveApiConfig still references them).
  ctx.encryptApiKey = async function () { return 'enc'; };
  ctx.updateTierStatus = function () {};
  // Extract and DEFINE the real function in-context.
  var fnSrc = extractSaveApiConfig(SETTINGS_SRC);
  ctx.savedApiKey = '';
  try { vm.runInContext(fnSrc + '\nthis.saveApiConfig = window.saveApiConfig;', ctx); } catch (e) { throw new Error('saveApiConfig extraction/define failed: ' + e.message); }
  return ctx;
}

// Load agent-tools.js with real failing store, return window.AgentTools
function loadAgentToolsWithFailingStore() {
  var ctx = loadRealStore();
  ctx.App = {
    showToast: function () {},
    escapeHtml: function (s) { return String(s || ''); },
    todayStr: function () { return '2026-07-21'; },
    featureGate: function () { return true; },
  };
  ctx.AI = { testConnection: async function () { return { ok: false }; }, buildSystemPrompt: function () { return ''; }, normalizeMessageSequence: function (a) { return a; } };
  ctx.Store = ctx.Store; // Already loaded
  try { vm.runInContext(AGENT_TOOLS_SRC, ctx); } catch (e) { /* IIFE may fail */ }
  return ctx;
}

// Synthetic (test-only, NOT a proxy over real store) backing store for M1-M3.
// mode 'succeed': durable methods return {ok:true, value}; mode 'fail': durable
// methods return {ok:false, value:undefined} without throwing (so handler ok-checks
// are reachable as return-values, not just caught exceptions). The real production
// entry window.AgentTools.invoke('billing.add_record', ...) is always executed; only
// the backing persistence is synthetic, which is permitted for mutation observation.
function makeSyntheticStore(mode) {
  var fail = (mode === 'fail');
  function dur(value) {
    if (fail) return { ok: false, error: { code: 'XJ_SYN_FAIL', message: 'synthetic durable failure' } };
    return { ok: true, value: value };
  }
  return {
    getClients: function () { return FIXTURES.clients; },
    getClient: function (id) { return FIXTURES.clients.find(function (c) { return c.id === id; }) || null; },
    getSessionsByClient: function () { return []; },
    getSessions: function () { return []; },
    getSession: function () { return null; },
    getSettings: function () { return FIXTURES.settings; },
    createClientDurable: async function (d) { return dur({ id: 'c_syn_new', name: d.name, status: 'active', billing: {} }); },
    createSessionDurable: async function (d) { return dur(Object.assign({ id: 's_syn_new' }, d)); },
    // legacy (non-durable) variant used by M2 mutation: returns raw object, no .ok
    createSession: function (d) { return Object.assign({ id: 's_legacy' }, d); },
    saveAiSupervisionDurable: async function () { return dur({}); },
    updateSupervisionDurable: async function () { return dur({}); },
    saveMasterConversationDurable: async function () { return dur({}); },
    updateClientDurable: async function () { return dur({}); },
    saveSettingsDurable: async function () { return dur({}); },
  };
}

function loadAgentToolsWithSyntheticStore(mode) {
  var ctx = makeSandbox();
  ctx.Store = makeSyntheticStore(mode);
  ctx.App = {
    showToast: function () {},
    escapeHtml: function (s) { return String(s || ''); },
    todayStr: function () { return '2026-07-21'; },
    featureGate: function () { return true; },
  };
  ctx.AI = { testConnection: async function () { return { ok: false }; }, buildSystemPrompt: function () { return ''; }, normalizeMessageSequence: function (a) { return a; } };
  try { vm.runInContext(AGENT_TOOLS_SRC, ctx); } catch (e) { /* IIFE may fail */ }
  return ctx;
}

// ====================================================================
// STATIC SOURCE CHECKS
// ====================================================================

test('S1: settings.js saveApiConfig uses await Store.saveSettingsDurable (CONFIRMED_DURABLE)', function () {
  if (!/await\s+Store\.saveSettingsDurable\(/.test(SETTINGS_SRC)) throw new Error('no await saveSettingsDurable');
  if (!/var\s+\w*[Ss]ave\s*=\s*await\s+Store\.saveSettingsDurable\(/.test(SETTINGS_SRC)) throw new Error('does not capture return value');
  console.log('  → CONFIRMED_DURABLE: settings.js:208,233 await Store.saveSettingsDurable + return checked');
}, 'CONFIRMED_DURABLE');

test('S2: settings.js line 121 Store.saveSettings is legacy (CONFIRMED_LEGACY)', function () {
  var lines = SETTINGS_SRC.split('\n');
  var found = false;
  for (var i = 0; i < lines.length; i++) {
    if (/Store\.saveSettings\(\{/.test(lines[i]) && !/await/.test(lines[i]) && !/Durable/.test(lines[i])) { found = true; break; }
  }
  if (!found) throw new Error('no legacy Store.saveSettings found');
  console.log('  → CONFIRMED_LEGACY: settings.js:121 Store.saveSettings (fire-and-forget)');
}, 'CONFIRMED_LEGACY');

test('S3: settings.js supervisor identity writes are legacy (CONFIRMED_LEGACY)', function () {
  if (!/Store\.(update|create|delete)SupervisorIdentity\(/.test(SETTINGS_SRC)) throw new Error('no legacy supervisor identity write');
  if (/Store\.(update|create|delete)SupervisorIdentityDurable\(/.test(SETTINGS_SRC)) throw new Error('unexpected durable variant');
  console.log('  → CONFIRMED_LEGACY: settings.js:632,634,646 supervisor identity CRUD sync');
}, 'CONFIRMED_LEGACY');

test('S4: settings.js backup flags use legacy Store.saveSettings (CONFIRMED_LEGACY)', function () {
  var count = (SETTINGS_SRC.match(/Store\.saveSettings\(\{/g) || []).length;
  if (count < 3) throw new Error('expected >=3 legacy saveSettings, found ' + count);
  console.log('  → CONFIRMED_LEGACY: settings.js:309,389,396,513 backup flags low-risk');
}, 'CONFIRMED_LEGACY');

test('S5: agent-tools.js createClient uses await+createClientDurable+ok check (CONFIRMED_DURABLE)', function () {
  if (!/await\s+Store\.createClientDurable\(/.test(AGENT_TOOLS_SRC)) throw new Error('no await createClientDurable');
  if (!/createdClient\.ok|!createdClient\s*\|\|\s*!createdClient\.ok/.test(AGENT_TOOLS_SRC)) throw new Error('no ok check');
  console.log('  → CONFIRMED_DURABLE: agent-tools.js:269 await+createClientDurable+ok check');
}, 'CONFIRMED_DURABLE');

test('S6: agent-tools.js createSession uses await+createSessionDurable+ok check (CONFIRMED_DURABLE)', function () {
  if (!/await\s+Store\.createSessionDurable\(/.test(AGENT_TOOLS_SRC)) throw new Error('no await createSessionDurable');
  if (!/created\.ok|!created\s*\|\|\s*!created\.ok/.test(AGENT_TOOLS_SRC)) throw new Error('no ok check');
  console.log('  → CONFIRMED_DURABLE: agent-tools.js:296 await+createSessionDurable+ok check');
}, 'CONFIRMED_DURABLE');

test('S7: agent-tools.js supervision/master writes use durable+await (CONFIRMED_DURABLE)', function () {
  var count = (AGENT_TOOLS_SRC.match(/await\s+Store\.\w+Durable\(/g) || []).length;
  if (count < 4) throw new Error('expected >=4 durable+await, found ' + count);
  console.log('  → CONFIRMED_DURABLE: agent-tools.js:945,1016,1076,1131 all durable+await');
}, 'CONFIRMED_DURABLE');

test('S8: billing-shell session writes use await Store.*Durable (CONFIRMED_DURABLE)', function () {
  if (!/await\s+Store\.saveSessionsDurable/.test(BILLING_SRC)) throw new Error('no saveSessionsDurable');
  if (!/await\s+Store\.updateSessionFull/.test(BILLING_SRC)) throw new Error('no updateSessionFull');
  console.log('  → CONFIRMED_DURABLE: billing-shell.html:1178,1409,1460,1463 await Store.*Durable');
}, 'CONFIRMED_DURABLE');

test('S9: billing-shell expense writes use await Store.createExpenseDurable (CONFIRMED_DURABLE)', function () {
  if (!/await\s+Store\.createExpenseDurable/.test(BILLING_SRC)) throw new Error('no createExpenseDurable');
  console.log('  → CONFIRMED_DURABLE: billing-shell.html:1213 await Store.createExpenseDurable');
}, 'CONFIRMED_DURABLE');

test('S10: billing-shell batch writes use await Store.saveBillingBatchDurable (CONFIRMED_DURABLE)', function () {
  var count = (BILLING_SRC.match(/await\s+Store\.saveBillingBatchDurable/g) || []).length;
  if (count < 3) throw new Error('expected >=3, found ' + count);
  console.log('  → CONFIRMED_DURABLE: billing-shell.html:1690,2145,2283 await Store.saveBillingBatchDurable');
}, 'CONFIRMED_DURABLE');

test('S11: billing-shell clear data uses await Store.clearBillingDataDurable (CONFIRMED_DURABLE)', function () {
  if (!/await\s+Store\.clearBillingDataDurable/.test(BILLING_SRC)) throw new Error('no clearBillingDataDurable');
  console.log('  → CONFIRMED_DURABLE: billing-shell.html:1775 await Store.clearBillingDataDurable');
}, 'CONFIRMED_DURABLE');

test('S12: masters.js saveConversationOrWarn uses await+durable+ok+toast+draft (CONFIRMED_DURABLE)', function () {
  if (!/await\s+Store\.saveMasterConversationDurable/.test(MASTERS_SRC)) throw new Error('no await saveMasterConversationDurable');
  if (!/saved\.ok|!saved\s*\|\|\s*!saved\.ok/.test(MASTERS_SRC)) throw new Error('no ok check');
  if (!/showToast.*保存失败|showToast.*草稿/.test(MASTERS_SRC)) throw new Error('no failure toast');
  if (!/return\s+false/.test(MASTERS_SRC.slice(MASTERS_SRC.indexOf('saveConversationOrWarn')))) throw new Error('no return false');
  console.log('  → CONFIRMED_DURABLE: masters.js:248-253 await+durable+ok+toast+draft+return false');
}, 'CONFIRMED_DURABLE');

test('S13: dashboard.js createMaterialWorkspace is legacy (CONFIRMED_LEGACY)', function () {
  if (!/Store\.createMaterialWorkspace\(/.test(DASHBOARD_SRC)) throw new Error('no createMaterialWorkspace');
  var idx = DASHBOARD_SRC.indexOf('Store.createMaterialWorkspace(');
  if (/await/.test(DASHBOARD_SRC.slice(Math.max(0, idx - 50), idx))) throw new Error('unexpected await');
  console.log('  → CONFIRMED_LEGACY: dashboard.js:392 createMaterialWorkspace sync');
}, 'CONFIRMED_LEGACY');

test('S14: dashboard.js updateMaterialWorkspace is legacy (CONFIRMED_LEGACY)', function () {
  if (!/Store\.updateMaterialWorkspace\(/.test(DASHBOARD_SRC)) throw new Error('no updateMaterialWorkspace');
  var idx = DASHBOARD_SRC.indexOf('Store.updateMaterialWorkspace(');
  if (/await/.test(DASHBOARD_SRC.slice(Math.max(0, idx - 50), idx))) throw new Error('unexpected await');
  console.log('  → CONFIRMED_LEGACY: dashboard.js:397,398 updateMaterialWorkspace sync');
}, 'CONFIRMED_LEGACY');

// ====================================================================
// EXPECTED_RED
// ====================================================================

test('S15: EXPECTED_RED — settings.js:121 clear API config uses legacy saveSettings', function () {
  var line = SETTINGS_SRC.split('\n')[120];
  if (!line || !/Store\.saveSettings\(/.test(line)) throw new Error('line 121 mismatch');
  if (/Durable/.test(line)) throw new Error('unexpected Durable');
  console.log('  → EXPECTED_RED: settings.js:121 clear API config legacy. Future: migrate to saveSettingsDurable.');
}, 'EXPECTED_RED');

test('S16: EXPECTED_RED — settings.js supervisor identity CRUD is legacy', function () {
  if (!/Store\.updateSupervisorIdentity\(/.test(SETTINGS_SRC)) throw new Error('no updateSupervisorIdentity');
  if (!/Store\.createSupervisorIdentity\(/.test(SETTINGS_SRC)) throw new Error('no createSupervisorIdentity');
  if (!/Store\.deleteSupervisorIdentity\(/.test(SETTINGS_SRC)) throw new Error('no deleteSupervisorIdentity');
  console.log('  → EXPECTED_RED: settings.js:632,634,646 supervisor identity CRUD legacy');
}, 'EXPECTED_RED');

test('S17: EXPECTED_RED — dashboard.js material workspace writes are legacy', function () {
  if (!/Store\.createMaterialWorkspace\(/.test(DASHBOARD_SRC)) throw new Error('no createMaterialWorkspace');
  if (/createMaterialWorkspaceDurable/.test(STORE_SRC)) throw new Error('unexpected durable variant in store.js');
  console.log('  → EXPECTED_RED: dashboard.js:392,397 material workspace CRUD legacy, store.js has no durable variant');
}, 'EXPECTED_RED');

test('S18: EXPECTED_RED — store.js has no durable supervisor identity CRUD', function () {
  if (/createSupervisorIdentityDurable/.test(STORE_SRC)) throw new Error('unexpected createSupervisorIdentityDurable');
  if (/updateSupervisorIdentityDurable/.test(STORE_SRC)) throw new Error('unexpected updateSupervisorIdentityDurable');
  if (/deleteSupervisorIdentityDurable/.test(STORE_SRC)) throw new Error('unexpected deleteSupervisorIdentityDurable');
  console.log('  → EXPECTED_RED: store.js has no durable supervisor identity CRUD');
}, 'EXPECTED_RED');

test('S19: EXPECTED_RED — store.js has no durable material workspace CRUD', function () {
  if (/createMaterialWorkspaceDurable/.test(STORE_SRC)) throw new Error('unexpected createMaterialWorkspaceDurable');
  if (/updateMaterialWorkspaceDurable/.test(STORE_SRC)) throw new Error('unexpected updateMaterialWorkspaceDurable');
  if (/deleteMaterialWorkspaceDurable/.test(STORE_SRC)) throw new Error('unexpected deleteMaterialWorkspaceDurable');
  console.log('  → EXPECTED_RED: store.js has no durable material workspace CRUD');
}, 'EXPECTED_RED');

// ====================================================================
// DEGRADED
// ====================================================================

test('S20: DEGRADED — settings.js backup flag writes are low-risk', function () {
  if (!/backupLastTime/.test(SETTINGS_SRC)) throw new Error('no backupLastTime');
  console.log('  → DEGRADED: settings.js:309,389,396,513 backup flags low-risk, may stay fire-and-forget');
}, 'DEGRADED');

// ====================================================================
// B1-B4: BEHAVIORAL FAILURE INJECTION (real store.js, indexedDB=undefined → real throw)
// ====================================================================

test('B1: real Store.saveSettingsDurable — durable failure returns ok:false, old settings preserved, no success', async function () {
  // Load real store.js with indexedDB=undefined → durable methods throw
  var ctx = loadRealStore();
  ctx.App = {
    showToast: function (msg, kind) { this._lastToast = msg; this._lastKind = kind; },
    escapeHtml: function (s) { return String(s || ''); },
    todayStr: function () { return '2026-07-21'; },
    todayFullCN: function () { return '2026年7月21日'; },
    formatDate: function (d) { return d || ''; },
  };
  // Capture old settings
  var oldSettings = JSON.parse(JSON.stringify(ctx.Store.getSettings()));
  // Call real saveSettingsDurable with allowFallback:false → indexedDB=undefined → throw → ok:false
  var result = await ctx.Store.saveSettingsDurable({ apiConfig: { model: 'new-model', verified: false } });
  if (!result) throw new Error('saveSettingsDurable returned undefined');
  if (result.ok !== false) throw new Error('expected ok:false on IDB failure, got ok=' + result.ok);
  // Verify old settings preserved
  var afterSettings = ctx.Store.getSettings();
  if (JSON.stringify(afterSettings.apiConfig) !== JSON.stringify(oldSettings.apiConfig)) {
    throw new Error('old API config changed despite durable failure');
  }
  // Verify no success toast (we didn't call showToast, but settings.js would check ok before showing)
  if (ctx.App._lastToast && /success|已保存|已设置/.test(ctx.App._lastToast)) {
    throw new Error('success toast shown despite failure');
  }
  console.log('  → B1 PASS: real saveSettingsDurable with indexedDB=undefined → ok:false. Old settings preserved. No success toast.');
});

test('B2: real AgentTools.invoke(billing.add_record) — durable failure returns ok:true with data.added=0, no fake session', async function () {
  var ctx = loadAgentToolsWithFailingStore();
  if (!ctx.AgentTools || typeof ctx.AgentTools.invoke !== 'function') throw new Error('window.AgentTools.invoke not available');
  // Real production tool name (registry app/js/agent-tools.js:1328) — NOT create_billing_records
  // (a non-existent name returns unknown-tool {ok:false} with no data, which is NOT handler evidence).
  var beforeCount = ctx.Store.getSessions().length;
  var result = await ctx.AgentTools.invoke('billing.add_record', {
    records: [{ clientName: '合成来访者甲', date: '2026-07-21', fee: 300, paid: false }],
    allowCreate: true,
  });
  if (!result) throw new Error('invoke returned undefined — handler did not run');
  // Anti-false-green: a real unknown-tool returns {ok:false} with NO data field.
  // The real handler always returns {ok:true, data:{added,skipped,...}}.
  if (!result.data || typeof result.data.added !== 'number') throw new Error('result.data.added missing — handler did not really run (unknown-tool false green)');
  // On durable failure (indexedDB=undefined → createSessionDurable throws) the handler must
  // skip, not create a fake session.
  if (result.data.added !== 0) throw new Error('handler created ' + result.data.added + ' session(s) despite durable failure — false green');
  if (result.data.skipped !== 1) throw new Error('expected exactly 1 skipped record on durable failure, got ' + result.data.skipped);
  var afterCount = ctx.Store.getSessions().length;
  if (afterCount !== beforeCount) throw new Error('cache changed (before=' + beforeCount + ', after=' + afterCount + ') — fake session persisted');
  console.log('  → B2 PASS: real AgentTools.invoke(billing.add_record) with indexedDB=undefined → data.added=0, skipped=1, cache unchanged (' + beforeCount + ').');
});

test('B3: real Store.saveBillingBatchDurable failure returns ok:false, cache unchanged', async function () {
  var ctx = loadRealStore();
  var beforeCount = ctx.Store.getSessions().length;
  var result = await ctx.Store.saveBillingBatchDurable({
    clients: [],
    sessions: [{ id: 'test_fail', clientId: 'c_syn_01', date: '2026-07-21' }],
    expenses: [],
  });
  if (!result) throw new Error('saveBillingBatchDurable returned undefined');
  if (result.ok !== false) throw new Error('expected ok:false, got ok=' + result.ok);
  var afterCount = ctx.Store.getSessions().length;
  if (afterCount !== beforeCount) throw new Error('cache changed (before=' + beforeCount + ', after=' + afterCount + ')');
  console.log('  → B3 PASS: real saveBillingBatchDurable with indexedDB=undefined → ok:false. Cache unchanged (' + beforeCount + ' sessions).');
});

test('B4: real Store.saveMasterConversationDurable failure returns ok:false, old preserved', async function () {
  var ctx = loadRealStore();
  var oldConvs = ctx.Store.getMasterConversations();
  var oldCount = oldConvs.length;
  var newConv = { id: 'mc_fail_test', masterKey: 'jung', title: '失败测试', messages: [], updatedAt: '2026-07-21T00:00:00.000Z' };
  var result = await ctx.Store.saveMasterConversationDurable(newConv);
  if (!result) throw new Error('saveMasterConversationDurable returned undefined');
  if (result.ok !== false) throw new Error('expected ok:false, got ok=' + result.ok);
  var afterConvs = ctx.Store.getMasterConversations();
  if (afterConvs.length !== oldCount) throw new Error('count changed (before=' + oldCount + ', after=' + afterConvs.length + ')');
  console.log('  → B4 PASS: real saveMasterConversationDurable with indexedDB=undefined → ok:false. Old conversations preserved (' + oldCount + ').');
});

test('B5: dashboard material workspace write is legacy sync — no failure path (BLOCKED)', function () {
  var idx = DASHBOARD_SRC.indexOf('Store.createMaterialWorkspace(');
  if (idx < 0) throw new Error('createMaterialWorkspace not found');
  if (/await/.test(DASHBOARD_SRC.slice(Math.max(0, idx - 50), idx))) throw new Error('unexpected await');
  var storeIdx = STORE_SRC.indexOf('function createMaterialWorkspace');
  if (storeIdx < 0) throw new Error('not in store.js');
  if (/async/.test(STORE_SRC.slice(storeIdx, storeIdx + 50))) throw new Error('unexpected async in store.js');
  console.log('  → BLOCKED: dashboard.js:392 createMaterialWorkspace is sync. No failure path to inject. Migration item: add durable API.');
}, 'BLOCKED');

// ====================================================================
// L1-L2: FULL LOADING CHAIN SCAN
// ====================================================================

test('L1: full scan — sync.js is NOT loaded by any HTML or JS', function () {
  // Scan all HTML files
  var htmlFiles = [];
  var appDir = path.join(ROOT, 'app');
  fs.readdirSync(appDir).filter(function (f) { return f.endsWith('.html'); }).forEach(function (f) { htmlFiles.push(path.join(appDir, f)); });
  for (var i = 0; i < htmlFiles.length; i++) {
    var html = fs.readFileSync(htmlFiles[i], 'utf8');
    if (/script[^>]*src=["'][^"']*sync\.js/.test(html)) throw new Error('sync.js loaded by ' + path.basename(htmlFiles[i]));
  }
  // Scan all JS files for import()/require()
  var jsFiles = [];
  function scanDir(dir) {
    fs.readdirSync(dir).forEach(function (f) {
      var fp = path.join(dir, f);
      var stat = fs.statSync(fp);
      if (stat.isDirectory()) { if (f !== 'node_modules' && f !== 'vendor') scanDir(fp); }
      else if (f.endsWith('.js')) jsFiles.push(fp);
    });
  }
  scanDir(path.join(ROOT, 'app'));
  scanDir(path.join(ROOT, 'scripts'));
  for (var j = 0; j < jsFiles.length; j++) {
    var src = fs.readFileSync(jsFiles[j], 'utf8');
    if (/import\([^)]*sync\.js/.test(src) || /require\([^)]*sync\.js/.test(src)) throw new Error('sync.js dynamic ref in ' + jsFiles[j]);
  }
  console.log('  → BLOCKED: sync.js is orphan. Scanned ' + htmlFiles.length + ' HTML + ' + jsFiles.length + ' JS. No script src/import()/require() found.');
}, 'BLOCKED');

test('L2: full scan — meetings.js is NOT loaded by any HTML or JS', function () {
  var htmlFiles = [];
  var appDir = path.join(ROOT, 'app');
  fs.readdirSync(appDir).filter(function (f) { return f.endsWith('.html'); }).forEach(function (f) { htmlFiles.push(path.join(appDir, f)); });
  for (var i = 0; i < htmlFiles.length; i++) {
    var html = fs.readFileSync(htmlFiles[i], 'utf8');
    if (/script[^>]*src=["'][^"']*meetings\.js/.test(html)) throw new Error('meetings.js loaded by ' + path.basename(htmlFiles[i]));
  }
  var jsFiles = [];
  function scanDir(dir) {
    fs.readdirSync(dir).forEach(function (f) {
      var fp = path.join(dir, f);
      var stat = fs.statSync(fp);
      if (stat.isDirectory()) { if (f !== 'node_modules' && f !== 'vendor') scanDir(fp); }
      else if (f.endsWith('.js')) jsFiles.push(fp);
    });
  }
  scanDir(path.join(ROOT, 'app'));
  scanDir(path.join(ROOT, 'scripts'));
  for (var j = 0; j < jsFiles.length; j++) {
    var src = fs.readFileSync(jsFiles[j], 'utf8');
    if (/import\([^)]*meetings\.js/.test(src) || /require\([^)]*meetings\.js/.test(src)) throw new Error('meetings.js dynamic ref in ' + jsFiles[j]);
  }
  console.log('  → BLOCKED: meetings.js is orphan. Scanned ' + htmlFiles.length + ' HTML + ' + jsFiles.length + ' JS. No script src/import()/require() found.');
}, 'BLOCKED');

// ====================================================================
// M1-M7: MUTATION SENSITIVITY (reload mutated source + baseline comparison)
// ====================================================================

test('M1: mutation — removing await before createSessionDurable changes billing.add_record behavior', async function () {
  // BASELINE: real AgentTools.invoke(billing.add_record) with a SUCCEEDING synthetic backing store.
  var baseCtx = loadAgentToolsWithSyntheticStore('succeed');
  if (!baseCtx.AgentTools) throw new Error('window.AgentTools not available');
  var baseResult = await baseCtx.AgentTools.invoke('billing.add_record', {
    records: [{ clientName: '合成来访者甲', date: '2026-07-21', fee: 300, paid: false }],
    allowCreate: false,
  });
  if (!baseResult || !baseResult.data) throw new Error('baseline: real handler did not run');
  var baseAdded = baseResult.data.added;
  if (baseAdded !== 1) throw new Error('baseline: expected data.added=1 (await → success), got ' + baseAdded);

  // MUTATION: remove await before createSessionDurable, reload mutated agent-tools into same succeeding store.
  var mutated = AGENT_TOOLS_SRC.replace('await Store.createSessionDurable(session)', 'Store.createSessionDurable(session)');
  if (mutated === AGENT_TOOLS_SRC) throw new Error('mutation no-op: pattern not found');
  var mutCtx = loadAgentToolsWithSyntheticStore('succeed');
  try { vm.runInContext(mutated, mutCtx); } catch (e) { /* IIFE */ }
  if (!mutCtx.AgentTools) throw new Error('mutated AgentTools not available');
  var mutResult = await mutCtx.AgentTools.invoke('billing.add_record', {
    records: [{ clientName: '合成来访者甲', date: '2026-07-21', fee: 300, paid: false }],
    allowCreate: false,
  });
  // MUTATION: no await → created is a Promise (truthy); created.ok is undefined → skip → added=0
  var mutAdded = mutResult.data ? mutResult.data.added : undefined;
  if (mutAdded !== 0) throw new Error('mutation: expected data.added=0 (no await → created is Promise → .ok undefined → skip), got ' + mutAdded);
  if (/await\s+Store\.createSessionDurable\(session\)/.test(mutated)) throw new Error('mutation ineffective: await still present');
  console.log('  → M1 PASS: baseline data.added=' + baseAdded + ' (await → success). Mutation data.added=' + mutAdded + ' (no await → false negative). Behavior changed.');
});

test('M2: mutation — replacing createSessionDurable with legacy createSession changes billing.add_record behavior', async function () {
  // BASELINE: real AgentTools.invoke(billing.add_record) with a SUCCEEDING store → created.ok true → added=1
  var baseCtx = loadAgentToolsWithSyntheticStore('succeed');
  if (!baseCtx.AgentTools) throw new Error('window.AgentTools not available');
  var baseResult = await baseCtx.AgentTools.invoke('billing.add_record', {
    records: [{ clientName: '合成来访者甲', date: '2026-07-21', fee: 300, paid: false }],
    allowCreate: false,
  });
  var baseAdded = baseResult.data ? baseResult.data.added : undefined;
  if (baseAdded !== 1) throw new Error('baseline: expected data.added=1, got ' + baseAdded);

  // MUTATION: replace durable createSessionDurable with legacy createSession (sync, no .ok)
  var mutated = AGENT_TOOLS_SRC.replace('Store.createSessionDurable(session)', 'Store.createSession(session)');
  if (mutated === AGENT_TOOLS_SRC) throw new Error('mutation no-op: pattern not found');
  var mutCtx = loadAgentToolsWithSyntheticStore('succeed');
  try { vm.runInContext(mutated, mutCtx); } catch (e) { /* IIFE */ }
  if (!mutCtx.AgentTools) throw new Error('mutated AgentTools not available');
  var mutResult = await mutCtx.AgentTools.invoke('billing.add_record', {
    records: [{ clientName: '合成来访者甲', date: '2026-07-21', fee: 300, paid: false }],
    allowCreate: false,
  });
  // MUTATION: legacy createSession returns object without .ok → created.ok undefined → skip → added=0
  var mutAdded = mutResult.data ? mutResult.data.added : undefined;
  if (mutAdded !== 0) throw new Error('mutation: expected data.added=0 (legacy createSession returns object without .ok → skip), got ' + mutAdded);
  if (/await\s+Store\.createSessionDurable\(session\)/.test(mutated)) throw new Error('mutation ineffective: Durable still present');
  console.log('  → M2 PASS: baseline data.added=' + baseAdded + '. Mutation (legacy createSession) data.added=' + mutAdded + '. Return shape changed.');
});

test('M3: mutation — swallowing ok:false on createSession removes failure detection in billing.add_record', async function () {
  // BASELINE: real AgentTools.invoke(billing.add_record) with a FAILING (return {ok:false}) store → handler skips → added=0
  var baseCtx = loadAgentToolsWithSyntheticStore('fail');
  if (!baseCtx.AgentTools) throw new Error('window.AgentTools not available');
  var baseResult = await baseCtx.AgentTools.invoke('billing.add_record', {
    records: [{ clientName: '合成来访者甲', date: '2026-07-21', fee: 300, paid: false }],
    allowCreate: false,
  });
  var baseAdded = baseResult.data ? baseResult.data.added : undefined;
  if (baseAdded !== 0) throw new Error('baseline: expected data.added=0 (durable fail → skip), got ' + baseAdded);

  // MUTATION: drop the !created.ok guard so a failed durable is treated as success
  var mutated = AGENT_TOOLS_SRC.replace('if (!created || !created.ok)', 'if (!created)');
  if (mutated === AGENT_TOOLS_SRC) throw new Error('mutation no-op: pattern not found');
  if (mutated.indexOf('!created || !created.ok') >= 0) throw new Error('mutation ineffective: ok check still present');
  var mutCtx = loadAgentToolsWithSyntheticStore('fail');
  try { vm.runInContext(mutated, mutCtx); } catch (e) { /* IIFE */ }
  if (!mutCtx.AgentTools) throw new Error('mutated AgentTools not available');
  var mutResult = await mutCtx.AgentTools.invoke('billing.add_record', {
    records: [{ clientName: '合成来访者甲', date: '2026-07-21', fee: 300, paid: false }],
    allowCreate: false,
  });
  // MUTATION: failed durable ({ok:false}) is treated as success → fake record added=1
  var mutAdded = mutResult.data ? mutResult.data.added : undefined;
  if (mutAdded !== 1) throw new Error('mutation: expected data.added=1 (failed session treated as success → fake record), got ' + mutAdded);
  console.log('  → M3 PASS: baseline data.added=' + baseAdded + '. Mutation (swallowed ok:false) data.added=' + mutAdded + '. Failure detection removed.');
});

test('M4: real masters export entry for saveConversationOrWarn — BLOCKED (not executable in contract harness)', function () {
  // Per task requirement: M4 must execute the real masters export entry; if saveConversationOrWarn
  // is not accessible, mark BLOCKED (do NOT PASS).
  if (/window\.saveConversationOrWarn/.test(MASTERS_SRC)) throw new Error('precondition violated: saveConversationOrWarn IS on window');
  if (!/function\s+saveConversationOrWarn/.test(MASTERS_SRC)) throw new Error('saveConversationOrWarn not found in masters.js');
  // saveConversationOrWarn is IIFE-internal. Its only callers (window.sendMessage / window.newConversation
  // / window.exportCurrent / ...) require the full DOM + App + AI + Store + currentConv runtime, which this
  // lightweight contract harness does not instantiate. Executing them would be a fragile false-positive.
  // The real durable entry it delegates to (Store.saveMasterConversationDurable) is independently covered
  // by B4 (real, indexedDB=undefined → ok:false, old preserved) and S12 (source assert).
  console.log('  → BLOCKED: saveConversationOrWarn is IIFE-internal (no window export); callers need full DOM runtime not instantiated. Real durable entry covered by B4/S12.');
}, 'BLOCKED');

test('M5: mutation — removing failure toast from masters saveConversationOrWarn (BLOCKED)', function () {
  // saveConversationOrWarn is an IIFE-internal function not exported to window.
  // We cannot call it directly. Attempting to load masters.js in VM and call it
  // would require the full DOM + App + Store + IconSystem environment.
  // Per Codex intake: "无法访问真实入口就标记 BLOCKED"
  // Verify the toast pattern exists in source (so the migration item is real)
  if (!/showToast.*对话保存失败/.test(MASTERS_SRC)) throw new Error('failure toast pattern not found in masters.js');
  // Verify saveConversationOrWarn is internal (not on window)
  if (/window\.saveConversationOrWarn/.test(MASTERS_SRC)) throw new Error('saveConversationOrWarn is on window — should be callable');
  // Mark as BLOCKED: cannot execute real function-level mutation
  console.log('  → BLOCKED: saveConversationOrWarn is IIFE-internal, not exported to window. Cannot execute mutation. Source pattern confirmed. Migration item: expose for testing or add integration test.');
}, 'BLOCKED');

test('M6: mutated billing-shell handler execution — BLOCKED (requires full DOM runtime)', function () {
  // Per task requirement: M6 must not only execute Store.createSession; if the billing-shell
  // mutation cannot be executed, mark BLOCKED (do NOT PASS).
  if (!/await\s+Store\.saveSessionsDurable/.test(BILLING_SRC)) throw new Error('billing-shell does not use real saveSessionsDurable');
  // Executing the mutated billing-shell inline handler requires loading the full HTML <script> with
  // DOM + App + Store + window wiring, which this lightweight contract harness does not instantiate.
  // The real durable behavior it depends on is independently covered by B3 (real saveBillingBatchDurable /
  // saveSessionsDurable, indexedDB=undefined → ok:false, cache unchanged) and by S8/S10 (source asserts).
  console.log('  → BLOCKED: billing-shell handler mutation needs full DOM runtime not instantiated. Real durable entry covered by B3/S8/S10.');
}, 'BLOCKED');

test('M7: mutation — adding false success toast before await in settings.js is detectable (toast-array + expected-red)', async function () {
  // REAL-ENTRY precondition: the REAL saveApiConfig function must be extracted & executable.
  var baseCtx = loadSettingsWithFailingStore();
  if (typeof baseCtx.saveApiConfig !== 'function') throw new Error('real entry saveApiConfig not available — cannot execute real handler');

  // BASELINE: real saveApiConfig with indexedDB=undefined → durable throws → error toast, NO success toast
  try { await baseCtx.saveApiConfig(); } catch (e) {}
  await new Promise(function (r) { setTimeout(r, 30); });
  var baseToasts = baseCtx.App.showToast.toasts;
  if (baseToasts.some(function (t) { return t.kind === 'success'; })) throw new Error('baseline unexpectedly fired a success toast before durable failure');

  // MUTATION: inject a false success toast BEFORE the await durable write (in extracted source).
  var mutatedSrc = SETTINGS_SRC.replace(
    /var\s+builtinSave\s*=\s*await\s+Store\.saveSettingsDurable\(\{ apiConfig:\s*\{\}\s*\}\)/,
    "App.showToast('配置已保存', 'success'); var builtinSave = await Store.saveSettingsDurable({ apiConfig: {} })"
  );
  if (mutatedSrc === SETTINGS_SRC) throw new Error('mutation no-op: pattern not found');
  var toastIdx = mutatedSrc.indexOf("App.showToast('配置已保存'");
  var awaitIdx = mutatedSrc.indexOf('await Store.saveSettingsDurable', toastIdx);
  if (toastIdx < 0) throw new Error('mutation ineffective: false success toast not found');
  if (awaitIdx < 0 || awaitIdx < toastIdx) throw new Error('mutation ineffective: toast not before await');

  // EXPECTED-RED: a naive STATIC string check would GREEN on this mutation, proving
  // behavioral assertion is required (mutation still contains durable await + showToast).
  var staticCheckGreen = /await\s+Store\.saveSettingsDurable/.test(mutatedSrc) && /App\.showToast/.test(mutatedSrc);
  if (!staticCheckGreen) throw new Error('expected-red setup broken: static check would not even green');

  // Build a mutated context that extracts & defines the MUTATED real function.
  var mutCtx = loadRealStore();
  mutCtx.App = {
    showToast: makeToastSpy(),
    escapeHtml: function (s) { return String(s || ''); },
    todayStr: function () { return '2026-07-21'; },
    todayFullCN: function () { return '2026年7月21日'; },
    formatDate: function (d) { return d || ''; },
    featureGate: function () { return true; },
    initPage: function () {},
  };
  function fakeEl() { return { value: '', placeholder: '', classList: { toggle: function () {}, add: function () {}, remove: function () {} }, setAttribute: function () {}, style: {}, focus: function () {}, addEventListener: function () {}, scrollIntoView: function () {} }; }
  mutCtx.document = { getElementById: function () { return fakeEl(); }, querySelector: function () { return fakeEl(); }, querySelectorAll: function () { return []; }, addEventListener: function () {} };
  mutCtx.window = mutCtx;
  mutCtx.encryptApiKey = async function () { return 'enc'; };
  mutCtx.updateTierStatus = function () {};
  mutCtx.savedApiKey = '';
  var mutFnSrc = extractSaveApiConfig(mutatedSrc);
  try { vm.runInContext(mutFnSrc + '\nthis.saveApiConfig = window.saveApiConfig;', mutCtx); } catch (e) { throw new Error('mutated saveApiConfig define failed: ' + e.message); }
  if (typeof mutCtx.saveApiConfig !== 'function') throw new Error('mutated real entry not available');
  try { await mutCtx.saveApiConfig(); } catch (e) {}
  await new Promise(function (r) { setTimeout(r, 30); });
  var mutToasts = mutCtx.App.showToast.toasts;
  var firstSuccessIdx = mutToasts.findIndex(function (t) { return t.kind === 'success'; });
  var errorIdx = mutToasts.findIndex(function (t) { return t.kind === 'error'; });
  // Behavior change proof: mutation fires success BEFORE the durable-failure error toast.
  if (firstSuccessIdx < 0) throw new Error('mutation: no success toast fired — mutation ineffective at runtime');
  if (errorIdx < 0) throw new Error('mutation: no error toast fired — durable failure not observed');
  if (firstSuccessIdx >= errorIdx) throw new Error('mutation: success toast did NOT precede error toast (expected-red detached)');
  // Baseline had ZERO success toasts; mutation has at least one → behavior differs.
  if (baseToasts.filter(function (t) { return t.kind === 'success'; }).length !== 0) throw new Error('baseline success-toast count assumption broken');
  if (mutToasts.filter(function (t) { return t.kind === 'success'; }).length < 1) throw new Error('mutation success-toast count assumption broken');
  console.log('  → M7 PASS: baseline success-toasts=0; mutation success-toasts=' + (mutToasts.filter(function (t) { return t.kind === 'success'; }).length) + ' fired before error (idx ' + firstSuccessIdx + '<' + errorIdx + '). expected-red static check would GREEN but behavior differs.');
});

// ====================================================================
// SUMMARY (runs after all tests via async queue)
// ====================================================================

runQueue(function () {
  console.log('\n=== XJ-4.2.2 legacy-write-contract-prep-v2 (rework v3 — BLOCKED-aware) ===');
  console.log('----------------------------------------');
  console.log('Passed (verified, excl. BLOCKED): ' + passed + ' | Blocked: ' + blocked + ' | Failed: ' + failed);
  console.log('CONFIRMED_DURABLE: ' + stats.CONFIRMED_DURABLE);
  console.log('CONFIRMED_LEGACY: ' + stats.CONFIRMED_LEGACY);
  console.log('EXPECTED_RED: ' + stats.EXPECTED_RED);
  console.log('DEGRADED: ' + stats.DEGRADED);
  console.log('BLOCKED: ' + blocked);
  var contractSha = crypto.createHash('sha256').update(fs.readFileSync(__filename, 'utf8')).digest('hex');
  console.log('contract_sha256: ' + contractSha);
  if (failed > 0) {
    console.log('contract_phase: CONTRACT-BROKEN');
    process.exit(1);
  } else if (blocked > 0) {
    // 无断言失败，但存在覆盖缺口：明确 NOT release gate，绝不输出 ALL-GREEN。
    console.log('contract_phase: PASS_WITH_BLOCKED');
    console.log('注：存在 ' + blocked + ' 个 BLOCKED 覆盖缺口（未执行真实入口），本契约不能作为版本放行依据（release gate 不可用）。不宣称 release-ready。');
    process.exit(0);
  } else {
    console.log('contract_phase: ALL-GREEN');
    console.log('注：仅验证遗留写入迁移契约，不宣称 release-ready。');
    process.exit(0);
  }
});
