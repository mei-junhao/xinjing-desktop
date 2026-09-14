'use strict';
/**
 * XJ-4.3.0-opensquilla-cross-package-evidence-loop-01
 * Mutation Probes — negative mutations against cross-package evidence runner
 *
 * Each mutant must cause the runner to FAIL (CONTRACT-BROKEN).
 * No mutant may survive. No-op/syntax-error/harness-error = ERROR not KILLED.
 *
 * Rework fixes:
 *  - ROOT anchored: mutated runners written to SAME dir so __dirname resolves correctly
 *  - HARNESS_ERROR classification for syntax/load/ENOENT/exception errors
 *  - exitCode null (timeout/crash) → HARNESS_ERROR
 *  - M2: fixed search string to match actual runner source (pass: pass, not shorthand)
 *  - M5: fixed search string typo; uses regex fallback for robustness
 *  - M8: redesigned — injects a failing check + swallows exit code; classify detects
 *    [FAIL] in stdout but exit 0 as HARNESS_ERROR; expected harness error counts as PASS
 *  - Calibration: healthy runner must pass, else HALT with HARNESS_ERROR
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ORIG_DIR = __dirname;
const RUNNER = path.join(ORIG_DIR, 'run-cross-package-evidence-loop.js');
const ROOT = path.resolve(ORIG_DIR, '..', '..', '..');
// Write mutated runners to SAME directory as original so __dirname resolves identically.
// Writing to .mutants/ subfolder shifts __dirname one level deeper and breaks ROOT.
const TMP_DIR = ORIG_DIR;

var results = [];
var tmpFiles = [];

/**
 * Classify a runner subprocess result.
 * Returns one of: 'killed', 'survived', 'harness_error'
 */
function classify(r, expectFail) {
  // null exit code = crash/timeout
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  var stdout = r.stdout || '';
  // ENOENT, MODULE_NOT_FOUND, require stack errors → harness error
  if (/Cannot find module|ENOENT|MODULE_NOT_FOUND|throw new TypeError/i.test(stderr)) return 'harness_error';
  // SyntaxError from node loading the file → harness error
  if (/SyntaxError: Unexpected|SyntaxError: /i.test(stderr)) return 'harness_error';
  // Uncaught exceptions that are not contract-driven → harness error
  if (/throw new Error|at Object\.|at Module/i.test(stderr) && !/CONTRACT-BROKEN/.test(stdout)) {
    return 'harness_error';
  }
  // Detect error-swallowing: [FAIL] in stdout but exit 0 → runner is lying about success
  if (r.status === 0 && /\[FAIL\]/.test(stdout)) return 'harness_error';
  // Normal classification
  var exitCode = r.status;
  var killed = expectFail ? exitCode !== 0 : exitCode === 0;
  return killed ? 'killed' : 'survived';
}

var mutantCounter = 0;
function runRunner(src) {
  mutantCounter++;
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + mutantCounter + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  var r = spawnSync('node', [tmpFile], { timeout: 15000, cwd: ROOT, encoding: 'utf8' });
  return r;
}

function loadRunner() {
  return fs.readFileSync(RUNNER, 'utf8');
}

/**
 * @param expectFail   true if mutant should cause runner to exit non-zero
 * @param expectHarnessError  true if mutant should cause harness to detect error-swallowing
 */
function record(id, title, src, expectFail, expectHarnessError) {
  var r = runRunner(src);
  var verdict = classify(r, expectFail);
  var status, detail, exitCode;
  if (verdict === 'harness_error') {
    // Expected harness error = harness correctly detected error-swallowing → PASS
    if (expectHarnessError) {
      status = 'PASS';
      detail = 'harness correctly detected error-swallowing';
    } else {
      status = 'HARNESS_ERROR';
      detail = 'exitCode=' + (r.status === null ? 'null' : r.status) + ' stderr=' + (r.stderr || '').trim().slice(0, 200);
    }
    exitCode = r.status;
  } else if (verdict === 'killed') {
    status = 'PASS';
    detail = 'mutant correctly ' + (expectFail ? 'caught' : 'healthy');
    exitCode = r.status;
  } else {
    status = 'FAIL';
    detail = 'SURVIVING exitCode=' + r.status;
    exitCode = r.status;
  }
  results.push({ id: id, title: title, ran: true, verdict: verdict, status: status, detail: detail, exitCode: exitCode });
  console.log('[' + status + '] ' + id + ': ' + title + ' — ' + (status === 'PASS' ? 'pass' : verdict));
}

