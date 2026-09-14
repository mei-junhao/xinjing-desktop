'use strict';

const crypto = require('crypto');

function safetyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function countSyntheticObjects(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw safetyError('snapshot-invalid');
  return Object.values(data).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

async function createVerifiedSnapshot(adapter, context) {
  if (!adapter || typeof adapter.readStableData !== 'function' || typeof adapter.writeSnapshot !== 'function' || typeof adapter.readSnapshot !== 'function') {
    throw safetyError('backup-failed');
  }
  const before = stableClone(await adapter.readStableData(context));
  const beforeHash = digest(before);
  const snapshot = { schemaVersion: 1, version: String(context.currentDataVersion), objectCount: countSyntheticObjects(before), payloadHash: beforeHash, data: before };
  try {
    await adapter.writeSnapshot(snapshot, context);
    const stored = await adapter.readSnapshot(context);
    if (!stored || stored.schemaVersion !== 1 || stored.version !== snapshot.version || stored.objectCount !== snapshot.objectCount || stored.payloadHash !== beforeHash || digest(stored.data) !== beforeHash) {
      throw safetyError('backup-failed');
    }
    return Object.freeze({ snapshot: stableClone(stored), version: stored.version, objectCount: stored.objectCount, payloadHash: stored.payloadHash });
  } catch (error) {
    if (error && error.code === 'backup-failed') throw error;
    throw safetyError('backup-failed');
  }
}

async function migrateWithProtection(adapter, verifiedSnapshot, context) {
  if (!adapter || typeof adapter.migrate !== 'function' || typeof adapter.replaceStableData !== 'function' || typeof adapter.readStableData !== 'function') {
    throw safetyError('migration-failed');
  }
  const previous = stableClone(verifiedSnapshot.snapshot.data);
  try {
    const migrated = await adapter.migrate(stableClone(previous), context);
    if (!migrated || typeof migrated !== 'object' || Array.isArray(migrated)) throw safetyError('migration-failed');
    await adapter.replaceStableData(stableClone(migrated), context);
    const actual = stableClone(await adapter.readStableData(context));
    if (digest(actual) !== digest(migrated)) throw safetyError('migration-failed');
    return Object.freeze({ version: String(context.targetDataVersion), objectCount: countSyntheticObjects(actual), payloadHash: digest(actual) });
  } catch (error) {
    try {
      await adapter.replaceStableData(stableClone(previous), Object.assign({}, context, { rollback: true }));
      const restored = stableClone(await adapter.readStableData(context));
      if (digest(restored) !== verifiedSnapshot.payloadHash) throw safetyError('rollback-failed');
    } catch (rollbackError) {
      if (rollbackError && rollbackError.code === 'rollback-failed') throw rollbackError;
      throw safetyError('rollback-failed');
    }
    if (error && error.code === 'rollback-failed') throw error;
    throw safetyError('migration-failed');
  }
}

module.exports = { safetyError, digest, countSyntheticObjects, createVerifiedSnapshot, migrateWithProtection };
