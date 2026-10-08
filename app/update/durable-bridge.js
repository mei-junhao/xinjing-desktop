'use strict';
// durable-bridge.js — renderer durable snapshot / migration boundary (decision 2.2).
//
// `window.Store.exportAll()` / `window.Store.importAll()` are the ONLY
// IndexedDB boundary. The main process never copies Chromium IndexedDB files
// and never invents a second durable store. Flow:
//   1. main asks the renderer through a typed allowlisted IPC request;
//   2. renderer AWAITS Store.exportAll() and returns the complete v2 payload;
//   3. main encrypts the payload through the existing authenticated backup
//      boundary (frozen backup-crypto; device key OR user passphrase, keeping
//      passphrase and quarantine semantics);
//   4. main writes an operation-scoped safety snapshot atomically and reads it
//      back; read-back decrypted hash must equal the recorded hash;
//   5. recovery invokes renderer Store.importAll() and WAITS for its real
//      durable result; `ok:false`, thrown errors, malformed results, fallback
//      persistence, stale schema or an uncompleted transaction fail closed.
// A successful encryption or IPC return alone is never commit evidence.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// exportAll() v2 payload keys (from frozen store.js). These are the ONLY
// durable business keys a snapshot may carry. Commercial projection,
// entitlement, recipient grants and license state are NOT exportable and must
// never be treated as restore authority.
const EXPORT_KEYS = new Set([
  'version', 'exportedAt', 'clients', 'sessions', 'supervisions',
  'supervisorIdentities', 'masterConversations', 'expenses',
  'materialWorkspaces', 'clinicalActionRuns', 'clinicalTasks',
  'importQuarantine', 'deletionBatches', 'deletionQuarantine'
]);
const FORBIDDEN_AUTHORITY_KEYS = ['commercialProjection', 'entitlements', 'recipientGrants', 'licenseState', 'balance'];

function sha256Hex(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex').toUpperCase();
}

function fail(code, detail) {
  const error = new Error('durable-bridge: ' + code + (detail ? ' ' + detail : ''));
  error.code = code;
  throw error;
}

