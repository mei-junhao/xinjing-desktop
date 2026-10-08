'use strict';
/**
 * XJ-4.3.0-opensquilla-plan-facts-shadow-audit-rework-02
 * Runtime contract tests — live-ledger assertions + absolute-path + base comparison.
 *
 * REWORK 02 FIXES:
 * - C5/C6/C7: LIVE current.json, release-train.yaml, write-locks.json assertions with evidence pointers
 * - C8/C8b: absolute-path positive + workspace-relative negative
 * - C11/C12: base comparison via git show for forbidden file immutability
 * - C13: AGENTS.md read
 * - C14: null/empty incomplete
 */
const path = require('path');
const VAL = require(path.join(__dirname, 'validator.js'));
const FIXTURES = require(path.join(__dirname, 'fixtures.js'));

var passed = 0, failed = 0;
var testPromises = [];

function test(name, fn) {
  var p = new Promise(function (resolve) {
    try { fn(); passed++; console.log('[PASS] ' + name); }
    catch (e) { failed++; console.log('[FAIL] ' + name + ' — ' + (e.message || '').slice(0, 200)); }
    resolve();
  });
  testPromises.push(p);
}
function ensure(cond, msg) { if (!cond) throw new Error(msg); }

// ── C1: 30 positive scenarios confirmed ──
test('C1: 30 positive scenarios confirmed', function () {
  FIXTURES.positive.forEach(function (s) {
    var r = VAL.classifyFact(s);
    ensure(r.classification === 'confirmed', 'pos ' + s.id + ' expected confirmed got ' + r.classification + ' (' + r.errorCode + ': ' + r.evidencePointer + ')');
  });
});

// ── C2: 18 negative scenarios match expected ──
test('C2: 18 negative scenarios match expected', function () {
  FIXTURES.negative.forEach(function (s) {
    var r = VAL.classifyFact(s);
    ensure(r.classification === s.expected, 'neg ' + s.id + ' expected ' + s.expected + ' got ' + r.classification + ' (' + r.errorCode + ': ' + r.evidencePointer + ')');
  });
});

// ── C3: batch validation total=48 matched=48 mismatched=0 ──
test('C3: batch validation total=48 matched=48 mismatched=0', function () {
  var batch = VAL.validateBatch(FIXTURES.all);
  ensure(batch.summary.total === 48, 'expected 48 total, got ' + batch.summary.total);
  ensure(batch.summary.matched === 48, 'expected 48 matched, got ' + batch.summary.matched);
  ensure(batch.summary.mismatched === 0, 'expected 0 mismatched, got ' + batch.summary.mismatched);
});

// ── C4: stable error codes ──
test('C4a: error code E_VERSION_MISMATCH', function () {
  var r = VAL.classifyFact(FIXTURES.negative[0]);
  ensure(r.errorCode === 'E_VERSION_MISMATCH', 'expected E_VERSION_MISMATCH, got ' + r.errorCode);
});
test('C4b: error code E_STATE_NOT_ALLOWED', function () {
  var r = VAL.classifyFact(FIXTURES.negative[1]);
  ensure(r.errorCode === 'E_STATE_NOT_ALLOWED', 'expected E_STATE_NOT_ALLOWED, got ' + r.errorCode);
});
test('C4c: error code E_BASE_COMMIT_MISMATCH', function () {
  var r = VAL.classifyFact(FIXTURES.negative[3]);
  ensure(r.errorCode === 'E_BASE_COMMIT_MISMATCH', 'expected E_BASE_COMMIT_MISMATCH, got ' + r.errorCode);
});
test('C4d: error code E_CANDIDATE_FROZEN_MISMATCH', function () {
  var r = VAL.classifyFact(FIXTURES.negative[2]);
  ensure(r.errorCode === 'E_CANDIDATE_FROZEN_MISMATCH', 'expected E_CANDIDATE_FROZEN_MISMATCH, got ' + r.errorCode);
});
test('C4e: error code E_DUPLICATE_FACT', function () {
  var r = VAL.classifyFact(FIXTURES.negative[13]);
  ensure(r.errorCode === 'E_DUPLICATE_FACT', 'expected E_DUPLICATE_FACT, got ' + r.errorCode);
});

