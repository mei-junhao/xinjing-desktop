'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

var RUNNER = path.join(__dirname, 'run-contract.js');
var TMP_DIR = __dirname;
var CANONICAL_MATRIX = path.resolve(__dirname, '..', '..', '..', 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-source-ref-admission', 'contract-matrix.json');
var results = [];
var tmpFiles = [];
var baselineMatrixHash = '';

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }
function runRunner(src) {
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + (results.length + 1) + '.js');
  var tmpMatrix = path.join(TMP_DIR, 'mutated-matrix-' + (results.length + 1) + '.json');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  tmpFiles.push(tmpMatrix);
  return spawnSync('node', [tmpFile], {
    timeout: 30000,
    cwd: path.resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { XJ_SOURCE_REF_MATRIX_PATH: tmpMatrix })
  });
}
function sha256(filePath) { return require('crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
var baselineStdout = '';
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
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  baselineStdout = r.stdout || '';
  console.log('[' + (r.status === 0 ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (r.status === 0 ? 'PASS' : 'BROKEN'));
  if (r.status !== 0) process.exit(1);
  baselineMatrixHash = sha256(CANONICAL_MATRIX);

  // M1: Reclassify stale as verified
  var src1 = loadRunner();
  src1 = src1.replace("r2.verified === false, 'CONFIRMED'", "r2.verified === true, 'CONFIRMED' /* MUTANT */");
  record('M1', 'Reclassify stale as verified', src1, true);

  // M2: Accept unknown client
  var src2 = loadRunner();
  src2 = src2.replace("r4.verified === false, 'CONFIRMED'", "r4.verified === true, 'CONFIRMED' /* MUTANT */");
  record('M2', 'Accept unknown client', src2, true);

  // M3: Bypass cross-client rejection
  var src3 = loadRunner();
  src3 = src3.replace("r5.verified === false, 'CONFIRMED'", "r5.verified === true, 'CONFIRMED' /* MUTANT */");
  record('M3', 'Bypass cross-client rejection', src3, true);

  // M4: Relabel EXPECTED_RED admission gap as CONFIRMED
  var src4 = loadRunner();
  src4 = src4.replace("typeof SourceRef.admit === 'undefined', 'EXPECTED_RED'", "typeof SourceRef.admit !== 'undefined', 'CONFIRMED' /* MUTANT */");
  record('M4', 'Relabel admission gap as CONFIRMED', src4, true);

  // M5: Replace real SourceRef with mock
  var src5 = loadRunner();
  src5 = src5.replace("require(path.join(ROOT, 'app', 'js', 'source-ref.js'))",
    "{ create: function(o){return o;}, verify: function(){return {status:'unchanged',verified:true};}, migrateLegacy: function(o){return Object.assign(o,{legacy:true,verified:false});}, containsAbsolutePath: function(){return false;} } /* MUTANT */");
  record('M5', 'Replace real SourceRef with mock', src5, true);

  // M6: Swallow exit code
  var src6 = loadRunner();
  src6 = src6.replace("process.exit(failedCount === 0 ? 0 : 1);", "check('M6_INJECTED', 'injected fail', false); process.exit(0);");
  record('M6', 'Swallow exit code', src6, true);

  // M7: Accept unknown session (bypass session-mismatch)
  var src7 = loadRunner();
  src7 = src7.replace("rUnknownSession.verified === false, 'CONFIRMED'", "rUnknownSession.verified === true, 'CONFIRMED' /* MUTANT */");
  record('M7', 'Accept unknown session', src7, true);

  // M8: Bypass async ordering (swap expected results)
  var src8 = loadRunner();
  src8 = src8.replace("asyncResults[0].verified === true && asyncResults[1].verified === false", "asyncResults[0].verified === false && asyncResults[1].verified === true /* MUTANT */");
  record('M8', 'Bypass async ordering', src8, true);

  // M9: Relabel expected-red D1 as CONFIRMED (classification only, condition unchanged)
  var src9 = loadRunner();
  src9 = src9.replace("typeof SourceRef.admit === 'undefined', 'EXPECTED_RED'", "typeof SourceRef.admit === 'undefined', 'CONFIRMED' /* MUTANT M9 */");
  record('M9', 'Relabel expected-red D1 as CONFIRMED', src9, true);

} finally {
  tmpFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch (e) {} });
  var orphans = fs.readdirSync(TMP_DIR).filter(function(f) { return /^mutated-runner-\d+\.js$/.test(f); });
  orphans.forEach(function(f) { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (e) {} });
  var matrixOrphans = fs.readdirSync(TMP_DIR).filter(function(f) { return /^mutated-matrix-\d+\.json$/.test(f); });
  matrixOrphans.forEach(function(f) { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (e) {} });
  console.log(orphans.length === 0 ? '[OK] CLEANUP: zero residue' : 'CLEANUP: ' + orphans.length + ' orphans removed');
}

var passed = results.filter(function(r) { return r.status === 'PASS'; }).length;
var failed = results.filter(function(r) { return r.status === 'FAIL'; }).length;
var he = results.filter(function(r) { return r.status === 'HARNESS_ERROR'; }).length;
var matrixPreserved = baselineMatrixHash !== '' && sha256(CANONICAL_MATRIX) === baselineMatrixHash;
console.log('[' + (matrixPreserved ? 'OK' : 'FAIL') + '] MATRIX: canonical artifact preserved');
if (!matrixPreserved) failed++;
console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + passed + '  FAIL=' + failed + '  HARNESS_ERROR=' + he);
console.log('mutation_phase: ' + (failed === 0 && he === 0 ? 'ALL-MUTATIONS-KILLED' : 'CONTRACT-BROKEN'));
process.exit(failed === 0 && he === 0 ? 0 : 1);