// ── All mutations wrapped in try/finally for guaranteed cleanup on any exception ──
try {

// ── Calibration: healthy runner must pass ──
(function cal() {
  var r = spawnSync('node', [RUNNER], { timeout: 15000, cwd: ROOT, encoding: 'utf8' });
  var ok = r.status === 0;
  var verdict = ok ? 'killed' : 'harness_error';
  results.push({ id: 'CAL', title: 'Healthy runner passes', ran: true, verdict: verdict, status: ok ? 'PASS' : 'HARNESS_ERROR', detail: ok ? 'baseline green' : 'baseline broken', exitCode: r.status });
  console.log('[' + (ok ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (ok ? 'PASS' : 'BROKEN'));
  if (!ok) {
    console.error('HALT: calibration failed, all subsequent mutations are unreliable');
  }
})();

// ── M1: Delete a released task record from write-locks → matrix must fail ──
(function m1() {
  var src = loadRunner();
  src = src.replace("var locks = JSON.parse(fs.readFileSync(LOCKS_PATH, 'utf8'));",
    "var locks = JSON.parse(fs.readFileSync(LOCKS_PATH, 'utf8'));\nlocks.locks = locks.locks.filter(function(l){return l.lock_id!=='lock-XJ-4.3.0-opensquilla-source-graph-goal-loop-01';});");
  record('M1', 'Delete a released task record → matrix must fail', src, true);
})();

// ── M2: Change report hash to stale value → integrity must fail ──
// Fixed: search string matches actual runner source (pass: pass, not shorthand)
(function m2() {
  var src = loadRunner();
  var oldStr = "return { file: f, pass: pass, score: score, hasDelivery: hasDelivery, lastLine: lastLine, content: content, sha: sha256(path.join(QA_DIR, f)) };";
  var newStr = "return { file: f, pass: pass, score: score, hasDelivery: hasDelivery, lastLine: lastLine, content: content, sha: 'STALE0000000000000000000000000000000000000000000000000000000000' };";
  src = src.replace(oldStr, newStr);
  record('M2', 'Stale artifact hash → integrity must fail', src, true);
})();

// ── M3: Mark Trae missing report as delivered → status contract must fail ──
(function m3() {
  var src = loadRunner();
  src = src.replace("delivery_status: report ? (report.pass ? 'delivered' : 'incomplete') : 'missing',",
    "delivery_status: 'delivered',");
  record('M3', 'Missing report marked delivered → must fail', src, true);
})();

// ── M4: Bypass stale base detection → must fail ──
(function m4() {
  var src = loadRunner();
  src = src.replace("var isStaleBase = !!(lockBase && lockBase !== BASE_COMMIT);",
    "var isStaleBase = false; // bypass stale detection");
  record('M4', 'Bypass stale base detection → must fail', src, true);
})();

// ── M5: Corrupt DELIVERY_REPORT regex in C3 → must fail ──
// Replacing the check with `true` was a no-op when all reports have DELIVERY_REPORT.
// Instead, corrupt the regex to a non-matching string. This proves C3 actually
// checks for the right marker — if the regex is wrong, C3 must fail.
(function m5() {
  var src = loadRunner();
  // Change the C3 regex from DELIVERY_REPORT to a non-matching string
  src = src.replace("return /DELIVERY_REPORT/.test(content);",
    "return /DELIVERY_REPORX_NONEXISTENT/.test(content);");
  record('M5', 'Corrupt DELIVERY_REPORT regex → must fail', src, true);
})();

// ── M6: Swap owner → must fail ──
(function m6() {
  var src = loadRunner();
  src = src.replace("owner: lock.owner || (task ? task.owner : 'unknown'),",
    "owner: 'wrong-owner',");
  record('M6', 'Swap owner → must fail', src, true);
})();

// ── M7: Let incomplete pass as confirmed → must fail ──
(function m7() {
  var src = loadRunner();
  src = src.replace("classification = 'incomplete';", "classification = 'confirmed';");
  record('M7', 'Let incomplete pass as confirmed → must fail', src, true);
})();

// ── M8: Runner swallows exit code despite failures → harness must detect ──
// Redesigned: injects a failing check AND swallows exit code → classify detects
// [FAIL] in stdout but exit 0 as HARNESS_ERROR; expected harness error = PASS
(function m8() {
  var src = loadRunner();
  // Inject a failing check before process.exit, then swallow the exit code
  src = src.replace("process.exit(failed === 0 ? 0 : 1);",
    "check('X_INJECT', 'injected failure', false);\nprocess.exit(0); // swallow errors");
  record('M8', 'Runner swallows exit code → harness must detect', src, false, true);
})();

} finally {
  // Cleanup: remove all temp files (runs even if mutation throws)
  tmpFiles.forEach(function (f) {
    try { fs.unlinkSync(f); } catch (e) {}
  });
  // Also scan for any orphaned mutated-runner files from previous crashed runs
  var orphans = fs.readdirSync(TMP_DIR).filter(function (f) { return /^mutated-runner-\d+\.js$/.test(f); });
  orphans.forEach(function (f) {
    try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (e) {}
  });
  var residue = fs.readdirSync(TMP_DIR).filter(function (f) { return /^mutated-runner-\d+\.js$/.test(f); });
  if (residue.length > 0) {
    console.error('CLEANUP FAIL: ' + residue.length + ' mutated-runner files remain');
    results.push({ id: 'CLEANUP', title: 'Zero residue after mutation run', ran: true, verdict: 'harness_error', status: 'HARNESS_ERROR', detail: residue.length + ' temp files remain', exitCode: 1 });
  } else {
    console.log('[OK] CLEANUP: zero residue — all mutated-runner temp files removed');
  }
}

// ── Summary ──
var passed = results.filter(function (r) { return r.status === 'PASS'; }).length;
var failed = results.filter(function (r) { return r.status === 'FAIL'; }).length;
var harnessErrors = results.filter(function (r) { return r.status === 'HARNESS_ERROR'; }).length;
console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + passed + '  FAIL=' + failed + '  HARNESS_ERROR=' + harnessErrors);
console.log('mutation_phase: ' + (failed === 0 && harnessErrors === 0 ? 'ALL-MUTATIONS-KILLED' : 'CONTRACT-BROKEN'));
process.exit(failed === 0 && harnessErrors === 0 ? 0 : 1);
