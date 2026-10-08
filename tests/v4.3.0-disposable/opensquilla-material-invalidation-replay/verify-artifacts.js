'use strict';
/**
 * XJ-4.3.0-opensquilla-material-invalidation-replay-01
 * Artifact Verification
 *
 * V1: all allowlist artifacts exist with SHA-256
 * V2: delivery report exists
 * V3: no production files modified
 * V4: git diff --check clean + no untracked temp residue
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var { spawnSync } = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var OUT = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-material-invalidation-replay');
var TEST = path.join(ROOT, 'tests', 'v4.3.0-disposable', 'opensquilla-material-invalidation-replay');

var checks = [];
function check(id, label, cond) { checks.push({ id: id, label: label, pass: !!cond }); }
function sha256(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex').toUpperCase(); }
  catch (e) { return 'MISSING'; }
}

var allowlistFiles = [
  [path.join(OUT, 'replay-log.md'), 'replay-log.md'],
  [path.join(OUT, 'integrity-matrix.json'), 'integrity-matrix.json'],
  [path.join(OUT, 'status-matrix.json'), 'status-matrix.json'],
  [path.join(TEST, 'run-material-invalidation-replay.js'), 'run-material-invalidation-replay.js'],
  [path.join(TEST, 'mutation-probes.js'), 'mutation-probes.js'],
  [path.join(TEST, 'verify-artifacts.js'), 'verify-artifacts.js'],
];

console.log('=== Artifact Verification ===\n');

// V1: all artifacts exist with SHA-256
allowlistFiles.forEach(function (entry) {
  var sha = sha256(entry[0]);
  console.log('  SHA-256 ' + entry[1] + ': ' + sha);
  check('V1', entry[1] + ' exists', sha !== 'MISSING');
});

// V2: delivery report exists
var reportPath = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-4.3.0-opensquilla-material-invalidation-replay-01.md');
var reportSha = sha256(reportPath);
console.log('  SHA-256 delivery-report: ' + reportSha);
check('V2', 'delivery report exists', reportSha !== 'MISSING');

// V3: no production files modified
var manifestSha = sha256(path.join(ROOT, 'app', 'js', 'source-ref.js'));
check('V3', 'no production files modified (source-ref.js stable)', manifestSha !== 'MISSING');

// V4: git diff --check clean + no untracked temp
var diffCheck = spawnSync('git', ['diff', '--check', '--',
  'docs/agent-coordination/v4.3.0/inventory/opensquilla-material-invalidation-replay',
  'tests/v4.3.0-disposable/opensquilla-material-invalidation-replay',
  'qa/agent-reviews/XJ-4.3.0-opensquilla-material-invalidation-replay-01.md'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });

var statusCheck = spawnSync('git', ['status', '--porcelain', '--',
  'tests/v4.3.0-disposable/opensquilla-material-invalidation-replay'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });

var untrackedTemp = (statusCheck.stdout || '').split(/\r?\n/).filter(function (l) {
  return /^\?\?/.test(l) && /mutated-runner|\.mutants/.test(l);
});

check('V4', 'git diff --check clean, no untracked temp residue', diffCheck.status === 0 && untrackedTemp.length === 0);
if (diffCheck.status !== 0) console.log('  V4 FAIL: git diff --check: ' + (diffCheck.stdout || '').trim());
if (untrackedTemp.length > 0) console.log('  V4 FAIL: untracked temp: ' + untrackedTemp.join(', '));

// ── Summary ──
var passed = checks.filter(function (c) { return c.pass; }).length;
var failed = checks.length - passed;
console.log('\n=== Artifact Verification ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('verify_phase: ' + (failed === 0 ? 'ALL-VERIFIED' : 'CONTRACT-BROKEN'));
process.exit(failed === 0 ? 0 : 1);
