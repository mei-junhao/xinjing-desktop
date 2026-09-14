'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

var ROOT = 'D:\\xinjing-electron';
var TST = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'agent-a-ai-evaluation-fixture');
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-ai-evaluation-fixture');
var QA = path.join(ROOT, 'qa', 'agent-reviews');

var passed = 0, failed = 0;
function check(label, cond) { cond ? passed++ : failed++; console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + label); }

var files = [
  path.join(TST, 'synthetic-corpus.json'),
  path.join(TST, 'run-fixture-contract.js'),
  path.join(TST, 'mutation-probes.js'),
  path.join(TST, 'verify-artifacts.js'),
  path.join(INV, 'metric-matrix.json'),
  path.join(QA, 'XJ-5.0.0-agent-a-ai-evaluation-fixture-01.md'),
];
files.forEach(function(f) {
  check('exists: ' + path.basename(f), fs.existsSync(f));
  if (fs.existsSync(f)) console.log('  SHA-256 ' + path.basename(f) + ': ' + sha256(f));
});

var r = require('child_process').spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
check('git diff --check clean', r.status === 0);

console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
