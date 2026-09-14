'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const INVENTORY = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-durable-store-verifier-rebind-07');
const MANIFEST = process.env.XJ_DURABLE_CANDIDATE_MANIFEST || path.join(INVENTORY, 'candidate-manifest.json');
const REPORT = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-5.0.0-codex-v4.3-durable-store-verifier-rebind-07.md');
const TASK_CARD = process.env.XJ_DURABLE_TASK_CARD || path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'tasks', 'XJ-5.0.0-codex-v4.3-durable-store-verifier-rebind-07.md');
const EXPECTED_FINAL = 'DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-codex-v4.3-durable-store-verifier-rebind-07.md';

const expectedPaths = [
  'app/js/store.js',
  'docs/agent-coordination/v5.0.0/contracts/v4.3-durable-clinical-task-session-template-v1.md',
  'tests/v5.0.0-production/durable-clinical-task-session-template-store/electron-fixture.html',
  'tests/v5.0.0-production/durable-clinical-task-session-template-store/electron-main.js',
  'tests/v5.0.0-production/durable-clinical-task-session-template-store/mutation-probes.js',
  'tests/v5.0.0-production/durable-clinical-task-session-template-store/run-contract.js',
  'tests/v5.0.0-production/durable-clinical-task-session-template-store/run-electron-contract.js',
  'tests/v5.0.0-production/durable-clinical-task-session-template-store/verify-artifacts.js'
];

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function lastLine(filePath) {
  return fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/).pop();
}

function taskCardValue(name) {
  const text = fs.readFileSync(TASK_CARD, 'utf8');
  const match = text.match(new RegExp('`' + name + '`:\\s*`([A-F0-9]{64})`'));
  assert.ok(match, 'task card missing ' + name);
  return match[1];
}

function candidateHash(files) {
  const payload = files.slice().sort((a, b) => a.path.localeCompare(b.path, 'en')).map((entry) => entry.path + '\0' + entry.sha256).join('\n');
  return crypto.createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex').toUpperCase();
}

function main() {
  assert.ok(fs.existsSync(MANIFEST), 'candidate manifest missing');
  assert.strictEqual(hash(MANIFEST), taskCardValue('candidate_manifest_sha256'), 'candidate manifest hash must match task card');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.strictEqual(manifest.task_id, 'XJ-5.0.0-codex-v4.3-durable-store-verifier-rebind-07', 'manifest task mismatch');
  assert.deepStrictEqual(manifest.files.map((item) => item.path).sort(), expectedPaths.slice().sort(), 'candidate path set mismatch');
  assert.ok(!manifest.files.some((item) => /quick-record|package(?:-lock)?\.json|task-ledger|write-locks/.test(item.path)), 'downstream or coordination file leaked into Store candidate');
  for (const item of manifest.files) {
    assert.ok(/^[A-F0-9]{64}$/.test(item.sha256), 'invalid candidate hash: ' + item.path);
    const filePath = path.join(ROOT, item.path);
    assert.ok(fs.existsSync(filePath), 'candidate file missing: ' + item.path);
    assert.strictEqual(hash(filePath), item.sha256, 'candidate file changed: ' + item.path);
  }
  const computedCandidate = candidateHash(manifest.files);
  assert.strictEqual(computedCandidate, manifest.candidate_sha256, 'manifest candidate SHA mismatch');
  assert.strictEqual(computedCandidate, taskCardValue('candidate_sha256'), 'candidate SHA must match task card');
  assert.strictEqual(lastLine(REPORT), EXPECTED_FINAL, 'report must end with the exact DELIVERY_REPORT line');
  assert.strictEqual(lastLine(TASK_CARD), EXPECTED_FINAL, 'task card must end with the exact DELIVERY_REPORT line');

  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'local-coordination', 'task-ledger.json'), 'utf8'));
  const task = ledger.tasks.find((item) => item.task_id === 'XJ-5.0.0-codex-v4.3-durable-store-verifier-rebind-07');
  assert.ok(task && (task.state === 'running' || task.state === 'accepted'), 'rebind task must remain running or accepted');
  const locks = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'write-locks.json'), 'utf8'));
  const lock = locks.locks.find((item) => item.lock_id === 'lock-XJ-5.0.0-codex-v4.3-durable-store-verifier-rebind-07');
  assert.ok(lock && (lock.state === 'active' || lock.state === 'released'), 'rebind lock must remain active or released');

  const diff = childProcess.spawnSync('git', ['diff', '--check', '--',
    'tests/v5.0.0-production/durable-clinical-task-session-template-store/verify-artifacts.js',
    'docs/agent-coordination/v5.0.0/inventory/codex-v4.3-durable-store-verifier-rebind-07',
    'qa/agent-reviews/XJ-5.0.0-codex-v4.3-durable-store-verifier-rebind-07.md'
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(diff.status, 0, String(diff.stderr || diff.stdout || 'git diff --check failed'));
  console.log('durable Store candidate artifact verification: PASS 14/14');
  console.log('candidate sha256:', computedCandidate);
  console.log('report sha256:', hash(REPORT));
}

try { main(); }
catch (error) {
  console.error(error && error.stack || error);
  process.exit(1);
}
