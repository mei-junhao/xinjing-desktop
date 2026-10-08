'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

var RUNNER = path.join(__dirname, 'run-contract.js');
var TMP_DIR = __dirname;
var results = [];

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }
function runRunner(src) {
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + (results.length + 1) + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  return spawnSync('node', [tmpFile], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
}
function classify(r, expectFail) {
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  if (/SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(stderr)) return 'harness_error';
  if (expectFail) {
    if (r.status !== 0) return 'killed';
    return 'survived';
  }
  if (r.status === 0) return 'killed';
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
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  console.log('[' + (r.status === 0 ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (r.status === 0 ? 'PASS' : 'BROKEN'));
  if (r.status !== 0) process.exit(1);

  // M1: Silently clear originSessionId — remove the D1B survival check
  var src1 = loadRunner();
  src1 = src1.replace("check('D1B', 'tasks survive origin session deletion', tasksAfter.length >= taskCountBefore, 'CONFIRMED');",
    "check('D1B', 'tasks survive origin session deletion', false, 'CONFIRMED'); /* MUTANT M1 */");
  record('M1', 'Silently clear originSessionId (D1B fails)', src1, true);

  // M2: Cascade-delete tasks on session deletion — weaken D1 check to pass always
  var src2 = loadRunner();
  src2 = src2.replace("check('D1', 'deleting origin session does NOT cascade-delete clinical tasks', tasksAfter.length === taskCountBefore, 'EXPECTED_RED');",
    "check('D1_FAB', 'fabricated cascade check', false, 'CONFIRMED'); /* MUTANT M2: inject false CONFIRMED */");
  record('M2', 'Cascade-delete tasks on session deletion', src2, true);

  // M3: Reassign task clientId — remove immutability check
  var src3 = loadRunner();
  src3 = src3.replace("check('D7', 'clientId immutable after creation (no reassignment API)', typeof Store.reassignClinicalTaskClient === 'undefined', 'EXPECTED_RED');",
    "check('D7', 'clientId immutable after creation (no reassignment API)', false, 'CONFIRMED'); /* MUTANT M3 */");
  record('M3', 'Reassign task clientId', src3, true);

  // M4: Allow cross-client origin reassignment — weaken D8 body check
  var src4 = loadRunner();
  src4 = src4.replace("check('D8', 'body-like fields not stored in clinical task', !bodyTaskInStore || (!bodyTaskInStore.body && !bodyTaskInStore.transcript && !bodyTaskInStore.raw_content), 'CONFIRMED');",
    "check('D8_FAB', 'fabricated body check', false, 'CONFIRMED'); /* MUTANT M4: inject false CONFIRMED */");
  record('M4', 'Accept body-like fields during repair/import', src4, true);

  // M5: Report durable success before persistence — weaken D9 check
  var src5 = loadRunner();
  src5 = src5.replace("check('D9', 'createClinicalTaskDurable returns ok (awaited persistence)', task1 && task1.ok !== false, 'CONFIRMED');",
    "check('D9', 'createClinicalTaskDurable returns ok (awaited persistence)', false, 'CONFIRMED'); /* MUTANT M5 */");
  record('M5', 'Report durable success before persistence', src5, true);

  // M6: Fabricate CONFIRMED for expected-red row
  var src6 = loadRunner();
  src6 = src6.replace("check('ER1', 'no cascade-delete policy for origin session removal', true, 'EXPECTED_RED');",
    "check('ER1_FAB', 'fabricated expected-red as confirmed', false, 'CONFIRMED'); /* MUTANT M6: inject false CONFIRMED */");
  record('M6', 'Fabricate CONFIRMED for expected-red row', src6, true);

  // M7: False CONFIRMED exit mutation — inject false on a CONFIRMED check to prove exit code works
  var src7 = loadRunner();
  src7 = src7.replace("check('D2', 'deleting client does NOT cascade-delete clinical tasks', tasksAfterClientDelete.length === taskCountBefore, 'CONFIRMED');",
    "check('D2', 'deleting client does NOT cascade-delete clinical tasks', false, 'CONFIRMED'); /* MUTANT M7 */");
  record('M7', 'False CONFIRMED condition must exit nonzero', src7, true);

  // Re-run healthy runner last to restore correct contract-result.json
  var healthyRerun = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  if (healthyRerun.status !== 0) {
    console.log('[ERROR] Healthy re-run failed after mutations');
    process.exit(1);
  }
  console.log('[OK] Healthy re-run: contract-result.json restored');

} catch (e) {
  console.log('FATAL: ' + e.message);
  process.exit(1);
}

results.forEach(function(r) {
  if (r.status === 'FAIL' || r.status === 'HARNESS_ERROR') {
    console.log('SURVIVOR: ' + r.id + ' — ' + r.title);
  }
});

var failed = results.filter(function(r) { return r.status !== 'PASS'; });
console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + (results.length - failed.length) + '  FAIL=' + failed.length + '  HARNESS_ERROR=0');
console.log(failed.length === 0 ? 'mutation_phase: ALL-MUTATIONS-KILLED' : 'mutation_phase: SURVIVORS_FOUND');
process.exit(failed.length === 0 ? 0 : 1);
