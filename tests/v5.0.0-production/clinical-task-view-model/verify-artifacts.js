'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const manifestPath = path.join(ROOT, 'docs/agent-coordination/v5.0.0/inventory/codex-v4.3-in-memory-task-template-viewmodels-01/protected-files-manifest.json');
const report = path.join(ROOT, 'qa/agent-reviews/XJ-5.0.0-codex-v4.3-in-memory-task-and-template-viewmodels-01.md');
const required = [
  'app/js/clinical-task-view-model.js',
  'app/js/session-template-view-model.js',
  'tests/v5.0.0-production/clinical-task-view-model/run-contract.js',
  'tests/v5.0.0-production/clinical-task-view-model/mutation-probes.js',
  'tests/v5.0.0-production/clinical-task-view-model/verify-artifacts.js',
  'tests/v5.0.0-production/session-template-view-model/run-contract.js',
  'tests/v5.0.0-production/session-template-view-model/mutation-probes.js',
  'tests/v5.0.0-production/session-template-view-model/verify-artifacts.js',
  'docs/agent-coordination/v5.0.0/design/codex-v4.3-in-memory-task-template-viewmodels-spec.md'
];
function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function check(label, value) { if (!value) { console.log('[FAIL] ' + label); process.exitCode = 1; } else console.log('[PASS] ' + label); }
required.forEach(function (rel) { check('exists ' + rel, fs.existsSync(path.join(ROOT, rel))); });
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
Object.keys(manifest.protected_files).forEach(function (rel) { check('protected hash ' + rel, fs.existsSync(path.join(ROOT, rel)) && sha(path.join(ROOT, rel)) === manifest.protected_files[rel]); });
check('delivery report exists', fs.existsSync(report));
if (fs.existsSync(report)) {
  const body = fs.readFileSync(report, 'utf8');
  check('delivery report final line', body.trimEnd().endsWith('DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-codex-v4.3-in-memory-task-and-template-viewmodels-01.md'));
  required.forEach(function (rel) { check('report cites ' + rel, body.indexOf(sha(path.join(ROOT, rel))) >= 0); });
}
const diff = cp.spawnSync('git', ['diff', '--check', '--', 'app/js/clinical-task-view-model.js', 'app/js/session-template-view-model.js', 'tests/v5.0.0-production/clinical-task-view-model', 'tests/v5.0.0-production/session-template-view-model', 'docs/agent-coordination/v5.0.0/design/codex-v4.3-in-memory-task-template-viewmodels-spec.md', 'qa/agent-reviews/XJ-5.0.0-codex-v4.3-in-memory-task-and-template-viewmodels-01.md'], { cwd: ROOT, encoding: 'utf8' });
check('git diff --check', diff.status === 0);
process.exit(process.exitCode || 0);
