'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

var ROOT = 'D:\\xinjing-electron';
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.4-controlled-supervision-package-expected-red-31');
var TST = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'agent-a-v4.4-controlled-supervision-package-expected-red-31');
var QA = path.join(ROOT, 'qa', 'agent-reviews');
var REPORT = path.join(QA, 'XJ-5.0.0-agent-a-v4.4-controlled-supervision-package-expected-red-31.md');

var passed = 0, failed = 0;
function check(label, cond) { cond ? passed++ : failed++; console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + label); }

var files = [
  path.join(INV, 'protected-files-manifest.json'),
  path.join(INV, 'contract-result.json'),
  path.join(TST, 'run-contract.js'),
  path.join(TST, 'mutation-probes.js'),
  path.join(TST, 'verify-artifacts.js'),
  REPORT,
];
files.forEach(function(f) {
  check('exists: ' + path.basename(f), fs.existsSync(f));
  if (fs.existsSync(f)) console.log('  SHA-256 ' + path.basename(f) + ': ' + sha256(f));
});

var r = require('child_process').spawnSync('git', ['diff', '--check', '--',
  'tests/v5.0.0-disposable/agent-a-v4.4-controlled-supervision-package-expected-red-31',
  'qa/agent-reviews/XJ-5.0.0-agent-a-v4.4-controlled-supervision-package-expected-red-31.md'],
  { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
check('git diff --check clean (allowlist scope)', r.status === 0);

if (fs.existsSync(REPORT)) {
  var reportContent = fs.readFileSync(REPORT, 'utf8');
  var bindTargets = [
    path.join(TST, 'run-contract.js'),
    path.join(TST, 'mutation-probes.js'),
    path.join(TST, 'verify-artifacts.js'),
    path.join(INV, 'contract-result.json'),
  ];
  bindTargets.forEach(function(f) {
    var basename = path.basename(f);
    if (!fs.existsSync(f)) { check('hash-bind: ' + basename + ' exists', false); return; }
    var actualSha = sha256(f);
    var escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp(escaped + '\\s*\\|\\s*([A-F0-9]{64})', 'i');
    var match = reportContent.match(regex);
    if (match) {
      check('hash-bind: ' + basename + ' matches report', match[1].toUpperCase() === actualSha);
    } else {
      check('hash-bind: ' + basename + ' found in report', false);
    }
  });
  check('delivery report has DELIVERY_REPORT line',
    /DELIVERY_REPORT:\s*D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5\.0\.0-agent-a-v4\.4-controlled-supervision-package-expected-red-31\.md/.test(reportContent));
} else {
  check('delivery report present for hash binding', false);
}

console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
