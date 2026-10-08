'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const taskId = 'XJ-5.0.0-codex-v4.3-later-session-task-projection-06';
const expectedReport = 'D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-codex-v4.3-later-session-task-projection-06.md';
const expectedManifestHash = 'CB5BD282E6C0B97C046F807AC0E5321DC1F652F1AED96EF62A7BDE46BDBB69B5';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  const full = path.join(ROOT, rel);
  assert.ok(fs.existsSync(full), 'missing artifact: ' + rel);
  return full;
}

function main() {
  const required = [
    'app/consult-notes.html',
    'app/js/consult-notes.js',
    'app/js/clinical-task-view-model.js',
    'docs/agent-coordination/v5.0.0/contracts/v4.3-later-session-clinical-task-projection-v1.md',
    'docs/agent-coordination/v5.0.0/inventory/codex-v4.3-later-session-task-projection/protected-inputs-manifest.json',
    'tests/v5.0.0-production/later-session-clinical-task-projection/run-contract.js',
    'tests/v5.0.0-production/later-session-clinical-task-projection/mutation-probes.js',
    'tests/v5.0.0-production/later-session-clinical-task-projection/electron-main.js',
    'tests/v5.0.0-production/later-session-clinical-task-projection/run-electron-contract.js',
    'tests/v5.0.0-production/later-session-clinical-task-projection/verify-artifacts.js',
    'qa/agent-reviews/XJ-5.0.0-codex-v4.3-later-session-task-projection-06.md'
  ];
  required.forEach(exists);

  const manifestPath = exists('docs/agent-coordination/v5.0.0/inventory/codex-v4.3-later-session-task-projection/protected-inputs-manifest.json');
  assert.strictEqual(sha256(manifestPath), expectedManifestHash, 'protected-inputs manifest hash mismatch');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.task_id, taskId, 'manifest task_id mismatch');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 5, 'manifest must bind 5 protected inputs');
  manifest.files.forEach((entry) => {
    assert.ok(entry.path && /^[A-F0-9]{64}$/.test(entry.sha256), 'invalid manifest entry: ' + JSON.stringify(entry));
    assert.strictEqual(sha256(path.join(ROOT, entry.path)), entry.sha256, 'protected input changed: ' + entry.path);
  });

  const html = read('app/consult-notes.html');
  const js = read('app/js/consult-notes.js');
  assert.ok(html.indexOf('js/clinical-task-view-model.js') >= 0, 'ViewModel script missing from consult-notes.html');
  assert.ok(html.indexOf('js/clinical-task-view-model.js') < html.indexOf('js/consult-notes.js'), 'ViewModel script order is wrong');
  assert.ok(js.includes('Store.getClinicalTasksByClient(currentClientId)'), 'same-client task read missing');
  assert.ok(/allowLaterSession:\s*true/.test(js), 'later-session projection option missing');

  const reportPath = path.join(ROOT, 'qa/agent-reviews/XJ-5.0.0-codex-v4.3-later-session-task-projection-06.md');
  const report = fs.readFileSync(reportPath, 'utf8');
  const lines = report.trimEnd().split(/\r?\n/);
  assert.strictEqual(lines[lines.length - 1], 'DELIVERY_REPORT: ' + expectedReport, 'strict DELIVERY_REPORT line mismatch');
  [
    'node --check app/js/consult-notes.js',
    'run-contract.js',
    'mutation-probes.js',
    'run-electron-contract.js',
    'verify-artifacts.js',
    'node scripts/self-test.js',
    'git diff --check',
    'P0',
    '内部对抗审查',
    '12/12',
    'real Electron later-session projection: PASS'
  ].forEach((needle) => assert.ok(report.includes(needle), 'report missing evidence marker: ' + needle));

  process.stdout.write('later-session artifact verification: PASS ' + required.length + ' files, manifest ' + expectedManifestHash + '\n');
}

try {
  main();
} catch (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.exit(1);
}
