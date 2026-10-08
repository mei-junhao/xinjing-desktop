'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

var ROOT = 'D:\\xinjing-electron';
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'capability-parity');
var TST = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'capability-parity');
var QA = path.join(ROOT, 'qa', 'agent-reviews');

var passed = 0, failed = 0;
function check(label, cond) { cond ? passed++ : failed++; console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + label); }

var files = [
  path.join(INV, 'capability-parity-matrix.md'),
  path.join(TST, 'validate-parity-matrix.js'),
  path.join(QA, 'XJ-5.0.0-agent-a-capability-parity-risk-inventory-02.md'),
];
files.forEach(function(f) {
  check('exists: ' + path.basename(f), fs.existsSync(f));
  if (fs.existsSync(f)) console.log('  SHA-256 ' + path.basename(f) + ': ' + sha256(f));
});

console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);