// Validate the renderer-returned exportAll payload (JSON string -> object).
function assertPayloadSchema(jsonStr) {
  if (typeof jsonStr !== 'string' || !jsonStr.trim()) fail('snapshot-invalid-payload', 'not a string');
  let payload;
  try { payload = JSON.parse(jsonStr); } catch (_) { fail('snapshot-invalid-payload', 'unparseable'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('snapshot-invalid-payload', 'not an object');
  if (payload.version !== '2.0.0') fail('snapshot-stale-schema', 'version=' + String(payload.version));
  if (typeof payload.exportedAt !== 'string' || !payload.exportedAt) fail('snapshot-invalid-payload', 'missing exportedAt');
  for (const key of FORBIDDEN_AUTHORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) fail('snapshot-authority-key:' + key);
  }
  for (const key of Object.keys(payload)) {
    if (!EXPORT_KEYS.has(key)) fail('snapshot-unknown-field:' + key);
  }
  const collections = ['clients', 'sessions', 'supervisions', 'supervisorIdentities', 'masterConversations', 'expenses', 'materialWorkspaces', 'clinicalActionRuns', 'clinicalTasks'];
  for (const key of collections) {
    if (!Array.isArray(payload[key])) fail('snapshot-invalid-collection:' + key);
  }
  return payload;
}

// Encrypt through the frozen authenticated backup boundary.
// key path (device backup key, sync) mirrors production exportBackup();
// passphrase path (async) preserves the user-passphrase export semantics.
function encryptContainer(backupCrypto, payloadText, { key, passphrase }) {
  if (key != null && key !== '') {
    // Device-key path preserves the production exportBackup boundary
    // (kind user-data-snapshot, SNAPSHOT_KEYS); the exportAll v2 payload is
    // carried as a named file so quarantine semantics are unchanged.
    if (typeof backupCrypto.encryptPayloadWithKey !== 'function') fail('snapshot-no-key-crypto');
    const wrapped = {
      version: '1.0.0',
      kind: 'user-data-snapshot',
      createdAt: new Date().toISOString(),
      files: [{ path: 'store-export-v2.json', data: payloadText }]
    };
    return backupCrypto.encryptPayloadWithKey(JSON.stringify(wrapped), key, { kind: 'user-data-snapshot', payloadVersion: '1.0.0' });
  }
  if (passphrase != null && String(passphrase).length >= 12) {
    if (typeof backupCrypto.encryptPayload !== 'function') fail('snapshot-no-passphrase-crypto');
    return backupCrypto.encryptPayload(payloadText, String(passphrase), { kind: 'user-export', payloadVersion: '2.0.0' });
  }
  fail('snapshot-no-credential');
}

function decryptContainer(backupCrypto, packageText, { key, passphrase }) {
  if (key != null && key !== '') {
    if (typeof backupCrypto.decryptPayloadWithKey !== 'function') fail('snapshot-no-key-crypto');
    const wrapped = JSON.parse(backupCrypto.decryptPayloadWithKey(packageText, key));
    if (!wrapped || !Array.isArray(wrapped.files) || !wrapped.files[0] || typeof wrapped.files[0].data !== 'string') fail('snapshot-corrupt');
    return wrapped.files[0].data;
  }
  if (passphrase != null && String(passphrase).length >= 12) {
    if (typeof backupCrypto.decryptPayload !== 'function') fail('snapshot-no-passphrase-crypto');
    return backupCrypto.decryptPayload(packageText, String(passphrase));
  }
  fail('snapshot-no-credential');
}

// Main-side snapshot capture. `ipc` is the real main<->renderer IPC facade
// ({ invoke(win, channel, request) -> Promise }); `backupCrypto` is the frozen
// backup-crypto module. Returns { snapshotPath, sha256, bytes }.
async function createSnapshot({ win, ipc, operationId, version, channel, strategy, key, passphrase, workDir, backupCrypto }) {
  if (!operationId || !/^[A-Za-z0-9-]{1,80}$/.test(operationId)) fail('snapshot-bad-operationId');
  if (typeof backupCrypto !== 'object') fail('snapshot-no-backup-crypto');
  if (typeof ipc !== 'function' && !(ipc && typeof ipc.invoke === 'function')) fail('snapshot-no-ipc');
  const invoke = typeof ipc === 'function' ? ipc : ipc.invoke.bind(ipc);
  let result;
  try { result = await invoke(win, 'xj:update:snapshot', { operationId, version, channel, strategy }); }
  catch (e) { fail('snapshot-renderer-threw', String((e && e.message) || e)); }
  if (!result || result.ok !== true) fail('snapshot-renderer-failed', JSON.stringify(result && result.code));
  const payload = assertPayloadSchema(result.payload);
  const payloadHash = sha256Hex(JSON.stringify(payload));
  const packageText = encryptContainer(backupCrypto, JSON.stringify(payload), { key, passphrase });
  const container = {
    schema: 1,
    kind: 'update-safety-snapshot',
    operationId,
    version,
    channel,
    strategy,
    payloadSha256: payloadHash,
    packageText,
    takenAt: Date.now()
  };
  fs.mkdirSync(workDir, { recursive: true });
  const snapshotPath = path.join(workDir, 'store.snapshot.' + operationId + '.json');
  const temporary = snapshotPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(container), 'utf8');
  const fd = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, snapshotPath);
  // Atomic read-back: decrypt and compare hash against the recorded hash.
  const readBack = readSnapshot({ snapshotPath, key, passphrase, backupCrypto });
  if (readBack.payloadSha256 !== payloadHash) fail('snapshot-readback-hash-mismatch');
  return { snapshotPath, sha256: payloadHash, bytes: Buffer.byteLength(JSON.stringify(container), 'utf8'), readBackOk: true };
}

