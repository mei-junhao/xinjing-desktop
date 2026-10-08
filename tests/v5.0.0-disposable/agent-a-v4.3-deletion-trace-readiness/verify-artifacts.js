'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

var ROOT = 'D:\\xinjing-electron';
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.3-deletion-trace-readiness');
var TST = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'agent-a-v4.3-deletion-trace-readiness');
var QA = path.join(ROOT, 'qa', 'agent-reviews');

var passed = 0, failed = 0;
function check(label, cond) { cond ? passed++ : failed++; console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + label); }

var files = [
  path.join(INV, 'source-anchor-capture.json'),
  path.join(INV, 'decision-matrix.json'),
  path.join(INV, 'protected-files-manifest.json'),
  path.join(INV, 'contract-result.json'),
  path.join(TST, 'run-contract.js'),
  path.join(TST, 'mutation-probes.js'),
  path.join(TST, 'verify-artifacts.js'),
  path.join(QA, 'XJ-5.0.0-agent-a-v4.3-deletion-trace-readiness-05.md'),
];
files.forEach(function(f) {
  check('exists: ' + path.basename(f), fs.existsSync(f));
  if (fs.existsSync(f)) console.log('  SHA-256 ' + path.basename(f) + ': ' + sha256(f));
});

var r = require('child_process').spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
check('git diff --check clean', r.status === 0);

// Bind: verify report-declared artifact hashes match actual file SHAs
var reportPath = path.join(QA, 'XJ-5.0.0-agent-a-v4.3-deletion-trace-readiness-05.md');
var reportHashes = {};
if (fs.existsSync(reportPath)) {
  var reportContent = fs.readFileSync(reportPath, 'utf8');
  files.forEach(function(f) {
    var basename = path.basename(f);
    if (basename === 'XJ-5.0.0-agent-a-v4.3-deletion-trace-readiness-05.md') return;
    var actualSha = sha256(f);
    var escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp(escaped + '\\s*\\|\\s*([A-F0-9]{64})', 'i');
    var match = reportContent.match(regex);
    if (match) {
      var declaredSha = match[1].toUpperCase();
      check('hash-bind: ' + basename + ' matches report', declaredSha === actualSha);
    } else {
      check('hash-bind: ' + basename + ' found in report', false);
    }
  });
}

console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
