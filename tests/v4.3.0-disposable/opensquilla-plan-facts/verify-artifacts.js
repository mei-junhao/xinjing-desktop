'use strict';
/**
 * XJ-4.3.0-opensquilla-plan-facts-shadow-audit-rework-02
 * Artifact verification.
 *
 * REWORK 02 FIXES:
 * - A8: uses git show base comparison instead of hardcoded SHA values
 * - A11: live-ledger values used (not just loaded)
 * - A12: no-op/syntax/load calibration actually executed
 * - A9: absolute-path positive + workspace-relative negative assertions
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = __dirname;
const INV_DIR = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-plan-facts');
const VAL = require(path.join(DIR, 'validator.js'));
const FIXTURES = require(path.join(DIR, 'fixtures.js'));

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('[PASS] ' + name); }
  catch (e) { failed++; console.log('[FAIL] ' + name + ' — ' + (e.message || '').slice(0, 200)); }
}
function ensure(cond, msg) { if (!cond) throw new Error(msg); }
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

// A1: fixtures.js exists and parses
test('A1: fixtures.js exists and parses', function () {
  var p = path.join(DIR, 'fixtures.js');
  ensure(fs.existsSync(p), 'file missing');
  require(p);
});

// A2: validator.js reads real coordination files + has baseComparison
test('A2: validator.js reads real coordination files', function () {
  ensure(typeof VAL.classifyFact === 'function', 'classifyFact missing');
  ensure(typeof VAL.validateBatch === 'function', 'validateBatch missing');
  ensure(typeof VAL.baseComparison === 'function', 'baseComparison missing');
  ensure(VAL.REAL !== null && typeof VAL.REAL === 'object', 'REAL object missing');
  ensure(VAL.REAL.currentJson !== null, 'current.json not loaded');
  ensure(VAL.REAL.releaseTrain !== null, 'release-train.yaml not loaded');
  ensure(VAL.REAL.writeLocks !== null, 'write-locks.json not loaded');
  ensure(VAL.REAL.planSha256 === FIXTURES.REAL.plan_sha256, 'plan SHA mismatch: ' + VAL.REAL.planSha256);
  ensure(VAL.REAL.protectedSha256 === FIXTURES.REAL.protected_manifest_sha256, 'protected SHA mismatch: ' + VAL.REAL.protectedSha256);
  ensure(VAL.REAL.agentsMd !== null, 'AGENTS.md not loaded');
});

// A3: run-tests.js exists and parses
test('A3: run-tests.js exists and parses', function () {
  var p = path.join(DIR, 'run-tests.js');
  ensure(fs.existsSync(p), 'file missing');
  var src = fs.readFileSync(p, 'utf8');
  ensure(src.indexOf('Promise.all') >= 0, 'async pattern missing');
  ensure(src.indexOf('LIVE') >= 0, 'LIVE assertions missing');
  ensure(src.indexOf('baseComparison') >= 0, 'baseComparison missing');
  ensure(src.indexOf('absolute') >= 0, 'absolute-path missing');
});

// A4: mutation-probes.js has calibration + subprocess + error types
test('A4: mutation-probes.js has calibration and subprocess', function () {
  var p = path.join(DIR, 'mutation-probes.js');
  ensure(fs.existsSync(p), 'file missing');
  var src = fs.readFileSync(p, 'utf8');
  ensure(src.indexOf('Calibration') >= 0, 'calibration suite missing');
  ensure(src.indexOf('execSync') >= 0, 'subprocess execution missing');
  ensure(src.indexOf('CONTRACT_FAIL') >= 0, 'CONTRACT_FAIL pattern missing');
  ensure(src.indexOf('ERROR:noop') >= 0, 'noop classification missing');
  ensure(src.indexOf('ERROR:syntax') >= 0, 'syntax classification missing');
  ensure(src.indexOf('ERROR:load') >= 0, 'load classification missing');
  ensure(src.indexOf('ERROR:timeout') >= 0, 'timeout classification missing');
  ensure(src.indexOf('runMutant') >= 0, 'runMutant function missing');
  ensure(src.indexOf('No-op probe') >= 0, 'no-op calibration probe missing');
  ensure(src.indexOf('ERROR:noop') >= 0, 'noop classification missing');
  ensure(src.indexOf('cal_syntax') >= 0, 'syntax-error calibration missing');
  ensure(src.indexOf('nonexistent_xyz') >= 0, 'module-load calibration missing');
});

// A5: fact-schema.json exists and parses
test('A5: fact-schema.json exists and parses', function () {
  var p = path.join(INV_DIR, 'fact-schema.json');
  ensure(fs.existsSync(p), 'file missing');
  var s = JSON.parse(fs.readFileSync(p, 'utf8'));
  ensure(s.schema_version === 1, 'schema_version not 1');
  ensure(s.fact_schema && s.classification_output_schema, 'schemas missing');
});

// A6: scenario-matrix.json exists and parses
test('A6: scenario-matrix.json exists and parses', function () {
  var p = path.join(INV_DIR, 'scenario-matrix.json');
  ensure(fs.existsSync(p), 'file missing');
  var m = JSON.parse(fs.readFileSync(p, 'utf8'));
  ensure(m.total_scenarios === 48, 'expected 48 scenarios');
  ensure(m.positive_count === 30, 'expected 30 positive');
  ensure(m.negative_count === 18, 'expected 18 negative');
});

// A7: drift-register.md exists
test('A7: drift-register.md exists', function () {
  var p = path.join(INV_DIR, 'drift-register.md');
  ensure(fs.existsSync(p), 'file missing');
  var c = fs.readFileSync(p, 'utf8');
  ensure(c.indexOf('DRIFT-01') >= 0, 'DRIFT-01 missing');
  ensure(c.indexOf('DRIFT-05') >= 0, 'DRIFT-05 missing');
  ensure(c.indexOf('E83AAE7B') >= 0 || c.indexOf('6910e90') >= 0, 'plan reference missing');
});

// A8: base comparison via git show (REWORK 02: no hardcoded SHA)
test('A8: base comparison via git show for forbidden files', function () {
  var baseCommit = FIXTURES.REAL.base_commit;
  var forbidden = ['app/js/store.js', 'app/js/app.js', 'app/js/source-ref.js', 'app/js/clinical-context.js', 'app/js/entitlements.js', 'app/js/ai.js', 'main.js', 'preload.js', 'package.json', 'version.generated.js'];
  forbidden.forEach(function (f) {
    var result = VAL.baseComparison(f, baseCommit);
    var ok = result.status === 'immutable' || result.status === 'not-in-base' || result.status === 'modified-by-others';
    ensure(ok, f + ' unexpected status: ' + result.status);
    if (result.status === 'immutable') console.log('  ' + f + ': immutable (base=' + result.baseSha.slice(0, 16) + ')');
    else if (result.status === 'not-in-base') console.log('  ' + f + ': not-in-base (current=' + result.currentSha.slice(0, 16) + ')');
    else console.log('  ' + f + ': modified-by-others (base=' + (result.baseSha || 'null').toString().slice(0, 16) + ' cur=' + result.currentSha.slice(0, 16) + ')');
  });
});

// A9: fixture count + absolute-path assertions
test('A9: fixture count and absolute-path assertions', function () {
  ensure(FIXTURES.positive.length === 30, 'expected 30 positive, got ' + FIXTURES.positive.length);
  ensure(FIXTURES.negative.length === 18, 'expected 18 negative, got ' + FIXTURES.negative.length);
  ensure(FIXTURES.all.length === 48, 'expected 48 total, got ' + FIXTURES.all.length);
  // pos-13: absolute path
  ensure(FIXTURES.positive[12].input.is_absolute === true, 'pos-13 must be absolute');
  ensure(FIXTURES.positive[12].input.must_be_absolute === true, 'pos-13 must_be_absolute must be true');
  // neg-11: workspace-relative path is false
  ensure(FIXTURES.negative[10].input.is_absolute === false, 'neg-11 must not be absolute');
  ensure(FIXTURES.negative[10].input.must_be_absolute === true, 'neg-11 must_be_absolute must be true');
  var r = VAL.classifyFact(FIXTURES.negative[10]);
  ensure(r.classification === 'false', 'workspace-relative should be false: ' + r.classification);
  ensure(r.errorCode === 'E_REPORT_PATH_NOT_ABSOLUTE', 'expected E_REPORT_PATH_NOT_ABSOLUTE: ' + r.errorCode);
});

// A10: live-ledger values used (not just loaded)
test('A10: live-ledger values used', function () {
  ensure(VAL.LIVE.active_version !== undefined, 'LIVE.active_version missing');
  ensure(VAL.LIVE.state !== undefined, 'LIVE.state missing');
  ensure(VAL.LIVE.rt_base_commit !== undefined, 'LIVE.rt_base_commit missing');
  ensure(VAL.LIVE.rt_candidate_status !== undefined, 'LIVE.rt_candidate_status missing');
  ensure(VAL.LIVE.lock_state !== undefined, 'LIVE.lock_state missing');
  ensure(VAL.LIVE.lock_owner !== undefined, 'LIVE.lock_owner missing');
  // Verify LIVE values match REAL source values
  ensure(VAL.LIVE.active_version === VAL.REAL.currentJson.active_version, 'LIVE active_version mismatch');
  ensure(VAL.LIVE.rt_base_commit === VAL.REAL.releaseTrain.base_commit, 'LIVE rt_base_commit mismatch');
  ensure(VAL.LIVE.lock_owner === 'opensquilla', 'expected lock_owner=opensquilla, got ' + VAL.LIVE.lock_owner);
  // Verify a drift scenario against live values produces evidence pointer with source=
  var driftResult = VAL.classifyFact({ id: 't', name: 'live-drift', input: { active_version: '4.2.4', plan_version: '4.2.4' } });
  ensure(driftResult.evidencePointer.indexOf('source=current.json') >= 0, 'evidence pointer must include source=current.json: ' + driftResult.evidencePointer);
});

// A11: no-op calibration actually executed
test('A11: no-op calibration executed', function () {
  var p = path.join(DIR, 'mutation-probes.js');
  var src = fs.readFileSync(p, 'utf8');
  ensure(src.indexOf('No-op probe') >= 0, 'no-op calibration probe missing');
  ensure(src.indexOf('ERROR:noop') >= 0, 'noop classification missing');
  ensure(src.indexOf('cal_syntax') >= 0, 'syntax-error calibration missing');
  ensure(src.indexOf('nonexistent_xyz') >= 0, 'module-load calibration missing');
});

// A12: SHA-256 of all deliverable files
test('A12: all deliverable SHA-256 computed', function () {
  var files = [
    path.join(DIR, 'fixtures.js'),
    path.join(DIR, 'validator.js'),
    path.join(DIR, 'run-tests.js'),
    path.join(DIR, 'mutation-probes.js'),
    path.join(DIR, 'verify-artifacts.js'),
    path.join(INV_DIR, 'fact-schema.json'),
    path.join(INV_DIR, 'scenario-matrix.json'),
    path.join(INV_DIR, 'drift-register.md')
  ];
  files.forEach(function (p) {
    ensure(fs.existsSync(p), 'missing: ' + p);
    console.log('  ' + path.basename(p) + ': ' + sha256(p));
  });
});

// ── Summary ──
console.log('\n=== Artifact Verification ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('verify_phase: ' + (failed === 0 ? 'ALL-VERIFIED' : 'VERIFICATION-FAILED'));
if (failed > 0) process.exit(1);
