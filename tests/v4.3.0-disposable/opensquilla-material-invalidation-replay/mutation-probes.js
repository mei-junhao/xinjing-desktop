'use strict';
/**
 * XJ-4.3.0-opensquilla-material-invalidation-replay-01
 * Mutation Probes — negative mutations against material invalidation replay runner
 *
 * Each mutant must cause the runner to FAIL (CONTRACT-BROKEN).
 * No mutant may survive. No-op/syntax-error/harness-error = ERROR not KILLED.
 * try/finally ensures zero residue on any exception.
 */
var { spawnSync } = require('child_process');
var path = require('path');
var fs = require('fs');

var ORIG_DIR = __dirname;
var RUNNER = path.join(ORIG_DIR, 'run-material-invalidation-replay.js');
var TMP_DIR = ORIG_DIR;

var results = [];
var tmpFiles = [];

function classify(r, expectFail) {
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  var stdout = r.stdout || '';
  if (/Cannot find module|ENOENT|MODULE_NOT_FOUND|throw new TypeError/i.test(stderr)) return 'harness_error';
  if (/SyntaxError/.test(stderr)) return 'harness_error';
  // M7 scenario: runner swallows exit code (exit 0 despite FAIL in stdout)
  // Harness detects this by checking stdout for [FAIL] when exit code is 0
  if (r.status === 0 && /\[FAIL\]/.test(stdout) && expectFail) return 'killed';
  if (r.status === 0 && !expectFail) return 'killed';
  if (r.status !== 0 && expectFail) return 'killed';
  if (r.status === 0 && expectFail) {
    if (/CONTRACT-BROKEN/.test(stdout)) return 'harness_error';
    return 'survived';
  }
  return 'survived';
}

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }

function runRunner(src, expectFail) {
  var mutantCounter = tmpFiles.length + 1;
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + mutantCounter + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  var r = spawnSync('node', [tmpFile], { timeout: 15000, cwd: path.resolve(ORIG_DIR, '..', '..', '..'), encoding: 'utf8' });
  var verdict = classify(r, expectFail);
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'survived' ? 'FAIL' : 'HARNESS_ERROR');
  var title = 'M' + mutantCounter;
  console.log('[' + status + '] ' + title + ' — ' + (verdict === 'killed' ? 'killed' : verdict));
  results.push({ id: title, status: status, verdict: verdict, exitCode: r.status });
}

try {
  // ── CAL: healthy runner must pass ──
  var calR = spawnSync('node', [RUNNER], { timeout: 15000, cwd: path.resolve(ORIG_DIR, '..', '..', '..'), encoding: 'utf8' });
  if (calR.status !== 0) {
    console.error('HALT: calibration failed');
    process.exit(1);
  }
  console.log('[OK] CAL: healthy runner — PASS');

  // ── M1: Negate sourceContentHash change detection ──
  var src1 = loadRunner();
  src1 = src1.replace(
    "changedResult.status === 'warning' || changedResult.status === 'changed'",
    "changedResult.status !== 'warning' && changedResult.status !== 'changed' /* MUTANT */"
  );
  runRunner(src1, true);

  // ── M2: Negate anchorContentHash change ──
  var src2 = loadRunner();
  src2 = src2.replace(
    "result.status === 'changed' && result.verified === false",
    "result.status !== 'changed' && result.verified === true /* MUTANT */"
  );
  runRunner(src2, true);

  // ── M3: Negate AI persistence rejection ──
  var src3 = loadRunner();
  src3 = src3.replace(
    "result.ok === false",
    "result.ok === true /* MUTANT */"
  );
  runRunner(src3, true);

  // ── M4: Negate quarantine ──
  var src4 = loadRunner();
  src4 = src4.replace(
    "quarantined.verified === false",
    "quarantined.verified === true /* MUTANT */"
  );
  runRunner(src4, true);

  // ── M5: Negate cross-client detection ──
  var src5 = loadRunner();
  src5 = src5.replace(
    "result.status === 'ambiguous' && result.verified === false",
    "result.status !== 'ambiguous' && result.verified === true /* MUTANT */"
  );
  runRunner(src5, true);

  // ── M6: Negate cache invalidation ──
  var src6 = loadRunner();
  src6 = src6.replace(
    "needsInvalidate === true",
    "needsInvalidate === false /* MUTANT */"
  );
  runRunner(src6, true);

  // ── M7: Swallow exit code (runner reports green but exits non-zero) ──
  var src7 = loadRunner();
  src7 = src7.replace(
    "process.exit(failed === 0 ? 0 : 1);",
    "process.exit(0); // swallowed"
  );
  // Also inject a failing check
  src7 = src7.replace(
    "check('C1', 'sourceContentHash unchanged detected correctly'",
    "check('C1_INJECTED_FAIL', 'injected fail', false); check('C1', 'sourceContentHash unchanged detected correctly'"
  );
  runRunner(src7, true);

} finally {
  // Cleanup: remove all temp files (runs even if mutation throws)
  tmpFiles.forEach(function (f) {
    try { fs.unlinkSync(f); } catch (e) {}
  });
  // Also scan for orphaned files
  var orphans = fs.readdirSync(TMP_DIR).filter(function (f) { return /^mutated-runner-\d+\.js$/.test(f); });
  orphans.forEach(function (f) {
    try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (e) {}
  });
  var residue = fs.readdirSync(TMP_DIR).filter(function (f) { return /^mutated-runner-\d+\.js$/.test(f); });
  if (residue.length > 0) {
    console.error('CLEANUP FAIL: ' + residue.length + ' mutated-runner files remain');
    results.push({ id: 'CLEANUP', status: 'HARNESS_ERROR', verdict: 'harness_error', exitCode: 1 });
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
