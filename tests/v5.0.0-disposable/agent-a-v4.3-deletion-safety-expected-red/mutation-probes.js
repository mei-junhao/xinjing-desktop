'use strict';
/**
 * XJ-5.0.0 v4.3 Deletion-Safety Expected-Red — Mutation Probes (repair-16)
 *
 * Two probe families:
 *  - M1..M10: harness-lying mutations (fabricated CONFIRMED rows, weakened
 *    hash checks). Each must produce a nonzero runner exit.
 *  - MS1..MS7, MSX: SEMANTIC REVERSE MUTATIONS against production behavior
 *    at the Store API boundary. Clearing / removing / rebinding the origin
 *    reference, dropping quarantine entries, no-op success replacements and
 *    swallowed {ok:false} must each cause a nonzero exit for the
 *    corresponding semantic assertion (R10 / R11). MSX additionally proves
 *    that forcing exit zero after a semantic failure is detected via
 *    stdout/exit-code cross-check.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

var RUNNER = path.join(__dirname, 'run-contract.js');
var TMP_DIR = __dirname;
var results = [];

var STORE_ANCHOR = 'var Store = global.window.Store;';
var EXIT_ANCHOR = 'process.exit(failedCount === 0 ? 0 : 1);';

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }
function runSrc(src) {
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + (results.length + 1) + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  return spawnSync('node', [tmpFile], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
}
function assertMutated(before, after, id) {
  if (before === after) {
    console.log('[HARNESS_ERROR] ' + id + ' — mutation anchor not found, probe is vacuous');
    results.push({ id: id, title: 'anchor missing', verdict: 'harness_error', status: 'HARNESS_ERROR' });
    return false;
  }
  return true;
}
function record(id, title, src, before) {
  if (!assertMutated(before, src, id)) return;
  var r = runSrc(src);
  var verdict;
  if (r.status === null || /SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(r.stderr || '')) verdict = 'harness_error';
  else if (r.status !== 0) verdict = 'killed';
  else verdict = 'survived';
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL');
  results.push({ id: id, title: title, verdict: verdict, status: status });
  console.log('[' + status + '] ' + id + ' — ' + verdict + ' — ' + title);
  if (verdict === 'survived') console.log('SURVIVOR: ' + id + ' — ' + title);
}
// MSX-style probe: mutant forces exit 0; killed if framework detects the lie
// (stdout contains a FAIL row while exit code is 0).
function recordExitZero(id, title, src, before) {
  if (!assertMutated(before, src, id)) return;
  var r = runSrc(src);
  var verdict;
  if (r.status === null || /SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(r.stderr || '')) verdict = 'harness_error';
  else if (r.status !== 0) verdict = 'killed';
  else if (/\[FAIL\]/.test(r.stdout || '')) verdict = 'killed'; // lie observable: FAIL rows with exit 0
  else verdict = 'survived';
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL');
  results.push({ id: id, title: title, verdict: verdict, status: status });
  console.log('[' + status + '] ' + id + ' — ' + verdict + ' — ' + title);
  if (verdict === 'survived') console.log('SURVIVOR: ' + id + ' — ' + title);
}
function semantic(id, title, patchCode) {
  var before = loadRunner();
  var src = before.replace(STORE_ANCHOR, STORE_ANCHOR + '\n' + patchCode);
  record(id, title, src, before);
}

try {
  // CAL: healthy runner must pass before mutations
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  console.log('[' + (r.status === 0 ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (r.status === 0 ? 'PASS' : 'BROKEN'));
  if (r.status !== 0) process.exit(1);

  // ── Family 1: harness-lying mutations ──
  var b1 = loadRunner();
  record('M1', 'Fabricate missing API as confirmed', b1.replace(
    "check('P2_' + api, 'Store has ' + api + ' (absent = EXPECTED_RED gap)', typeof Store[api] !== 'function', 'EXPECTED_RED');",
    "check('P2_' + api, 'Store has ' + api, false, 'CONFIRMED'); /* MUTANT M1 */"
  ), b1);

  var b2 = loadRunner();
  record('M2', 'Omit one matrix row (R9)', b2.replace(
    "check('R9', 'getDeletionQuarantine lists quarantined references', typeof Store.getDeletionQuarantine !== 'function', 'EXPECTED_RED');",
    "check('R9_FAB', 'fabricated R9', false, 'CONFIRMED'); /* MUTANT M2 */"
  ), b2);

  var b3 = loadRunner();
  record('M3', 'Accept stale preview as confirmed', b3.replace(
    "check('R3', 'stale previewHash rejected (fail closed)', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');",
    "check('R3_FAB', 'fabricated R3', false, 'CONFIRMED'); /* MUTANT M3 */"
  ), b3);

  var b4 = loadRunner();
  record('M4', 'Fabricate R10 origin-preservation row', b4.replace(
    "check('R10', 'clinical-task originSessionId preserved after real session deletion (created, durably deleted, re-read; not deleted, cleared or rebound)', r10Pass, 'CONFIRMED');",
    "check('R10_FAB', 'fabricated R10', false, 'CONFIRMED'); /* MUTANT M4 */"
  ), b4);

  var b5 = loadRunner();
  record('M5', 'Classify physical cascade as tombstone', b5.replace(
    "check('R4', 'createDeletionBatch tombstones target and owned objects', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');",
    "check('R4_FAB', 'fabricated R4', false, 'CONFIRMED'); /* MUTANT M5 */"
  ), b5);

  var b6 = loadRunner();
  record('M6', 'Swallow persistence failure as confirmed', b6.replace(
    "check('R12', 'persistence failure returns {ok:false} without partial write', typeof Store.saveClinicalTasksDurable === 'function', 'EXPECTED_RED');",
    "check('R12_FAB', 'fabricated R12', false, 'CONFIRMED'); /* MUTANT M6 */"
  ), b6);

  var b7 = loadRunner();
  record('M7', 'Report success before persistence', b7.replace(
    "check('R13', 'batch creation failure leaves no active partial batch', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');",
    "check('R13_FAB', 'fabricated R13', false, 'CONFIRMED'); /* MUTANT M7 */"
  ), b7);

  var b8 = loadRunner();
  record('M8', 'Fabricate R11 quarantine row', b8.replace(
    "check('R11', 'real import quarantines synthetic orphan originSessionId (reason recorded, orphan excluded, valid task kept)', r11Pass, 'CONFIRMED');",
    "check('R11_FAB', 'fabricated R11', false, 'CONFIRMED'); /* MUTANT M8 */"
  ), b8);

  var b9 = loadRunner();
  record('M9', 'Weaken protected hashes', b9.replace(
    "check('P1_' + f.path.replace(/[^a-z0-9]/gi, '_').substring(0, 40), 'protected hash: ' + f.path, actual === f.sha256, 'CONFIRMED');",
    "check('P1_FAB', 'weakened hash check', false, 'CONFIRMED'); /* MUTANT M9 */"
  ), b9);

  var b10 = loadRunner();
  record('M10', 'Fabricate Store-loaded row (P2A)', b10.replace(
    "check('P2A', 'real Store module loaded (not a copy)', typeof Store === 'object' && Store !== null, 'CONFIRMED');",
    "check('P2A_FAB', 'fabricated P2A', false, 'CONFIRMED'); /* MUTANT M10 */"
  ), b10);

  // ── Family 2: semantic reverse mutations against production behavior ──
  semantic('MS1', 'Clear originSessionId at API boundary (semantic: cleared origin must fail R10)',
    "var __g1 = Store.getClinicalTasks.bind(Store); Store.getClinicalTasks = function(){ return __g1().map(function(t){ t.originSessionId = ''; return t; }); }; /* MUTANT MS1 */");

  semantic('MS2', 'Remove the clinical task after deletion (semantic: removed task must fail R10)',
    "var __g2 = Store.getClinicalTasks.bind(Store); Store.getClinicalTasks = function(){ return __g2().filter(function(t){ return t.id !== 'wb-task-R10'; }); }; /* MUTANT MS2 */");

  semantic('MS3', 'Rebind originSessionId to another session (semantic: rebound origin must fail R10)',
    "var __g3 = Store.getClinicalTasks.bind(Store); Store.getClinicalTasks = function(){ return __g3().map(function(t){ if (t.id === 'wb-task-R10') t.originSessionId = 'wb-sess-other'; return t; }); }; /* MUTANT MS3 */");

  semantic('MS4', 'Drop quarantine entries (semantic: dropped quarantine must fail R11)',
    "var __i4 = Store.importAll.bind(Store); Store.importAll = async function(s){ var r = await __i4(s); return { ok: r.ok, quarantine: [] }; }; Store.getImportQuarantine = function(){ return []; }; /* MUTANT MS4 */");

  semantic('MS5', 'Task-card false-green repro: deleteSessionDurable + getClinicalTasks no-op success',
    "Store.deleteSessionDurable = async function(){ return { ok: true }; }; Store.getClinicalTasks = function(){ return []; }; /* MUTANT MS5 */");

  semantic('MS6', 'Task-card false-green repro: importAll no-op success',
    "Store.importAll = async function(){ return { ok: true, quarantine: [] }; }; /* MUTANT MS6 */");

  semantic('MS7', 'Swallowed {ok:false}: deletion reports failure and does not delete',
    "Store.deleteSessionDurable = async function(){ return { ok: false, error: { code: 'SYNTH_FAIL' } }; }; /* MUTANT MS7 */");

  // MSX: semantic failure + forced exit zero must be observable
  var bx = loadRunner();
  var srcX = bx
    .replace(STORE_ANCHOR, STORE_ANCHOR + "\nvar __gx = Store.getClinicalTasks.bind(Store); Store.getClinicalTasks = function(){ return __gx().map(function(t){ t.originSessionId = ''; return t; }); }; /* MUTANT MSX */")
    .replace(EXIT_ANCHOR, 'process.exit(0); /* MUTANT MSX forced zero */');
  recordExitZero('MSX', 'Force exit zero after semantic failure (must be detected via stdout/exit cross-check)', srcX, bx);

  // Re-run healthy runner last to restore correct contract-result.json
  var healthyRerun = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  if (healthyRerun.status !== 0) {
    console.log('[ERROR] Healthy re-run failed after mutations');
    process.exit(1);
  }
  console.log('[OK] Healthy re-run: contract-result.json restored');

} catch (e) {
  console.log('HARNESS_ERROR: ' + e.message);
  results.push({ id: 'FRAMEWORK', title: 'exception', verdict: 'harness_error', status: 'HARNESS_ERROR' });
} finally {
  try {
    var tmps = fs.readdirSync(TMP_DIR).filter(function(f) { return f.indexOf('mutated-runner-') === 0; });
    tmps.forEach(function(f) { fs.unlinkSync(path.join(TMP_DIR, f)); });
  } catch(e) {}
}

console.log('----------------------------------------');
var passCount = results.filter(function(x) { return x.status === 'PASS'; }).length;
var failCount = results.filter(function(x) { return x.status === 'FAIL'; }).length;
var errCount = results.filter(function(x) { return x.status === 'HARNESS_ERROR'; }).length;
console.log('Mutant total=' + results.length + '  PASS=' + passCount + '  FAIL=' + failCount + '  HARNESS_ERROR=' + errCount);
console.log(errCount === 0 && failCount === 0 && results.length === 18 ? 'mutation_phase: ALL-MUTATIONS-KILLED' : 'mutation_phase: SURVIVORS_FOUND');
process.exit(failCount === 0 && errCount === 0 && results.length === 18 ? 0 : 1);
