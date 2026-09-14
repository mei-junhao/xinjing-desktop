'use strict';
/**
 * XJ-5.0.0 Pi 4.4 Controlled Supervision Package Expected-Red — Artifact Verifier (task 28)
 *
 * Independent verifier. Re-derives whether the harness artifacts are a clean
 * EXPECTED_RED result FROM THE ARTIFACT DATA ITSELF — never trusts run-contract.js's
 * exit code. This is the non-circular backstop for mutation M12 (a mutant that forces
 * process.exit(0) after a semantic failure still writes a bad result; this verifier
 * reads the result, detects pass=false / invariant=false, and exits nonzero).
 *
 * Verifies, against the REAL protected manifest + REAL project root:
 *   1. protected-files manifest byte hash + all ten per-file hashes (exit 1 on mismatch)
 *   2. contract-result.json internal consistency: recounted counts == recorded counts,
 *      failed===0, overall===EXPECTED_RED, EVERY check.pass===true, all invariants true
 *      and independently re-derived, no CONFIRMED label matches the false-runtime regex,
 *      module_hashes recomputed from real files match the recorded hashes,
 *      protected_files_manifest_sha256 + base_commit match the real manifest.
 *   3. contract-matrix.json: row count matches, every EXPECTED_RED row's
 *      production_entry_point begins with "NO PRODUCTION ENTRY" (no false confirmed
 *      runtime), every CONFIRMED row's entry point is a real production surface.
 *   4. mutation-result.json (when present in the verify dir): every probe killed,
 *      killed count >= minimum_required, no survivors.
 *   5. non-exposure: deep secret-marker scan over all artifacts (exit 1 on any hit).
 *
 * Env override (used ONLY by mutation-probes.js M12 against a temp out dir):
 *   XJ_TASK28_VERIFY_OUT_DIR — directory holding the artifacts to verify
 *                              (default: this harness directory).
 *
 * Determinism: prints artifact SHA-256 diagnostics to stdout; exits 0 only on full
 * independent pass. Contains no volatile fields itself.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve('D:\\xinjing-electron');
const HARNESS_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'pi-v4.4-controlled-supervision-package-expected-red-28');
const VERIFY_DIR = process.env.XJ_TASK28_VERIFY_OUT_DIR ? path.resolve(process.env.XJ_TASK28_VERIFY_OUT_DIR) : HARNESS_DIR;
const MANIFEST_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'pi-v4.4-controlled-supervision-package-expected-red-28', 'protected-files-manifest.json');
const EXPECTED_MANIFEST_HASH = '5941356B7B24CB1D24A6B6A011C37E024F4763A13BBFB4E91263B28115A18033';
const EXPECTED_BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const TASK_ID = 'XJ-5.0.0-pi-v4.4-controlled-supervision-package-expected-red-28';

const ENT_PATH = path.join(ROOT, 'app', 'js', 'entitlements.js');
const CSM_PATH = path.join(ROOT, 'app', 'js', 'commercial-state-machine.js');
const LIC_PATH = path.join(ROOT, 'license-core.js');
const MAIN_PATH = path.join(ROOT, 'main.js');
const PRELOAD_PATH = path.join(ROOT, 'preload.js');

const FALSE_RUNTIME_RE = /XJSUP parser|canonical manifest|signature-before-decrypt|envelope unwrap|install\/run API|typed IPC|wiring|author-key|online revocation|provider policy|plaintext non-exposure/i;
const SECRET_MARKERS = ['PRIVATE KEY', 'BEGIN PRIVATE', 'BEGIN ENCRYPTED', 'authorPrivateKey', 'devicePrivateKey', '-----BEGIN'];

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function sha256Str(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase(); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

let errors = 0;
function fail(msg) { errors++; console.error('[VERIFY-FAIL] ' + msg); }
function ok(msg) { console.log('[VERIFY-OK] ' + msg); }

function deepSecretScan(obj) {
  const found = [];
  const visit = (v) => {
    if (typeof v === 'string') SECRET_MARKERS.forEach((mk) => { if (v.indexOf(mk) !== -1) found.push(mk); });
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(obj);
  return found;
}

// ── 1. Protected manifest + per-file hashes (REAL manifest/root) ─────────────
const manifestBytes = fs.readFileSync(MANIFEST_PATH);
const manifestByteHash = crypto.createHash('sha256').update(manifestBytes).digest('hex').toUpperCase();
if (manifestByteHash !== EXPECTED_MANIFEST_HASH) {
  fail('protected manifest byte hash mismatch: ' + manifestByteHash + ' != ' + EXPECTED_MANIFEST_HASH);
} else {
  ok('protected manifest byte hash verified (' + manifestByteHash.slice(0, 12) + '...)');
}
const manifest = readJson(MANIFEST_PATH);
let protectedFailures = 0;
manifest.files.forEach((f) => {
  const p = path.join(ROOT, f.path);
  const actual = fs.existsSync(p) ? sha256(p) : 'MISSING';
  if (actual !== f.sha256.toUpperCase()) {
    protectedFailures++;
    fail('protected hash mismatch: ' + f.path + ' -> ' + actual + ' != ' + f.sha256.toUpperCase());
  }
});
if (protectedFailures === 0) ok('all ' + manifest.files.length + ' protected per-file hashes verified');

// ── 2. contract-result.json independent re-derivation ───────────────────────
const resultPath = path.join(VERIFY_DIR, 'contract-result.json');
const matrixPath = path.join(VERIFY_DIR, 'contract-matrix.json');
const mutResultPath = path.join(VERIFY_DIR, 'mutation-result.json');

let result = null;
try { result = readJson(resultPath); } catch (e) { fail('cannot read contract-result.json: ' + e.message); }
let matrix = null;
try { matrix = readJson(matrixPath); } catch (e) { fail('cannot read contract-matrix.json: ' + e.message); }

if (result) {
  // identity / provenance
  if (result.task_id !== TASK_ID) fail('result task_id mismatch: ' + result.task_id);
  if (result.base_commit !== EXPECTED_BASE_COMMIT) fail('result base_commit mismatch: ' + result.base_commit);
  if (result.protected_files_manifest_sha256 !== EXPECTED_MANIFEST_HASH) fail('result manifest hash mismatch: ' + result.protected_files_manifest_sha256);
  if (result.overall !== 'EXPECTED_RED') fail('result overall must be EXPECTED_RED, got ' + result.overall);

  // every check must pass
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const nonPass = checks.filter((c) => c.pass !== true);
  if (nonPass.length > 0) fail(nonPass.length + ' check(s) have pass!==true: ' + nonPass.map((c) => c.id).join(','));
  else ok('all ' + checks.length + ' result checks have pass===true');

  // recount classifications
  const recounted = { CONFIRMED: 0, EXPECTED_RED: 0, UNVERIFIED: 0, failed: 0 };
  checks.forEach((c) => {
    if (c.pass !== true) recounted.failed++;
    if (c.classification === 'CONFIRMED') recounted.CONFIRMED++;
    else if (c.classification === 'EXPECTED_RED') recounted.EXPECTED_RED++;
    else if (c.classification === 'UNVERIFIED') recounted.UNVERIFIED++;
    else fail('unknown classification ' + c.classification + ' on ' + c.id);
  });
  if (recounted.CONFIRMED !== result.confirmed) fail('recounted confirmed ' + recounted.CONFIRMED + ' != recorded ' + result.confirmed);
  if (recounted.EXPECTED_RED !== result.expected_red) fail('recounted expected_red ' + recounted.EXPECTED_RED + ' != recorded ' + result.expected_red);
  if (recounted.UNVERIFIED !== result.unverified) fail('recounted unverified ' + recounted.UNVERIFIED + ' != recorded ' + result.unverified);
  if (recounted.failed !== result.failed) fail('recounted failed ' + recounted.failed + ' != recorded ' + result.failed);
  if (result.failed !== 0) fail('result.failed must be 0, got ' + result.failed);
  else ok('counts independently re-derived and match: confirmed=' + recounted.CONFIRMED + ' expected_red=' + recounted.EXPECTED_RED + ' failed=0');

  // expected-red floor
  if (!(result.expected_red >= 11)) fail('expected_red must be >= 11, got ' + result.expected_red);

  // no false confirmed runtime (independent re-check)
  const falseRuntimeConfirmed = checks.filter((c) => c.classification === 'CONFIRMED' && FALSE_RUNTIME_RE.test(c.label));
  if (falseRuntimeConfirmed.length > 0) fail('CONFIRMED check(s) match false-runtime regex: ' + falseRuntimeConfirmed.map((c) => c.id).join(','));
  else ok('no CONFIRMED check label matches false-runtime regex (noFalseConfirmedRuntime independently confirmed)');

  // no expected-red row promoted away from EXPECTED_RED
  const promoted = checks.filter((c) => c.category === 'expected-red' && c.classification !== 'EXPECTED_RED');
  if (promoted.length > 0) fail('expected-red category row(s) promoted: ' + promoted.map((c) => c.id).join(','));
  else ok('no expected-red row promoted (noExpectedRedPromoted independently confirmed)');

  // invariants independently re-derived and all true
  const expectedRedAllGreen = checks.filter((c) => c.classification === 'EXPECTED_RED').every((c) => c.pass === true);
  const confirmedAllGreen = checks.filter((c) => c.classification === 'CONFIRMED').every((c) => c.pass === true);
  const inv = {
    totalRowsAtLeast12: checks.length >= 12,
    confirmedRealExecuted: confirmedAllGreen,
    expectedRedAtLeastOne: recounted.EXPECTED_RED >= 1,
    expectedRedAtLeast11: recounted.EXPECTED_RED >= 11,
    noExpectedRedPromoted: promoted.length === 0,
    expectedRedAllGreen: expectedRedAllGreen,
    noFalseConfirmedRuntime: falseRuntimeConfirmed.length === 0,
    zeroFailed: recounted.failed === 0,
    csmPureLogicNotWired: true, // re-derived from matrix below (wiring row)
  };
  const recordedInv = result.invariants || {};
  Object.keys(inv).forEach((k) => {
    if (recordedInv[k] !== true) fail('recorded invariant ' + k + ' is not true (' + recordedInv[k] + ')');
    if (inv[k] !== true) fail('independently re-derived invariant ' + k + ' is not true');
  });
  if (errors === 0) ok('all ' + Object.keys(inv).length + ' invariants independently re-derived and true');

  // module_hashes recomputed from real files
  const realModuleHashes = {
    'entitlements.js': sha256(ENT_PATH),
    'commercial-state-machine.js': sha256(CSM_PATH),
    'license-core.js': sha256(LIC_PATH),
    'main.js': sha256(MAIN_PATH),
    'preload.js': sha256(PRELOAD_PATH),
  };
  const recordedHashes = result.module_hashes || {};
  let hashMismatch = false;
  Object.keys(realModuleHashes).forEach((k) => {
    if (recordedHashes[k] !== realModuleHashes[k]) { fail('module_hash ' + k + ' mismatch: recorded ' + recordedHashes[k] + ' != real ' + realModuleHashes[k]); hashMismatch = true; }
  });
  if (!hashMismatch) ok('module_hashes recomputed from real files match recorded (result provenanced from real modules)');

  // row_counts re-derived
  const rc = { total: checks.length, positive: 0, fail_closed: 0, boundary: 0, trial_quota: 0, expected_red: 0 };
  checks.forEach((c) => {
    if (c.category === 'positive') rc.positive++;
    else if (c.category === 'fail-closed') rc.fail_closed++;
    else if (c.category === 'boundary') rc.boundary++;
    else if (c.category === 'trial-quota') rc.trial_quota++;
    else if (c.category === 'expected-red') rc.expected_red++;
  });
  const recordedRc = result.row_counts || {};
  Object.keys(rc).forEach((k) => { if (recordedRc[k] !== rc[k]) fail('row_counts.' + k + ' recorded ' + recordedRc[k] + ' != re-derived ' + rc[k]); });
  if (errors === 0) ok('row_counts independently re-derived and match: ' + JSON.stringify(rc));

  // non-exposure scan on result
  const resultSecrets = deepSecretScan(result);
  if (resultSecrets.length > 0) fail('secret-like material in contract-result.json: ' + JSON.stringify(resultSecrets));
}

// ── 3. contract-matrix.json independent checks ──────────────────────────────
if (matrix) {
  if (matrix.task_id !== TASK_ID) fail('matrix task_id mismatch: ' + matrix.task_id);
  const rows = Array.isArray(matrix.rows) ? matrix.rows : [];
  if (result && rows.length !== (result.checks || []).length) fail('matrix row count ' + rows.length + ' != result check count ' + (result.checks || []).length);
  const noEntry = rows.filter((r) => r.classification === 'EXPECTED_RED' && !String(r.production_entry_point).startsWith('NO PRODUCTION ENTRY'));
  if (noEntry.length > 0) fail('EXPECTED_RED matrix row(s) lack NO PRODUCTION ENTRY: ' + noEntry.map((r) => r.id).join(','));
  else ok('all EXPECTED_RED matrix rows carry NO PRODUCTION ENTRY (no false confirmed runtime in matrix)');
  const fakeConfirmed = rows.filter((r) => r.classification === 'CONFIRMED' && String(r.production_entry_point).startsWith('NO PRODUCTION ENTRY'));
  if (fakeConfirmed.length > 0) fail('CONFIRMED matrix row(s) wrongly carry NO PRODUCTION ENTRY: ' + fakeConfirmed.map((r) => r.id).join(','));
  // CSM wiring row must be EXPECTED_RED with NO PRODUCTION ENTRY (csmPureLogicNotWired)
  const wiringRow = rows.find((r) => r.id === 'E-CSM-WIRING');
  if (!wiringRow) fail('matrix missing E-CSM-WIRING row');
  else if (wiringRow.classification !== 'EXPECTED_RED' || !String(wiringRow.production_entry_point).startsWith('NO PRODUCTION ENTRY')) fail('E-CSM-WIRING must be EXPECTED_RED / NO PRODUCTION ENTRY');
  else ok('E-CSM-WIRING is EXPECTED_RED / NO PRODUCTION ENTRY (csmPureLogicNotWired confirmed in matrix)');
  // non-exposure scan on matrix
  const matrixSecrets = deepSecretScan(matrix);
  if (matrixSecrets.length > 0) fail('secret-like material in contract-matrix.json: ' + JSON.stringify(matrixSecrets));
}

// ── 4. mutation-result.json (when present in verify dir) ────────────────────
if (fs.existsSync(mutResultPath)) {
  try {
    const mr = readJson(mutResultPath);
    if (mr.task_id !== TASK_ID) fail('mutation-result task_id mismatch: ' + mr.task_id);
    const probes = Array.isArray(mr.probes) ? mr.probes : [];
    const survivors = probes.filter((p) => p.killed !== true);
    if (survivors.length > 0) fail('mutation-result has ' + survivors.length + ' survivor(s): ' + survivors.map((p) => p.id).join(','));
    const minReq = mr.minimum_required || 12;
    if (probes.length < minReq) fail('mutation-result probe count ' + probes.length + ' < minimum_required ' + minReq);
    if (!(mr.killed_count >= minReq)) fail('mutation-result killed_count ' + mr.killed_count + ' < minimum_required ' + minReq);
    if (mr.overall !== 'ALL_KILLED') fail('mutation-result overall must be ALL_KILLED, got ' + mr.overall);
    if (survivors.length === 0 && mr.killed_count >= minReq) ok('mutation-result: ' + mr.killed_count + '/' + probes.length + ' probes killed, >= ' + minReq + ' required, ALL_KILLED');
    // non-exposure scan on mutation-result
    const mrSecrets = deepSecretScan(mr);
    if (mrSecrets.length > 0) fail('secret-like material in mutation-result.json: ' + JSON.stringify(mrSecrets));
  } catch (e) {
    fail('cannot read/parse mutation-result.json: ' + e.message);
  }
} else {
  console.log('[VERIFY-NOTE] mutation-result.json not present in verify dir (skipped; expected for M12 temp-dir probe)');
}

// ── 5. Artifact SHA-256 diagnostics (for the report; not gated) ─────────────
const artifactPaths = {
  'run-contract.js': path.join(HARNESS_DIR, 'run-contract.js'),
  'contract-result.json': path.join(HARNESS_DIR, 'contract-result.json'),
  'contract-matrix.json': path.join(HARNESS_DIR, 'contract-matrix.json'),
  'mutation-probes.js': path.join(HARNESS_DIR, 'mutation-probes.js'),
  'verify-artifacts.js': path.join(HARNESS_DIR, 'verify-artifacts.js'),
  'mutation-result.json': path.join(HARNESS_DIR, 'mutation-result.json'),
};
console.log('--- artifact SHA-256 (real harness dir) ---');
Object.keys(artifactPaths).forEach((name) => {
  const p = artifactPaths[name];
  if (fs.existsSync(p)) console.log('  ' + name + ' = ' + sha256(p));
  else console.log('  ' + name + ' = <missing>');
});

// ── summary + exit ──────────────────────────────────────────────────────────
if (errors > 0) {
  console.error('verify-artifacts.js FAILED with ' + errors + ' error(s).');
  process.exit(1);
}
console.log('verify-artifacts.js PASSED: artifacts are a clean, internally-consistent EXPECTED_RED result provenanced from real protected modules.');
process.exit(0);
