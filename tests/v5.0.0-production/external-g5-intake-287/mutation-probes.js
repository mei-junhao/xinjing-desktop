'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { workspace, candidateRoot: sourceRoot, inputRoot, evidenceFile } = require('./harness-paths');
const scratchRoot = path.resolve(process.env.XJ_287_SCRATCH_ROOT || path.join(workspace, 'scratch', 'mutation-probes-' + crypto.randomUUID()));
const node = process.execPath;
const tests = {
  restore: path.join(workspace, 'tests', 'backup-restore-failure-preservation.js'),
  observability: path.join(workspace, 'tests', 'privacy-observability-controller-contract.js'),
  behavior: path.join(workspace, 'tests', 'settings-safety-behavior-equivalence.js'),
  dom: path.join(workspace, 'tests', 'settings-controller-dom-contract.js')
};

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').toUpperCase();
}
function replaceExact(source, before, after) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const beforeActual = before.replace(/\r?\n/g, eol);
  const afterActual = after.replace(/\r?\n/g, eol);
  const count = source.split(beforeActual).length - 1;
  assert.strictEqual(count, 1, 'mutation anchor count must be one: ' + before.slice(0, 80));
  return source.replace(beforeActual, afterActual);
}
function copyTree(from, to) {
  for (const relative of CLOSURE) {
    const source = path.join(from, relative);
    const target = path.join(to, relative);
    if (!fs.existsSync(source)) throw new Error('closure source missing: ' + relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}
function run(test, candidateRoot, envExtra) {
  return spawnSync(node, [test], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, envExtra || {}, { XJ_287_CANDIDATE_ROOT: candidateRoot })
  });
}

const mutations = [
  {
    name: 'allow-empty-default-passphrase', file: 'app/js/settings-data-safety-controller.js', test: 'restore',
    apply: (s) => replaceExact(s,
      "if (length < PASSPHRASE_MIN_LENGTH || length > PASSPHRASE_MAX_LENGTH || !String(value || '').trim()) {",
      "if (length > PASSPHRASE_MAX_LENGTH) {")
  },
  {
    name: 'durable-failure-treated-as-success', file: 'app/js/settings-data-safety-controller.js', test: 'restore',
    apply: (s) => replaceExact(
      replaceExact(s, "if (!importResult || importResult.ok !== true) {", "if (!importResult) {"),
      "var readback = await store.exportAll();",
      "var readback = decrypted.payload;")
  },
  {
    name: 'clear-input-before-restore', file: 'app/js/settings-data-safety-controller.js', test: 'restore',
    apply: (s) => replaceExact(s,
      "var inputElement = operation.inputElement || null;\n      if (!file || typeof file.text !== 'function') return failure('no-file');",
      "var inputElement = operation.inputElement || null;\n      if (inputElement) inputElement.value = '';\n      if (!file || typeof file.text !== 'function') return failure('no-file');")
  },
  {
    name: 'success-before-readback', file: 'app/js/settings-data-safety-controller.js', test: 'restore',
    apply: (s) => replaceExact(s,
      "var readback = await store.exportAll();\n        if (!sameProjection(decrypted.payload, readback)) {",
      "var readback = decrypted.payload;\n        if (!sameProjection(decrypted.payload, readback)) {")
  },
  {
    name: 'backup-locked-by-commercial-tier', file: 'app/js/settings-data-safety-controller.js', test: 'restore',
    apply: (s) => replaceExact(s,
      "async function backup() {\n      var request =",
      "async function backup() {\n      return failure('commercial-required');\n      var request =")
  },
  {
    name: 'observability-default-enabled', file: 'app/js/privacy-observability-core.js', test: 'core',
    apply: (s) => replaceExact(s, "var enabled = false; // MUTATION: default-disabled", "var enabled = true; // MUTATION: default-disabled")
  },
  {
    name: 'observability-revoke-keeps-queue', file: 'app/js/privacy-observability-core.js', test: 'core',
    apply: (s) => replaceExact(s, "records = []; // MUTATION: revoke-clears", "records = records; // MUTATION: revoke-clears")
  },
  {
    name: 'observability-accepts-sensitive-extra-field', file: 'app/js/privacy-observability-core.js', test: 'core',
    apply: (s) => replaceExact(
      replaceExact(s, "if (keys.length !== INPUT_FIELDS.length) return invalidEvent(); // MUTATION: exact-fields", "if (keys.length < INPUT_FIELDS.length) return invalidEvent(); // MUTATION: exact-fields"),
      "if (INPUT_FIELDS.indexOf(key) === -1) return invalidEvent();",
      "if (false) return invalidEvent();")
  },
  {
    name: 'support-export-allows-path-secret', file: 'app/js/settings-observability-controller.js', test: 'observability',
    apply: (s) => replaceExact(s,
      "var RECORD_KEYS = Object.freeze(['errorCode', 'version', 'stage', 'recoveryResult', 'timestamp']);",
      "var RECORD_KEYS = Object.freeze(['errorCode', 'version', 'stage', 'recoveryResult', 'timestamp', 'path', 'secret', 'clinicalBody', 'prompt', 'providerPayload', 'accountId']);")
  },
  {
    name: 'remove-settings-restore-handler', file: 'app/js/settings.js', test: 'dom',
    apply: (s) => replaceExact(s, "window.restoreData = function (event) {", "window.restoreDataRemoved = function (event) {")
  },
  {
    name: 'remove-privacy-aria', file: 'app/settings.html', test: 'dom',
    apply: (s) => replaceExact(s, ' aria-checked="false"', '')
  },
  {
    name: 'remove-data-settings-group', file: 'app/settings.html', test: 'dom',
    apply: (s) => replaceExact(s, '数据管理', '已移除分组')
  },
  {
    name: 'test-live-readback-sentinel', file: 'app/js/settings-data-safety-controller.js', test: 'restore',
    apply: (s) => replaceExact(s,
      'createSettingsDataSafetyController: createSettingsDataSafetyController',
      'createSettingsDataSafetyControllerRemoved: createSettingsDataSafetyController')
  }
];

