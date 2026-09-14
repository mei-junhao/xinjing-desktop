'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const STORE_PATH = process.env.XJ_DELETION_STORE_PATH
  ? path.resolve(process.env.XJ_DELETION_STORE_PATH)
  : path.join(ROOT, 'app', 'js', 'store.js');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-deletion-tombstone-recovery-29', 'protected-files-manifest.json');
const RESULT_PATH = process.env.XJ_DELETION_RESULT_PATH
  ? path.resolve(process.env.XJ_DELETION_RESULT_PATH)
  : path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-deletion-tombstone-recovery-29', 'contract-result.json');
const BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';

const checks = [];
let confirmed = 0;
let expectedRed = 0;
let failed = 0;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function check(id, label, pass, classification = 'CONFIRMED', evidence) {
  const ok = !!pass;
  if (classification === 'CONFIRMED') {
    if (ok) confirmed += 1; else failed += 1;
  } else if (classification === 'EXPECTED_RED') {
    if (ok) expectedRed += 1; else failed += 1;
  }
  checks.push({ id, label, pass: ok, classification, evidence: evidence || null });
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + id + ' ' + label + ' [' + classification + ']');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function idIn(collection, id) {
  return Array.isArray(collection) && collection.some((item) => item && String(item.id) === String(id));
}

function jsonHasClinicalBody(value) {
  const raw = JSON.stringify(value);
  return /SYNTHETIC_CLINICAL_BODY|SYNTHETIC_PROMPT|SYNTHETIC_MODEL_OUTPUT|sk_[A-Za-z0-9_-]+|transcript|soap|dap|prompt|modelOutput|rawContent/i.test(raw);
}

function writeResult(status) {
  const result = {
    task_id: 'XJ-5.0.0-codex-v4.3-deletion-tombstone-recovery-29',
    base_commit: BASE_COMMIT,
    status,
    determinism: 'no volatile fields; hash-stable across healthy runs',
    confirmed,
    expected_red: expectedRed,
    failed,
    checks,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\n');
  return result;
}

// Real Store loader: this harness does not copy or replace production behavior.
const memStore = Object.create(null);
let failWrites = false;
const localValues = Object.create(null);

const fakeLocalStorage = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(localValues, key) ? localValues[key] : null; },
  setItem(key, value) { localValues[key] = String(value); },
  removeItem(key) { delete localValues[key]; },
  key(index) { return Object.keys(localValues)[index] || null; },
  get length() { return Object.keys(localValues).length; },
};

const fakeIndexedDB = {
  open() {
    const request = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    const db = {
      objectStoreNames: { contains() { return true; } },
      transaction() {
        const tx = { oncomplete: null, onabort: null, onerror: null, error: null, failed: false };
        const objectStore = {
          get(key) {
            const result = { result: memStore[key], onsuccess: null, onerror: null };
            setTimeout(() => { if (result.onsuccess) result.onsuccess({ target: result }); }, 0);
            return result;
          },
          getAll() {
            const result = { result: Object.keys(memStore).map((key) => memStore[key]), onsuccess: null, onerror: null };
            setTimeout(() => { if (result.onsuccess) result.onsuccess({ target: result }); }, 0);
            return result;
          },
          put(value) {
            if (failWrites) tx.failed = true;
            else if (value && value.key) memStore[value.key] = value;
            return { onsuccess: null, onerror: null };
          },
          delete(key) {
            if (failWrites) tx.failed = true;
            else delete memStore[key];
            return { onsuccess: null, onerror: null };
          },
        };
        tx.objectStore = () => objectStore;
        setTimeout(() => {
          if (tx.failed) {
            tx.error = new Error('synthetic durable write failure');
            if (tx.onerror) tx.onerror({ target: tx });
            if (tx.onabort) tx.onabort({ target: tx });
          } else if (tx.oncomplete) tx.oncomplete({ target: tx });
        }, 0);
        return tx;
      },
      close() {},
    };
    setTimeout(() => {
      request.result = db;
      if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
      if (request.onsuccess) request.onsuccess({ target: request });
    }, 0);
    return request;
  },
  deleteDatabase() {
    const request = { onsuccess: null, onerror: null };
    setTimeout(() => { if (request.onsuccess) request.onsuccess({ target: request }); }, 0);
    return request;
  },
};