// ── C5: LIVE current.json assertions ──
test('C5: LIVE current.json assertions', function () {
  ensure(VAL.REAL.currentJson !== null, 'current.json not loaded');
  ensure(VAL.LIVE.active_version !== undefined, 'LIVE.active_version missing');
  ensure(VAL.LIVE.state !== undefined, 'LIVE.state missing');
  ensure(VAL.LIVE.transition_id !== undefined, 'LIVE.transition_id missing');
  ensure(VAL.LIVE.active_version === VAL.REAL.currentJson.active_version, 'LIVE active_version mismatch');
  ensure(VAL.LIVE.state === VAL.REAL.currentJson.state, 'LIVE state mismatch');
  var driftResult = VAL.classifyFact({ id: 'test', name: 'live-version-mismatch', input: { active_version: '4.2.4', plan_version: '4.2.4' } });
  ensure(driftResult.classification === 'drift', 'live version mismatch should be drift');
  ensure(driftResult.errorCode === 'E_LIVE_VERSION_DRIFT', 'expected E_LIVE_VERSION_DRIFT, got ' + driftResult.errorCode);
  ensure(driftResult.evidencePointer.indexOf('source=current.json') >= 0, 'evidence pointer must include source=current.json: ' + driftResult.evidencePointer);
});

// ── C6: LIVE release-train.yaml assertions ──
test('C6: LIVE release-train.yaml assertions', function () {
  ensure(VAL.REAL.releaseTrain !== null, 'release-train.yaml not loaded');
  ensure(VAL.LIVE.rt_active_version !== undefined, 'LIVE.rt_active_version missing');
  ensure(VAL.LIVE.rt_base_commit !== undefined, 'LIVE.rt_base_commit missing');
  ensure(VAL.LIVE.rt_candidate_status !== undefined, 'LIVE.rt_candidate_status missing');
  ensure(VAL.LIVE.rt_active_version === VAL.REAL.releaseTrain.active_version, 'LIVE rt_active_version mismatch');
  ensure(VAL.LIVE.rt_base_commit === VAL.REAL.releaseTrain.base_commit, 'LIVE rt_base_commit mismatch');
  var staleResult = VAL.classifyFact({ id: 'test', name: 'live-base-commit-mismatch', input: { base_commit: '6910e90bcc2206658a3c66f6c203216b70089001' } });
  ensure(staleResult.classification === 'stale', 'live base commit mismatch should be stale');
  ensure(staleResult.evidencePointer.indexOf('source=release-train.yaml') >= 0, 'evidence pointer must include source=release-train.yaml: ' + staleResult.evidencePointer);
});

// ── C7: LIVE write-locks.json assertions ──
test('C7: LIVE write-locks.json assertions', function () {
  ensure(VAL.REAL.writeLocks !== null, 'write-locks.json not loaded');
  ensure(VAL.LIVE.lock_state !== undefined, 'LIVE.lock_state missing');
  ensure(VAL.LIVE.lock_owner !== undefined, 'LIVE.lock_owner missing');
  ensure(VAL.LIVE.lock_state === 'granted', 'expected lock_state=granted, got ' + VAL.LIVE.lock_state);
  ensure(VAL.LIVE.lock_owner === 'opensquilla', 'expected lock_owner=opensquilla, got ' + VAL.LIVE.lock_owner);
});

// ── C8: absolute report path contract ──
test('C8: absolute report path positive case', function () {
  var r = VAL.classifyFact(FIXTURES.positive[12]);
  ensure(r.classification === 'confirmed', 'absolute path should be confirmed: ' + r.classification + ' (' + r.errorCode + ')');
});
test('C8b: workspace-relative path is false', function () {
  var r = VAL.classifyFact(FIXTURES.negative[10]);
  ensure(r.classification === 'false', 'workspace-relative should be false: ' + r.classification + ' (' + r.errorCode + ')');
  ensure(r.errorCode === 'E_REPORT_PATH_NOT_ABSOLUTE', 'expected E_REPORT_PATH_NOT_ABSOLUTE: ' + r.errorCode);
});

// ── C9: classification output schema complete ──
test('C9: classification output schema complete', function () {
  var r = VAL.classifyFact(FIXTURES.positive[0]);
  ensure(typeof r.classification === 'string', 'classification missing');
  ensure(r.errorCode === null || typeof r.errorCode === 'string', 'errorCode missing');
  ensure(typeof r.scenarioName === 'string', 'scenarioName missing');
  ensure(typeof r.evidencePointer === 'string', 'evidencePointer missing');
  ensure(typeof r.details === 'string', 'details missing');
});

