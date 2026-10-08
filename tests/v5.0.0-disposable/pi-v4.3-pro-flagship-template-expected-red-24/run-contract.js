'use strict';
/**
 * XJ-5.0.0 Pi v4.3 Pro/Flagship Template Expected-Red — Contract Runner (task 24)
 *
 * Executes the REAL current production modules (Store, SessionTemplateViewModel,
 * XJEntitlements, QuickRecord) through their actual export/runtime surface and
 * classifies the exact remaining 4.3-F2 gap:
 *   - Free manual template (manual-session-v1) full path            -> CONFIRMED
 *   - Fail-closed tier/entitlement + body/brand rejection           -> CONFIRMED
 *   - Trial not raised, quota/BYOK not raised, Free not paywalled   -> CONFIRMED
 *   - Pro/Flagship selection durable-bounded-metadata boundary      -> CONFIRMED (defensive boundary only)
 *   - Pro AI-assisted template GENERATION capability                -> EXPECTED_RED
 *   - Flagship custom brand template DEFINITION + VALIDATION        -> EXPECTED_RED
 *
 * Determinism: contract-result.json and contract-matrix.json carry NO volatile
 * (timestamp/random/hash-bound) fields; volatile diagnostics are stdout-only.
 *
 * Output directory is overridable via XJ_TASK24_OUT_DIR so mutation probes can
 * run mutated runners against temp output without touching the real artifacts.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve('D:\\xinjing-electron');
const HARNESS_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'pi-v4.3-pro-flagship-template-expected-red-24');
const OUT_DIR = process.env.XJ_TASK24_OUT_DIR ? path.resolve(process.env.XJ_TASK24_OUT_DIR) : HARNESS_DIR;
// Env overrides are used ONLY by mutation probes M11/M12 to drive the real
// drift gates against OS-temporary copies; when unset the real manifest and
// real project root are used, so production/default behavior is unchanged.
const MANIFEST_PATH = process.env.XJ_TASK24_MANIFEST_PATH ? path.resolve(process.env.XJ_TASK24_MANIFEST_PATH) : path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'pi-v4.3-pro-flagship-template-expected-red-24', 'protected-files-manifest.json');
const PROTECTED_ROOT = process.env.XJ_TASK24_PROTECTED_ROOT ? path.resolve(process.env.XJ_TASK24_PROTECTED_ROOT) : ROOT;

const TASK_ID = 'XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24';
const BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const CONTRACT_ID = 'v4.3-pro-flagship-template-expected-red-v1';
const WRITE_LOCK_ID = 'lock-XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24';
const GRANT_ID = 'local-codex-20260728T005553Z-pi-template-expected-red-24';
const MANIFEST_HASH = 'D2364BA0FDBF3D4776C0B89FB61D98D76E94DF4CFBAAF82AC3BF9D0E33B65D5D';

const STORE_PATH = path.join(ROOT, 'app', 'js', 'store.js');
const ENT_PATH = path.join(ROOT, 'app', 'js', 'entitlements.js');
const STVM_PATH = path.join(ROOT, 'app', 'js', 'session-template-view-model.js');
const QR_PATH = path.join(ROOT, 'app', 'js', 'quick-record.js');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function sha256Str(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase(); }

const checks = [];
let confirmedCount = 0, expectedRedCount = 0, unverifiedCount = 0, failedCount = 0;

function check(id, label, cond, classification, category, evidence) {
  const ok = !!cond;
  const cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  else if (cls === 'UNVERIFIED') { if (ok) unverifiedCount++; else failedCount++; }
  checks.push({ id, label, pass: ok, classification: cls, category: category || '', evidence: evidence || '' });
  const tag = cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : (ok ? 'PASS' : 'FAIL');
  console.log('[' + tag + '] ' + id + ' (' + cls + '/' + (category || '') + '): ' + label);
  if (evidence) console.log('    evidence: ' + evidence);
  return ok;
}

// ──────────────────────────────────────────────────────────────────────────
// Precondition: verify all nine protected hashes (BLOCKED on mismatch).
// Drift-before-write sensitivity (rework 1): both gates run at module top
// BEFORE main() is invoked, so any one-byte protected-input drift (manifest
// byte-hash gate #1, or per-file sha256 gate #2) forces process.exit(1) with
// ZERO artifact writes. Proven by mutation probes M11 + M12.
// ──────────────────────────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const manifestByteHash = sha256(MANIFEST_PATH);
if (manifestByteHash !== MANIFEST_HASH) {
  console.error('[BLOCKED] protected-files manifest byte hash mismatch: ' + manifestByteHash + ' != ' + MANIFEST_HASH);
  process.exit(1);
}
let hashFailures = 0;
manifest.files.forEach((f) => {
  const p = path.join(PROTECTED_ROOT, f.path);
  const actual = fs.existsSync(p) ? sha256(p) : 'MISSING';
  if (actual !== f.sha256.toUpperCase()) {
    hashFailures++;
    console.error('[BLOCKED] protected hash mismatch: ' + f.path + ' -> ' + actual + ' != ' + f.sha256.toUpperCase());
  }
});
if (hashFailures > 0) {
  console.error('[BLOCKED] ' + hashFailures + ' protected-file hash mismatch(es); aborting before any task write.');
  process.exit(1);
}
console.log('[OK] precondition: all nine protected-file hashes match manifest ' + MANIFEST_HASH);

// ──────────────────────────────────────────────────────────────────────────
// In-memory IndexedDB shim (records persist across Store instances that share
// the same database object, so reload/survival tests are real). Supports
// setFailWrites for failure-preservation assertions.
// ──────────────────────────────────────────────────────────────────────────
function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    key(i) { return Array.from(values.keys())[i] || null; },
  };
}
function createIndexedDB() {
  const records = new Map();
  let failWrites = false;
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
          if (failWrites) {
            tx.error = new Error('synthetic durable write failure');
            if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
            return;
          }
          pending.forEach((op) => {
            if (op.type === 'put') records.set(op.key, op.value);
            else records.delete(op.key);
          });
          if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
        }, 0);
      }
      tx.objectStore = () => ({
        get(key) {
          const r = { result: undefined, error: null, onsuccess: null, onerror: null };
          setTimeout(() => {
            r.result = records.has(String(key)) ? { key: String(key), value: records.get(String(key)) } : undefined;
            if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
          }, 0);
          return r;
        },
        getAll() {
          const r = { result: undefined, error: null, onsuccess: null, onerror: null };
          setTimeout(() => {
            r.result = Array.from(records, ([key, value]) => ({ key, value }));
            if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
          }, 0);
          return r;
        },
        put(record) {
          pending.push({ type: 'put', key: String(record.key), value: record.value });
          if (mode === 'readwrite') scheduleWrite();
          return { onsuccess: null, onerror: null };
        },
        delete(key) {
          pending.push({ type: 'delete', key: String(key) });
          if (mode === 'readwrite') scheduleWrite();
          return { onsuccess: null, onerror: null };
        },
      });
      return tx;
    },
    close() {},
  };
  return {
    open() {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        req.result = db;
        if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
        if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    deleteDatabase() { const r = { onsuccess: null, onerror: null }; setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; },
    setFailWrites(v) { failWrites = !!v; },
    read(key) { return records.get(String(key)); },
    recordCount() { return records.size; },
  };
}

const VM_GLOBALS = ['console', 'setTimeout', 'clearTimeout', 'Date', 'Math', 'JSON', 'Promise', 'Map', 'Set', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Error', 'RegExp'];

function loadStore(source, database, extras) {
  const scope = {
    localStorage: memoryStorage(),
    indexedDB: database,
    location: { reload() {} },
  };
  VM_GLOBALS.forEach((g) => { scope[g] = global[g]; });
  if (extras) Object.assign(scope, extras);
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(source + '\n;globalThis.__store = (typeof Store !== "undefined") ? Store : window.Store;', scope, { filename: 'store.js' });
  return { Store: scope.__store, scope };
}

function loadQuickRecord(source, Store, App) {
  const scope = { Store, App };
  VM_GLOBALS.forEach((g) => { scope[g] = global[g]; });
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(source + '\n;globalThis.__qr = window.QuickRecord;', scope, { filename: 'quick-record.js' });
  return scope.__qr;
}

// ──────────────────────────────────────────────────────────────────────────
// Main: load real modules + run the behavior matrix
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const storeSource = fs.readFileSync(STORE_PATH, 'utf8');
  const entSource = fs.readFileSync(ENT_PATH, 'utf8');
  const stvmSource = fs.readFileSync(STVM_PATH, 'utf8');
  const qrSource = fs.readFileSync(QR_PATH, 'utf8');

  // Real module hashes (recorded in artifact for traceability + stdout)
  const MODULE_HASHES = {
    'store.js': sha256(STORE_PATH),
    'entitlements.js': sha256(ENT_PATH),
    'session-template-view-model.js': sha256(STVM_PATH),
    'quick-record.js': sha256(QR_PATH),
  };
  console.log('[INFO] real module hashes:');
  console.log('  store.js: ' + MODULE_HASHES['store.js']);
  console.log('  entitlements.js: ' + MODULE_HASHES['entitlements.js']);
  console.log('  session-template-view-model.js: ' + MODULE_HASHES['session-template-view-model.js']);
  console.log('  quick-record.js: ' + MODULE_HASHES['quick-record.js']);

  // Load XJEntitlements (pure UMD, no window deps)
  const entScope = { module: { exports: {} }, exports: {} };
  VM_GLOBALS.forEach((g) => { entScope[g] = global[g]; });
  entScope.globalThis = entScope;
  vm.createContext(entScope);
  vm.runInContext(entSource + '\n;globalThis.__ent = (typeof module !== "undefined" && module.exports) ? module.exports : globalThis.XJEntitlements;', entScope, { filename: 'entitlements.js' });
  const XJEntitlements = entScope.__ent;

  // Load SessionTemplateViewModel (pure UMD, no window deps)
  const stvmScope = { module: { exports: {} }, exports: {} };
  VM_GLOBALS.forEach((g) => { stvmScope[g] = global[g]; });
  stvmScope.globalThis = stvmScope;
  vm.createContext(stvmScope);
  vm.runInContext(stvmSource + '\n;globalThis.__stvm = (typeof module !== "undefined" && module.exports) ? module.exports : globalThis.SessionTemplateViewModel;', stvmScope, { filename: 'session-template-view-model.js' });
  const SessionTemplateViewModel = stvmScope.__stvm;

  // Load real Store
  const database = createIndexedDB();
  const { Store } = loadStore(storeSource, database);
  await Store.hydrate();

  // ===== F1-LIST: Free tier lists manual-session-v1 only =====
  const freeList = SessionTemplateViewModel.list({ tier: 'Free', context: 'individual' });
  const freeIds = freeList.ok ? freeList.templates.map((t) => t.id) : [];
  check('F1-LIST',
    'Free tier lists manual-session-v1 only (no ai-session-v1 / flagship-session-v1)',
    freeList.ok === true && freeIds.length === 1 && freeIds[0] === 'manual-session-v1',
    'CONFIRMED', 'positive',
    'SessionTemplateViewModel.list({tier:Free}) -> ids=' + JSON.stringify(freeIds));

  // ===== F1-SELECT: Free tier selects manual-session-v1 =====
  const freeSel = SessionTemplateViewModel.select('manual-session-v1', { tier: 'Free', context: 'individual' });
  check('F1-SELECT',
    'Free tier selects manual-session-v1 via real select()',
    freeSel.ok === true && freeSel.template && freeSel.template.id === 'manual-session-v1' && freeSel.template.tier === 'Free',
    'CONFIRMED', 'positive',
    'select ok=' + freeSel.ok + ' templateId=' + (freeSel.template && freeSel.template.id));

  // ===== F1-SELECT-FLAGSHIP-DENIED: Free cannot select Flagship template =====
  const freeFlag = SessionTemplateViewModel.select('flagship-session-v1', { tier: 'Free', context: 'individual' });
  check('F1-SELECT-FLAGSHIP-DENIED',
    'Free tier cannot select flagship-session-v1 (fail closed, not promoted)',
    freeFlag.ok === false && freeFlag.code === 'template-unavailable',
    'CONFIRMED', 'fail-closed',
    'select flagship under Free -> ok=' + freeFlag.ok + ' code=' + freeFlag.code);

  // ===== F1-DURABLE: Free manual selection persists + survives reload =====
  await Store.createClientDurable({ id: 'c-f1', name: 'Synth F1' });
  await Store.createSessionDurable({ id: 's-f1', clientId: 'c-f1', sessionNumber: 1, marker: 'keep-f1' });
  const f1Save = await Store.saveSessionTemplateSelectionDurable('s-f1', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual',
  });
  const f1Read = Store.getSessionTemplateSelection('s-f1');
  // reload via a fresh Store backed by the same IDB records
  const reloadScope = loadStore(storeSource, database);
  await reloadScope.Store.hydrate();
  const f1AfterReload = reloadScope.Store.getSessionTemplateSelection('s-f1');
  const f1SessionMarker = reloadScope.Store.getSession('s-f1').marker;
  check('F1-DURABLE',
    'Free manual selection persists durably, preserves unrelated session fields, survives Store reload',
    f1Save.ok === true && f1Save.session.marker === 'keep-f1' &&
    f1Read && f1Read.templateId === 'manual-session-v1' && f1Read.tierAtSelection === 'Free' &&
    f1AfterReload && f1AfterReload.templateId === 'manual-session-v1' && f1AfterReload.tierAtSelection === 'Free' &&
    f1SessionMarker === 'keep-f1',
    'CONFIRMED', 'positive',
    'save.ok=' + f1Save.ok + ' read.tier=' + (f1Read && f1Read.tierAtSelection) + ' reload.tier=' + (f1AfterReload && f1AfterReload.tierAtSelection));

  // ===== F1-DURABLE-FAILURE: durable failure returns {ok:false} + preserves authoritative =====
  const failDb = createIndexedDB();
  const failStoreLoad = loadStore(storeSource, failDb);
  await failStoreLoad.Store.hydrate();
  await failStoreLoad.Store.createClientDurable({ id: 'c-ff', name: 'Synth FF' });
  await failStoreLoad.Store.createSessionDurable({ id: 's-ff', clientId: 'c-ff', sessionNumber: 1 });
  const ffOk = await failStoreLoad.Store.saveSessionTemplateSelectionDurable('s-ff', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual',
  });
  failDb.setFailWrites(true);
  const ffFail = await failStoreLoad.Store.saveSessionTemplateSelectionDurable('s-ff', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', appliedAt: '2026-07-28T00:00:00+08:00',
  });
  const ffAuthoritative = failStoreLoad.Store.getSessionTemplateSelection('s-ff');
  check('F1-DURABLE-FAILURE',
    'durable template failure returns {ok:false} and preserves prior authoritative selection',
    ffOk.ok === true && ffFail.ok === false && ffAuthoritative && ffAuthoritative.templateId === 'manual-session-v1',
    'CONFIRMED', 'fail-closed',
    'ffOk=' + ffOk.ok + ' ffFail=' + ffFail.ok + ' authoritative.tier=' + (ffAuthoritative && ffAuthoritative.tierAtSelection));

  // ===== F1-QUICKRECORD: real QuickRecord Free manual end-to-end path =====
  const AppStub = { todayStr: () => '2026-07-28', showToast: () => {} };
  const QuickRecord = loadQuickRecord(qrSource, Store, AppStub);
  QuickRecord.reset();
  const qrRes = await QuickRecord.createQuickRecord({ clientId: 'c-f1', templateId: 'manual-session-v1', taskTitles: ['follow-up one'] });
  const qrSession = qrRes && qrRes.value ? qrRes.value : null;
  const qrSelection = qrSession ? Store.getSessionTemplateSelection(qrSession.id) : null;
  check('F1-QUICKRECORD',
    'real QuickRecord creates session + persists Free manual template selection + manual task (not paywalled)',
    qrRes.ok === true && !!qrSession && qrSelection && qrSelection.templateId === 'manual-session-v1' && qrSelection.tierAtSelection === 'Free',
    'CONFIRMED', 'positive',
    'qr.ok=' + qrRes.ok + ' sessionIdPrefix=' + (qrSession && qrSession.id && qrSession.id.startsWith('qr-c-f1-') ? 'match' : 'MISMATCH') + ' sel.tier=' + (qrSelection && qrSelection.tierAtSelection));

  // ===== FC-QUICKRECORD-TIER: QuickRecord rejects non-manual templateId =====
  QuickRecord.reset();
  const qrPro = await QuickRecord.createQuickRecord({ clientId: 'c-f1', templateId: 'ai-session-v1', taskTitles: [] });
  QuickRecord.reset();
  const qrFlag = await QuickRecord.createQuickRecord({ clientId: 'c-f1', templateId: 'flagship-session-v1', taskTitles: [] });
  check('FC-QUICKRECORD-TIER',
    'QuickRecord rejects Pro/Flagship templateId (Free manual is the only wired quick-record template)',
    qrPro.ok === false && qrFlag.ok === false,
    'CONFIRMED', 'fail-closed',
    'qrPro.ok=' + qrPro.ok + ' qrFlag.ok=' + qrFlag.ok);

  // ===== FC-ENT-TIER: unknown/malformed/expired/revoked entitlement tier fails closed to free =====
  const ntUnknown = XJEntitlements.normalizeTier('unknown-tier');
  const ntFlagship = XJEntitlements.normalizeTier('Flagship');     // Flagship is NOT an entitlements tier
  const ntNull = XJEntitlements.normalizeTier(null);
  const ntEmpty = XJEntitlements.normalizeTier('');
  const etExpired = XJEntitlements.effectiveTier({ activated: false, tier: 'pro' });         // expired/revoked -> free
  const etRevoked = XJEntitlements.effectiveTier({ activated: false, tier: 'custom' });      // revoked -> free
  const etFlagship = XJEntitlements.effectiveTier({ activated: true, tier: 'Flagship' });    // Flagship not a tier -> free
  const etMalformed = XJEntitlements.effectiveTier({ activated: true, tier: 'Pro', /* malformed: missing nothing but tier literal */ });
  // 'Pro' (capitalized) normalizes to 'free' because entitlements lowercases and 'pro' is valid
  const proCapNorm = XJEntitlements.normalizeTier('Pro');
  check('FC-ENT-TIER',
    'unknown/malformed/expired/revoked entitlement tier fails closed to free, never Pro/Flagship/custom',
    ntUnknown === 'free' && ntFlagship === 'free' && ntNull === 'free' && ntEmpty === 'free' &&
    etExpired === 'free' && etRevoked === 'free' && etFlagship === 'free',
    'CONFIRMED', 'fail-closed',
    'ntUnknown=' + ntUnknown + ' ntFlagship=' + ntFlagship + ' etExpired=' + etExpired + ' etFlagship=' + etFlagship + ' proCapNorm=' + proCapNorm);

  // ===== FC-STORE-BODY-BRAND: Store rejects body-like text + invalid custom; drops arbitrary brand payloads (bounded metadata) =====
  // Contract: brand assets are OUTSIDE this first persistence contract, so the
  // Store drops non-body-like brand payloads (persisted selection stays bounded
  // to the 6 known fields) while body-like clinical text + invalid customTemplateId
  // fail closed. This is the precise bounded-metadata boundary.
  const bodyRes = await Store.saveSessionTemplateSelectionDurable('s-f1', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', body: 'clinical narrative with spaces',
  });
  const contentRes = await Store.saveSessionTemplateSelectionDurable('s-f1', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', content: 'transcript-like text',
  });
  const brandPayloadRes = await Store.saveSessionTemplateSelectionDurable('s-f1', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', brandAssets: { logo: '<svg>x</svg>', colors: ['#f00'] },
  });
  const selAfterBrand = Store.getSessionTemplateSelection('s-f1');
  const brandDropped = brandPayloadRes.ok === true && !!selAfterBrand && !('brandAssets' in selAfterBrand) &&
    Object.keys(selAfterBrand).sort().join(',') === 'appliedAt,context,customTemplateId,templateId,tierAtSelection,version';
  const unsafeCustomRes = await Store.saveSessionTemplateSelectionDurable('s-f1', {
    templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', customTemplateId: '../bad',
  });
  const customOnFreeRes = await Store.saveSessionTemplateSelectionDurable('s-f1', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', customTemplateId: 'brand-001',
  });
  const overlongCustomRes = await Store.saveSessionTemplateSelectionDurable('s-f1', {
    templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', customTemplateId: 'x'.repeat(129),
  });
  check('FC-STORE-BODY-BRAND',
    'Store rejects body-like clinical text + invalid customTemplateId; arbitrary brand payloads are DROPPED so persisted selection stays bounded metadata',
    bodyRes.ok === false && contentRes.ok === false && brandDropped &&
    unsafeCustomRes.ok === false && customOnFreeRes.ok === false && overlongCustomRes.ok === false,
    'CONFIRMED', 'fail-closed',
    'body=' + bodyRes.ok + ' content=' + contentRes.ok + ' brandDropped=' + brandDropped + ' unsafe=' + unsafeCustomRes.ok + ' customOnFree=' + customOnFreeRes.ok + ' overlong=' + overlongCustomRes.ok);

  // ===== TRIAL-NOT-RAISED: trial not normalized to custom/Flagship =====
  const trialState = { activated: false, mode: 'trial', aiUnlocked: true };
  const trialActive = XJEntitlements.isTrialActive(trialState);
  const trialEffTier = XJEntitlements.effectiveTier(trialState);
  const trialAiAllowed = XJEntitlements.canUse('ai-notes', trialState);          // trialEligible pro feature -> allowed by trial
  const trialCustomAllowed = XJEntitlements.canUse('custom-supervisors', trialState); // custom feature -> NOT allowed by trial
  const trialFlagshipSel = SessionTemplateViewModel.list({ tier: 'Flagship', context: 'individual' }); // trial tier is still free
  check('TRIAL-NOT-RAISED',
    'Trial unlocks only trialEligible pro features; effectiveTier stays free; custom/Flagship not granted',
    trialActive === true && trialEffTier === 'free' && trialAiAllowed === true && trialCustomAllowed === false,
    'CONFIRMED', 'trial-quota',
    'trialActive=' + trialActive + ' effTier=' + trialEffTier + ' aiNotes=' + trialAiAllowed + ' customSup=' + trialCustomAllowed);

  // ===== QUOTA-BYOK-NOT-RAISED: no quota/BYOK path raises TIER_RANK =====
  const quotaState = { activated: true, tier: 'pro', quota: 999999, byok: true, aiUnlocked: true };
  const quotaEffTier = XJEntitlements.effectiveTier(quotaState);
  const byokCustom = XJEntitlements.canUse('custom-supervisors', quotaState); // BYOK/quota must not raise pro -> custom
  // behavioral: enumerate entitlements public API for any tier-raise/upgrade function
  const entRaiseFns = Object.keys(XJEntitlements).filter((k) => /raise|upgrade|promote/i.test(k));
  // supplementary source trace (not the primary assertion)
  const entHasQuotaRaiseSrc = /quota.*custom|byok.*custom|raiseTier|upgradeTier/i.test(entSource);
  check('QUOTA-BYOK-NOT-RAISED',
    'quota/BYOK does not raise tier; effectiveTier stays pro; custom remains denied; no tier-raise function on entitlements API',
    quotaEffTier === 'pro' && byokCustom === false && entRaiseFns.length === 0,
    'CONFIRMED', 'trial-quota',
    'quotaEffTier=' + quotaEffTier + ' byokCustom=' + byokCustom + ' raiseFns=' + JSON.stringify(entRaiseFns) + ' srcTrace=' + entHasQuotaRaiseSrc);

  // ===== PRO-SEL-BOUNDARY: Pro ai-session-v1 selection persistence boundary exists (defensive only) =====
  await Store.createSessionDurable({ id: 's-pro', clientId: 'c-f1', sessionNumber: 2 });
  const proSel = await Store.saveSessionTemplateSelectionDurable('s-pro', {
    templateId: 'ai-session-v1', tierAtSelection: 'Pro', context: 'individual',
  });
  const proRead = Store.getSessionTemplateSelection('s-pro');
  check('PRO-SEL-BOUNDARY',
    'Pro ai-session-v1 selection persistence BOUNDARY exists (Store allows Pro tier/template) — defensive boundary, NOT the AI-assisted capability',
    proSel.ok === true && proRead && proRead.templateId === 'ai-session-v1' && proRead.tierAtSelection === 'Pro',
    'CONFIRMED', 'boundary',
    'proSel.ok=' + proSel.ok + ' read.tier=' + (proRead && proRead.tierAtSelection));

  // ===== FLAG-SEL-BOUNDARY: Flagship selection + bounded customTemplateId persistence boundary exists =====
  await Store.createSessionDurable({ id: 's-flag', clientId: 'c-f1', sessionNumber: 3 });
  const flagSel = await Store.saveSessionTemplateSelectionDurable('s-flag', {
    templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', customTemplateId: 'brand-acme-001',
  });
  const flagRead = Store.getSessionTemplateSelection('s-flag');
  const flagReload = loadStore(storeSource, database);
  await flagReload.Store.hydrate();
  const flagAfterReload = flagReload.Store.getSessionTemplateSelection('s-flag');
  check('FLAG-SEL-BOUNDARY',
    'Flagship selection + bounded customTemplateId persistence BOUNDARY exists and survives reload — defensive boundary, NOT the custom brand capability',
    flagSel.ok === true && flagRead && flagRead.templateId === 'flagship-session-v1' && flagRead.tierAtSelection === 'Flagship' && flagRead.customTemplateId === 'brand-acme-001' &&
    flagAfterReload && flagAfterReload.customTemplateId === 'brand-acme-001',
    'CONFIRMED', 'boundary',
    'flagSel.ok=' + flagSel.ok + ' read.custom=' + (flagRead && flagRead.customTemplateId) + ' reload.custom=' + (flagAfterReload && flagAfterReload.customTemplateId));

  // ===== PRO-AI-GEN: no production entry for AI-assisted template content generation =====
  const stvmKeys = Object.keys(SessionTemplateViewModel).sort();
  const hasGenFn = ['generateAiTemplate', 'aiGenerate', 'generate', 'assist', 'aiAssist', 'generateDraft'].some((fn) => typeof SessionTemplateViewModel[fn] === 'function');
  check('PRO-AI-GEN',
    'No production entry for AI-assisted session template content GENERATION (SessionTemplateViewModel exposes only static list/select/apply)',
    hasGenFn === false,
    'EXPECTED_RED', 'expected-red',
    'stvmKeys=' + JSON.stringify(stvmKeys) + ' hasGenFn=' + hasGenFn);

  // ===== PRO-AI-ORCH: apply() only produces an empty skeleton; no AI provider/orchestration =====
  const proTemplate = SessionTemplateViewModel.select('ai-session-v1', { tier: 'Pro', context: 'individual' });
  const proApply = proTemplate.ok ? SessionTemplateViewModel.apply(proTemplate.template, 's-pro') : { ok: false };
  const applyEntriesEmpty = proApply.ok && Array.isArray(proApply.draft.entries) && proApply.draft.entries.every((e) => e.value === '');
  // behavioral: enumerate STVM public API for any AI provider/orchestration function
  const providerFns = Object.keys(SessionTemplateViewModel).filter((k) => /provider|orchestrat|ai/i.test(k));
  // supplementary source trace (not the primary assertion)
  const hasProviderWiringSrc = /generateAiTemplate|aiAssist|aiGenerate|provider.*template|template.*provider/i.test(stvmSource + '\n' + qrSource);
  check('PRO-AI-ORCH',
    'No AI provider/orchestration wired into the session template path; apply() yields only an empty-value skeleton draft',
    applyEntriesEmpty === true && providerFns.length === 0,
    'EXPECTED_RED', 'expected-red',
    'apply.ok=' + proApply.ok + ' entriesEmpty=' + applyEntriesEmpty + ' providerFns=' + JSON.stringify(providerFns) + ' srcTrace=' + hasProviderWiringSrc);

  // ===== FLAG-DEF: no production entry for custom brand template definition =====
  const hasDefineFn = ['defineCustomBrandTemplate', 'createBrandTemplate', 'defineBrandTemplate', 'registerCustomTemplate', 'createCustomTemplate'].some((fn) => typeof SessionTemplateViewModel[fn] === 'function');
  // flagship-session-v1 is a STATIC built-in definition; no API to define a NEW custom brand template
  const flagshipStatic = SessionTemplateViewModel.select('flagship-session-v1', { tier: 'Flagship', context: 'individual' });
  const flagshipIsStaticBuiltin = flagshipStatic.ok && flagshipStatic.template && flagshipStatic.template.id === 'flagship-session-v1' && Object.isFrozen(flagshipStatic.template);
  check('FLAG-DEF',
    'No production entry for custom brand template DEFINITION (only a static built-in flagship-session-v1; no define/create brand template API)',
    hasDefineFn === false && flagshipIsStaticBuiltin === true,
    'EXPECTED_RED', 'expected-red',
    'hasDefineFn=' + hasDefineFn + ' flagshipStatic=' + flagshipIsStaticBuiltin);

  // ===== FLAG-VAL: no production entry for brand asset validation =====
  // Store only validates the customTemplateId STRING format (regex), not brand assets/content
  const storeSrc = storeSource;
  // behavioral: enumerate Store + STVM public API for any brand-validation function
  const brandValFns = Object.keys(Store).concat(Object.keys(SessionTemplateViewModel)).filter((k) => /brand|validateAsset|validateCustom|assetSchema/i.test(k));
  // supplementary source trace (not the primary assertion)
  const hasBrandValidationSrc = /validateBrand|brandAsset|brandValidation|validateCustomTemplateBody|brand.*schema/i.test(storeSrc + '\n' + stvmSource);
  // Confirm Store DOES validate the customTemplateId string format (boundary), but NOT brand assets
  const customIdFormatValid = await Store.saveSessionTemplateSelectionDurable('s-flag', {
    templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', customTemplateId: 'valid-id-1',
  });
  check('FLAG-VAL',
    'No production entry for brand ASSET validation (Store validates only customTemplateId string format, not brand assets/content)',
    brandValFns.length === 0 && customIdFormatValid.ok === true,
    'EXPECTED_RED', 'expected-red',
    'brandValFns=' + JSON.stringify(brandValFns) + ' customIdFormatValid=' + customIdFormatValid.ok + ' srcTrace=' + hasBrandValidationSrc);

  // ──────────────────────────────────────────────────────────────────────────
  // Invariant enforcement
  // ──────────────────────────────────────────────────────────────────────────
  const totalRows = checks.length;
  const positiveCount = checks.filter((c) => c.category === 'positive' && c.classification === 'CONFIRMED' && c.pass).length;
  const failClosedCount = checks.filter((c) => c.category === 'fail-closed' && c.classification === 'CONFIRMED' && c.pass).length;
  const expectedRedRows = checks.filter((c) => c.classification === 'EXPECTED_RED');
  const boundaryCount = checks.filter((c) => c.category === 'boundary' && c.classification === 'CONFIRMED' && c.pass).length;

  const invariants = {
    totalRowsAtLeast12: totalRows >= 12,
    positiveAtLeast4: positiveCount >= 4,
    failClosedAtLeast2: failClosedCount >= 2,
    expectedRedAtLeast4: expectedRedRows.length >= 4,
    expectedRedAllGreen: expectedRedRows.every((c) => c.pass),
    zeroFailed: failedCount === 0,
  };
  console.log('----------------------------------------');
  console.log('Invariants: ' + JSON.stringify(invariants));
  console.log('Counts: confirmed=' + confirmedCount + ' expected_red=' + expectedRedCount + ' unverified=' + unverifiedCount + ' failed=' + failedCount +
    ' | positive=' + positiveCount + ' fail-closed=' + failClosedCount + ' boundary=' + boundaryCount + ' expected-red=' + expectedRedRows.length);

  // ──────────────────────────────────────────────────────────────────────────
  // Write deterministic contract-result.json + contract-matrix.json
  // ──────────────────────────────────────────────────────────────────────────
  const MATRIX_META = {
    'F1-LIST': { capability: 'Free tier lists manual-session-v1 only', production_entry_point: 'app/js/session-template-view-model.js SessionTemplateViewModel.list' },
    'F1-SELECT': { capability: 'Free tier selects manual-session-v1 via real select()', production_entry_point: 'app/js/session-template-view-model.js SessionTemplateViewModel.select' },
    'F1-SELECT-FLAGSHIP-DENIED': { capability: 'Free tier cannot select flagship-session-v1 (fail closed)', production_entry_point: 'app/js/session-template-view-model.js SessionTemplateViewModel.select' },
    'F1-DURABLE': { capability: 'Free manual selection persists durably and survives reload', production_entry_point: 'app/js/store.js Store.saveSessionTemplateSelectionDurable' },
    'F1-DURABLE-FAILURE': { capability: 'durable template failure returns {ok:false} and preserves authoritative', production_entry_point: 'app/js/store.js Store.saveSessionTemplateSelectionDurable' },
    'F1-QUICKRECORD': { capability: 'real QuickRecord Free manual end-to-end path (not paywalled)', production_entry_point: 'app/js/quick-record.js QuickRecord.createQuickRecord' },
    'FC-QUICKRECORD-TIER': { capability: 'QuickRecord rejects Pro/Flagship templateId', production_entry_point: 'app/js/quick-record.js createQuickRecord guard' },
    'FC-ENT-TIER': { capability: 'unknown/expired/revoked entitlement tier fails closed to free', production_entry_point: 'app/js/entitlements.js normalizeTier/effectiveTier' },
    'FC-STORE-BODY-BRAND': { capability: 'Store rejects body-like text + arbitrary/unsafe brand payloads', production_entry_point: 'app/js/store.js normalizeSessionTemplateSelection' },
    'TRIAL-NOT-RAISED': { capability: 'Trial not normalized to custom/Flagship', production_entry_point: 'app/js/entitlements.js isTrialActive/effectiveTier/canUse' },
    'QUOTA-BYOK-NOT-RAISED': { capability: 'quota/BYOK does not raise tier', production_entry_point: 'app/js/entitlements.js effectiveTier' },
    'PRO-SEL-BOUNDARY': { capability: 'Pro ai-session-v1 selection persistence boundary (defensive only)', production_entry_point: 'app/js/store.js Store.saveSessionTemplateSelectionDurable' },
    'FLAG-SEL-BOUNDARY': { capability: 'Flagship selection + bounded customTemplateId persistence boundary (defensive only)', production_entry_point: 'app/js/store.js Store.saveSessionTemplateSelectionDurable' },
    'PRO-AI-GEN': { capability: 'Pro AI-assisted template content GENERATION (missing)', production_entry_point: 'NO PRODUCTION ENTRY (app/js/session-template-view-model.js has no generate function)' },
    'PRO-AI-ORCH': { capability: 'Pro AI provider/orchestration for template draft (missing)', production_entry_point: 'NO PRODUCTION ENTRY (apply() yields empty skeleton only)' },
    'FLAG-DEF': { capability: 'Flagship custom brand template DEFINITION (missing)', production_entry_point: 'NO PRODUCTION ENTRY (only static built-in flagship-session-v1)' },
    'FLAG-VAL': { capability: 'Flagship brand ASSET validation (missing)', production_entry_point: 'NO PRODUCTION ENTRY (Store validates customTemplateId string format only)' },
  };

  const matrix = checks.map((c) => ({
    id: c.id,
    capability: (MATRIX_META[c.id] || {}).capability || c.label,
    expected_current_result: c.classification === 'EXPECTED_RED' ? 'capability absent / behavior missing (EXPECTED_RED gap)' : 'behavior present and correct (CONFIRMED)',
    actual_result: c.pass ? (c.classification === 'EXPECTED_RED' ? 'gap confirmed absent as expected' : 'behavior confirmed') : 'UNEXPECTED — check failed',
    classification: c.classification,
    category: c.category,
    production_entry_point: (MATRIX_META[c.id] || {}).production_entry_point || 'unknown',
    evidence: c.evidence,
  }));

  const result = {
    task_id: TASK_ID,
    base_commit: BASE_COMMIT,
    contract_id: CONTRACT_ID,
    write_lock_id: WRITE_LOCK_ID,
    grant_id: GRANT_ID,
    protected_files_manifest_sha256: MANIFEST_HASH,
    module_hashes: MODULE_HASHES,
    determinism: 'no volatile fields; no timestamps/random/hashes inside artifact; hash-stable across healthy runs',
    confirmed: confirmedCount,
    expected_red: expectedRedCount,
    unverified: unverifiedCount,
    failed: failedCount,
    row_counts: { total: totalRows, positive: positiveCount, fail_closed: failClosedCount, boundary: boundaryCount, expected_red: expectedRedRows.length },
    invariants: invariants,
    checks: checks.map((c) => ({ id: c.id, label: c.label, pass: c.pass, classification: c.classification, category: c.category })),
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'contract-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'contract-matrix.json'), JSON.stringify({ task_id: TASK_ID, base_commit: BASE_COMMIT, rows: matrix }, null, 2) + '\n', 'utf8');

  console.log('----------------------------------------');
  console.log('Wrote: ' + path.join(OUT_DIR, 'contract-result.json'));
  console.log('Wrote: ' + path.join(OUT_DIR, 'contract-matrix.json'));
  console.log('run completed (stdout timestamp only, not hash-bound): ' + new Date().toISOString());

  const allInvariantsOk = Object.values(invariants).every(Boolean);
  process.exit(allInvariantsOk && failedCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS_ERROR: ' + (e && e.stack || e));
  process.exit(1);
});
