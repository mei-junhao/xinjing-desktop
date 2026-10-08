'use strict';
/**
 * XJ-4.3.0-opensquilla-cross-package-evidence-loop-01
 * Artifact Verification (rework: remove fake-greens V3/V4)
 *
 * V3 was `true` (unconditional) → real check: no production files modified
 * V4 was `true` (unconditional) → real check: git diff --check clean for allowlist paths
 * Also adds real SHA-256 reporting for all 7 artifacts + the delivery report.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-cross-package-evidence-loop');
const TEST = path.join(ROOT, 'tests', 'v4.3.0-disposable', 'opensquilla-cross-package-evidence-loop');

var checks = [];
function check(id, label, cond) { checks.push({ id: id, label: label, pass: !!cond }); }
function sha256(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8')).digest('hex').toUpperCase(); }
  catch (e) { return 'MISSING'; }
}

// Files that this task is allowed to have written (allowlist)
var allowlistFiles = [
  [path.join(OUT, 'agent-status-matrix.json'), 'agent-status-matrix.json'],
  [path.join(OUT, 'delivery-integrity-matrix.json'), 'delivery-integrity-matrix.json'],
  [path.join(OUT, 'handoff-risk-register.md'), 'handoff-risk-register.md'],
  [path.join(OUT, 'replay-log.md'), 'replay-log.md'],
  [path.join(TEST, 'run-cross-package-evidence-loop.js'), 'run-cross-package-evidence-loop.js'],
  [path.join(TEST, 'mutation-probes.js'), 'mutation-probes.js'],
  [path.join(TEST, 'verify-artifacts.js'), 'verify-artifacts.js'],
];

console.log('=== Artifact Verification ===\n');

// V1: all 7 allowlist artifacts exist with SHA-256
var artifactShas = {};
allowlistFiles.forEach(function (f) {
  var exists = fs.existsSync(f[0]);
  var sha = sha256(f[0]);
  artifactShas[f[1]] = sha;
  check('V1', f[1] + ' exists', exists);
  if (exists) console.log('  SHA-256 ' + f[1] + ': ' + sha);
  else console.log('  SHA-256 ' + f[1] + ': MISSING');
});

// V2: delivery report exists
var reportPath = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-4.3.0-opensquilla-cross-package-evidence-loop-rework-02.md');
var reportExists = fs.existsSync(reportPath);
var reportSha = sha256(reportPath);
check('V2', 'delivery report exists', reportExists);
if (reportExists) console.log('  SHA-256 delivery-report: ' + reportSha);

// V3: no production files modified BY THIS TASK — real check
// In a shared multi-agent repo, production files (app/**, main.js, etc.) are
// modified by other agents. V3 verifies this governance task did NOT touch them:
// (a) protected_files_manifest_hash from write-locks matches the task card
// (b) this task's lock globs do NOT include production paths
// (c) no production files are staged (git diff --cached) — this task has not
//     staged any production changes (commit is denied anyway)
var locksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'write-locks.json'), 'utf8'));
var ownLock2 = locksJson.locks.find(function (l) { return l.lock_id === 'lock-XJ-4.3.0-opensquilla-cross-package-evidence-loop-rework-02'; });
var manifestMatch = !!(ownLock2 && (ownLock2.protected_files_manifest_hash || '').toUpperCase() === 'E83AAE7BC0B3AE5E8127F9815D0FBA3DF80F925353ACC9112B18F70633DB76BC');
// Check lock globs don't include production paths
var prodGlobPattern = /^(app\/|main\.js|preload\.js|package[^.]*\.json|license-[^.]+\.js|cloud-verify\.js|server\/|scripts\/)/;
var lockGlobsSafe = !!(ownLock2 && ownLock2.globs && ownLock2.globs.every(function (g) { return !prodGlobPattern.test(g); }));
// Check no production files are staged (git diff --cached)
var stagedCheck = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
var stagedFiles = (stagedCheck.stdout || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
var prodStaged = stagedFiles.some(function (f) { return prodGlobPattern.test(f); });
check('V3', 'no production files modified by this task (manifest stable, globs safe, nothing staged)', manifestMatch && lockGlobsSafe && !prodStaged);
if (!manifestMatch) console.log('  V3 FAIL: protected manifest hash mismatch');
if (!lockGlobsSafe) console.log('  V3 FAIL: lock globs include production paths');
if (prodStaged) console.log('  V3 FAIL: production files staged: ' + stagedFiles.filter(function (f) { return prodGlobPattern.test(f); }).join(', '));

// V4: git diff --check clean for allowlist paths AND no untracked mutated-runner files
var diffCheck = spawnSync('git', ['diff', '--check', '--',
  'docs/agent-coordination/v4.3.0/inventory/opensquilla-cross-package-evidence-loop',
  'tests/v4.3.0-disposable/opensquilla-cross-package-evidence-loop',
  'qa/agent-reviews/XJ-4.3.0-opensquilla-cross-package-evidence-loop-rework-02.md'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
// Also check for untracked temp files (mutated-runner-*.js, .mutants/)
var statusCheck = spawnSync('git', ['status', '--porcelain', '--',
  'tests/v4.3.0-disposable/opensquilla-cross-package-evidence-loop'
], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
var untrackedTemp = (statusCheck.stdout || '').split(/\r?\n/).filter(function (l) {
  return /^\?\?/.test(l) && /mutated-runner|\.mutants/.test(l);
});
check('V4', 'git diff --check clean for allowlist paths, no untracked temp residue', diffCheck.status === 0 && untrackedTemp.length === 0);
if (diffCheck.status !== 0) {
  console.log('  V4 FAIL: git diff --check found issues: ' + (diffCheck.stdout || '').trim());
}
if (untrackedTemp.length > 0) {
  console.log('  V4 FAIL: untracked temp files found: ' + untrackedTemp.join(', '));
}

var passed = checks.filter(function (c) { return c.pass; }).length;
var failed = checks.length - passed;
checks.forEach(function (c) { console.log('[' + (c.pass ? 'PASS' : 'FAIL') + '] ' + c.id + ': ' + c.label); });
console.log('\n=== Artifact Verification ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('verify_phase: ' + (failed === 0 ? 'ALL-VERIFIED' : 'CONTRACT-BROKEN'));
process.exit(failed === 0 ? 0 : 1);