const CLOSURE = [
  'app/settings.html',
  'app/js/settings.js',
  'app/js/settings-data-safety-controller.js',
  'app/js/settings-observability-controller.js',
  'app/js/backup-crypto.js',
  'app/js/privacy-observability-boundary.js',
  'app/js/privacy-observability-core.js',
  'app/js/privacy-observability-runtime.js',
];

fs.mkdirSync(scratchRoot, { recursive: true });
const coreRunner = path.join(inputRoot, 'tests', 'v5.0.0-production', 'privacy-observability-core', 'run-contract.js');
const results = [];
for (const mutation of mutations) {
  const root = path.join(scratchRoot, mutation.name, 'repo');
  copyTree(sourceRoot, root);
  const file = path.join(root, mutation.file);
  const original = fs.readFileSync(file, 'utf8');
  const changed = mutation.apply(original);
  assert.notStrictEqual(sha(changed), sha(original), mutation.name + ' must change SHA');
  fs.writeFileSync(file, changed, 'utf8');
  let execution;
  if (mutation.test === 'core') {
    execution = spawnSync(node, [coreRunner], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { MODULE_UNDER_TEST: path.join(root, 'app', 'js', 'privacy-observability-core.js') })
    });
  } else {
    execution = run(tests[mutation.test], root);
  }
  const killed = execution.status !== 0;
  results.push({
    name: mutation.name,
    originalSha256: sha(original),
    mutatedSha256: sha(changed),
    originalNormalizedSha256: sha(original.replace(/\r\n/g, '\n')),
    mutatedNormalizedSha256: sha(changed.replace(/\r\n/g, '\n')),
    test: mutation.test,
    exitCode: execution.status,
    killed,
    applied: sha(original) !== sha(changed) && sha(original.replace(/\r\n/g, '\n')) !== sha(changed.replace(/\r\n/g, '\n')),
    stdout: String(execution.stdout || '').slice(-2000),
    stderr: String(execution.stderr || '').slice(-2000)
  });
  process.stdout.write((killed ? 'KILLED ' : 'SURVIVED ') + mutation.name + '\n');
}
const survived = results.filter((result) => !result.killed || !result.applied);
const evidence = evidenceFile('mutation-results.json');
fs.mkdirSync(path.dirname(evidence), { recursive: true });
fs.writeFileSync(evidence, JSON.stringify({ total: results.length, killed: results.length - survived.length, survived: survived.length, results }, null, 2) + '\n', 'utf8');
console.log('SUMMARY killed=' + (results.length - survived.length) + ' survived=' + survived.length);
if (survived.length) process.exitCode = 1;
