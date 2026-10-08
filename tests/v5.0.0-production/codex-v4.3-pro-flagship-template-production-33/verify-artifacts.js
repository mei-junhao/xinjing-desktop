'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TASK_ID = 'XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33';
const CONTRACT_ID = 'v4.3-pro-flagship-template-production-v1';
const WRITE_LOCK_ID = 'lock-XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33';
const GRANT_ID = 'local-codex-20260728T105103Z-v4.3-f2-production-33';
const MANIFEST = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-pro-flagship-template-production-33', 'protected-files-manifest.json');
const TASK_CARD = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'tasks', TASK_ID + '.md');
const REPORT = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33.md');
const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const EXPECTED_MANIFEST_SHA = '7C9231EF2D477D6648411815D54FC0A2AC7EB97B9FDD40FFF93532E11727FC66';
const EXPECTED_REPORT_TAIL = 'DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33.md';
const IMMUTABLE_INPUTS = new Set([
  'app/js/store.js',
  'app/js/entitlements.js',
  'XinJing-中远期发展计划-v4.1.1-v6.0.md',
  'docs/agent-coordination/v5.0.0/contracts/v4.3-durable-clinical-task-session-template-v1.md',
  'docs/agent-coordination/v5.0.0/contracts/v4.3-quick-record-task-template-dashboard-integration-v1.md',
]);
const REQUIRED_ARTIFACTS = ['contract-result.json', 'contract-matrix.json', 'mutation-result.json', 'electron-result.json'];

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function lastLine(filePath) {
  return fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/).pop();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertResultShape(contract, mutation, electron) {
  assert.strictEqual(contract.task_id, TASK_ID, 'contract task mismatch');
  assert.strictEqual(contract.contract_id, CONTRACT_ID, 'contract contract_id mismatch');
  assert.strictEqual(contract.write_lock_id, WRITE_LOCK_ID, 'contract lock mismatch');
  assert.strictEqual(contract.failed, 0, 'focused contract has failures');
  assert.strictEqual(contract.passed, 8, 'focused contract must contain 8 passing checks');
  assert.ok(contract.invariants && contract.invariants.zeroFailed, 'focused contract invariant missing');

  assert.strictEqual(mutation.task_id, TASK_ID, 'mutation task mismatch');
  assert.strictEqual(mutation.probe_count, 8, 'mutation count mismatch');
  assert.strictEqual(mutation.killed, 8, 'not all mutations were killed');
  assert.strictEqual(mutation.survived, 0, 'a mutation survived');
  assert.strictEqual(mutation.harness_errors, 0, 'mutation harness error');
  assert.strictEqual(mutation.all_killed, true, 'mutation gate did not pass');

  assert.strictEqual(electron.task_id, TASK_ID, 'Electron task mismatch');
  assert.strictEqual(electron.pass, true, 'real Electron contract did not pass');
  assert.strictEqual(electron.synthetic_data_only, true, 'Electron evidence must be synthetic only');
  assert.strictEqual(electron.network_denied, true, 'Electron network denial evidence missing');
  assert.deepStrictEqual(electron.viewports, ['1024x700', '1366x768', '1920x1080'], 'viewport matrix mismatch');
  assert.strictEqual(electron.trial_preview.aiLocked, true, 'trial AI option was not locked');
  assert.strictEqual(electron.trial_preview.flagshipLocked, true, 'trial Flagship option was not locked');
  assert.strictEqual(electron.custom_ready.aiEligible, true, 'Pro/Flagship AI option missing');
  assert.strictEqual(electron.custom_ready.flagshipEligible, true, 'Flagship option missing');
  assert.strictEqual(electron.custom_flow.selection.templateId, 'flagship-session-v1', 'custom selection template mismatch');
  assert.strictEqual(electron.custom_flow.selection.tierAtSelection, 'Flagship', 'custom selection tier mismatch');
  assert.strictEqual(electron.custom_flow.selection.customTemplateId, 'brand-acme-001', 'custom selection ID mismatch');
  assert.strictEqual(electron.custom_flow.noBody, true, 'custom selection persisted body-like data');
  assert.strictEqual(electron.custom_flow.taskCount, 2, 'QuickRecord task count mismatch');
  assert.strictEqual(electron.failure_retry.ok, true, 'QuickRecord retry did not succeed');
  assert.strictEqual(electron.failure_retry.sameSession, true, 'QuickRecord retry created a duplicate session');
  assert.strictEqual(electron.failure_retry.sameSessionCount, true, 'QuickRecord retry session count changed unexpectedly');
  assert.strictEqual(electron.failure_retry.blockedEscape, true, 'pending QuickRecord was dismissible by Escape');
  assert.strictEqual(electron.failure_retry.matchingTasks, 1, 'QuickRecord retry duplicated a task');
  assert.strictEqual(electron.persisted_after_reload.templateId, 'flagship-session-v1', 'selection did not survive reload');
  assert.strictEqual(electron.persisted_after_reload.customTemplateId, 'brand-acme-001', 'custom ID did not survive reload');
  assert.strictEqual(electron.historical.historical, true, 'historical selection was not labeled');
  assert.strictEqual(electron.historical.customDisabled, true, 'historical custom ID was editable');
  assert.match(electron.historical.status || '', /历史模板当前不可用/);
  assert.strictEqual(electron.consultation_retry.firstFailed, true, 'consultation failure was not observed');
  assert.strictEqual(electron.consultation_retry.inputRetained, true, 'consultation input was not retained');
  assert.strictEqual(electron.consultation_retry.failureVisible, true, 'consultation failure state was not visible');
  assert.strictEqual(electron.consultation_retry.oldSelectionRetainedOnFailure, true, 'consultation failure rewrote the historical selection');
  assert.strictEqual(electron.consultation_retry.sameSessionCount, true, 'consultation retry duplicated the session');
  assert.strictEqual(electron.consultation_retry.retrySucceeded, true, 'consultation retry did not succeed');
  assert.strictEqual(electron.consultation_retry.finalTemplateId, 'manual-session-v1', 'consultation retry selection mismatch');
  for (const skin of ['clinical', 'theatre', 'observatory']) {
    assert.ok(electron.skins && electron.skins[skin] && electron.skins[skin].canvas && electron.skins[skin].surface && electron.skins[skin].accent && electron.skins[skin].text, 'skin token evidence missing: ' + skin);
  }
  assert.strictEqual(electron.reduced_motion.matches, true, 'reduced motion media was not active');
  assert.strictEqual(electron.reduced_motion.zeroTransitions, true, 'reduced motion left relevant transitions active');
  assert.deepStrictEqual(electron.console_errors, [], 'renderer console errors present');
  assert.deepStrictEqual(electron.renderer_exceptions, [], 'renderer exceptions present');
}