// Read + decrypt + verify a snapshot (throws fail-closed on any mismatch).
function readSnapshot({ snapshotPath, key, passphrase, backupCrypto }) {
  let container;
  try { container = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); }
  catch (_) { fail('snapshot-corrupt'); }
  if (container.schema !== 1 || container.kind !== 'update-safety-snapshot') fail('snapshot-corrupt');
  if (!container.packageText || !/^[0-9A-F]{64}$/.test(String(container.payloadSha256 || ''))) fail('snapshot-corrupt');
  let decrypted;
  try { decrypted = decryptContainer(backupCrypto, container.packageText, { key, passphrase }); }
  catch (e) { fail('snapshot-decrypt-failed', String((e && e.message) || e)); }
  const decryptedHash = sha256Hex(String(decrypted));
  if (decryptedHash !== container.payloadSha256) fail('snapshot-hash-mismatch');
  const payload = assertPayloadSchema(decrypted);
  return { container, payload, decryptedHash, payloadSha256: container.payloadSha256 };
}

// Main-side restore. Renderer must AWAIT Store.importAll() and report its real
// durable result. ok:false / throw / malformed / fallback / stale -> fail closed.
async function restoreSnapshot({ win, ipc, operationId, key, passphrase, snapshotPath, backupCrypto }) {
  const { payload } = readSnapshot({ snapshotPath, key, passphrase, backupCrypto });
  if (typeof ipc !== 'function' && !(ipc && typeof ipc.invoke === 'function')) fail('restore-no-ipc');
  const invoke = typeof ipc === 'function' ? ipc : ipc.invoke.bind(ipc);
  let result;
  try { result = await invoke(win, 'xj:update:restore', { operationId, payload: JSON.stringify(payload) }); }
  catch (e) { fail('restore-renderer-threw', String((e && e.message) || e)); }
  if (!result) fail('restore-no-result');
  if (result.ok !== true) fail('restore-durable-failed', String(result.code || 'ok-false'));
  if (typeof result.quarantine === 'undefined' && typeof result.deletionQuarantine === 'undefined') fail('restore-malformed-result');
  return { ok: true, quarantine: (result.quarantine || []).slice(), deletionQuarantine: (result.deletionQuarantine || []).slice() };
}


// Encrypt an ALREADY-obtained payload into an atomic operation-scoped snapshot
// (used when the renderer export already happened once; no second IPC round trip).
function encryptPayloadSnapshot({ operationId, version, channel, strategy, payload, key, passphrase, workDir, backupCrypto }) {
  if (!operationId || !/^[A-Za-z0-9-]{1,80}$/.test(operationId)) fail('snapshot-bad-operationId');
  if (typeof backupCrypto !== 'object') fail('snapshot-no-backup-crypto');
  const payloadHash = sha256Hex(JSON.stringify(payload));
  const packageText = encryptContainer(backupCrypto, JSON.stringify(payload), { key, passphrase });
  const container = {
    schema: 1, kind: 'update-safety-snapshot', operationId, version, channel, strategy,
    payloadSha256: payloadHash, packageText, takenAt: Date.now()
  };
  fs.mkdirSync(workDir, { recursive: true });
  const snapshotPath = path.join(workDir, 'store.snapshot.' + operationId + '.json');
  const temporary = snapshotPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(container), 'utf8');
  const fd = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, snapshotPath);
  const readBack = readSnapshot({ snapshotPath, key, passphrase, backupCrypto });
  if (readBack.payloadSha256 !== payloadHash) fail('snapshot-readback-hash-mismatch');
  return { snapshotPath, sha256: payloadHash, bytes: Buffer.byteLength(JSON.stringify(container), 'utf8'), readBackOk: true };
}

// Transient plaintext cleanup after a terminal state: remove the coordinator's
// plaintext migrate artifacts; keep the encrypted container and the marker.
function cleanupTransient(env) {
  const targets = [];
  if (env && env.snapshotPath) {
    targets.push(env.snapshotPath, env.snapshotPath + '.store', env.snapshotPath + '.tmp');
    try {
      const dir = path.dirname(env.snapshotPath);
      for (const f of fs.readdirSync(dir)) {
        if (/\.(tmp|store)$/.test(f)) targets.push(path.join(dir, f));
      }
    } catch (_) {}
  }
  for (const t of targets) { try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch (_) {} }
  return targets.length;
}

module.exports = { createSnapshot, encryptPayloadSnapshot, readSnapshot, restoreSnapshot, assertPayloadSchema, cleanupTransient, EXPORT_KEYS, FORBIDDEN_AUTHORITY_KEYS, sha256Hex };
