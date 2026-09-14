'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var { spawnSync } = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var OUT = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-independent-context-reconciliation');
var TEST = __dirname;

function sha256(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex').toUpperCase(); }
  catch (e) { return 'MISSING'; }
}

var checks = [];
var p = 0, f = 0;
function check(id, label, cond) {
  var ok = !!cond;
  if (ok) p++; else f++;
  checks.push({ id: id, label: label, pass: ok });
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label);
}

console.log('=== Artifact Verification ===\n');

var files = [
  [path.join(OUT, 'context-reconciliation-matrix.json'), 'context-reconciliation-matrix.json'],
  [path.join(OUT, 'replay-log.md'), 'replay-log.md'],
  [path.join(TEST, 'run-independent-context-contract.js'), 'run-independent-context-contract.js'],
  [path.join(TEST, 'mutation-probes.js'), 'mutation-probes.js'],
  [path.join(TEST, 'verify-artifacts.js'), 'verify-artifacts.js'],
  [path.join(ROOT, 'qa', 'agent-reviews', 'XJ-4.3.0-opensquilla-independent-context-reconciliation-01.md'), 'delivery-report']
];

var shas = {};
files.forEach(function (f) {
  var h = sha256(f[0]);
  shas[f[1]] = h;
  console.log('  SHA-256 ' + f[1] + ': ' + h);
  check('V1-' + f[1], 'exists: ' + f[1], h !== 'MISSING');
});

// V2: git diff --check clean
var diffCheck = spawnSync('git', ['diff', '--check', '--',
  'docs/agent-coordination/v4.3.0/inventory/opensquilla-independent-context-reconciliation',
  'tests/v4.3.0-disposable/opensquilla-independent-context-reconciliation',
  'qa/agent-reviews/XJ-4.3.0-opensquilla-independent-context-reconciliation-01.md'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });

var statusCheck = spawnSync('git', ['status', '--porcelain', '--',
  'tests/v4.3.0-disposable/opensquilla-independent-context-reconciliation'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });

var untracked = (statusCheck.stdout || '').split(/\r?\n/).filter(function (l) {
  return /^\?\?/.test(l) && /mutated-runner/.test(l);
});
check('V2', 'git diff --check clean, no untracked temp residue',
  diffCheck.status === 0 && untracked.length === 0);

console.log('\n=== Artifact Verification ===');
console.log('----------------------------------------');
console.log('Passed: ' + p + ' | Failed: ' + f);
console.log('verify_phase: ' + (f === 0 ? 'ALL-VERIFIED' : 'CONTRACT-BROKEN'));
process.exit(f === 0 ? 0 : 1);