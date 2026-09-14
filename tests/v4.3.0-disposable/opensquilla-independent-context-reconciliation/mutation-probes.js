'use strict';
var { spawnSync } = require('child_process');
var path = require('path');
var fs = require('fs');

var ORIG_DIR = __dirname;
var RUNNER = path.join(ORIG_DIR, 'run-independent-context-contract.js');
var TMP_DIR = ORIG_DIR;
var ROOT = path.resolve(ORIG_DIR, '..', '..', '..');

var mutantCounter = 0;
var results = [];
var tmpFiles = [];

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }

function classify(r, expectFail) {
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  var stdout = r.stdout || '';
  if (/Cannot find module|ENOENT|MODULE_NOT_FOUND|throw new TypeError/i.test(stderr)) return 'harness_error';
  if (/SyntaxError/.test(stderr)) return 'harness_error';
  if (r.status === 0 && /\[FAIL\]/.test(stdout) && expectFail) return 'killed';
  if (r.status === 0 && !expectFail) return 'killed';
  if (r.status !== 0 && expectFail) return 'killed';
  if (r.status === 0 && expectFail) {
    if (/CONTRACT-BROKEN/.test(stdout)) return 'harness_error';
    return 'survived';
  }
  return 'survived';
}

function runRunner(src, expectFail) {
  mutantCounter++;
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + mutantCounter + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  var r = spawnSync('node', [tmpFile], { timeout: 30000, cwd: ROOT, encoding: 'utf8' });
  var verdict = classify(r, expectFail);
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL');
  results.push({ id: 'M' + mutantCounter, title: '', ran: true, verdict: verdict, status: status, detail: 'exitCode=' + r.status, exitCode: r.status });
  console.log('[' + status + '] M' + mutantCounter + ' — ' + verdict);
  return r;
}

// ── Calibration ──
var cal = spawnSync('node', [RUNNER], { timeout: 30000, cwd: ROOT, encoding: 'utf8' });
if (cal.status !== 0) { console.log('[ERROR] CAL: healthy runner must pass'); process.exit(1); }
console.log('[OK] CAL: healthy runner — PASS');

try {
  // M1: Reclassify adapter DEGRADED as CONFIRMED (swap D6 condition)
  var src1 = loadRunner();
  src1 = src1.replace(
    "check('D6', 'D2 classification must be DEGRADED_EXPECTED_RED, not CONFIRMED',\r\n  d2.verified === true",
    "check('D6', 'D2 classification must be DEGRADED_EXPECTED_RED, not CONFIRMED',\r\n  d2.verified === false /* MUTANT */"
  );
  runRunner(src1, true);

  // M2: Set SourceRef independent context to same value (swap C2 condition)
  var src2 = loadRunner();
  src2 = src2.replace(
    "r2.verified === false, 'CONFIRMED'",
    "r2.verified === true, 'CONFIRMED' /* MUTANT */"
  );
  runRunner(src2, true);

  // M3: Remove adapter fourth parameter ignore detection (swap D7 condition)
  var src3 = loadRunner();
  src3 = src3.replace(
    "check('D7', 'D3 classification must be DEGRADED_EXPECTED_RED, not CONFIRMED',\r\n  d3.verified === true",
    "check('D7', 'D3 classification must be DEGRADED_EXPECTED_RED, not CONFIRMED',\r\n  d3.verified === false /* MUTANT */"
  );
  runRunner(src3, true);

  // M4: Swallow runner exit code
  var src4 = loadRunner();
  src4 = src4.replace(
    "process.exit(passed === total ? 0 : 1);",
    "check('M4_INJECTED', 'injected fail for swallow test', false); process.exit(0);"
  );
  runRunner(src4, true);

  // M5: Make cross-session fail-closed appear as PASS (swap C3 condition)
  var src5 = loadRunner();
  src5 = src5.replace(
    "r3.verified === false, 'CONFIRMED'",
    "r3.verified === true, 'CONFIRMED' /* MUTANT */"
  );
  runRunner(src5, true);

  // M6: Remove D5 gap classification
  var src6 = loadRunner();
  src6 = src6.replace(
    "d2.verified === true && r2b.verified === false, 'DEGRADED_EXPECTED_RED'",
    "d2.verified === true && r2b.verified === true, 'CONFIRMED' /* MUTANT */"
  );
  runRunner(src6, true);

} finally {
  tmpFiles.forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
  var residue = fs.readdirSync(TMP_DIR).filter(function (f) { return /^mutated-runner-\d+\.js$/.test(f); });
  residue.forEach(function (f) { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (e) {} });
  residue = fs.readdirSync(TMP_DIR).filter(function (f) { return /^mutated-runner-\d+\.js$/.test(f); });
  if (residue.length > 0) {
    console.error('CLEANUP FAIL: ' + residue.length + ' temp files remain');
    results.push({ id: 'CLEANUP', title: 'Zero residue', ran: true, verdict: 'harness_error', status: 'HARNESS_ERROR', detail: residue.length + ' remain', exitCode: 1 });
  } else {
    console.log('[OK] CLEANUP: zero residue');
  }
}

// Mutant executions write the same deterministic artifacts as the healthy
// runner. Restore the baseline once all mutants have finished.
var restore = spawnSync('node', [RUNNER], { timeout: 30000, cwd: ROOT, encoding: 'utf8' });
if (restore.status !== 0) {
  console.error('[HARNESS_ERROR] RESTORE: healthy runner did not regenerate artifacts');
  results.push({ id: 'RESTORE', title: 'Restore healthy artifacts', ran: true, verdict: 'harness_error', status: 'HARNESS_ERROR', detail: 'exitCode=' + restore.status, exitCode: restore.status });
} else {
  console.log('[OK] RESTORE: healthy runner regenerated deterministic artifacts');
}

var p = results.filter(function (r) { return r.status === 'PASS'; }).length;
var f = results.filter(function (r) { return r.status === 'FAIL'; }).length;
var he = results.filter(function (r) { return r.status === 'HARNESS_ERROR'; }).length;
console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + p + '  FAIL=' + f + '  HARNESS_ERROR=' + he);
console.log('mutation_phase: ' + (f === 0 && he === 0 ? 'ALL-MUTATIONS-KILLED' : 'CONTRACT-BROKEN'));
process.exit(f === 0 && he === 0 ? 0 : 1);
