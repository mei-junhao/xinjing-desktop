'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-quick-record-task-template-dashboard-integration', 'protected-files-manifest.json');
const REPORT = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-5.0.0-codex-v4.3-quick-record-task-template-dashboard-integration-03.md');
const TASK_CARD = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'tasks', 'XJ-5.0.0-codex-v4.3-quick-record-task-template-dashboard-integration-03.md');
const EXPECTED_FINAL = 'DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-codex-v4.3-quick-record-task-template-dashboard-integration-03.md';

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function lastLine(filePath) {
  return fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/).pop();
}

function main() {
  assert.strictEqual(hash(MANIFEST), 'E6213D84222AE78FEAB0BC34DA31AF24D630CAC19CFC2EBEA2D3F16779921356', 'protected manifest hash must match the task card');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const readOnly = new Set(manifest.read_only_inputs || []);
  for (const item of manifest.files) {
    const filePath = path.join(ROOT, item.path);
    assert.ok(fs.existsSync(filePath), 'manifest file must exist: ' + item.path);
    if (readOnly.has(item.path)) assert.strictEqual(hash(filePath), item.sha256, 'read-only input changed: ' + item.path);
  }

  const artifacts = {
    'app/js/quick-record.js': '73ACFA7F40BD7BACE82AA57338912B677B43E7D055ACB8F584A50D1CA3E503AA',
    'app/js/dashboard.js': '0770374FBDEC0E656AC23BF0973D55FAE66150EF691C74E5A4D501E7FECC7E9E',
    'app/index.html': '3B380845267F262CCF78A5662848D802144E60DA49DB20F919F79CB5FC0E6CCC',
    'app/css/workbench-home.css': '07275BA9D12BF53C850CBABC213F0108BAFF61E83DF41C0CC96004B356719E34',
    'tests/v5.0.0-production/quick-record-task-template-dashboard-integration/run-contract.js': '504A3726F822766A1ACA1EF31114BB57F21AC0247AA3329C77C6AADF3D04B5B3',
    'tests/v5.0.0-production/quick-record-task-template-dashboard-integration/mutation-probes.js': '55EE212218A6691F36740CF845DDBA05409FF438D4AAA7039197148A2C00C095',
    'tests/v5.0.0-production/quick-record-task-template-dashboard-integration/run-electron-contract.js': '89945D3C409E155F75BE174929A79463C5A81287725DF37B6C3BD0CF581BB63C',
    'tests/v5.0.0-production/quick-record-task-template-dashboard-integration/electron-main.js': '672CDB3CC121F1F4E6FCDE07D9CEB37B0050C5688ACDA7D0C988A904193BA037'
  };
  for (const [relative, expected] of Object.entries(artifacts)) {
    assert.strictEqual(hash(path.join(ROOT, relative)), expected, 'artifact hash changed: ' + relative);
  }

  assert.strictEqual(lastLine(REPORT), EXPECTED_FINAL, 'report must end with the exact absolute DELIVERY_REPORT line');
  assert.ok(fs.readFileSync(TASK_CARD, 'utf8').includes(EXPECTED_FINAL), 'task card must declare the absolute DELIVERY_REPORT line');

  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'local-coordination', 'task-ledger.json'), 'utf8'));
  const task = ledger.tasks.find((item) => item.task_id === 'XJ-5.0.0-codex-v4.3-quick-record-task-template-dashboard-integration-03');
  assert.ok(task && (task.state === 'active' || task.state === 'accepted'), 'ledger task must remain active or accepted');
  const locks = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'write-locks.json'), 'utf8'));
  const lock = locks.locks.find((item) => item.lock_id === 'lock-XJ-5.0.0-codex-v4.3-quick-record-task-template-dashboard-integration-03');
  assert.ok(lock && (lock.state === 'active' || lock.state === 'released'), 'task lock must remain active or released');

  const diff = childProcess.spawnSync('git', ['diff', '--check', '--',
    'app/js/quick-record.js', 'app/js/dashboard.js', 'app/index.html', 'app/css/workbench-home.css',
    'tests/v5.0.0-production/quick-record-task-template-dashboard-integration',
    'qa/agent-reviews/XJ-5.0.0-codex-v4.3-quick-record-task-template-dashboard-integration-03.md'
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(diff.status, 0, String(diff.stderr || diff.stdout || 'git diff --check failed'));

  console.log('artifact verification: PASS 17/17');
  console.log('report sha256:', hash(REPORT));
}

try { main(); }
catch (error) {
  console.error(error && error.stack || error);
  process.exit(1);
}
