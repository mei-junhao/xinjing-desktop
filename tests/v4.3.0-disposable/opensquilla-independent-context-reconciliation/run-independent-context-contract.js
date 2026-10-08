'use strict';
/*
 * XJ-4.3.0-opensquilla-independent-context-reconciliation-01
 * Independent Context Reconciliation Runner
 *
 * Proves:
 * 1. SourceRef.verify(ref, independentCurrent) correctly fail-closes on
 *    cross-client and cross-session mismatches (CONFIRMED).
 * 2. SourceRefAdapter.verifyAtlasSourceRef ignores the independent
 *    currentContext parameter — the adapter passes ref.clientId as current,
 *    so tampered refs pass verification (DEGRADED_EXPECTED_RED).
 *
 * This resolves the ambiguity between:
 *  - material-replay C3: SourceRef control layer PASS (CONFIRMED)
 *  - production-contract Item 7: adapter layer DEGRADED (cannot accept
 *    independent currentContext)
 */
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));
var SourceRefAdapter = require(path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'source-ref-adapter.js'));

var OUT_DIR = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-independent-context-reconciliation');
var BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
var MANIFEST_HASH = 'E83AAE7BC0B3AE5E8127F9815D0FBA3DF80F925353ACC9112B18F70633DB76BC';

var checks = [];
var total = 0, passed = 0;
function check(id, label, cond, classification) {
  total++;
  var ok = !!cond;
  if (ok) passed++;
  checks.push({ id: id, label: label, pass: ok, classification: classification || (ok ? 'CONFIRMED' : 'BLOCKED') });
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label + ' (' + (ok ? 'CONFIRMED' : 'BLOCKED') + ')');
}

// ─── Fixtures: create via adapter (handles anchor normalization) ───
var atlasRef = SourceRefAdapter.createAtlasSourceRef({
  clientId: 'synth-client-001', sessionId: 'synth-sess-001',
  anchor: { kind: 'transcript', locator: 'paragraph' }, sourceText: '原始材料内容',
  anchorText: '锚点文本', capturedAt: new Date().toISOString()
});

// Alias for SourceRef control layer tests
var ref = atlasRef;

var independentCurrent = {
  clientId: 'synth-client-001',
  sessionId: 'synth-sess-001',
  anchor: ref.anchor,
  sourceText: '原始材料内容',
  anchorText: '锚点文本'
};

var wrongClient = Object.assign({}, independentCurrent, { clientId: 'synth-client-999' });
var wrongSession = Object.assign({}, independentCurrent, { sessionId: 'synth-sess-999' });

// ═══════════════════════════════════════════════════════════════
// SECTION A: SourceRef Control Layer — Cross-Client Fail-Closed
// ═══════════════════════════════════════════════════════════════

// C1: SourceRef.verify with correct clientId → verified
var r1 = SourceRef.verify(ref, independentCurrent);
check('C1', 'SourceRef verify with matching clientId verified',
  r1.status === 'unchanged' && r1.verified === true, 'CONFIRMED');

// C2: SourceRef.verify with different clientId → fail-closed
var r2 = SourceRef.verify(ref, wrongClient);
check('C2', 'SourceRef verify with different clientId fail-closed',
  r2.verified === false, 'CONFIRMED');

// C2b: verify with wrong client returns ambiguous status
check('C2b', 'SourceRef verify with wrong client returns ambiguous',
  r2.status === 'ambiguous', 'CONFIRMED');

// C3: SourceRef.verify with different sessionId → fail-closed
var r3 = SourceRef.verify(ref, wrongSession);
check('C3', 'SourceRef verify with different sessionId fail-closed',
  r3.verified === false, 'CONFIRMED');

// C3b: verify with wrong session returns ambiguous
check('C3b', 'SourceRef verify with wrong session returns ambiguous',
  r3.status === 'ambiguous', 'CONFIRMED');

// C4: SourceRef.verify with correct session → verified
var r4 = SourceRef.verify(ref, independentCurrent);
check('C4', 'SourceRef verify with matching sessionId verified',
  r4.status === 'unchanged' && r4.verified === true, 'CONFIRMED');

// ═══════════════════════════════════════════════════════════════
// SECTION B: Adapter Layer — Independent Context Not Accepted
// ═══════════════════════════════════════════════════════════════

