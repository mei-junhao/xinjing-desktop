'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

var ROOT = 'D:\\xinjing-electron';
var TST = path.join(ROOT, 'tests', 'v4.3.0-production', 'source-ref-admission');
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-source-ref-admission');
var QA = path.join(ROOT, 'qa', 'agent-reviews');

var passed = 0, failed = 0;
function check(label, cond) { cond ? passed++ : failed++; console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + label); }

var files = [
  path.join(TST, 'run-contract.js'),
  path.join(TST, 'mutation-probes.js'),
  path.join(TST, 'verify-artifacts.js'),
  path.join(INV, 'contract-matrix.json'),
  path.join(QA, 'XJ-5.0.0-agent-a-source-ref-admission-harness-01.md'),
];
files.forEach(function(f) {
  check('exists: ' + path.basename(f), fs.existsSync(f));
  if (fs.existsSync(f)) console.log('  SHA-256 ' + path.basename(f) + ': ' + sha256(f));
});

var matrixPath = path.join(INV, 'contract-matrix.json');
if (fs.existsSync(matrixPath)) {
  var matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  var expectedRed = matrix.checks.filter(function(entry) { return entry.classification === 'EXPECTED_RED'; });
  var confirmed = matrix.checks.filter(function(entry) { return entry.classification === 'CONFIRMED'; });
  check('matrix has 12 confirmed checks', matrix.confirmed === 12 && confirmed.length === 12);
  check('matrix has four expected-red gaps', matrix.expected_red === 4 && expectedRed.length === 4);
  check('expected-red gaps are D1-D4 without pass markers', expectedRed.every(function(entry, index) {
    return entry.id === 'D' + (index + 1) && entry.is_expected_red === true && !Object.prototype.hasOwnProperty.call(entry, 'pass') && entry.observed_gap === true;
  }));
  check('matrix has no failed checks', matrix.failed === 0);
}

// git diff check
var r = require('child_process').spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
check('git diff --check clean', r.status === 0);

console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
