'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PROD = path.join(ROOT, 'app', 'js', 'case-space-view-model.js');
var TEST = path.join(ROOT, 'tests', 'v4.3.0-production', 'case-space-view-model');
var REPORT = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-4.3.0-agent-a-case-space-view-model-01.md');

var checks = [];
function check(id, label, cond) { checks.push({ id: id, label: label, pass: !!cond }); }
function sha256(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex').toUpperCase(); } catch(e) { return 'MISSING'; } }

console.log('=== Artifact Verification ===\n');

var artifacts = [
  [PROD, 'case-space-view-model.js'],
  [path.join(TEST, 'run-case-space-view-model.js'), 'run-case-space-view-model.js'],
  [path.join(TEST, 'mutation-probes.js'), 'mutation-probes.js'],
  [path.join(TEST, 'verify-artifacts.js'), 'verify-artifacts.js'],
];

artifacts.forEach(function(a) {
  var h = sha256(a[0]);
  console.log('  SHA-256 ' + a[1] + ': ' + h);
  check('V1-' + a[1], 'exists: ' + a[1], h !== 'MISSING');
});

var reportSha = sha256(REPORT);
console.log('  SHA-256 delivery-report: ' + reportSha);
check('V1-delivery-report', 'exists: delivery-report', reportSha !== 'MISSING');

// V2: git diff --check
var diffCheck = spawnSync('git', ['diff', '--check', '--',
  'app/js/case-space-view-model.js',
  'tests/v4.3.0-production/case-space-view-model',
  'qa/agent-reviews/XJ-4.3.0-agent-a-case-space-view-model-01.md'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });

var statusCheck = spawnSync('git', ['status', '--porcelain', '--',
  'tests/v4.3.0-production/case-space-view-model'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });

var untrackedTemp = (statusCheck.stdout || '').split(/\r?\n/).filter(function(l) {
  return /^\?\?/.test(l) && /mutated-runner/.test(l);
});
check('V2', 'git diff --check clean, no untracked temp residue', diffCheck.status === 0 && untrackedTemp.length === 0);

var passed = checks.filter(function(c) { return c.pass; }).length;
console.log('\n=== Artifact Verification ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + (checks.length - passed));
console.log('verify_phase: ' + (passed === checks.length ? 'ALL-VERIFIED' : 'CONTRACT-BROKEN'));
process.exit(passed === checks.length ? 0 : 1);