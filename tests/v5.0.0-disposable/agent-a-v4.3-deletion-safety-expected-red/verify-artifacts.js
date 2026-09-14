'use strict';
/* ============================================================
 * verify-artifacts.js — repair-16 deterministic artifact verifier
 * Task: XJ-5.0.0-agent-workbuddy-v4.3-deletion-safety-expected-red-repair-16
 *
 * Determinism guarantees (vs inherited version):
 *  - contract-result.json no longer carries timestamps, so its SHA is
 *    stable across healthy runs; this verifier asserts that property.
 *  - Hash binding targets the WorkBuddy repair-16 delivery report
 *    (which declares the final artifact SHAs), not the stale A report.
 *  - The read-only A report is verified against its manifest baseline
 *    hash instead (proves it was NOT modified).
 *  - git diff --check is scoped to the repair-16 write allowlist so
 *    unrelated concurrent worktree changes cannot flip the result.
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

var ROOT = 'D:\\xinjing-electron';
var INV_A = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.3-deletion-safety-expected-red');
var INV_R16 = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'workbuddy-v4.3-deletion-safety-expected-red-repair-16');
var TST = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'agent-a-v4.3-deletion-safety-expected-red');
var QA = path.join(ROOT, 'qa', 'agent-reviews');

var INV_26 = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.3-deletion-safety-artifact-rebind-26');
var REPORT_26 = path.join(QA, 'XJ-5.0.0-agent-a-v4.3-deletion-safety-artifact-rebind-26.md');
var REPORT_A = path.join(QA, 'XJ-5.0.0-agent-a-v4.3-deletion-safety-expected-red-06.md');
var REPORT_A_BASELINE_SHA = 'D7F9FE8410A1D57FDCE768FD8A8DC808204C04D3943BF410E7E5BF5923EAED44';

var passed = 0, failed = 0;
function check(label, cond) { cond ? passed++ : failed++; console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + label); }

/* ---------- 1. Existence ---------- */
var files = [
  path.join(INV_R16, 'protected-files-manifest.json'),
  path.join(INV_26, 'contract-result.json'),
  REPORT_26,
  path.join(TST, 'mutation-probes.js'),
  path.join(TST, 'verify-artifacts.js'),
  REPORT_26,
  REPORT_A,
];
files.forEach(function (f) {
  check('exists: ' + path.basename(f), fs.existsSync(f));
  if (fs.existsSync(f)) console.log('  SHA-256 ' + path.basename(f) + ': ' + sha256(f));
});

/* ---------- 2. Protected files untouched (repair-16 manifest) ---------- */
try {
  var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.3-deletion-safety-artifact-rebind-26', 'protected-files-manifest.json'), 'utf8'));
  var protFiles = manifest.protected_files || manifest.files || [];
  protFiles.forEach(function (e) {
    var abs = path.join(ROOT, e.path);
    var ok = fs.existsSync(abs) && sha256(abs) === e.sha256.toUpperCase();
    check('protected untouched: ' + e.path, ok);
  });
} catch (e) {
  check('protected manifest readable', false);
}

/* ---------- 3. Read-only A report NOT modified ---------- */
check('A report read-only baseline intact',
  fs.existsSync(REPORT_A) && sha256(REPORT_A) === REPORT_A_BASELINE_SHA);

/* ---------- 4. contract-result.json determinism + semantics ---------- */
try {
  var crPath = path.join(INV_26, 'contract-result.json');
  var raw = fs.readFileSync(crPath, 'utf8');
  var cr = JSON.parse(raw);
  var keys = JSON.stringify(cr);
  check('contract-result has no timestamp fields',
    !/generated_at|timestamp|"date"|_at"\s*:/i.test(keys.replace(/"generated_by"/g, '')));
  check('contract-result bound to task-26',
    cr.task_id === 'XJ-5.0.0-agent-a-v4.3-deletion-safety-artifact-rebind-26');
  check('contract-result base_commit pinned',
    cr.base_commit === '9971787eb6e443ab5a5c80aee118b9b43285c093');
  check('contract-result determinism flag',
    typeof cr.determinism === 'string' && /hash-stable/.test(cr.determinism));
  check('contract-result zero failed rows', cr.failed === 0);
  var r10 = (cr.checks || []).filter(function (c) { return c.id === 'R10'; })[0];
  var r11 = (cr.checks || []).filter(function (c) { return c.id === 'R11'; })[0];
  check('R10 real-behavior CONFIRMED',
    !!r10 && r10.pass === true && r10.classification === 'CONFIRMED' && /real session deletion/.test(r10.label));
  check('R11 real-behavior CONFIRMED',
    !!r11 && r11.pass === true && r11.classification === 'CONFIRMED' && /real import/.test(r11.label));
} catch (e) {
  check('contract-result.json parseable', false);
}

/* ---------- 5. Hash binding: delivery report declares final artifact SHAs ---------- */
if (fs.existsSync(REPORT_26)) {
  var reportContent = fs.readFileSync(REPORT_26, 'utf8');
  var bindTargets = [
    path.join(TST, 'run-contract.js'),
    path.join(TST, 'mutation-probes.js'),
    path.join(TST, 'verify-artifacts.js'),
    path.join(INV_26, 'contract-result.json'),
  ];
  bindTargets.forEach(function (f) {
    var basename = path.basename(f);
    if (!fs.existsSync(f)) { check('hash-bind: ' + basename + ' exists', false); return; }
    var actualSha = sha256(f);
    var escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp(escaped + '\\s*\\|\\s*`?([A-F0-9]{64})`?', 'i');
    var match = reportContent.match(regex);
    if (match) {
      check('hash-bind: ' + basename + ' matches delivery report', match[1].toUpperCase() === actualSha);
    } else {
      check('hash-bind: ' + basename + ' declared in delivery report', false);
    }
  });
  check('delivery report has DELIVERY_REPORT line',
    /DELIVERY_REPORT:\s*D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5\.0\.0-agent-a-v4\.3-deletion-safety-artifact-rebind-26\.md/.test(reportContent));
} else {
  check('delivery report present for hash binding', false);
}

/* ---------- 6. git diff --check scoped to repair-16 allowlist ---------- */
var r = require('child_process').spawnSync('git', ['diff', '--check', '--',
  'tests/v5.0.0-disposable/agent-a-v4.3-deletion-safety-expected-red',
  'qa/agent-reviews/XJ-5.0.0-agent-a-v4.3-deletion-safety-artifact-rebind-26.md'],
  { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
check('git diff --check clean (allowlist scope)', r.status === 0);

console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