function installBrowserShim() {
  global.window = {
    indexedDB: fakeIndexedDB,
    localStorage: fakeLocalStorage,
    __XJ_API__: { notifyMigrateDone() {} },
    location: { reload() {} },
  };
  global.indexedDB = fakeIndexedDB;
  global.localStorage = fakeLocalStorage;
  global.location = global.window.location;
}

async function loadStore() {
  installBrowserShim();
  delete require.cache[require.resolve(STORE_PATH)];
  require(STORE_PATH);
  const store = global.window.Store;
  await store.hydrate();
  return store;
}

function manifestCheck() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  check('P1_MANIFEST', 'protected manifest is readable', Array.isArray(manifest.files) && manifest.files.length >= 3, 'CONFIRMED');
  for (const entry of manifest.files || []) {
    const filePath = path.join(ROOT, entry.path);
    check('P1_' + entry.path.replace(/[^a-z0-9]/gi, '_').slice(0, 42), 'protected hash: ' + entry.path, fs.existsSync(filePath) && sha256(filePath) === String(entry.sha256).toUpperCase(), 'CONFIRMED');
  }
}

async function main() {
  manifestCheck();
  const Store = await loadStore();
  check('P2_STORE_REAL', 'real Store module loaded', Store && typeof Store === 'object', 'CONFIRMED');
  check('P2_STORE_PATH', 'Store resolved from the production path', !!require.cache[require.resolve(STORE_PATH)], 'CONFIRMED');

  const requiredApis = ['previewDeletionImpact', 'createDeletionBatch', 'restoreDeletionBatch', 'getDeletionBatch', 'getDeletionQuarantine'];
  const missing = requiredApis.filter((name) => typeof Store[name] !== 'function');
  if (missing.length) {
    for (const name of missing) check('API_' + name, 'Store API absent: ' + name, true, 'EXPECTED_RED');
    writeResult('EXPECTED_RED');
    console.log('EXPECTED_RED_MISSING_APIS=' + missing.join(','));
    process.exitCode = 1;
    return;
  }

  for (const name of requiredApis) check('API_' + name, 'Store API present: ' + name, true, 'CONFIRMED');

  const clientId = 'codex-client-29';
  const sessionA = 'codex-session-29-a';
  const sessionB = 'codex-session-29-b';
  const taskId = 'codex-task-29';
  const materialId = 'codex-material-29';
  const actionRunId = 'codex-action-29';
  const supervisionId = 'codex-supervision-29';

  Store.createClient({ id: clientId, name: 'SYNTHETIC CLIENT 29', status: 'active' });
  Store.createSession({ id: sessionA, clientId, date: '2026-07-28', transcript: 'SYNTHETIC_CLINICAL_BODY' });
  Store.createSession({ id: sessionB, clientId, date: '2026-07-29' });
  Store.createSupervision({ id: supervisionId, sessionIds: [sessionA], content: 'SYNTHETIC_CLINICAL_BODY' });
  Store.createMaterialWorkspace({ id: materialId, clientId, sessionId: sessionA, extractedText: 'SYNTHETIC_CLINICAL_BODY', parseStatus: 'ready' });
  Store.createClinicalActionRun({
    id: actionRunId,
    task: 'transcript-ai-detect',
    status: 'succeeded',
    origin: { clientId, sessionId: sessionA, materialId },
    sources: [{ kind: 'session', id: sessionA, label: 'synthetic', chars: 10 }],
    snapshot: { clientId, sessionId: sessionA, materialId },
  });
  const invalidPreview = Store.previewDeletionImpact({ targetType: 'unsupported', targetId: clientId });
  check('R0_INVALID_TARGET', 'unsupported deletion targets fail closed without a write', invalidPreview && invalidPreview.ok === false && invalidPreview.error && invalidPreview.error.code === 'XJ_DELETION_TARGET_TYPE', 'CONFIRMED');
  const taskCreate = await Store.createClinicalTaskDurable({
    id: taskId,
    clientId,
    originSessionId: sessionA,
    title: 'synthetic deletion task',
    target: 'follow-up',
    status: 'open',
    sourceRefs: ['codex-ref-29'],
    createdBy: 'manual',
  });
  check('R0_TASK_SETUP', 'synthetic clinical task setup uses the real durable Store', taskCreate && taskCreate.ok === true, 'CONFIRMED');

  const preview1 = Store.previewDeletionImpact({ targetType: 'client', targetId: clientId });
  const preview2 = Store.previewDeletionImpact({ targetType: 'client', targetId: clientId });
  const p1 = preview1 && (preview1.value || preview1);
  const p2 = preview2 && (preview2.value || preview2);
  check('R1_PREVIEW', 'preview returns identifier/count metadata and previewHash', preview1 && preview1.ok === true && p1.previewHash && p1.counts, 'CONFIRMED');
  check('R2_DETERMINISTIC', 'repeated preview is deterministic without a write', preview1 && preview2 && preview1.ok && preview2.ok && p1.previewHash === p2.previewHash && JSON.stringify(p1) === JSON.stringify(p2), 'CONFIRMED');
  check('R3_SCOPE', 'client preview includes owned identifier-only affected entries', p1 && idIn(p1.affected && p1.affected.clients, clientId) && idIn(p1.affected && p1.affected.sessions, sessionA) && idIn(p1.affected && p1.affected.sessions, sessionB) && idIn(p1.affected && p1.affected.clinicalTasks, taskId), 'CONFIRMED');
  check('R4_NO_BODY', 'preview excludes clinical bodies and secrets', p1 && !jsonHasClinicalBody(p1), 'CONFIRMED');

  const beforeChangeHash = p1.previewHash;
  const changedSession = Object.assign({}, Store.getSession(sessionA), { summary: 'SYNTHETIC_CLINICAL_BODY updated' });
  const changed = await Store.updateSessionFull(changedSession);
  const previewAfterWrite = Store.previewDeletionImpact({ targetType: 'client', targetId: clientId });
  const p3 = previewAfterWrite && (previewAfterWrite.value || previewAfterWrite);
  check('R5_REVISION', 'relevant durable write changes the preview hash', changed && changed.ok === true && p3 && p3.previewHash && p3.previewHash !== beforeChangeHash, 'CONFIRMED');
  const stale = await Store.createDeletionBatch({ targetType: 'client', targetId: clientId, previewHash: beforeChangeHash });
  check('R6_STALE_REJECTED', 'stale preview hash is rejected without applying deletion', stale && stale.ok === false && stale.error && /STALE|PREVIEW/i.test(stale.error.code || ''), 'CONFIRMED');

  const applied = await Store.createDeletionBatch({ targetType: 'client', targetId: clientId, previewHash: p3.previewHash });
  const batch = applied && (applied.value || applied);
  check('R7_APPLY', 'deletion persists an applied tombstone batch', applied && applied.ok === true && batch.batchId && batch.status === 'applied', 'CONFIRMED');
  check('R8_ACTIVE_OMIT', 'active projections omit tombstoned client and sessions', !idIn(Store.getClients(), clientId) && !idIn(Store.getSessions(), sessionA), 'CONFIRMED');
  check('R9_TASK_PRESERVE', 'clinical task identity and originSessionId remain unchanged', Store.getClinicalTasks().some((task) => task.id === taskId && task.clientId === clientId && task.originSessionId === sessionA), 'CONFIRMED');
  check('R10_BATCH_NO_BODY', 'tombstone batch contains identifier-only entries', !jsonHasClinicalBody(batch), 'CONFIRMED');
  const duplicateApply = await Store.createDeletionBatch({ targetType: 'client', targetId: clientId, previewHash: p3.previewHash });
  const duplicateBatch = duplicateApply && (duplicateApply.value || duplicateApply);
  check('R11_APPLY_IDEMPOTENT', 'duplicate apply is idempotent', duplicateApply && duplicateApply.ok === true && duplicateBatch.batchId === batch.batchId, 'CONFIRMED');

  const restored = await Store.restoreDeletionBatch(batch.batchId);
  check('R12_RESTORE', 'restore reactivates the tombstoned objects', restored && restored.ok === true && idIn(Store.getClients(), clientId) && idIn(Store.getSessions(), sessionA), 'CONFIRMED');
  const duplicateRestore = await Store.restoreDeletionBatch(batch.batchId);
  check('R13_RESTORE_IDEMPOTENT', 'duplicate restore is idempotent', duplicateRestore && duplicateRestore.ok === true && (duplicateRestore.value || duplicateRestore).status === 'restored', 'CONFIRMED');
  const fetched = Store.getDeletionBatch(batch.batchId);
  check('R14_GET_BATCH', 'getDeletionBatch retrieves the durable audit record', fetched && fetched.ok === true && (fetched.value || fetched).batchId === batch.batchId, 'CONFIRMED');
  const quarantineBefore = Store.getDeletionQuarantine();
  check('R15_GET_QUARANTINE', 'getDeletionQuarantine returns a durable list', Array.isArray(quarantineBefore && (quarantineBefore.value || quarantineBefore)), 'CONFIRMED');

  const sessionTaskId = 'codex-session-task-29';
  const sessionTaskCreate = await Store.createClinicalTaskDurable({
    id: sessionTaskId,
    clientId,
    originSessionId: sessionB,
    title: 'synthetic session deletion task',
    target: 'follow-up',
    status: 'open',
    sourceRefs: ['codex-session-ref-29'],
    createdBy: 'manual',
  });
  check('R16A_TASK_SETUP', 'session deletion task uses the real durable Store', sessionTaskCreate && sessionTaskCreate.ok === true, 'CONFIRMED');
  const sessionPreview = Store.previewDeletionImpact({ targetType: 'session', targetId: sessionB });
  const sessionPreviewValue = sessionPreview && (sessionPreview.value || sessionPreview);
  const sessionBatchResult = await Store.createDeletionBatch({ targetType: 'session', targetId: sessionB, previewHash: sessionPreviewValue.previewHash });
  const sessionBatch = sessionBatchResult && (sessionBatchResult.value || sessionBatchResult);
  check('R16_SESSION_BATCH', 'session deletion uses the same durable batch contract', sessionBatchResult && sessionBatchResult.ok === true && sessionBatch.targetType === 'session', 'CONFIRMED');
  check('R16B_SESSION_TASK_PRESERVE', 'session deletion preserves the task clientId and originSessionId', Store.getClinicalTasks().some((task) => task.id === sessionTaskId && task.clientId === clientId && task.originSessionId === sessionB), 'CONFIRMED');
  const exported = JSON.parse(await Store.exportAll());
  check('R17_EXPORT', 'export preserves tombstone batches and quarantine', Array.isArray(exported.deletionBatches) && exported.deletionBatches.some((item) => item.batchId === sessionBatch.batchId) && Array.isArray(exported.deletionQuarantine), 'CONFIRMED');
  check('R18_EXPORT_NO_BODY', 'exported deletion audit data contains no clinical body', !jsonHasClinicalBody(exported.deletionBatches), 'CONFIRMED');

  const StoreAfterRestart = await loadStore();
  const restoredBatch = StoreAfterRestart.getDeletionBatch(sessionBatch.batchId);
  check('R19_HYDRATE', 'hydration preserves tombstone batches', restoredBatch && restoredBatch.ok === true && (restoredBatch.value || restoredBatch).batchId === sessionBatch.batchId, 'CONFIRMED');
  check('R20_HYDRATE_OMIT', 'hydration keeps tombstoned session out of active lists', !idIn(StoreAfterRestart.getSessions(), sessionB), 'CONFIRMED');

  const mismatchClient = 'codex-mismatch-client-29';
  const otherClient = 'codex-other-client-29';
  const mismatchSession = 'codex-mismatch-session-29';
  StoreAfterRestart.createClient({ id: mismatchClient, name: 'synthetic mismatch client' });
  StoreAfterRestart.createClient({ id: otherClient, name: 'synthetic other client' });
  StoreAfterRestart.createSession({ id: mismatchSession, clientId: mismatchClient, date: '2026-07-30' });
  const mismatchPreview = StoreAfterRestart.previewDeletionImpact({ targetType: 'session', targetId: mismatchSession });
  const mismatchPreviewValue = mismatchPreview && (mismatchPreview.value || mismatchPreview);
  const mismatchBatchResult = await StoreAfterRestart.createDeletionBatch({ targetType: 'session', targetId: mismatchSession, previewHash: mismatchPreviewValue.previewHash });
  const rawSessions = await StoreAfterRestart._get('sessions');
  await StoreAfterRestart._put('sessions', rawSessions.map((item) => item.id === mismatchSession ? Object.assign({}, item, { clientId: otherClient }) : item));
  const StoreAfterMismatch = await loadStore();
  const mismatchRestore = await StoreAfterMismatch.restoreDeletionBatch((mismatchBatchResult.value || mismatchBatchResult).batchId);
  const mismatchQuarantine = StoreAfterMismatch.getDeletionQuarantine();
  const mismatchQuarantineValues = mismatchQuarantine && (mismatchQuarantine.value || mismatchQuarantine);
  check('R20A_MISMATCH_QUARANTINE', 'restore quarantines a cross-client identity mismatch', mismatchRestore && mismatchRestore.ok === false && mismatchRestore.error && mismatchRestore.error.code === 'XJ_DELETION_RESTORE_QUARANTINED' && Array.isArray(mismatchQuarantineValues) && mismatchQuarantineValues.some((item) => item.entityId === mismatchSession), 'CONFIRMED');

  const invalidImport = {
    version: '2.0.0',
    clients: [{ id: 'codex-import-client-29', name: 'synthetic import' }],
    sessions: [],
    deletionBatches: [{ schemaVersion: 1, batchId: 'codex-invalid-batch-29', targetType: 'client', targetId: 'unknown-client-29', previewHash: 'invalid', status: 'applied', affected: [] }],
    deletionQuarantine: [{ id: 'codex-existing-quarantine-29', collection: 'clients', entityId: 'unknown-client-29', reason: 'synthetic-import' }],
  };
  const imported = await StoreAfterRestart.importAll(JSON.stringify(invalidImport));
  check('R21_IMPORT_PRESERVE', 'import returns quarantine results and preserves deletion metadata', imported && imported.ok === true && Array.isArray((imported.value || imported).quarantine), 'CONFIRMED');
  const deletionQuarantine = StoreAfterRestart.getDeletionQuarantine();
  const deletionQuarantineValues = deletionQuarantine && (deletionQuarantine.value || deletionQuarantine);
  check('R22_QUARANTINE', 'identifier-only deletion quarantine survives import', Array.isArray(deletionQuarantineValues) && deletionQuarantineValues.some((item) => item.id === 'codex-existing-quarantine-29'), 'CONFIRMED');

  const failureClient = 'codex-failure-client-29';
  StoreAfterRestart.createClient({ id: failureClient, name: 'synthetic persistence failure' });
  const failurePreview = StoreAfterRestart.previewDeletionImpact({ targetType: 'client', targetId: failureClient });
  const failurePreviewValue = failurePreview && (failurePreview.value || failurePreview);
  failWrites = true;
  const failedApply = await StoreAfterRestart.createDeletionBatch({ targetType: 'client', targetId: failureClient, previewHash: failurePreviewValue.previewHash });
  failWrites = false;
  check('R23_FAILURE', 'persistence failure returns ok:false', failedApply && failedApply.ok === false, 'CONFIRMED');
  check('R24_FAILURE_NO_CACHE_MUTATION', 'persistence failure leaves cache and batch state unchanged', idIn(StoreAfterRestart.getClients(), failureClient) && !((StoreAfterRestart.getDeletionBatch(failureClient) || {}).value), 'CONFIRMED');

  const result = writeResult(failed ? 'FAIL' : 'PASS');
  console.log('CONFIRMED=' + result.confirmed + ' EXPECTED_RED=' + result.expected_red + ' FAILED=' + result.failed);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error('HARNESS_ERROR: ' + (error && error.stack || error));
  failed += 1;
  writeResult('ERROR');
  process.exitCode = 1;
});
