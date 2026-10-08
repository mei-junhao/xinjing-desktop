'use strict';
/**
 * XJ-5.0.0 Pi v4.3 Pro/Flagship Template Expected-Red — Mutation Probes (task 24)
 *
 * Mutates OS-temporary copies ONLY (never real production files or the real runner).
 *
 *  Family A (M1..M8): write a mutated temp copy of a real production module to
 *    os.tmpdir(), load it via the same vm loader the runner uses, and run a
 *    focused real-vs-mutated assertion. KILLED when real behaves correctly AND
 *    the mutant shows a different/bad behavior (including throws).
 *
 *  Family B (M9..M10): write a mutated temp copy of run-contract.js to
 *    os.tmpdir(), run it with XJ_TASK24_OUT_DIR -> temp dir, expect nonzero exit.
 *
 *  Family C (M11..M12): drift ONE byte in an OS-temp copy of a protected INPUT
 *    (M11: capability-inventory.json file content; M12: manifest content) and run
 *    the REAL runner via XJ_TASK24_MANIFEST_PATH / XJ_TASK24_PROTECTED_ROOT env
 *    overrides. KILLED when a healthy control run exits 0 + writes artifacts AND
 *    the one-byte-drift run exits nonzero with ZERO artifacts (drift-before-write).
 *
 * Determinism: mutation-result.json carries no volatile fields. Temp files removed.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve('D:\\xinjing-electron');
const HARNESS_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'pi-v4.3-pro-flagship-template-expected-red-24');
const RUNNER = path.join(HARNESS_DIR, 'run-contract.js');
const STORE_PATH = path.join(ROOT, 'app', 'js', 'store.js');
const ENT_PATH = path.join(ROOT, 'app', 'js', 'entitlements.js');
const STVM_PATH = path.join(ROOT, 'app', 'js', 'session-template-view-model.js');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'pi-v4.3-pro-flagship-template-expected-red-24', 'protected-files-manifest.json');
const CAPINV_REL = 'docs/agent-coordination/v5.0.0/inventory/codex-v4x-capability-gap/capability-inventory.json';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-task24-mut-'));
const results = [];

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

// tryMutant: run fn, return result or {__threw} on exception. A throw is a
// detectable behavioral difference (mutation KILLED), never a harness crash.
async function tryMutant(fn) {
  try { return await fn(); }
  catch (e) { return { __threw: e.message }; }
}
const threw = (r) => r && typeof r === 'object' && r.__threw !== undefined;

// ── vm loaders (identical semantics to run-contract.js) ──────────────────
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
      const pending = []; let scheduled = false;
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      function scheduleWrite() {
        if (scheduled) return; scheduled = true;
        setTimeout(() => {
          if (failWrites) { tx.error = new Error('synthetic durable write failure'); if (typeof tx.onerror === 'function') tx.onerror({ target: tx }); return; }
          pending.forEach((op) => { if (op.type === 'put') records.set(op.key, op.value); else records.delete(op.key); });
          if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
        }, 0);
      }
      tx.objectStore = () => ({
        get(key) { const r = { result: undefined, onsuccess: null, onerror: null }; setTimeout(() => { r.result = records.has(String(key)) ? { key: String(key), value: records.get(String(key)) } : undefined; if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; },
        getAll() { const r = { result: undefined, onsuccess: null, onerror: null }; setTimeout(() => { r.result = Array.from(records, ([k, v]) => ({ key: k, value: v })); if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; },
        put(rec) { pending.push({ type: 'put', key: String(rec.key), value: rec.value }); if (mode === 'readwrite') scheduleWrite(); return { onsuccess: null, onerror: null }; },
        delete(key) { pending.push({ type: 'delete', key: String(key) }); if (mode === 'readwrite') scheduleWrite(); return { onsuccess: null, onerror: null }; },
      });
      return tx;
    },
    close() {},
  };
  return {
    open() { const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null }; setTimeout(() => { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded({ target: req }); if (req.onsuccess) req.onsuccess({ target: req }); }, 0); return req; },
    deleteDatabase() { const r = { onsuccess: null, onerror: null }; setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; },
    setFailWrites(v) { failWrites = !!v; },
    read(key) { return records.get(String(key)); },
  };
}
const VM_GLOBALS = ['console', 'setTimeout', 'clearTimeout', 'Date', 'Math', 'JSON', 'Promise', 'Map', 'Set', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Error', 'RegExp'];
function loadStore(source, database) {
  const scope = { localStorage: memoryStorage(), indexedDB: database, location: { reload() {} } };
  VM_GLOBALS.forEach((g) => { scope[g] = global[g]; });
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(source + '\n;globalThis.__store = (typeof Store !== "undefined") ? Store : window.Store;', scope, { filename: 'store.js' });
  return { Store: scope.__store, scope };
}
function loadEntitlements(source) {
  const scope = { module: { exports: {} }, exports: {} };
  VM_GLOBALS.forEach((g) => { scope[g] = global[g]; });
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(source + '\n;globalThis.__ent = (typeof module !== "undefined" && module.exports) ? module.exports : globalThis.XJEntitlements;', scope, { filename: 'entitlements.js' });
  return scope.__ent;
}
function loadStvm(source) {
  const scope = { module: { exports: {} }, exports: {} };
  VM_GLOBALS.forEach((g) => { scope[g] = global[g]; });
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(source + '\n;globalThis.__stvm = (typeof module !== "undefined" && module.exports) ? module.exports : globalThis.SessionTemplateViewModel;', scope, { filename: 'session-template-view-model.js' });
  return scope.__stvm;
}

async function setupStore(Store) {
  await Store.hydrate();
  await Store.createClientDurable({ id: 'c-mut', name: 'Synth Mut' });
  await Store.createSessionDurable({ id: 's-mut', clientId: 'c-mut', sessionNumber: 1 });
  await Store.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual' });
  return 's-mut';
}

// realOk = real behaves correctly; mutantBad = mutant shows different/bad behavior
// (including throws). KILLED = realOk && mutantBad. SURVIVED = realOk && !mutantBad.
function record(id, title, realOk, mutantBad, realEv, mutEv) {
  let verdict, status;
  if (typeof realOk !== 'boolean' || typeof mutantBad !== 'boolean') { verdict = 'harness_error'; status = 'HARNESS_ERROR'; }
  else if (!realOk) { verdict = 'real_misbehavior'; status = 'HARNESS_ERROR'; }
  else if (mutantBad) { verdict = 'killed'; status = 'PASS'; }
  else { verdict = 'survived'; status = 'FAIL'; }
  results.push({ id, title, verdict, status, real_result: String(realOk) + ' (' + realEv + ')', mutated_result: String(mutantBad) + ' (' + mutEv + ')' });
  console.log('[' + status + '] ' + id + ' — ' + verdict + ' — ' + title);
  console.log('    real: ' + realEv + ' -> ' + realOk);
  console.log('    mutant: ' + mutEv + ' -> ' + mutantBad);
  if (verdict === 'survived') console.log('SURVIVOR: ' + id + ' — ' + title);
}

function writeTemp(name, source) { const p = path.join(TMP_ROOT, name); fs.writeFileSync(p, source, 'utf8'); return p; }

// ── Family A: production-module semantic mutations ───────────────────────
async function runSemanticProbes() {
  const storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
  const entSrc = fs.readFileSync(ENT_PATH, 'utf8');
  const stvmSrc = fs.readFileSync(STVM_PATH, 'utf8');

  // M1-FAKE-MODULE: bypass SessionTemplateViewModel tier filter
  {
    const anchor = 'return TIER_RANK[item.tier] <= TIER_RANK[current] && item.contexts.indexOf(context) >= 0;';
    const mutant = stvmSrc.replace(anchor, 'return true; /* MUTANT M1 bypass tier filter */');
    if (mutant === stvmSrc) { record('M1-FAKE-MODULE', 'fake module: bypass STVM tier filter', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m1-stvm.js', mutant);
      const realStvm = loadStvm(stvmSrc), mutStvm = loadStvm(mutant);
      const realList = realStvm.list({ tier: 'Free', context: 'individual' });
      const mutList = mutStvm.list({ tier: 'Free', context: 'individual' });
      const realIds = realList.ok ? realList.templates.map((t) => t.id).sort() : [];
      const mutIds = mutList.ok ? mutList.templates.map((t) => t.id).sort() : [];
      record('M1-FAKE-MODULE', 'fake module: bypass STVM tier filter (Free would list Pro/Flagship)',
        realIds.length === 1 && realIds[0] === 'manual-session-v1',
        mutIds.length === 3 && mutIds.indexOf('ai-session-v1') >= 0 && mutIds.indexOf('flagship-session-v1') >= 0,
        'Free ids=' + JSON.stringify(realIds), 'Free ids=' + JSON.stringify(mutIds));
    }
  }

  // M2-PROMOTE-TIER: unknown 'Flagship' entitlement tier promoted to custom
  {
    const anchor = "return Object.prototype.hasOwnProperty.call(TIER_RANK, value) ? value : 'free';";
    const mutant = entSrc.replace(anchor, "return (value === 'flagship') ? 'custom' : (Object.prototype.hasOwnProperty.call(TIER_RANK, value) ? value : 'free'); /* MUTANT M2 */");
    if (mutant === entSrc) { record('M2-PROMOTE-TIER', 'unknown tier promoted to custom', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m2-ent.js', mutant);
      const realEnt = loadEntitlements(entSrc), mutEnt = loadEntitlements(mutant);
      const realVal = realEnt.normalizeTier('Flagship'), mutVal = mutEnt.normalizeTier('Flagship');
      record('M2-PROMOTE-TIER', 'unknown tier promoted to custom (normalizeTier(Flagship) must fail-closed to free)',
        realVal === 'free', mutVal === 'custom',
        'normalizeTier(Flagship)=' + realVal, 'normalizeTier(Flagship)=' + mutVal);
    }
  }

  // M3-SWALLOW-FAILURE: saveSessionTemplateSelectionDurable swallows {ok:false}
  {
    const anchor = 'const result = await saveSessionDurable(Object.assign({}, session, { templateSelection: normalized }));\n    if (!result.ok) return result;';
    const mutant = storeSrc.replace(anchor, 'const result = await saveSessionDurable(Object.assign({}, session, { templateSelection: normalized }));\n    if (!result.ok) return { ok: true, value: normalized, session: session, version: 1 }; /* MUTANT M3 swallow */');
    if (mutant === storeSrc) { record('M3-SWALLOW-FAILURE', 'swallowed durable failure', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m3-store.js', mutant);
      const realDb = createIndexedDB(), mutDb = createIndexedDB();
      const realStore = loadStore(storeSrc, realDb).Store, mutStore = loadStore(mutant, mutDb).Store;
      await setupStore(realStore); await setupStore(mutStore);
      realDb.setFailWrites(true); mutDb.setFailWrites(true);
      const realRes = await realStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'ai-session-v1', tierAtSelection: 'Pro', context: 'individual' });
      const mutRes = await tryMutant(() => mutStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'ai-session-v1', tierAtSelection: 'Pro', context: 'individual' }));
      const realAuth = realStore.getSessionTemplateSelection('s-mut');
      record('M3-SWALLOW-FAILURE', 'swallowed durable failure (must surface {ok:false} and preserve authoritative)',
        realRes.ok === false && realAuth && realAuth.templateId === 'manual-session-v1',
        threw(mutRes) || mutRes.ok === true,
        'res.ok=' + realRes.ok + ' auth=' + (realAuth && realAuth.templateId), 'res=' + (threw(mutRes) ? 'threw:' + mutRes.__threw : 'ok=' + mutRes.ok));
    }
  }

  // M4-AWAIT-ORDER: cache updated before await (deleted-await / report-before-persist)
  {
    const anchor = 'await idbPut(\'sessions\', nextSessions, { allowFallback: false });\n      // The authoritative cache changes only after the transaction completes.\n      cache.sessions = nextSessions;';
    const mutant = storeSrc.replace(anchor, 'cache.sessions = nextSessions;\n      await idbPut(\'sessions\', nextSessions, { allowFallback: false });\n      /* MUTANT M4: cache before persist */');
    if (mutant === storeSrc) { record('M4-AWAIT-ORDER', 'deleted await / cache-before-persist', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m4-store.js', mutant);
      const realDb = createIndexedDB(), mutDb = createIndexedDB();
      const realStore = loadStore(storeSrc, realDb).Store, mutStore = loadStore(mutant, mutDb).Store;
      await setupStore(realStore); await setupStore(mutStore);
      realDb.setFailWrites(true); mutDb.setFailWrites(true);
      const realRes = await realStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'ai-session-v1', tierAtSelection: 'Pro', context: 'individual' });
      const mutRes = await tryMutant(() => mutStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'ai-session-v1', tierAtSelection: 'Pro', context: 'individual' }));
      const realAuth = realStore.getSessionTemplateSelection('s-mut');
      const mutAuth = mutStore.getSessionTemplateSelection('s-mut');
      record('M4-AWAIT-ORDER', 'deleted await / cache-before-persist (failed save must NOT update authoritative cache)',
        realRes.ok === false && realAuth && realAuth.templateId === 'manual-session-v1',
        threw(mutRes) || (mutAuth && mutAuth.templateId === 'ai-session-v1'),
        'res.ok=' + realRes.ok + ' auth=' + (realAuth && realAuth.templateId), 'res=' + (threw(mutRes) ? 'threw:' + mutRes.__threw : 'ok=' + mutRes.ok) + ' auth=' + (mutAuth && mutAuth.templateId));
    }
  }

  // M5-BYPASS-ENTRY: skip templateId rule lookup (accept unknown templateId)
  {
    const anchor = 'if (!rule || SESSION_TEMPLATE_TIER_RANK[tierAtSelection] === undefined) return null;';
    const mutant = storeSrc.replace(anchor, 'if (SESSION_TEMPLATE_TIER_RANK[tierAtSelection] === undefined) return null; /* MUTANT M5 skip rule check */');
    if (mutant === storeSrc) { record('M5-BYPASS-ENTRY', 'bypassed Store/template entry', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m5-store.js', mutant);
      const realDb = createIndexedDB(), mutDb = createIndexedDB();
      const realStore = loadStore(storeSrc, realDb).Store, mutStore = loadStore(mutant, mutDb).Store;
      await setupStore(realStore); await setupStore(mutStore);
      const realRes = await realStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'fake-template', tierAtSelection: 'Free', context: 'individual' });
      const mutRes = await tryMutant(() => mutStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'fake-template', tierAtSelection: 'Free', context: 'individual' }));
      record('M5-BYPASS-ENTRY', 'bypassed Store/template entry (unknown templateId must fail closed)',
        realRes.ok === false, threw(mutRes) || mutRes.ok === true,
        'fake-template ok=' + realRes.ok, 'fake-template ' + (threw(mutRes) ? 'threw:' + mutRes.__threw : 'ok=' + mutRes.ok));
    }
  }

  // M6-TIER-MISMATCH: skip tier/template rank check (Free persists Pro template)
  {
    const anchor = 'if (SESSION_TEMPLATE_TIER_RANK[tierAtSelection] < SESSION_TEMPLATE_TIER_RANK[rule.minimumTier]) return null;';
    const mutant = storeSrc.replace(anchor, '/* MUTANT M6: skip tier rank check */');
    if (mutant === storeSrc) { record('M6-TIER-MISMATCH', 'tier/template mismatch removed', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m6-store.js', mutant);
      const realDb = createIndexedDB(), mutDb = createIndexedDB();
      const realStore = loadStore(storeSrc, realDb).Store, mutStore = loadStore(mutant, mutDb).Store;
      await setupStore(realStore); await setupStore(mutStore);
      const realRes = await realStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'ai-session-v1', tierAtSelection: 'Free', context: 'individual' });
      const mutRes = await tryMutant(() => mutStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'ai-session-v1', tierAtSelection: 'Free', context: 'individual' }));
      record('M6-TIER-MISMATCH', 'tier/template mismatch removed (Free must not persist Pro template)',
        realRes.ok === false, threw(mutRes) || mutRes.ok === true,
        'Free+ai ok=' + realRes.ok, 'Free+ai ' + (threw(mutRes) ? 'threw:' + mutRes.__threw : 'ok=' + mutRes.ok));
    }
  }

  // M7-UNSAFE-CUSTOM: skip customTemplateId regex (accept unsafe custom id)
  {
    const anchor = "if (customTemplateId && (!rule.allowCustom || !/^[A-Za-z0-9._:-]{1,128}$/.test(customTemplateId))) return null;";
    const mutant = storeSrc.replace(anchor, 'if (customTemplateId && !rule.allowCustom) return null; /* MUTANT M7 skip regex */');
    if (mutant === storeSrc) { record('M7-UNSAFE-CUSTOM', 'unsafe customTemplateId allowed', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m7-store.js', mutant);
      const realDb = createIndexedDB(), mutDb = createIndexedDB();
      const realStore = loadStore(storeSrc, realDb).Store, mutStore = loadStore(mutant, mutDb).Store;
      await setupStore(realStore); await setupStore(mutStore);
      const realRes = await realStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', customTemplateId: '../bad' });
      const mutRes = await tryMutant(() => mutStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', customTemplateId: '../bad' }));
      record('M7-UNSAFE-CUSTOM', 'unsafe customTemplateId allowed (../bad must fail closed)',
        realRes.ok === false, threw(mutRes) || mutRes.ok === true,
        '../bad ok=' + realRes.ok, '../bad ' + (threw(mutRes) ? 'threw:' + mutRes.__threw : 'ok=' + mutRes.ok));
    }
  }

  // M8-BODY-FIELDS: hasClinicalBodyField always false (body-like fields accepted)
  {
    const anchor = 'return Object.keys(value).some((key) => CLINICAL_BODY_KEYS.has(key) || hasClinicalBodyField(value[key], seen));';
    const mutant = storeSrc.replace(anchor, 'return false; /* MUTANT M8 disable body-field detection */');
    if (mutant === storeSrc) { record('M8-BODY-FIELDS', 'body-like fields allowed', null, null, 'anchor missing', 'anchor missing'); }
    else {
      writeTemp('m8-store.js', mutant);
      const realDb = createIndexedDB(), mutDb = createIndexedDB();
      const realStore = loadStore(storeSrc, realDb).Store, mutStore = loadStore(mutant, mutDb).Store;
      await setupStore(realStore); await setupStore(mutStore);
      const realRes = await realStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', body: 'clinical narrative' });
      const mutRes = await tryMutant(() => mutStore.saveSessionTemplateSelectionDurable('s-mut', { templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', body: 'clinical narrative' }));
      record('M8-BODY-FIELDS', 'body-like clinical text allowed (body field must fail closed)',
        realRes.ok === false, threw(mutRes) || mutRes.ok === true,
        'body ok=' + realRes.ok, 'body ' + (threw(mutRes) ? 'threw:' + mutRes.__threw : 'ok=' + mutRes.ok));
    }
  }
}

// ── Family B: runner-lying mutations ─────────────────────────────────────
function runRunnerProbes() {
  const runnerSrc = fs.readFileSync(RUNNER, 'utf8');

  // M9-MISSING-ROW: remove the PRO-AI-GEN expected-red row (invariant expects >=4)
  {
    const anchor = "  check('PRO-AI-GEN',\n    'No production entry for AI-assisted session template content GENERATION (SessionTemplateViewModel exposes only static list/select/apply)',\n    hasGenFn === false,\n    'EXPECTED_RED', 'expected-red',\n    'stvmKeys=' + JSON.stringify(stvmKeys) + ' hasGenFn=' + hasGenFn);";
    const mutant = runnerSrc.replace(anchor, "  /* MUTANT M9: PRO-AI-GEN row removed */");
    if (mutant === runnerSrc) { record('M9-MISSING-ROW', 'missing required expected-red row', null, null, 'anchor missing', 'anchor missing'); }
    else {
      const tmpRunner = writeTemp('m9-runner.js', mutant);
      const tmpOut = path.join(TMP_ROOT, 'm9-out'); fs.mkdirSync(tmpOut, { recursive: true });
      const r = spawnSync('node', [tmpRunner], { cwd: ROOT, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { XJ_TASK24_OUT_DIR: tmpOut }) });
      const killed = r.status !== null && r.status !== 0 && !/SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(r.stderr || '');
      record('M9-MISSING-ROW', 'missing required expected-red row (runner invariant must fail)',
        true, killed, 'healthy runner exit 0', 'mutated exit=' + r.status + (r.stderr ? ' stderr=' + r.stderr.split('\n')[0].slice(0, 120) : ''));
    }
  }

  // M10-FLIP-CLASSIFICATION: flip PRO-AI-GEN from EXPECTED_RED to CONFIRMED
  {
    const anchor = "  check('PRO-AI-GEN',\n    'No production entry for AI-assisted session template content GENERATION (SessionTemplateViewModel exposes only static list/select/apply)',\n    hasGenFn === false,\n    'EXPECTED_RED', 'expected-red',";
    const mutant = runnerSrc.replace(anchor, "  check('PRO-AI-GEN',\n    'No production entry for AI-assisted session template content GENERATION (SessionTemplateViewModel exposes only static list/select/apply)',\n    hasGenFn === false,\n    'CONFIRMED', 'expected-red', /* MUTANT M10 flip */");
    if (mutant === runnerSrc) { record('M10-FLIP-CLASSIFICATION', 'altered expected-red classification', null, null, 'anchor missing', 'anchor missing'); }
    else {
      const tmpRunner = writeTemp('m10-runner.js', mutant);
      const tmpOut = path.join(TMP_ROOT, 'm10-out'); fs.mkdirSync(tmpOut, { recursive: true });
      const r = spawnSync('node', [tmpRunner], { cwd: ROOT, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { XJ_TASK24_OUT_DIR: tmpOut }) });
      const killed = r.status !== null && r.status !== 0 && !/SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(r.stderr || '');
      record('M10-FLIP-CLASSIFICATION', 'altered expected-red classification (runner invariant must fail)',
        true, killed, 'healthy runner exit 0', 'mutated exit=' + r.status + (r.stderr ? ' stderr=' + r.stderr.split('\n')[0].slice(0, 120) : ''));
    }
  }
}

// ── Family C: protected-input drift mutations (drift-before-write gates) ──
// Proves run-contract.js's two precondition gates (manifest byte-hash #1 and the
// nine per-file sha256 #2) fire with ZERO artifact writes on a one-byte drift in
// a protected input. Mutates OS-temp copies only; runs the REAL runner via env
// overrides. Each probe includes a healthy control run so the override mechanism
// itself is proven and a kill can never be a fake green from a broken override.
function runDriftProbes() {
  const manifestBuf = fs.readFileSync(MANIFEST_PATH); // exact bytes
  const manifestObj = JSON.parse(manifestBuf.toString('utf8'));

  function byteDiffBuf(a, b) {
    const n = Math.min(a.length, b.length);
    let d = 0;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
    return d + Math.abs(a.length - b.length);
  }
  function runRunner(env, outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    return spawnSync('node', [RUNNER], { cwd: ROOT, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, env) });
  }
  function artifactsPresent(outDir) {
    return fs.existsSync(path.join(outDir, 'contract-result.json')) || fs.existsSync(path.join(outDir, 'contract-matrix.json'));
  }
  function lastErrLine(r) {
    if (!r || !r.stderr) return '';
    const lines = r.stderr.split('\n').filter((l) => l.length > 0);
    return lines.length ? lines[lines.length - 1].slice(0, 110) : '';
  }

  // M11-PROTECTED-FILE-DRIFT: one-byte drift in a protected input file (the
  // EXACT Rework 1 scenario: capability-inventory.json changed after the 01:30
  // delivery) must force nonzero exit via the nine per-file hash gate (#2),
  // BEFORE any artifact write.
  {
    const healthyRoot = path.join(TMP_ROOT, 'm11-healthy-root');
    const driftRoot = path.join(TMP_ROOT, 'm11-drift-root');
    manifestObj.files.forEach((f) => {
      [healthyRoot, driftRoot].forEach((root) => {
        const dest = path.join(root, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(ROOT, f.path), dest);
      });
    });
    // drift: XOR low bit of byte[0] of the capability-inventory.json copy.
    const origCapInvBuf = fs.readFileSync(path.join(ROOT, CAPINV_REL));
    const driftCapInvBuf = Buffer.from(origCapInvBuf);
    driftCapInvBuf[0] = driftCapInvBuf[0] ^ 0x01; // one-byte content drift
    fs.writeFileSync(path.join(driftRoot, CAPINV_REL), driftCapInvBuf);
    const capInvOneByte = byteDiffBuf(origCapInvBuf, driftCapInvBuf) === 1;
    // temp manifest copy (byte-identical Buffer -> Gate #1 passes; Gate #2 catches drift)
    const tmpManifest = path.join(TMP_ROOT, 'm11-manifest.json');
    fs.writeFileSync(tmpManifest, manifestBuf);

    const healthyOut = path.join(TMP_ROOT, 'm11-healthy-out');
    const rh = runRunner({ XJ_TASK24_MANIFEST_PATH: tmpManifest, XJ_TASK24_PROTECTED_ROOT: healthyRoot, XJ_TASK24_OUT_DIR: healthyOut }, healthyOut);
    const healthyOk = rh.status === 0 && fs.existsSync(path.join(healthyOut, 'contract-result.json'));

    const driftOut = path.join(TMP_ROOT, 'm11-drift-out');
    const rd = runRunner({ XJ_TASK24_MANIFEST_PATH: tmpManifest, XJ_TASK24_PROTECTED_ROOT: driftRoot, XJ_TASK24_OUT_DIR: driftOut }, driftOut);
    const driftBlocked = rd.status !== null && rd.status !== 0 && !artifactsPresent(driftOut);

    record('M11-PROTECTED-FILE-DRIFT',
      'one-byte protected-input drift (capability-inventory.json, the Rework-1 drift target) forces nonzero exit before artifact writes (Gate #2 per-file hash)',
      healthyOk && capInvOneByte, driftBlocked,
      'healthy-root exit=' + rh.status + ' artifacts=' + fs.existsSync(path.join(healthyOut, 'contract-result.json')) + ' oneByte=' + capInvOneByte,
      'drift-root exit=' + rd.status + ' artifacts=' + artifactsPresent(driftOut) + (lastErrLine(rd) ? ' err=' + lastErrLine(rd) : ''));
  }

  // M12-MANIFEST-BYTE-DRIFT: one-byte drift in the manifest content (JSON-safe,
  // so JSON.parse succeeds and the byte-hash gate fires) must force nonzero exit
  // via the manifest byte-hash gate (#1, hard-coded MANIFEST_HASH), BEFORE any
  // artifact write.
  {
    const needle = Buffer.from('"task_id": "');
    const idx = manifestBuf.indexOf(needle);
    const valueByteIdx = idx + needle.length;
    const origByte = idx >= 0 ? manifestBuf[valueByteIdx] : -1;
    // flip 'X' (0x58) -> 'Y' (0x59) in the task_id value (ASCII region, JSON-safe)
    const driftManifestBuf = Buffer.from(manifestBuf);
    let driftValid = false, oneByte = false;
    if (idx >= 0 && origByte === 0x58) {
      driftManifestBuf[valueByteIdx] = 0x59;
      try { JSON.parse(driftManifestBuf.toString('utf8')); driftValid = true; } catch (_) { driftValid = false; }
      oneByte = byteDiffBuf(manifestBuf, driftManifestBuf) === 1;
    }
    const tmpManifestHealthy = path.join(TMP_ROOT, 'm12-manifest-healthy.json');
    const tmpManifestDrift = path.join(TMP_ROOT, 'm12-manifest-drift.json');
    fs.writeFileSync(tmpManifestHealthy, manifestBuf);
    fs.writeFileSync(tmpManifestDrift, driftManifestBuf);

    const healthyOut = path.join(TMP_ROOT, 'm12-healthy-out');
    const rh = runRunner({ XJ_TASK24_MANIFEST_PATH: tmpManifestHealthy, XJ_TASK24_OUT_DIR: healthyOut }, healthyOut);
    const healthyOk = rh.status === 0 && fs.existsSync(path.join(healthyOut, 'contract-result.json'));

    const driftOut = path.join(TMP_ROOT, 'm12-drift-out');
    const rd = runRunner({ XJ_TASK24_MANIFEST_PATH: tmpManifestDrift, XJ_TASK24_OUT_DIR: driftOut }, driftOut);
    const driftBlocked = rd.status !== null && rd.status !== 0 && !artifactsPresent(driftOut);

    record('M12-MANIFEST-BYTE-DRIFT',
      'one-byte manifest content drift (JSON-safe task_id X->Y) forces nonzero exit before artifact writes (Gate #1 manifest byte hash)',
      healthyOk && driftValid && oneByte, driftBlocked,
      'healthy-manifest exit=' + rh.status + ' artifacts=' + fs.existsSync(path.join(healthyOut, 'contract-result.json')) + ' driftValid=' + driftValid + ' oneByte=' + oneByte,
      'drift-manifest exit=' + rd.status + ' artifacts=' + artifactsPresent(driftOut) + (lastErrLine(rd) ? ' err=' + lastErrLine(rd) : ''));
  }
}

// ── main ─────────────────────────────────────────────────────────────────
(async function main() {
  console.log('XJ-5.0.0 task 24 — mutation-probes.js');
  console.log('temp root: ' + TMP_ROOT);
  console.log('runner hash: ' + sha256(RUNNER));
  console.log('store.js hash: ' + sha256(STORE_PATH));
  console.log('entitlements.js hash: ' + sha256(ENT_PATH));
  console.log('session-template-view-model.js hash: ' + sha256(STVM_PATH));
  console.log('----------------------------------------');
  await runSemanticProbes();
  runRunnerProbes();
  runDriftProbes();
  console.log('----------------------------------------');

  const killed = results.filter((r) => r.verdict === 'killed').length;
  const survived = results.filter((r) => r.verdict === 'survived').length;
  const herrors = results.filter((r) => r.verdict === 'harness_error' || r.verdict === 'real_misbehavior').length;
  console.log('Mutation probes: killed=' + killed + ' survived=' + survived + ' errors=' + herrors);

  const out = {
    schema_version: 1,
    task_id: 'XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24',
    probe_count: results.length,
    killed, survived, harness_errors: herrors,
    all_killed: survived === 0 && herrors === 0,
    runner_hash: sha256(RUNNER),
    store_hash: sha256(STORE_PATH),
    entitlements_hash: sha256(ENT_PATH),
    stvm_hash: sha256(STVM_PATH),
    probes: results.map((r) => ({ id: r.id, title: r.title, verdict: r.verdict, status: r.status, real_result: r.real_result, mutated_result: r.mutated_result })),
  };
  fs.writeFileSync(path.join(HARNESS_DIR, 'mutation-result.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote: ' + path.join(HARNESS_DIR, 'mutation-result.json'));

  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); console.log('cleaned temp root: ' + TMP_ROOT); }
  catch (e) { console.log('temp cleanup warning: ' + e.message); }

  process.exit(survived === 0 && herrors === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
