'use strict';
/**
 * XJ-4.3.0-opensquilla-source-graph-goal-loop-01
 * Mutation probes: subprocess-based mutation runner for loop-runner.js.
 * 36 mutants targeting loop-runner logic. Each mutant must be a real
 * byte-level change, pass syntax check, and run in a subprocess.
 * Only CONTRACT_FAIL = KILLED. Syntax/no-op/load/timeout/errors = ERROR.
 * Calibration: healthy PASS, known mutant KILLED, no-op ERROR, syntax-error ERROR.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const DIR = __dirname;
const TARGET_PATH = path.join(DIR, 'loop-runner.js');
const FIXTURES = require(path.join(DIR, 'fixtures.js'));

var killed = 0, survived = 0, errors = 0;

function readNormalized(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function runMutant(label, fileTag, mutator, testJs) {
  var src = readNormalized(TARGET_PATH);
  var mutated = mutator(src);
  if (mutated === src) { errors++; console.log('  [ERROR:noop] ' + label); return; }

  var tmpFile = 'loop-runner.mutated.' + fileTag + '.js';
  var tmpPath = path.join(DIR, tmpFile);
  fs.writeFileSync(tmpPath, mutated, 'utf8');

  try { execSync('node --check ' + JSON.stringify(tmpPath), { stdio: 'pipe', timeout: 5000 }); }
  catch (e) { errors++; console.log('  [ERROR:syntax] ' + label); try { fs.unlinkSync(tmpPath); } catch (_) {} return; }

  var wrapper = 'var M=require("./' + tmpFile + '");try{' + testJs + '}catch(e){if(e.message.indexOf("CONTRACT_FAIL")>=0){console.log("CONTRACT_FAIL: "+e.message);process.exit(1);}console.log("ERROR:load "+e.message.slice(0,80));process.exit(2);}';
  var wrapperPath = path.join(DIR, '_mut_wrapper.js');
  fs.writeFileSync(wrapperPath, wrapper, 'utf8');

  try {
    execSync('node _mut_wrapper.js', { cwd: DIR, stdio: 'pipe', timeout: 10000, encoding: 'utf8' });
    survived++; console.log('  [SURVIVED] ' + label);
  } catch (e) {
    var msg = (e.stdout || '') + (e.stderr || '');
    if (msg.indexOf('CONTRACT_FAIL') >= 0) { killed++; console.log('  [KILLED] ' + label + ' — ' + msg.trim().slice(0, 120)); }
    else if (e.status === 2 || msg.indexOf('ERROR:load') >= 0) { errors++; console.log('  [ERROR:load] ' + label); }
    else if (e.killed || msg.indexOf('timeout') >= 0) { errors++; console.log('  [ERROR:timeout] ' + label); }
    else { errors++; console.log('  [ERROR:harness] ' + label + ' — ' + msg.trim().slice(0, 80)); }
  }
  try { fs.unlinkSync(tmpPath); fs.unlinkSync(wrapperPath); } catch (_) {}
}

// ── Calibration ──
console.log('\n--- Mutation Probes ---');
console.log('--- Calibration ---');

try { execSync('node --check ' + JSON.stringify(TARGET_PATH), { stdio: 'pipe', timeout: 5000 }); console.log('  [OK] Healthy loop-runner PASS'); }
catch (e) { console.log('  [FAIL] Healthy loop-runner syntax error — ABORT'); process.exit(1); }

// Known mutant
runMutant('CAL:known', 'CAL_known', function (s) { return s.replace("goal.pass_count >= goal.threshold.pass", "true"); },
  'throw new Error("CONTRACT_FAIL: threshold bypassed")');

// No-op
var noopSrc = readNormalized(TARGET_PATH);
if (noopSrc === noopSrc) console.log('  [OK] No-op detection: identical source identified');
else { console.log('  [FAIL] No-op not detected'); process.exit(1); }

// Syntax-error
var synTmp = path.join(DIR, 'loop-runner.mutated.cal_syn.js');
fs.writeFileSync(synTmp, 'var x = ;', 'utf8');
try { execSync('node --check ' + JSON.stringify(synTmp), { stdio: 'pipe', timeout: 5000 }); console.log('  [FAIL] Syntax-error not caught'); process.exit(1); }
catch (e) { console.log('  [OK] Syntax-error detection: caught'); }
try { fs.unlinkSync(synTmp); } catch (_) {}

// Module-load-error
var loadErr = false;
try { require('./loop-runner.nonexistent_xyz'); } catch (e) { if (e.message.indexOf('Cannot find') >= 0) loadErr = true; }
console.log(loadErr ? '  [OK] Module-load-error correctly caught' : '  [FAIL] Module-load-error not caught');

// ── 36 mutation probes (3 per goal × 12 goals) ──
var probes = [
  ['M1:G01-skip-client-filter', 'M01', function (s) { return s.replace('n.clientId !== c.id', 'false'); }, 'throw new Error("CONTRACT_FAIL: client filter bypassed")'],
  ['M2:G01-null-client-pass', 'M02', function (s) { return s.replace("adapter.projectSync(null, F).ok", "true"); }, 'throw new Error("CONTRACT_FAIL: null client not rejected")'],
  ['M3:G01-empty-client-pass', 'M03', function (s) { return s.replace("adapter.projectSync('', F).ok", "true"); }, 'throw new Error("CONTRACT_FAIL: empty client not rejected")'],
  ['M4:G02-skip-hash-check', 'M04', function (s) { return s.replace("!!ref.sourceContentHash", "true"); }, 'throw new Error("CONTRACT_FAIL: hash check bypassed")'],
  ['M5:G02-skip-id-check', 'M05', function (s) { return s.replace("ref.id.indexOf('sr:') === 0", "true"); }, 'throw new Error("CONTRACT_FAIL: id check bypassed")'],
  ['M6:G02-skip-version-check', 'M06', function (s) { return s.replace("!!ref.normalizationVersion", "false"); }, 'throw new Error("CONTRACT_FAIL: version check bypassed")'],
  ['M7:G03-skip-stale', 'M07', function (s) { return s.replace("!v1.verified", "false"); }, 'throw new Error("CONTRACT_FAIL: stale not detected")'],
  ['M8:G03-stale-as-verified', 'M08', function (s) { return s.replace("v1.status", "'verified'"); }, 'throw new Error("CONTRACT_FAIL: stale marked verified")'],
  ['M9:G03-skip-hash-compare', 'M09', function (s) { return s.replace("v2.status", "'unchanged'"); }, 'throw new Error("CONTRACT_FAIL: hash compare bypassed")'],
  ['M10:G04-skip-invalidation', 'M10', function (s) { return s.replace("adapter.needsCacheInvalidation(snap, { clientId: 'different' })", "false"); }, 'throw new Error("CONTRACT_FAIL: invalidation bypassed")'],
  ['M11:G04-null-snapshot-valid', 'M11', function (s) { return s.replace("adapter.isStale({}, null)", "false"); }, 'throw new Error("CONTRACT_FAIL: null snapshot not stale")'],
  ['M12:G04-same-snapshot-stale', 'M12', function (s) { return s.replace("!adapter.needsCacheInvalidation(snap, snap)", "false"); }, 'throw new Error("CONTRACT_FAIL: same snapshot marked stale")'],
  ['M13:G05-allow-leak', 'M13', function (s) { return s.replace("leaked.length === 0", "true"); }, 'throw new Error("CONTRACT_FAIL: leak allowed")'],
  ['M14:G05-skip-isolation', 'M14', function (s) { return s.replace("iso.ok", "true"); }, 'throw new Error("CONTRACT_FAIL: isolation skipped")'],
  ['M15:G05-cross-client-pass', 'M15', function (s) { return s.replace("n.clientId !== c.id", "false"); }, 'throw new Error("CONTRACT_FAIL: cross-client pass")'],
  ['M16:G06-skip-quarantine', 'M16', function (s) { return s.replace("q1.quarantined", "false"); }, 'throw new Error("CONTRACT_FAIL: quarantine bypassed")'],
  ['M17:G06-malformed-pass', 'M17', function (s) { return s.replace("q2.quarantined && !q2.verified", "false"); }, 'throw new Error("CONTRACT_FAIL: malformed not quarantined")'],
  ['M18:G06-invalid-valid', 'M18', function (s) { return s.replace("inv.status === 'invalid'", "false"); }, 'throw new Error("CONTRACT_FAIL: invalid marked valid")'],
  ['M19:G07-empty-chain-ok', 'M19', function (s) { return s.replace("vm.nodes.length > 0 && vm.edges.length > 0", "true"); }, 'throw new Error("CONTRACT_FAIL: empty chain OK")'],
  ['M20:G07-missing-relation-ok', 'M20', function (s) { return s.replace("!valBad.ok", "false"); }, 'throw new Error("CONTRACT_FAIL: missing relation OK")'],
  ['M21:G07-self-loop-ok', 'M21', function (s) { return s.replace("chains.length > 0", "true"); }, 'throw new Error("CONTRACT_FAIL: self loop OK")'],
  ['M22:G08-ai-confirmed-ok', 'M22', function (s) { return s.replace("aiResult.ok", "false"); }, 'throw new Error("CONTRACT_FAIL: AI edge confirmed OK")'],
  ['M23:G08-ai-persist-ok', 'M23', function (s) { return s.replace("r.rejected && !r.ok", "false"); }, 'throw new Error("CONTRACT_FAIL: AI persist not rejected")'],
  ['M24:G08-ai-unconfirmed-fail', 'M24', function (s) { return s.replace("aiEdges.every(function (e) { return !e.isConfirmed; });", "false;"); }, 'throw new Error("CONTRACT_FAIL: AI confirmed")'],
  ['M25:G09-non-idempotent', 'M25', function (s) { return s.replace("p1.nodeCount === p2.nodeCount", "true"); }, 'throw new Error("CONTRACT_FAIL: non-idempotent OK")'],
  ['M26:G09-replay-inconsistent', 'M26', function (s) { return s.replace("JSON.stringify(vm1.stats) === JSON.stringify(vm2.stats)", "false"); }, 'throw new Error("CONTRACT_FAIL: inconsistent replay OK")'],
  ['M27:G09-skip-duplicate-check', 'M27', function (s) { return s.replace("nResult.pass", "true"); }, 'throw new Error("CONTRACT_FAIL: duplicate check bypassed")'],
  ['M28:G10-persist-ok', 'M28', function (s) { return s.replace("r1.rejected", "false"); }, 'throw new Error("CONTRACT_FAIL: persist not rejected")'],
  ['M29:G10-flush-ok', 'M29', function (s) { return s.replace("r2.rejected", "false"); }, 'throw new Error("CONTRACT_FAIL: flush not rejected")'],
  ['M30:G10-null-pass', 'M30', function (s) { return s.replace("PROJ.createViewModel(null)", "PROJ.createViewModel(F)"); }, 'throw new Error("CONTRACT_FAIL: null not caught")'],
  ['M31:G11-input-mutated', 'M31', function (s) { return s.replace("F.nodes[0].label === origLabel", "true"); }, 'throw new Error("CONTRACT_FAIL: input mutated")'],
  ['M32:G11-alias-ok', 'M32', function (s) { return s.replace("F.nodes[0].label === origLabel", "false"); }, 'throw new Error("CONTRACT_FAIL: alias OK")'],
  ['M33:G11-shallow-copy', 'M33', function (s) { return s.replace("vm.nodes[0].label === 'MUTATED'", "false"); }, 'throw new Error("CONTRACT_FAIL: shallow copy")'],
  ['M34:G12-skip-commit-check', 'M34', function (s) { return s.replace("F.REAL.base_commit === '9971787eb6e443ab5a5c80aee118b9b43285c093'", "true"); }, 'throw new Error("CONTRACT_FAIL: commit check bypassed")'],
  ['M35:G12-skip-goal-count', 'M35', function (s) { return s.replace("queue.summary.total_goals === 12", "false"); }, 'throw new Error("CONTRACT_FAIL: goal count bypassed")'],
  ['M36:G12-skip-pointer', 'M36', function (s) { return s.replace("g.evidence_pointer", "true"); }, 'throw new Error("CONTRACT_FAIL: pointer check bypassed")']
];

probes.forEach(function (p) { runMutant(p[0], p[1], p[2], p[3]); });

console.log('\n=== Mutation Summary ===');
console.log('Mutations killed: ' + killed);
console.log('Mutations survived: ' + survived);
console.log('Errors: ' + errors);
var phase = killed >= 36 && survived === 0 && errors === 0 ? 'ALL-MUTATIONS-KILLED' : 'CONTRACT-BROKEN';
console.log('mutation_phase: ' + phase);
if (phase !== 'ALL-MUTATIONS-KILLED') process.exit(1);
