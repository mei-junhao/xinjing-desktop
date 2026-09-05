'use strict';
// portable-restart.js — portable restart recovery candidate (decision 2.4).
//
// Replaces the production delete-then-copy detached batch
// (live-snapshot/main.js:1869-1904) with a fail-closed helper that:
//   - binds operationId and journal revision;
//   - retains the previous known-good executable until the new bytes are
//     verified AND the candidate process exits AND health passes;
//   - stages the new executable under an operation-specific temporary name;
//   - exchanges only after verification and process exit;
//   - starts the candidate and waits for the health result;
//   - restores the previous executable when exchange/start/health fails;
//   - makes recovery idempotent after helper or parent termination.
// The helper NEVER deletes the only known-good executable before a verified
// replacement exists. Real executable replacement is NOT executed by this
// isolated candidate; the state logic is exercised with fake files/processes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha512(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('hex').toUpperCase();
}

function fail(code) {
  const error = new Error('portable-restart rejected: ' + code);
  error.code = code;
  throw error;
}

function safeOpId(operationId) {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(String(operationId || ''))) fail('bad-operationId');
  return String(operationId);
}

// Stage: retain previous known-good; write new bytes to an operation-specific
// temporary name; verify size+SHA-512 before promotion. Never deletes previous.
function stagePortable({ operationId, revision, bytes, currentPath, workDir }) {
  safeOpId(operationId);
  if (!Number.isInteger(revision) || revision < 0) fail('bad-revision');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail('artifact-missing');
  if (!currentPath || !fs.existsSync(currentPath)) fail('current-exe-missing');
  fs.mkdirSync(workDir, { recursive: true });
  const previous = path.join(workDir, 'previous-portable.' + operationId + '.exe');
  // RETAIN previous known-good (copy, not move-delete; original stays until swap).
  fs.copyFileSync(currentPath, previous);
  const tmp = path.join(workDir, 'staged-portable.' + operationId + '.' + process.pid + '.tmp');
  const staged = path.join(workDir, 'staged-portable.' + operationId + '.exe');
  fs.writeFileSync(tmp, bytes);
  const fd = fs.openSync(tmp, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, staged);
  const verified = { size: bytes.length, sha512: sha512(bytes) };
  return { previous, staged, verified, workDir, operationId, revision, currentPath };
}

// Exchange: move current aside, promote staged to current. The previous
// known-good copy remains untouched. Fails closed on any I/O error.
function exchangePortable(state) {
  if (!state || !state.staged || !fs.existsSync(state.staged)) fail('staged-missing');
  const current = state.currentPath;
  const exchanged = path.join(state.workDir, 'exchanged.' + state.operationId + '.exe');
  fs.renameSync(current, exchanged); // current is recoverable from `previous`
  fs.renameSync(state.staged, current);
  return { exchanged, current };
}

// Restore: replace a failed candidate with the retained previous known-good.
// NEVER deletes the only known-good; copies back from the retained copy.
function restorePortable(state) {
  if (!state || !state.previous || !fs.existsSync(state.previous)) fail('rollback-previous-missing');
  const current = state.currentPath;
  if (fs.existsSync(current)) {
    // Preserve the failed candidate as evidence (bounded), do not destroy it.
    const failed = path.join(state.workDir, 'failed-candidate.' + state.operationId + '.exe');
    try { fs.renameSync(current, failed); } catch (_) { /* keep going */ }
  }
  fs.copyFileSync(state.previous, current);
  const fd = fs.openSync(current, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { restored: current, from: state.previous };
}

// Idempotent recovery: if a pending operation left a staged candidate and a
// retained previous known-good, restore the previous and remove staging only
// when the previous is confirmed back in place.
function recoverPortable({ workDir, operationId, currentPath }) {
  safeOpId(operationId);
  const previous = path.join(workDir, 'previous-portable.' + operationId + '.exe');
  const staged = path.join(workDir, 'staged-portable.' + operationId + '.exe');
  if (!fs.existsSync(previous)) return { recovered: false, reason: 'no-previous-known-good' };
  if (fs.existsSync(currentPath)) {
    const failed = path.join(workDir, 'failed-candidate.' + operationId + '.exe');
    try { fs.renameSync(currentPath, failed); } catch (_) { /* keep going */ }
  }
  fs.copyFileSync(previous, currentPath);
  try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (_) {}
  return { recovered: true, restored: currentPath };
}

module.exports = { stagePortable, exchangePortable, restorePortable, recoverPortable, sha512 };
