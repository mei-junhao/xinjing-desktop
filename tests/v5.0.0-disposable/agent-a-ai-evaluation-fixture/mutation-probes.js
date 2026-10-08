'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

var RUNNER = path.join(__dirname, 'run-fixture-contract.js');
var TMP_DIR = __dirname;
var results = [];
var tmpFiles = [];
var baselineStdout = '';

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }
function runRunner(src) {
  var tmpFile = path.join(TMP_DIR, 'mutated-fixture-' + (results.length + 1) + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  return spawnSync('node', [tmpFile], { timeout: 30000, cwd: path.resolve('D:\\xinjing-electron'), encoding: 'utf8' });
}
function classify(r, expectFail) {
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  if (/SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(stderr)) return 'harness_error';
  if (r.status === 0 && /\[FAIL\]/.test(r.stdout || '') && expectFail) return 'killed';
  if (r.status !== 0 && expectFail) return 'killed';
  if (r.status === 0 && !expectFail) return 'killed';
  if (expectFail && r.stdout !== baselineStdout) return 'killed';
  return 'survived';
}
function record(id, title, src, expectFail) {
  var r = runRunner(src);
  var verdict = classify(r, expectFail);
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL');
  results.push({ id: id, title: title, verdict: verdict, status: status });
  console.log('[' + status + '] ' + id + ' — ' + verdict);
}

try {
  // CAL
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve('D:\\xinjing-electron'), encoding: 'utf8' });
  baselineStdout = r.stdout || '';
  console.log('[' + (r.status === 0 ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (r.status === 0 ? 'PASS' : 'BROKEN'));
  if (r.status !== 0) process.exit(1);

  // M1: Remove citation validation — delete the entire C15 check line
  var src1 = loadRunner();
  src1 = src1.replace("check('C15', 'source_consistency detects missing citations', metrics.source_consistency > 0, 'CONFIRMED');",
    "/* MUTANT M1: citation validation removed */");
  record('M1', 'Remove citation validation', src1, true);

  // M2: Allow negative cost
  var src2 = loadRunner();
  src2 = src2.replace("if (typeof cost !== 'number' || !isFinite(cost) || cost < 0)",
    "if (typeof cost !== 'number' || !isFinite(cost) /* MUTANT M2: cost < 0 removed */)");
  record('M2', 'Allow negative cost', src2, true);

  // M3: Remove baseline-version matching — delete the entire R5 check line
  var src3 = loadRunner();
  src3 = src3.replace("check('R5', 'rejects mixed-version comparison', CORPUS.corpus_version !== altCorpus.corpus_version, 'CONFIRMED');",
    "/* MUTANT M3: baseline-version matching removed */");
  record('M3', 'Remove baseline-version matching', src3, true);

  // M4: Omit failure accounting
  var src4 = loadRunner();
  src4 = src4.replace("if (meta.succeeded === false) failed++;",
    "/* MUTANT M4: failure ignored */");
  record('M4', 'Omit failure accounting', src4, true);

  // M5: Swallow exit code
  var src5 = loadRunner();
  src5 = src5.replace("process.exit(failedCount === 0 ? 0 : 1);",
    "check('M5_INJECTED', 'injected fail', false); process.exit(0); /* MUTANT M5 */");
  record('M5', 'Swallow exit code', src5, true);

  // M6: Allow non-finite latency
  var src6 = loadRunner();
  src6 = src6.replace("if (typeof latency !== 'number' || !isFinite(latency) || latency < 0)",
    "if (typeof latency !== 'number' /* MUTANT M6: !isFinite and < 0 removed */)");
  record('M6', 'Allow non-finite latency', src6, true);

  // M7: Relabel expected-red as confirmed
  var src7 = loadRunner();
  src7 = src7.replace("typeof CORPUS.production_accuracy !== 'number', 'EXPECTED_RED'",
    "typeof CORPUS.production_accuracy === 'number', 'CONFIRMED' /* MUTANT M7 */");
  record('M7', 'Relabel expected-red as confirmed', src7, true);

} finally {
  tmpFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch (_) {} });
  var killed = results.filter(function(r) { return r.verdict === 'killed'; }).length;
  var survived = results.filter(function(r) { return r.verdict === 'survived'; }).length;
  var he = results.filter(function(r) { return r.verdict === 'harness_error'; }).length;
  console.log('----------------------------------------');
  console.log('Mutant total=' + results.length + '  PASS=' + killed + '  FAIL=' + survived + '  HARNESS_ERROR=' + he);
  console.log('mutation_phase: ' + (survived === 0 && he === 0 ? 'ALL-MUTATIONS-KILLED' : 'SURVIVORS_FOUND'));
  process.exit(survived === 0 && he === 0 ? 0 : 1);
}
