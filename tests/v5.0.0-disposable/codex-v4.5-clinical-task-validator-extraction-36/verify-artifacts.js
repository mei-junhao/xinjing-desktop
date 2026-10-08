'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const INVENTORY = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.5-clinical-task-validator-extraction-36');
const TASK_ID = 'XJ-5.0.0-codex-v4.5-clinical-task-validator-extraction-36';
const CONTRACT_ID = 'v4.5-clinical-task-validator-extraction-v1';
const PROTECTED_MANIFEST = path.join(INVENTORY, 'protected-files-manifest.json');
const CONTRACT_RESULT = path.join(INVENTORY, 'contract-result.json');
const MUTATION_RESULT = path.join(INVENTORY, 'mutation-result.json');
const CANDIDATE_MANIFEST = path.join(INVENTORY, 'candidate-files-manifest.json');
const PAGES = [
  'billing-calendar.html', 'billing-shell.html', 'chat-home.html', 'consult-notes.html',
  'doc-center.html', 'doc-growth.html', 'feedback.html', 'index.html', 'knowledge.html',
  'masters.html', 'real-supervision-ai.html', 'real-supervision.html', 'report-writing.html',
  'session-calendar.html', 'settings.html', 'supervision-mindmap.html', 'supervision.html',
  'transcript-guide.html', 'transcript.html',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, null, 2)).digest('hex').toUpperCase();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolve(relativePath) {
  return path.join(ROOT, relativePath.replace(/\//g, path.sep));
}

function assertArtifact(file, taskId) {
  assert.ok(fs.existsSync(file), 'missing artifact: ' + file);
  const value = readJson(file);
  assert.strictEqual(value.task_id, taskId, 'wrong task id in ' + file);
  assert.strictEqual(value.contract_id, CONTRACT_ID, 'wrong contract id in ' + file);
  return value;
}

const protectedManifest = readJson(PROTECTED_MANIFEST);
assert.strictEqual(protectedManifest.task_id, TASK_ID);
assert.strictEqual(protectedManifest.base_commit, '9971787eb6e443ab5a5c80aee118b9b43285c093');
assert.strictEqual(protectedManifest.files.length, 20, 'Task 36 protected input manifest must cover 20 pre-edit files');
assert.strictEqual(sha256(PROTECTED_MANIFEST), '53144BFD5493336E8027816E35FC63E644493BD1949EE134148CE757AE388513', 'protected manifest hash drifted');

const contract = assertArtifact(CONTRACT_RESULT, TASK_ID);
assert.strictEqual(contract.status, 'PASS', 'contract result must be PASS');
assert.ok(contract.check_count >= 80, 'contract result must contain the validator and Store checks');
assert.strictEqual(contract.page_count, 19, 'contract result must cover all Store-loading pages');
const contractUnsigned = Object.assign({}, contract);
delete contractUnsigned.result_hash;
assert.strictEqual(contract.result_hash, stableHash(contractUnsigned), 'contract result hash must cover its contents');

const mutations = assertArtifact(MUTATION_RESULT, TASK_ID);
assert.strictEqual(mutations.status, 'PASS', 'mutation result must be PASS');
assert.strictEqual(mutations.mutation_count, 8);
assert.strictEqual(mutations.killed_count, 8);
assert.strictEqual(mutations.baseline.status, 'SURVIVED', 'unmutated baseline must pass');
assert.ok(mutations.mutants.every((item) => item.status === 'KILLED'), 'every mutation must be killed');
const mutationUnsigned = Object.assign({}, mutations);
delete mutationUnsigned.result_hash;
assert.strictEqual(mutations.result_hash, stableHash(mutationUnsigned), 'mutation result hash must cover its contents');

const candidateRelative = [
  'app/js/clinical-task-validators.js',
  'app/js/store.js',
  ...PAGES.map((page) => 'app/' + page),
  'docs/agent-coordination/v5.0.0/contracts/v4.5-clinical-task-validator-extraction-v1.md',
  'tests/v5.0.0-disposable/codex-v4.5-clinical-task-validator-extraction-36/mutation-probes.js',
  'tests/v5.0.0-disposable/codex-v4.5-clinical-task-validator-extraction-36/run-contract.js',
  'tests/v5.0.0-disposable/codex-v4.5-clinical-task-validator-extraction-36/verify-artifacts.js',
  'docs/agent-coordination/v5.0.0/inventory/codex-v4.5-clinical-task-validator-extraction-36/contract-result.json',
  'docs/agent-coordination/v5.0.0/inventory/codex-v4.5-clinical-task-validator-extraction-36/mutation-result.json',
  'docs/agent-coordination/v5.0.0/inventory/codex-v4.5-clinical-task-validator-extraction-36/protected-files-manifest.json',
].sort();
const candidateFiles = candidateRelative.map((relativePath) => {
  const file = resolve(relativePath);
  assert.ok(fs.existsSync(file), 'missing candidate file: ' + relativePath);
  return { path: relativePath, sha256: sha256(file) };
});
const bundle = candidateFiles.map((file) => file.path + '\0' + file.sha256).join('\n');
const candidateSha256 = crypto.createHash('sha256').update(bundle).digest('hex').toUpperCase();
const candidateManifest = {
  schema_version: 1,
  task_id: TASK_ID,
  base_commit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
  candidate_sha256: candidateSha256,
  bundle_rule: 'sorted relative path + NUL + uppercase SHA-256, joined with LF',
  files: candidateFiles,
};
fs.writeFileSync(CANDIDATE_MANIFEST, JSON.stringify(candidateManifest, null, 2) + '\n', 'utf8');

console.log('Task 36 artifact verification: PASS');
console.log('contract: PASS, checks=' + contract.check_count + ', pages=' + contract.page_count);
console.log('mutations: PASS, killed=' + mutations.killed_count + '/' + mutations.mutation_count);
console.log('candidate files: ' + candidateFiles.length);
console.log('candidate_sha256: ' + candidateSha256);
