'use strict';
/**
 * XJ-5.0.0 Agent A SourceRef Admission Harness — Contract Runner
 * Uses real SourceRef module. Distinguishes CONFIRMED from EXPECTED_RED.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));

var checks = [];
var confirmedCount = 0, expectedRedCount = 0, failedCount = 0;
function check(id, label, cond, classification) {
  var ok = !!cond;
  var cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  var entry = { id: id, label: label, classification: cls, is_expected_red: cls === 'EXPECTED_RED' };
  if (cls === 'EXPECTED_RED') entry.observed_gap = ok;
  else entry.pass = ok;
  checks.push(entry);
  var statusTag = cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : (ok ? 'PASS' : 'FAIL');
  console.log('[' + statusTag + '] ' + id + ': ' + label + ' (' + cls + ')');
}

// ═══ Synthetic fixtures ═══
var ts = new Date().toISOString();
function makeRef(overrides) {
  return SourceRef.create(Object.assign({
    clientId: 'synth-client-001', sessionId: 'synth-sess-001',
    anchor: { kind: 'transcript', locator: 'paragraph:1' },
    sourceText: '原始来源内容', anchorText: '锚点文本',
    sourceContentHash: '', anchorContentHash: '', capturedAt: ts
  }, overrides));
}

var refVerified = makeRef();
var refStale = makeRef({ sourceText: '修改后的来源内容' });
var refInvalid = { schemaVersion: '', sourceContentHash: '' };
var refQuarantined = makeRef({ sourceText: 'quarantined-stale-content' });
var refUnknownClient = makeRef({ clientId: 'unknown-client-999' });
var refUnknownSession = makeRef({ sessionId: 'unknown-sess-999' });
var refCrossClient = makeRef({ clientId: 'synth-client-002' });
var refCrossSession = makeRef({ sessionId: 'synth-sess-002' });
var refMissingHash = makeRef({ sourceContentHash: 'STALE0000000000000000000000000000000000000000000000000000000000' });
var refMismatchedAnchor = makeRef({ anchor: { kind: 'notes', locator: 'field:soap' } });

// ═══ Current context ═══
var current = {
  clientId: 'synth-client-001', sessionId: 'synth-sess-001',
  anchor: { kind: 'transcript', locator: 'paragraph:1' },
  sourceText: '原始来源内容', anchorText: '锚点文本'
};

// ═══ SECTION A: SourceRef Control Layer — CONFIRMED ═══
var r1 = SourceRef.verify(refVerified, current);
check('C1', 'verified source', r1.status === 'unchanged' && r1.verified === true, 'CONFIRMED');

var r2 = SourceRef.verify(refStale, current);
check('C2', 'stale source not verified', r2.verified === false, 'CONFIRMED');

var r3 = SourceRef.verify(refInvalid, current);
check('C3', 'invalid ref rejected', r3.verified === false, 'CONFIRMED');

var r4 = SourceRef.verify(refUnknownClient, current);
check('C4', 'unknown client fail-closed', r4.verified === false, 'CONFIRMED');

var r5 = SourceRef.verify(refCrossClient, current);
check('C5', 'cross-client blocked', r5.verified === false, 'CONFIRMED');

var r6 = SourceRef.verify(refCrossSession, current);
check('C6', 'cross-session blocked', r6.verified === false, 'CONFIRMED');

var r7 = SourceRef.verify(refMissingHash, current);
check('C7', 'hash mismatch detected', r7.verified === false, 'CONFIRMED');

var r8 = SourceRef.verify(refMismatchedAnchor, current);
check('C8', 'anchor mismatch detected', r8.verified === false, 'CONFIRMED');

// C9: Quarantine — use real SourceRef.verify on a ref with stale content
// Gap fix: previously used Object.assign to hand-craft a fake quarantined object.
var rQuarantined = SourceRef.verify(refQuarantined, current);
check('C9', 'quarantined (stale) ref not verified', rQuarantined.verified === false, 'CONFIRMED');

// C10: Legacy migration
var legacyRef = SourceRef.migrateLegacy({ clientId: 'synth-client-001', sessionId: 'synth-sess-001', sourceText: 'legacy content' });
check('C10', 'legacy migration produces unverified', legacyRef.verified === false && legacyRef.legacy === true, 'CONFIRMED');

// ═══ SECTION B: Stage-2 Admission Gap — EXPECTED_RED ═══
check('D1', 'admission pipeline absent', typeof SourceRef.admit === 'undefined', 'EXPECTED_RED');
check('D2', 'material validation gate absent', typeof SourceRef.validateMaterial === 'undefined', 'EXPECTED_RED');
check('D3', 'async admission queue absent', typeof SourceRef.admitAsync === 'undefined', 'EXPECTED_RED');
check('D4', 'quarantine admission gate absent', typeof SourceRef.admitQuarantine === 'undefined', 'EXPECTED_RED');

// ═══ SECTION A2: Unknown-session — CONFIRMED ═══
// Gap fix: previously created refUnknownSession but never called verify on it.
var rUnknownSession = SourceRef.verify(refUnknownSession, current);
check('C11', 'unknown session blocked', rUnknownSession.verified === false, 'CONFIRMED');

// ═══ SECTION C: Real async ordering via setImmediate ═══
// Gap fix: previously synchronous push to array — not truly async.
// SourceRef.verify is synchronous; this case proves results are preserved
// when called from real async callbacks (setImmediate).
var asyncResults = [];
setImmediate(function () { asyncResults.push(SourceRef.verify(refVerified, current)); });
setImmediate(function () { asyncResults.push(SourceRef.verify(refStale, current)); });
setImmediate(function () {
  check('C12', 'async ordering preserves results', asyncResults.length === 2 && asyncResults[0].verified === true && asyncResults[1].verified === false, 'CONFIRMED');

  // ═══ Write matrix ═══
  var matrix = {
    task_id: 'XJ-5.0.0-agent-a-source-ref-admission-harness-01',
    write_lock_id: 'lock-XJ-5.0.0-agent-a-source-ref-admission-harness-01',
    checks: checks,
    confirmed: confirmedCount,
    expected_red: expectedRedCount,
    failed: failedCount,
    total: confirmedCount + expectedRedCount + failedCount
  };
  var matrixPath = process.env.XJ_SOURCE_REF_MATRIX_PATH || path.join(
    ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-source-ref-admission', 'contract-matrix.json'
  );
  fs.mkdirSync(path.dirname(matrixPath), { recursive: true });
  fs.writeFileSync(matrixPath, JSON.stringify(matrix, null, 2), 'utf8');

  console.log('----------------------------------------');
  console.log('Confirmed: ' + confirmedCount + ' | Expected-Red: ' + expectedRedCount + ' | Failed: ' + failedCount);
  process.exit(failedCount === 0 ? 0 : 1);
});
