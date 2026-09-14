'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TASK_ID = 'XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30';
const MANIFEST = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-ai-draft-confirmation-dashboard-30', 'protected-files-manifest.json');
const TASK_CARD = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'tasks', 'XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30.md');
const REPORT = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30.md');
const EXPECTED_MANIFEST_SHA = '72E289472E64640EE4FE9BCBAB1860E35F347DB1EA2BFB84063126BF20A473F8';
const EXPECTED_REPORT_TAIL = 'DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30.md';
const EXPECTED_ARTIFACTS = {
  'app/js/dashboard.js': '041F8072359635EF9C6EC931AD3E2ABC71CBFECFF2BA5006DAD0729218DDB733',
  'app/css/workbench-home.css': '714E8FF81ABE29B872EC3E3891CF6ECCCF5916F96D8EFF228EDA072D86AE071D',
  'tests/v5.0.0-production/codex-v4.3-ai-draft-confirmation-dashboard/run-contract.js': '980E6B6E019DC90069127CFF0FE574C68B826FF8EB318BCCED1D1FE6F02B5F8B',
  'tests/v5.0.0-production/codex-v4.3-ai-draft-confirmation-dashboard/mutation-probes.js': 'BE505DAD29F8178D43D4AB473E8D2DA2D2C08097494AECB24D46AB5F9B894989',
  'tests/v5.0.0-production/codex-v4.3-ai-draft-confirmation-dashboard/run-electron-contract.js': 'ACE57FB10412CCE04E93C97280A23DD68E4535882FC34B4CABC31F4E47D5A8BA',
  'tests/v5.0.0-production/codex-v4.3-ai-draft-confirmation-dashboard/contract-result.json': '85E36BB6FA82D8C0D24D4A6B82815E3FEE5CC0A5575895AAD2D560BF96B5B29B',
  'tests/v5.0.0-production/codex-v4.3-ai-draft-confirmation-dashboard/mutation-result.json': '7AEBABC067975AC0CDFB13810544A3711D3E0FC9E16D1C886A10BA81C5939B66',
};

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function lastLine(filePath) {
  return fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/).pop();
}

function main() {
  assert.strictEqual(hash(MANIFEST), EXPECTED_MANIFEST_SHA, 'protected manifest hash mismatch');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.strictEqual(manifest.task_id, TASK_ID, 'manifest task mismatch');
  for (const item of manifest.files) {
    assert.strictEqual(hash(path.join(ROOT, item.path)), item.sha256, 'protected input changed: ' + item.path);
  }
  assert.ok(fs.readFileSync(TASK_CARD, 'utf8').includes(EXPECTED_REPORT_TAIL), 'task card report tail missing');
  assert.strictEqual(lastLine(REPORT), EXPECTED_REPORT_TAIL, 'report tail mismatch');

  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract-result.json'), 'utf8'));
  assert.deepStrictEqual({ overall: contract.overall, tests: contract.tests, passed: contract.passed, failed: contract.failed }, { overall: 'PASS', tests: 6, passed: 6, failed: 0 }, 'contract result mismatch');
  assert.strictEqual(contract.real_entry, 'app/js/dashboard.js::renderTodo', 'real entry evidence missing');

  const mutations = JSON.parse(fs.readFileSync(path.join(__dirname, 'mutation-result.json'), 'utf8'));
  assert.strictEqual(mutations.total, 5, 'mutation count mismatch');
  assert.strictEqual(mutations.killed, 5, 'not all mutations were killed');
  assert.strictEqual(mutations.survived, 0, 'a mutation survived');
  assert.ok(mutations.results.every((item) => item.status === 'KILLED'), 'mutation status mismatch');

  const electronResultPath = path.join(__dirname, 'artifacts', 'electron-result.json');
  const electron = JSON.parse(fs.readFileSync(electronResultPath, 'utf8'));
  assert.strictEqual(electron.pass, true, 'real Electron contract did not pass');
  assert.deepStrictEqual(electron.viewports, ['1024x700', '1366x768', '1920x1080'], 'visual viewport matrix mismatch');
  assert.strictEqual(electron.success.status, 'open', 'confirmed draft did not become open');
  assert.strictEqual(electron.success.hasCompletion, true, 'confirmed draft completion action missing');
  assert.strictEqual(electron.success.hasConfirm, false, 'confirmed draft still exposes confirm action');
  assert.strictEqual(electron.failure.status, 'ai-draft', 'failed draft changed status');
  assert.strictEqual(electron.failure.enabled, true, 'failed draft action was not restored');
  assert.strictEqual(electron.failure.stillDraft, true, 'failed draft action disappeared');
  for (const shot of electron.screenshots) {
    assert.ok(fs.existsSync(shot.file), 'screenshot missing: ' + shot.viewport);
    assert.ok(fs.statSync(shot.file).size > 1024, 'screenshot is blank: ' + shot.viewport);
    assert.strictEqual(hash(shot.file), shot.sha256, 'screenshot hash mismatch: ' + shot.viewport);
  }

  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'local-coordination', 'task-ledger.json'), 'utf8'));
  const task = ledger.tasks.find((item) => item.task_id === TASK_ID);
  assert.ok(task && (task.state === 'active' || task.state === 'accepted'), 'ledger task must remain active or accepted');
  const locks = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'write-locks.json'), 'utf8'));
  const lock = locks.locks.find((item) => item.lock_id === 'lock-XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30');
  assert.ok(lock && (lock.state === 'active' || lock.state === 'released'), 'task lock must remain active or released');

  for (const [relative, expected] of Object.entries(EXPECTED_ARTIFACTS)) {
    assert.notStrictEqual(expected.indexOf('__FILL_'), 0, 'artifact hash placeholder remains: ' + relative);
    assert.strictEqual(hash(path.join(ROOT, relative)), expected, 'artifact hash mismatch: ' + relative);
  }

  const diff = childProcess.spawnSync('git', ['diff', '--check', '--',
    'app/js/dashboard.js',
    'app/css/workbench-home.css',
    'tests/v5.0.0-production/codex-v4.3-ai-draft-confirmation-dashboard',
    'docs/agent-coordination/v5.0.0/inventory/codex-v4.3-ai-draft-confirmation-dashboard-30',
    'docs/agent-coordination/v5.0.0/tasks/XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30.md',
    'qa/agent-reviews/XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30.md',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(diff.status, 0, String(diff.stderr || diff.stdout || 'git diff --check failed'));
  console.log('artifact verification: PASS 16/16');
  console.log('report sha256:', hash(REPORT));
}

try { main(); }
catch (error) {
  console.error((error && error.stack) || error);
  process.exit(1);
}
