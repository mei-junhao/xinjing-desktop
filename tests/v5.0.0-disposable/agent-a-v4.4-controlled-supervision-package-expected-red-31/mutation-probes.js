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
    if (/\[FAIL\]/.test(r.stdout || '')) return 'killed';
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
  console.log('[' + status + '] ' + id + ' — ' + title);
}

try {
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  console.log('[' + (r.status === 0 ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (r.status === 0 ? 'PASS' : 'BROKEN'));
  if (r.status !== 0) process.exit(1);

  var base = loadRunner();

  // M1: Inject false CONFIRMED for XJSUP_parse check
  var src1 = base.replace("check('P2_' + api.name, 'Store/app has ' + api.desc + ' (absent = EXPECTED_RED gap)', !found, 'EXPECTED_RED');",
    "check('P2_' + api.name, 'Store/app has ' + api.desc + ' (absent = EXPECTED_RED gap)', false, 'CONFIRMED'); /* MUTANT M1 */");
  record('M1', 'Fabricate missing API as confirmed', src1, true);

  // M2: Weaken protected hash — inject a false CONFIRMED on a static check line
  var src2 = base.replace("check('P3_supervision_entry', 'supervision.js entry point traced (556 lines)', supSrc.length > 500, 'CONFIRMED');",
    "check('P3_supervision_entry', 'supervision.js entry point traced (556 lines)', false, 'CONFIRMED'); /* MUTANT M2 */");
  record('M2', 'Weaken source anchor check (false CONFIRMED)', src2, true);

  // M3: Allow author key leakage
  var src3 = base.replace("!/authorPrivateKey|author_private_key|BEGIN PRIVATE KEY/i.test(supSrc + realSupSrc + mainSrc + preloadSrc)",
    "false /* MUTANT M3: allow author key leakage */");
  record('M3', 'Allow author key leakage in source', src3, true);

  // M4: Allow device key leakage
  var src4 = base.replace("!/devicePrivateKey|device_private_key/i.test(supSrc + realSupSrc + mainSrc + preloadSrc)",
    "false /* MUTANT M4: allow device key leakage */");
  record('M4', 'Allow device key leakage in source', src4, true);

  // M5: Fabricate wrong-subject rejection
  var src5 = base.replace("check('R21', 'wrong-subject rejection not implemented', true, 'EXPECTED_RED');",
    "check('R21', 'wrong-subject rejection not implemented', false, 'CONFIRMED'); /* MUTANT M5 */");
  record('M5', 'Fabricate wrong-subject rejection as confirmed', src5, true);

  // M6: Fabricate second-device prevention
  var src6 = base.replace("check('R24', 'second-active-device prevention not implemented', true, 'EXPECTED_RED');",
    "check('R24', 'second-active-device prevention not implemented', false, 'CONFIRMED'); /* MUTANT M6 */");
  record('M6', 'Fabricate second-device prevention as confirmed', src6, true);

  // M7: Fabricate grace-expiry enforcement
  var src7 = base.replace("check('R27', 'grace-expiry enforcement not implemented', true, 'EXPECTED_RED');",
    "check('R27', 'grace-expiry enforcement not implemented', false, 'CONFIRMED'); /* MUTANT M7 */");
  record('M7', 'Fabricate grace-expiry enforcement as confirmed', src7, true);

  // M8: Fabricate clock-rollback rejection
  var src8 = base.replace("check('R28', 'clock-rollback rejection not implemented', true, 'EXPECTED_RED');",
    "check('R28', 'clock-rollback rejection not implemented', false, 'CONFIRMED'); /* MUTANT M8 */");
  record('M8', 'Fabricate clock-rollback rejection as confirmed', src8, true);

  // M9: Fabricate grant-sequence rollback
  var src9 = base.replace("check('R29', 'grant-sequence rollback rejection not implemented', true, 'EXPECTED_RED');",
    "check('R29', 'grant-sequence rollback rejection not implemented', false, 'CONFIRMED'); /* MUTANT M9 */");
  record('M9', 'Fabricate grant-sequence rollback as confirmed', src9, true);

  // M10: Fabricate corrupt-package rejection
  var src10 = base.replace("check('R30', 'corrupt-package rejection not implemented', true, 'EXPECTED_RED');",
    "check('R30', 'corrupt-package rejection not implemented', false, 'CONFIRMED'); /* MUTANT M10 */");
  record('M10', 'Fabricate corrupt-package rejection as confirmed', src10, true);

  // M11: Allow plaintext in renderer
  var src11 = base.replace("!/plaintext|privateKey|BEGIN.*PRIVATE/i.test(preloadSrc)",
    "false /* MUTANT M11: allow plaintext in renderer */");
  record('M11', 'Allow plaintext/key in renderer', src11, true);

  // M12: Force exit zero after injecting a failure
  var src12 = base.replace("check('R21', 'wrong-subject rejection not implemented', true, 'EXPECTED_RED');",
    "check('R21', 'wrong-subject rejection not implemented', false, 'CONFIRMED'); /* MUTANT M12 */");
  src12 = src12.replace('process.exit(failedCount === 0 ? 0 : 1);', 'process.exit(0); /* MUTANT M12: force exit zero */');
  record('M12', 'Force exit zero after semantic failure', src12, true);

  // Re-run healthy runner last
  var healthyRerun = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  if (healthyRerun.status !== 0) {
    console.log('[ERROR] Healthy re-run failed after mutations');
    process.exit(1);
  }
  console.log('[OK] Healthy re-run: contract-result.json restored');

} catch (e) {
  console.log('[ERROR] ' + e.message);
  process.exit(1);
}

var mutantResult = {
  task_id: 'XJ-5.0.0-agent-a-v4.4-controlled-supervision-package-expected-red-31',
  mutant_total: results.length,
  killed: results.filter(function(r) { return r.verdict === 'killed'; }).length,
  survived: results.filter(function(r) { return r.verdict === 'survived'; }).length,
  harness_errors: results.filter(function(r) { return r.verdict === 'harness_error'; }).length,
  results: results,
};
fs.writeFileSync(path.join(__dirname, 'mutation-result.json'), JSON.stringify(mutantResult, null, 2));

console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + mutantResult.killed + '  FAIL=' + mutantResult.survived + '  HARNESS_ERROR=' + mutantResult.harness_errors);
console.log('mutation_phase: ' + (mutantResult.survived === 0 && mutantResult.harness_errors === 0 ? 'ALL-MUTATIONS-KILLED' : 'SURVIVORS_FOUND'));