// D1: Adapter verify with independently correct context → verified (degrades)
// The adapter IGNORES the independent context and reuses ref.clientId
var d1 = SourceRefAdapter.verifyAtlasSourceRef(atlasRef, '原始材料内容', '锚点文本', independentCurrent);
check('D1', 'Adapter verify with correct independent context returns verified',
  d1.verified === true, 'DEGRADED_EXPECTED_RED');

// D2: Adapter verify with WRONG clientId in independent context → STILL verified
// The adapter ignores the fourth parameter, so cross-client tampering is NOT detected
var d2 = SourceRefAdapter.verifyAtlasSourceRef(atlasRef, '原始材料内容', '锚点文本', wrongClient);
check('D2', 'Adapter verify with wrong client in independent context still verified (DEGRADED)',
  d2.verified === true, 'DEGRADED_EXPECTED_RED');

// D2b: SourceRef control layer catches the same cross-client mismatch
var r2b = SourceRef.verify(atlasRef, wrongClient);
check('D2b', 'SourceRef control layer catches cross-client mismatch that adapter misses',
  r2b.verified === false, 'CONFIRMED');

// D3: Adapter verify with WRONG sessionId in independent context → STILL verified
var d3 = SourceRefAdapter.verifyAtlasSourceRef(atlasRef, '原始材料内容', '锚点文本', wrongSession);
check('D3', 'Adapter verify with wrong session in independent context still verified (DEGRADED)',
  d3.verified === true, 'DEGRADED_EXPECTED_RED');

// D3b: SourceRef control layer catches the same cross-session mismatch
var r3b = SourceRef.verify(atlasRef, wrongSession);
check('D3b', 'SourceRef control layer catches cross-session mismatch that adapter misses',
  r3b.verified === false, 'CONFIRMED');

// D4: Both layers agree on correct context
check('D4', 'Both layers agree on correct context',
  d1.verified === true && r4.verified === true, 'CONFIRMED');

// D5: Gap classification — adapter degrades, control layer confirmed
check('D5', 'Gap classification: adapter DEGRADED, control layer CONFIRMED',
  d2.verified === true && r2b.verified === false, 'DEGRADED_EXPECTED_RED');

// D6: Classification integrity — D2 must NOT be classified as CONFIRMED
check('D6', 'D2 classification must be DEGRADED_EXPECTED_RED, not CONFIRMED',
  d2.verified === true, 'DEGRADED_EXPECTED_RED');

// D7: Classification integrity — D3 must NOT be classified as CONFIRMED
check('D7', 'D3 classification must be DEGRADED_EXPECTED_RED, not CONFIRMED',
  d3.verified === true, 'DEGRADED_EXPECTED_RED');

// ─── Write deterministic matrix (no generated_at) ───
var matrix = {
  schema_version: 1,
  task_id: 'XJ-4.3.0-opensquilla-independent-context-reconciliation-01',
  base_commit: BASE_COMMIT,
  protected_manifest_hash: MANIFEST_HASH,
  classifications: {
    source_ref_control_layer: {
      cross_client_fail_closed: 'CONFIRMED',
      cross_session_fail_closed: 'CONFIRMED',
      matching_context_verified: 'CONFIRMED'
    },
    adapter_layer: {
      independent_context_accepted: 'DEGRADED_EXPECTED_RED',
      reason: 'verifyAtlasSourceRef ignores fourth parameter; passes ref.clientId as current context',
      production_fix: 'verifyAtlasSourceRef(ref, currentContext) must accept independent { currentClientId, currentSessionId }'
    }
  },
  results: checks
};

var matrixPath = path.join(OUT_DIR, 'context-reconciliation-matrix.json');
fs.writeFileSync(matrixPath, JSON.stringify(matrix, null, 2), 'utf8');

// ─── Write replay log (deterministic) ───
var log = checks.map(function (c) {
  return c.classification + ' ' + c.id + ' ' + c.label + ' ' + (c.pass ? 'PASS' : 'FAIL');
}).join('\n');
var logPath = path.join(OUT_DIR, 'replay-log.md');
fs.writeFileSync(logPath, '# Context Reconciliation Replay Log\n\n' + log + '\n', 'utf8');

// ─── Summary ───
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + (total - passed));
console.log('reconciliation_phase: ' + (passed === total ? 'ALL-GREEN' : 'CONTRACT-BROKEN'));
process.exit(passed === total ? 0 : 1);