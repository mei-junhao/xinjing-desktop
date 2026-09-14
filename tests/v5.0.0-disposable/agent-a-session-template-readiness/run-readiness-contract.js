'use strict';
/**
 * XJ-5.0.0 Agent A 4.3 Session Template Readiness — Contract Runner
 * Reads real source files and evidence artifacts.
 * All 8 rows EXPECTED_RED — no session-template implementation exists.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

var ROOT = path.resolve('D:\\xinjing-electron');
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-session-template-readiness');
var OUT = path.join(INV, 'contract-result.json');

var checks = [];
var confirmedCount = 0, expectedRedCount = 0, failedCount = 0;

function check(id, label, cond, classification) {
  var ok = !!cond;
  var cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  checks.push({ id: id, label: label, pass: ok, classification: cls, is_expected_red: cls === 'EXPECTED_RED' });
  var statusTag = cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : (ok ? 'PASS' : 'FAIL');
  console.log('[' + statusTag + '] ' + id + ': ' + label + ' (' + cls + ')');
}

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

// ═══ P1: Protected source hash verification ═══
var manifest = JSON.parse(fs.readFileSync(path.join(INV, 'protected-files-manifest.json'), 'utf8'));
var allHashesOk = true;
manifest.protected_files.forEach(function(f) {
  var p = path.join(ROOT, f.path);
  var exists = fs.existsSync(p);
  var actual = exists ? sha256(p) : 'MISSING';
  var match = actual === f.sha256;
  if (!match) allHashesOk = false;
  check('P1_' + f.path.replace(/[^a-z0-9]/gi, '_'), 'protected hash: ' + f.path, match, 'CONFIRMED');
});

// ═══ P2: Readiness matrix structure ═══
var matrix = JSON.parse(fs.readFileSync(path.join(INV, 'session-template-readiness-matrix.json'), 'utf8'));
check('P2A', 'matrix has 8 rows', matrix.rows.length === 8, 'CONFIRMED');
var rowIds = ['R1','R2','R3','R4','R5','R6','R7','R8'];
rowIds.forEach(function(rid, i) {
  var row = matrix.rows[i];
  check('P2B_' + rid, 'row ' + rid + ' has required fields', !!row.id && !!row.capability && !!row.status && Array.isArray(row.source_anchors) && row.source_anchors.length > 0 && !!row.acceptance_condition, 'CONFIRMED');
  check('P2C_' + rid, 'row ' + rid + ' source_anchors are nonempty strings', Array.isArray(row.source_anchors) && row.source_anchors.every(function(a) { return typeof a === 'string' && a.length > 0; }), 'CONFIRMED');
  check('P2D_' + rid, 'row ' + rid + ' source_anchors reference protected files', Array.isArray(row.source_anchors) && row.source_anchors.every(function(a) {
    return manifest.protected_files.some(function(pf) { return a.indexOf(pf.path) !== -1; });
  }), 'CONFIRMED');
});

// ═══ P3: Source anchor capture ═══
var capture = JSON.parse(fs.readFileSync(path.join(INV, 'source-anchor-capture.json'), 'utf8'));
check('P3A', 'source anchor capture has 4 protected files', capture.protected_files.length === 4, 'CONFIRMED');
check('P3B', 'all source hashes in capture match manifest', capture.protected_files.every(function(f) {
  return manifest.protected_files.some(function(m) { return m.path === f.path && m.sha256 === f.sha256; });
}), 'CONFIRMED');

// ═══ R1-R8: Capability readiness ═══
matrix.rows.forEach(function(row) {
  check(row.id, row.capability + ' — ' + row.description, row.status === 'EXPECTED_RED', 'EXPECTED_RED');
});

// ═══ R9: All rows are EXPECTED_RED (no fabricated CONFIRMED) ═══
check('R9', 'all 8 rows are EXPECTED_RED (no fabricated implementation)', matrix.rows.every(function(r) { return r.status === 'EXPECTED_RED'; }), 'EXPECTED_RED');
check('R9B', 'no empty source_anchors in any row', matrix.rows.every(function(r) { return Array.isArray(r.source_anchors) && r.source_anchors.length > 0; }), 'CONFIRMED');

// ═══ Write result ═══
var result = {
  task_id: 'XJ-5.0.0-agent-a-v4.3-session-template-readiness-02',
  write_lock_id: 'lock-XJ-5.0.0-agent-a-v4.3-session-template-readiness-02',
  checks: checks,
  confirmed: confirmedCount,
  expected_red: expectedRedCount,
  failed: failedCount,
  total: confirmedCount + expectedRedCount + failedCount,
  protected_hashes_verified: allHashesOk
};
fs.mkdirSync(INV, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

console.log('----------------------------------------');
console.log('Confirmed: ' + confirmedCount + ' | Expected-Red: ' + expectedRedCount + ' | Failed: ' + failedCount);
process.exit(failedCount === 0 ? 0 : 1);
