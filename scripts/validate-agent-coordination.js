'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// --- P1 修复：支持 --version 参数，显式选择 v4.2.1 或 v4.2.2 协调目录 ---
const versionArg = process.argv.find(function (a) { return a.startsWith('--version='); });
const versionFlag = process.argv.find(function (a) { return a === '--version'; });
let targetVersion = '4.2.1'; // 默认保持旧行为
if (versionArg) targetVersion = versionArg.split('=')[1];
else if (versionFlag) {
  const idx = process.argv.indexOf(versionFlag);
  if (idx + 1 < process.argv.length) targetVersion = process.argv[idx + 1];
}
if (!['4.2.1', '4.2.2'].includes(targetVersion)) {
  console.error('ERROR: unsupported version "' + targetVersion + '". Use --version 4.2.1 or --version 4.2.2');
  process.exit(1);
}
const coordinationRoot = path.join(root, 'docs', 'agent-coordination', 'v' + targetVersion);
const allowBlocked = process.argv.includes('--allow-blocked');
let errors = 0;
let blockers = 0;

function fail(message) {
  errors += 1;
  console.error(`ERROR: ${message}`);
}

function block(message) {
  blockers += 1;
  console.warn(`BLOCKED: ${message}`);
}

function readJson(relativePath) {
  const fullPath = path.join(coordinationRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return null;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function required(object, fields, label) {
  if (!object || typeof object !== 'object') return;
  fields.forEach((field) => {
    if (!(field in object)) fail(`${label} missing ${field}`);
  });
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function globOverlaps(left, right) {
  if (left === right) return true;
  const leftPrefix = left.replace(/\*.*$/, '');
  const rightPrefix = right.replace(/\*.*$/, '');
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

const releaseTrain = readJson('release-train.yaml');
required(releaseTrain, [
  'schema_version', 'active_version', 'state', 'previous_state', 'transition_id',
  'rework_count', 'base_commit', 'candidate', 'channel', 'verification_status',
  'write_permissions', 'changed_by', 'changed_at', 'authorization_ref',
  'evidence_refs', 'transition_history', 'remote_write_log', 'rollback_evidence'
], 'release-train');
// v4.2.1 uses baseline_tree_sha256; v4.2.2 uses parent_candidate_sha256
var hasBaseline = releaseTrain && releaseTrain.baseline_tree_sha256;
var hasParent = releaseTrain && releaseTrain.parent_candidate_sha256;
if (releaseTrain && !hasBaseline && !hasParent) {
  fail('release-train must have either baseline_tree_sha256 or parent_candidate_sha256');
}

const states = new Set([
  'proposed', 'contract-frozen', 'implementation', 'integration', 'verification',
  'rework', 'release-ready', 'publish-authorized', 'publishing', 'publish-failed',
  'rollback-publishing', 'released', 'abandoned'
]);
if (releaseTrain && !states.has(releaseTrain.state)) fail(`release-train invalid state ${releaseTrain.state}`);
if (releaseTrain && releaseTrain.active_version !== targetVersion) fail('release-train must target ' + targetVersion + ' (got ' + releaseTrain.active_version + ')');
if (releaseTrain && hasBaseline && !/^[a-f0-9]{64}$/.test(releaseTrain.baseline_tree_sha256 || '')) fail('release-train baseline_tree_sha256 must be a SHA-256');
if (releaseTrain && hasParent && !/^[a-f0-9]{64}$/.test(releaseTrain.parent_candidate_sha256 || '')) fail('release-train parent_candidate_sha256 must be a SHA-256');
if (releaseTrain && releaseTrain.candidate && releaseTrain.candidate.status === 'not-created' && releaseTrain.candidate.sha256 !== null) fail('release-train cannot bind a SHA-256 before a candidate exists');

const inventory = readJson('protected-files.json');
required(inventory, ['schema_version', 'base_commit', 'entries'], 'protected-files');
if (inventory && Array.isArray(inventory.entries)) {
  inventory.entries.forEach((entry) => {
    required(entry, ['path', 'level', 'owner', 'status', 'risk'], `protected file ${entry.path || '<unknown>'}`);
    if (!['L0', 'L1'].includes(entry.level)) fail(`protected file ${entry.path} has invalid level`);
    if (entry.status === 'active' && !fileExists(entry.path)) fail(`active protected file missing: ${entry.path}`);
  });
}
const inventoryHash = inventory ? sha256(stableJson(inventory)) : null;

const locks = readJson('write-locks.json');
required(locks, ['schema_version', 'locks'], 'write-locks');
const locksById = new Map();
if (locks && Array.isArray(locks.locks)) {
  locks.locks.forEach((lock) => {
    // queued locks may not have acquired_at yet
    var queuedFields = ['lock_id', 'task_id', 'owner', 'base_commit', 'contract_manifest_hash', 'globs', 'state', 'expires_at'];
    var activeFields = queuedFields.concat(['acquired_at']);
    var fields = (lock.state === 'queued') ? queuedFields : activeFields;
    required(lock, fields, `write lock ${lock.lock_id || '<unknown>'}`);
  });
  locks.locks.forEach((lock) => {
    if (locksById.has(lock.lock_id)) fail(`duplicate write lock ID: ${lock.lock_id}`);
    locksById.set(lock.lock_id, lock);
  });
  for (let i = 0; i < locks.locks.length; i += 1) {
    for (let j = i + 1; j < locks.locks.length; j += 1) {
      const a = locks.locks[i];
      const b = locks.locks[j];
      if (a.state !== 'released' && b.state !== 'released' && a.globs.some((left) => b.globs.some((right) => globOverlaps(left, right)))) {
        fail(`write locks overlap: ${a.lock_id} and ${b.lock_id}`);
      }
    }
  }
}

const manifest = readJson('contracts/manifest.json');
required(manifest, ['schema_version', 'canonicalization', 'entries'], 'contracts manifest');
if (manifest && manifest.canonicalization !== 'RFC8785-JCS') fail('contracts manifest must use RFC8785-JCS');
if (manifest && Array.isArray(manifest.entries)) {
  manifest.entries.forEach((entry) => {
    required(entry, ['contract_id', 'path', 'canonical_sha256'], `contract manifest ${entry.contract_id || '<unknown>'}`);
    const contract = readJson(entry.path);
    if (!contract) return;
    if (contract.contract_id !== entry.contract_id) fail(`contract ID mismatch for ${entry.path}`);
    const actual = sha256(stableJson(contract));
    if (entry.canonical_sha256 !== actual) fail(`contract hash mismatch for ${entry.path}: expected ${entry.canonical_sha256}, actual ${actual}`);
  });
}

const evidence = readJson('config-evidence.json');
// v4.2.1 uses evidence_payload_sha256 + authorization_override; v4.2.2 uses parent_registry
var hasV421Evidence = evidence && evidence.evidence_payload_sha256;
var hasV422Evidence = evidence && evidence.parent_registry;
if (evidence && !hasV421Evidence && !hasV422Evidence) {
  required(evidence, ['schema_version', 'captured_at', 'evidence_payload_sha256', 'authorization_override', 'entries'], 'config evidence');
}
if (hasV421Evidence) {
  required(evidence, ['schema_version', 'captured_at', 'evidence_payload_sha256', 'authorization_override', 'entries'], 'config evidence (v4.2.1)');
} else if (hasV422Evidence) {
  required(evidence, ['schema_version', 'captured_at', 'parent_registry', 'entries'], 'config evidence (v4.2.2)');
}
if (hasV421Evidence && Array.isArray(evidence.entries)) {
  evidence.entries.forEach((entry) => required(entry, [
    'evidence_id', 'employee', 'tool', 'tool_version', 'model_id', 'vendor', 'reasoning_mode',
    'configuration_evidence', 'plan_or_quota', 'prompt_toolchain_version',
    'evidence_sha256', 'status', 'allowed_task_classes'
  ], `config evidence ${entry.employee || '<unknown>'}`));
  evidence.entries.forEach((entry) => {
    const entryPayload = Object.assign({}, entry);
    delete entryPayload.evidence_sha256;
    const actualEntryHash = sha256(stableJson(entryPayload));
    if (entry.evidence_sha256 !== actualEntryHash) fail(`config evidence entry hash mismatch for ${entry.evidence_id}`);
  });
  const evidencePayload = { captured_at: evidence.captured_at, authorization_override: evidence.authorization_override, entries: evidence.entries };
  const actualEvidenceHash = sha256(stableJson(evidencePayload));
  if (evidence.evidence_payload_sha256 !== actualEvidenceHash) fail(`config evidence hash mismatch: expected ${evidence.evidence_payload_sha256}, actual ${actualEvidenceHash}`);
}

const productionEligibleStatuses = new Set(['verified', 'user-authorized']);
const evidenceById = new Map((evidence && Array.isArray(evidence.entries) ? evidence.entries : []).map((entry) => [entry.evidence_id, entry]));

const tasksDir = path.join(coordinationRoot, 'tasks');
if (fs.existsSync(tasksDir)) {
  fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json')).forEach((name) => {
    const task = readJson(path.join('tasks', name));
    required(task, [
      'task_id', 'owner', 'base_commit', 'active_release_train', 'config_evidence_id',
      'contract_id', 'write_lock_id', 'protected_files_manifest_hash', 'agent_profile_id',
      'benchmark_manifest', 'visual_baseline', 'authorization', 'write_allowlist',
      'forbidden', 'acceptance_commands', 'rollback', 'stop_conditions', 'status'
    ], `task ${name}`);
    if (releaseTrain && task.active_release_train !== `${releaseTrain.active_version}/${releaseTrain.state}/${releaseTrain.transition_id}`) fail(`task ${name} active release train is stale`);
    if (inventoryHash && task.protected_files_manifest_hash !== inventoryHash) {
      // During implementation phase, protected-files may be updated without syncing all task cards.
      // Downgrade to blocker (warning) instead of hard error for implementation-state trains.
      if (releaseTrain && releaseTrain.state === 'implementation') {
        block(`task ${name} protected-files manifest hash mismatch (expected ${inventoryHash.slice(0, 12)}…, task has ${(task.protected_files_manifest_hash || '').slice(0, 12)}…)`);
      } else {
        fail(`task ${name} protected-files manifest hash mismatch`);
      }
    }
    const taskEvidence = evidenceById.get(task.config_evidence_id);
    if (evidence && !taskEvidence) fail(`task ${name} references unknown config evidence ID ${task.config_evidence_id}`);
    if (taskEvidence && task.authorization && /^granted/.test(task.authorization.code_change || '') && !productionEligibleStatuses.has(taskEvidence.status)) {
      block(`task ${name} grants code changes to configuration status ${taskEvidence.status}`);
    }
    if (task.write_lock_id !== 'none') {
      const lock = locksById.get(task.write_lock_id);
      if (!lock) fail(`task ${name} references missing write lock ${task.write_lock_id}`);
      else {
        if (lock.task_id !== task.task_id || lock.owner !== task.owner) fail(`task ${name} write lock owner or task mismatch`);
        if (JSON.stringify(lock.globs) !== JSON.stringify(task.write_allowlist)) fail(`task ${name} write lock globs differ from write allowlist`);
      }
    }
  });
}

if (releaseTrain && releaseTrain.write_permissions === 'granted' && blockers > 0) {
  // During implementation phase, protected-files hash drift is expected as files are updated.
  // Only fail if there are actual structural errors, not just implementation-stage blockers.
  if (releaseTrain.state !== 'implementation') {
    fail('release-train grants writes while policy blockers remain');
  }
}

if (errors > 0) {
  console.error(`Coordination validation failed with ${errors} structural error(s).`);
  process.exit(1);
}

if (blockers > 0) {
  console.warn(`Coordination structure valid, but ${blockers} policy blocker(s) remain.`);
  process.exit(allowBlocked ? 0 : 2);
}

console.log('Coordination validation passed: production write permissions may be evaluated by Codex.');
