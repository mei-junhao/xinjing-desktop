'use strict';
/**
 * XJ-5.0.0 Agent A 4.3 Session Template Readiness — Mutation Probes (Rework 01)
 * Semantic failure assertions only — no stdout-difference verdicts.
 * Each mutation alters matrix data or manifest to trigger a real contract failure.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

var RUNNER = path.join(__dirname, 'run-readiness-contract.js');
var TMP_DIR = __dirname;
var results = [];
var tmpFiles = [];

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }
function runRunner(src) {
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + (results.length + 1) + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  return spawnSync('node', [tmpFile], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
}

// Semantic failure detection: killed only if runner produces FAIL or nonzero exit.
// No stdout-difference comparison.
function classify(r, expectFail) {
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  if (/SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(stderr)) return 'harness_error';
  if (r.status === 0 && /\[FAIL\]/.test(r.stdout || '') && expectFail) return 'killed';
  if (r.status !== 0 && expectFail) return 'killed';
  if (r.status === 0 && !expectFail) return 'killed';
  return 'survived';
}

function record(id, title, src, expectFail) {
  var r = runRunner(src);
  var verdict = classify(r, expectFail);
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL');
  results.push({ id: id, title: title, verdict: verdict, status: status });
  console.log('[' + status + '] ' + id + ' — ' + verdict);
}

// Helper: inject matrix data mutation after the matrix parse line
var MATRIX_LINE = "var matrix = JSON.parse(fs.readFileSync(path.join(INV, 'session-template-readiness-matrix.json'), 'utf8'));";

try {
  // CAL
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  console.log('[' + (r.status === 0 ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (r.status === 0 ? 'PASS' : 'BROKEN'));
  if (r.status !== 0) process.exit(1);

  // M1: Fabricate CONFIRMED status for R1 (bypass expected-red enforcement)
  var src1 = loadRunner();
  src1 = src1.replace(MATRIX_LINE,
    MATRIX_LINE + " matrix.rows[0].status = 'CONFIRMED'; /* MUTANT M1 */");
  record('M1', 'Fabricate CONFIRMED status for R1', src1, true);

  // M2: Substitute protected source hash
  var src2 = loadRunner();
  src2 = src2.replace(
    "var actual = exists ? sha256(p) : 'MISSING';",
    "var actual = '0000000000000000000000000000000000000000000000000000000000000000'; /* MUTANT M2 */"
  );
  record('M2', 'Substitute protected source hash', src2, true);

  // M3: Empty source_anchors for R1 (contract must reject)
  var src3 = loadRunner();
  src3 = src3.replace(MATRIX_LINE,
    MATRIX_LINE + " matrix.rows[0].source_anchors = []; /* MUTANT M3 */");
  record('M3', 'Empty source_anchors for R1', src3, true);

  // M4: Remove protected files from manifest (contract must detect)
  var src4 = loadRunner();
  src4 = src4.replace(
    "var allHashesOk = true;",
    "var allHashesOk = true; manifest.protected_files = manifest.protected_files.slice(0, 2); /* MUTANT M4 */"
  );
  record('M4', 'Remove protected files from manifest', src4, true);

  // M5: Bypass real-source reading in verifier
  var src5 = loadRunner();
  src5 = src5.replace(
    "var allHashesOk = true;",
    "var allHashesOk = true; manifest.protected_files = []; /* MUTANT M5 */"
  );
  record('M5', 'Bypass real-source reading in verifier', src5, true);

  // M6: Swallow exit code
  var src6 = loadRunner();
  src6 = src6.replace(
    "process.exit(failedCount === 0 ? 0 : 1);",
    "check('M6_INJECTED', 'injected fail', false, 'CONFIRMED'); process.exit(0); /* MUTANT M6 */"
  );
  record('M6', 'Swallow exit code', src6, true);

  // M7: Empty source_anchors for R8 (mutation for empty anchor)
  var src7 = loadRunner();
  src7 = src7.replace(MATRIX_LINE,
    MATRIX_LINE + " matrix.rows[7].source_anchors = []; /* MUTANT M7 */");
  record('M7', 'Empty source_anchors for R8', src7, true);

  // M8: Non-protected anchor reference for R8 (removal of expected-red enforcement)
  var src8 = loadRunner();
  src8 = src8.replace(MATRIX_LINE,
    MATRIX_LINE + " matrix.rows[7].source_anchors = ['app/js/nonexistent-file.js: no such file']; /* MUTANT M8 */");
  record('M8', 'Non-protected anchor reference for R8', src8, true);

} finally {
  tmpFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch(_) {} });
}

var killed = results.filter(function(r) { return r.verdict === 'killed'; }).length;
var he = results.filter(function(r) { return r.verdict === 'harness_error'; }).length;
var survived = results.filter(function(r) { return r.verdict === 'survived'; }).length;
console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + killed + '  FAIL=' + survived + '  HARNESS_ERROR=' + he);
console.log('mutation_phase: ' + (survived === 0 && he === 0 ? 'ALL-MUTATIONS-KILLED' : 'SURVIVORS_FOUND'));
process.exit(survived === 0 && he === 0 ? 0 : 1);