// ── C10: deterministic classification ──
test('C10: deterministic classification', function () {
  var r1 = VAL.classifyFact(FIXTURES.positive[0]);
  var r2 = VAL.classifyFact(FIXTURES.positive[0]);
  ensure(r1.classification === r2.classification, 'non-deterministic');
  ensure(r1.errorCode === r2.errorCode, 'non-deterministic errorCode');
});

// ── C11: base comparison via git show ──
test('C11: base comparison uses git show', function () {
  ensure(typeof VAL.baseComparison === 'function', 'baseComparison missing');
  var result = VAL.baseComparison('app/js/clinical-context.js', FIXTURES.REAL.base_commit);
  ensure(result.status === 'immutable', 'clinical-context.js should be immutable: ' + result.status);
  ensure(result.baseSha !== null, 'baseSha missing');
  ensure(result.currentSha !== null, 'currentSha missing');
});

// ── C12: forbidden files not modified by this task ──
test('C12: forbidden files base comparison', function () {
  var forbidden = ['app/js/store.js', 'app/js/app.js', 'app/js/clinical-context.js', 'main.js', 'preload.js', 'package.json'];
  forbidden.forEach(function (f) {
    var result = VAL.baseComparison(f, FIXTURES.REAL.base_commit);
    ensure(result.status === 'immutable' || result.status === 'not-in-base' || result.status === 'modified-by-others',
      f + ' unexpected status: ' + result.status);
  });
});

// ── C13: AGENTS.md read ──
test('C13: AGENTS.md read', function () {
  ensure(VAL.REAL.agentsMd !== null, 'AGENTS.md not loaded');
  ensure(VAL.REAL.agentsMd.indexOf('XinJing') >= 0 || VAL.REAL.agentsMd.indexOf('平台规则') >= 0, 'AGENTS.md missing key content');
});

// ── C14: null scenario returns incomplete ──
test('C14: null scenario returns incomplete', function () {
  var r = VAL.classifyFact(null);
  ensure(r.classification === 'incomplete', 'null should be incomplete');
  ensure(r.errorCode === 'E_INVALID_SCENARIO', 'expected E_INVALID_SCENARIO');
  var r2 = VAL.classifyFact({});
  ensure(r2.classification === 'incomplete', 'empty should be incomplete');
  ensure(r2.errorCode === 'E_EMPTY_INPUT', 'expected E_EMPTY_INPUT');
});

// ── C15: batch validation summary byClassification ──
test('C15: validateBatch summary byClassification', function () {
  var batch = VAL.validateBatch(FIXTURES.all);
  ensure(batch.summary.byClassification.confirmed >= 30, 'expected >=30 confirmed');
  ensure(batch.summary.byClassification['false'] >= 6, 'expected >=6 false');
  ensure(batch.summary.byClassification.stale >= 3, 'expected >=3 stale');
  ensure(batch.summary.byClassification.incomplete >= 3, 'expected >=3 incomplete');
  ensure(batch.summary.byClassification.drift >= 3, 'expected >=3 drift');
});

// ── C16: REAL plan SHA matches known value ──
test('C16: REAL plan SHA matches known value', function () {
  ensure(VAL.REAL.planSha256 === FIXTURES.REAL.plan_sha256, 'plan SHA mismatch: ' + VAL.REAL.planSha256);
  ensure(VAL.REAL.protectedSha256 === FIXTURES.REAL.protected_manifest_sha256, 'protected SHA mismatch: ' + VAL.REAL.protectedSha256);
});

// ── C17: no production file in allowlist ──
test('C17: no production file in allowlist', function () {
  var r = VAL.classifyFact({ id: 't', name: 't', input: { lock_globs: ['app/js/store.js', 'tests/**'] } });
  ensure(r.classification === 'false', 'production file should be false: ' + r.classification);
  ensure(r.errorCode === 'E_LOCK_ALLOWLIST_MISMATCH', 'wrong error: ' + r.errorCode);
});

// ── Summary ──
Promise.all(testPromises).then(function () {
  console.log('\n=== XJ-4.3.0 Plan-Facts Shadow Audit (Rework 02) ===');
  console.log('----------------------------------------');
  console.log('Passed: ' + passed + ' | Failed: ' + failed);
  console.log('test_phase: ' + (failed === 0 ? 'ALL-GREEN' : 'CONTRACT-BROKEN'));
  if (failed > 0) process.exit(1);
});