function main() {
  assert.strictEqual(hash(MANIFEST), EXPECTED_MANIFEST_SHA, 'protected manifest hash mismatch');
  const manifest = readJson(MANIFEST);
  assert.strictEqual(manifest.task_id, TASK_ID, 'manifest task mismatch');
  assert.strictEqual(manifest.base_commit, '9971787eb6e443ab5a5c80aee118b9b43285c093', 'manifest base mismatch');
  for (const item of manifest.protected_files) {
    const filePath = path.join(ROOT, item.path);
    assert.ok(fs.existsSync(filePath), 'protected input missing: ' + item.path);
    if (IMMUTABLE_INPUTS.has(item.path)) assert.strictEqual(hash(filePath), item.sha256, 'immutable input changed: ' + item.path);
  }

  const contract = readJson(path.join(__dirname, 'contract-result.json'));
  const mutation = readJson(path.join(__dirname, 'mutation-result.json'));
  const electron = readJson(path.join(ARTIFACT_DIR, 'electron-result.json'));
  assertResultShape(contract, mutation, electron);

  const currentSourceHashes = Object.fromEntries([
    'app/js/session-template-view-model.js',
    'app/js/quick-record.js',
    'app/js/dashboard.js',
    'app/css/workbench-home.css',
    'app/consult-notes.html',
    'app/js/consult-notes.js',
  ].map((relative) => [relative, hash(path.join(ROOT, relative))]));
  assert.deepStrictEqual(electron.source_hashes, currentSourceHashes, 'Electron source hashes are stale');
  for (const relative of ['app/js/session-template-view-model.js', 'app/js/quick-record.js', 'app/js/dashboard.js', 'app/js/consult-notes.js']) {
    assert.strictEqual(contract.module_hashes[relative.replace('app/js/', '')] || contract.module_hashes[relative], currentSourceHashes[relative], 'contract source hash mismatch: ' + relative);
    assert.strictEqual(mutation.source_hashes[relative.replace('app/js/', '')] || mutation.source_hashes[relative], currentSourceHashes[relative], 'mutation source hash mismatch: ' + relative);
  }

  for (const name of REQUIRED_ARTIFACTS) {
    const artifactPath = name === 'electron-result.json' ? path.join(ARTIFACT_DIR, name) : path.join(__dirname, name);
    assert.ok(fs.existsSync(artifactPath), 'required artifact missing: ' + artifactPath);
  }
  assert.strictEqual(electron.screenshots.length, 6, 'expected QuickRecord and consultation screenshots for 3 viewports');
  for (const shot of electron.screenshots) {
    assert.ok(fs.existsSync(shot.file), 'screenshot missing: ' + shot.file);
    assert.ok(fs.statSync(shot.file).size > 1024, 'screenshot is blank: ' + shot.file);
    assert.strictEqual(hash(shot.file), shot.sha256, 'screenshot hash mismatch: ' + shot.file);
  }

  assert.ok(fs.existsSync(REPORT), 'delivery report missing');
  assert.strictEqual(lastLine(REPORT), EXPECTED_REPORT_TAIL, 'report must end with the exact absolute DELIVERY_REPORT line');
  assert.ok(fs.readFileSync(TASK_CARD, 'utf8').includes(EXPECTED_REPORT_TAIL), 'task card report tail missing');

  const ledger = readJson(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'local-coordination', 'task-ledger.json'));
  const task = ledger.tasks.find((item) => item.task_id === TASK_ID);
  assert.ok(task && task.owner === 'codex' && task.lease && task.lease.grant_id === GRANT_ID && ['running', 'accepted'].includes(task.state), 'ledger task/lease mismatch');
  assert.strictEqual(task.contract.id, CONTRACT_ID, 'ledger contract mismatch');
  assert.strictEqual(task.write_lock_id, WRITE_LOCK_ID, 'ledger lock mismatch');
  const locks = readJson(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'write-locks.json'));
  const lock = locks.locks.find((item) => item.lock_id === WRITE_LOCK_ID);
  assert.ok(lock && ['active', 'released'].includes(lock.state), 'task lock must remain active or released');

  const diff = childProcess.spawnSync('git', ['diff', '--check', '--',
    'app/js/session-template-view-model.js',
    'app/js/quick-record.js',
    'app/js/dashboard.js',
    'app/css/workbench-home.css',
    'app/consult-notes.html',
    'app/js/consult-notes.js',
    'tests/v5.0.0-production/codex-v4.3-pro-flagship-template-production-33',
    'docs/agent-coordination/v5.0.0/inventory/codex-v4.3-pro-flagship-template-production-33',
    'docs/agent-coordination/v5.0.0/tasks/' + TASK_ID + '.md',
    'qa/agent-reviews/' + TASK_ID + '.md',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(diff.status, 0, String(diff.stderr || diff.stdout || 'git diff --check failed'));
  console.log('artifact verification: PASS 35/35');
  console.log('report sha256:', hash(REPORT));
}

try { main(); }
catch (error) {
  console.error((error && error.stack) || error);
  process.exit(1);
}
