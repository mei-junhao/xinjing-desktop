'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const STORE_PATH = path.join(ROOT, 'app', 'js', 'store.js');
const RUNNER_PATH = path.join(__dirname, 'run-contract.js');
const RESULT_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-deletion-tombstone-recovery-29', 'mutation-result.json');
const source = fs.readFileSync(STORE_PATH, 'utf8');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function replaceOnce(input, needle, replacement) {
  const index = input.indexOf(needle);
  if (index < 0) throw new Error('mutation anchor not found');
  return input.slice(0, index) + replacement + input.slice(index + needle.length);
}

const mutations = [
  {
    id: 'M01_ACTIVE_CLIENT_PROJECTION',
    description: 'return tombstoned clients from the active projection',
    apply: (value) => replaceOnce(value, 'return cache.clients.filter((client) => !isDeletionTombstoned(client));', 'return cache.clients;'),
  },
  {
    id: 'M02_ACTIVE_SESSION_PROJECTION',
    description: 'return tombstoned sessions from the active projection',
    apply: (value) => replaceOnce(value, 'return cache.sessions.filter((session) => !isDeletionTombstoned(session));', 'return cache.sessions;'),
  },
  {
    id: 'M03_STALE_PREVIEW_ACCEPTED',
    description: 'accept a stale preview hash',
    apply: (value) => replaceOnce(value, 'if (!preview || preview.previewHash !== previewHash) {', 'if (false) {'),
  },
  {
    id: 'M04_BATCH_NOT_RECORDED',
    description: 'omit the new batch from the durable batch array',
    apply: (value) => replaceOnce(value, 'const nextBatches = cache.deletionBatches.concat([batch]);', 'const nextBatches = cache.deletionBatches.slice();'),
  },
  {
    id: 'M05_CLIENT_NOT_TOMBSTONED',
    description: 'leave the client active after applying a batch',
    apply: (value) => replaceOnce(value, 'const nextClients = cache.clients.map((item) => clientIds.has(deletionId(item)) ? tombstoneEntity(item, batchId, targetType, targetId) : item);', 'const nextClients = cache.clients.slice();'),
  },
  {
    id: 'M06_SESSION_NOT_TOMBSTONED',
    description: 'leave sessions active after applying a client batch',
    apply: (value) => replaceOnce(value, 'const nextSessions = cache.sessions.map((item) => sessionIds.has(deletionId(item)) ? tombstoneEntity(item, batchId, targetType, targetId) : item);', 'const nextSessions = cache.sessions.slice();'),
  },
  {
    id: 'M07_RESTORE_DOES_NOT_CLEAR_MARKER',
    description: 'keep the tombstone marker during restore',
    apply: (value) => replaceOnce(value, 'collection[index] = restoreEntity(entity);', 'collection[index] = entity;'),
  },
  {
    id: 'M08_EXPORT_DROPS_BATCHES',
    description: 'drop tombstone batches from backup export',
    apply: (value) => replaceOnce(value, 'deletionBatches: cache.deletionBatches.map(normalizeDeletionBatch).filter(Boolean),', 'deletionBatches: [],'),
  },
  {
    id: 'M09_HYDRATE_DROPS_BATCHES',
    description: 'drop persisted tombstones during hydration',
    apply: (value) => replaceOnce(value, "cache.deletionBatches = Array.isArray(deletionBatches)\n      ? deletionBatches.map(normalizeDeletionBatch).filter(Boolean)\n      : [];", 'cache.deletionBatches = [];'),
  },
  {
    id: 'M10_PERSISTENCE_FAILURE_FALLBACK_SUCCESS',
    description: 'allow fallback persistence for a deletion batch',
    apply: (value) => replaceOnce(value, "['deletionQuarantine', nextQuarantine],\n      ], { allowFallback: false });", "['deletionQuarantine', nextQuarantine],\n      ]);"),
  },
  {
    id: 'M11_REVISION_CONSTANT',
    description: 'stop relevant writes from changing the preview revision',
    apply: (value) => replaceOnce(value, "return deletionHash(stableDeletionStringify(snapshot));\n  }\n\n  function buildDeletionPreview", "return 'fixed-revision';\n  }\n\n  function buildDeletionPreview"),
  },
  {
    id: 'M12_RESTORE_PHYSICALLY_LOST',
    description: 'replace restored objects with null instead of restoring identity',
    apply: (value) => replaceOnce(value, 'collection[index] = restoreEntity(entity);', 'collection[index] = null;'),
  },
];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-deletion-mutations-'));
const results = [];
try {
  mutations.forEach((mutation) => {
    const mutationDir = path.join(tempRoot, mutation.id);
    fs.mkdirSync(mutationDir);
    const mutatedPath = path.join(mutationDir, 'store.js');
    const resultPath = path.join(mutationDir, 'contract-result.json');
    let mutated;
    try {
      mutated = mutation.apply(source);
      fs.writeFileSync(mutatedPath, mutated, 'utf8');
    } catch (error) {
      results.push({ id: mutation.id, description: mutation.description, killed: false, reason: error.message });
      return;
    }
    const child = spawnSync(process.execPath, [RUNNER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, process.env, {
        XJ_DELETION_STORE_PATH: mutatedPath,
        XJ_DELETION_RESULT_PATH: resultPath,
      }),
    });
    let result = null;
    if (fs.existsSync(resultPath)) {
      try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch (error) { result = null; }
    }
    const output = String(child.stdout || '') + String(child.stderr || '');
    const killed = child.status !== 0 && !child.error && result && Number(result.failed) > 0;
    results.push({
      id: mutation.id,
      description: mutation.description,
      mutated_sha256: sha256(mutated),
      exit_code: child.status,
      killed: !!killed,
      failed_checks: result ? Number(result.failed) : null,
      evidence: killed ? 'focused semantic check failed' : output.slice(-300),
    });
    console.log((killed ? '[KILLED] ' : '[SURVIVED] ') + mutation.id + ' ' + mutation.description);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const killed = results.filter((item) => item.killed).length;
const artifact = {
  task_id: 'XJ-5.0.0-codex-v4.3-deletion-tombstone-recovery-29',
  determinism: 'no volatile fields; hash-stable across healthy runs',
  total: results.length,
  killed,
  survived: results.length - killed,
  mutations: results,
};
fs.writeFileSync(RESULT_PATH, JSON.stringify(artifact, null, 2) + '\n');
console.log('MUTATIONS_KILLED=' + killed + '/' + results.length);
process.exitCode = killed === results.length && killed >= 10 ? 0 : 1;
