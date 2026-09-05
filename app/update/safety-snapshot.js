'use strict';

const fs = require('fs');
const crypto = require('crypto');

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.from(JSON.stringify(value), 'utf8')).digest('hex').toUpperCase();
}

function createVerifiedSnapshot(snapshotPath, data, meta) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error('snapshot invalid-data'); error.code = 'snapshot-invalid-data'; throw error;
  }
  const content = { schema: 1, version: meta.version, channel: meta.channel, data, takenAt: Date.now() };
  const payload = JSON.stringify(content);
  const expected = crypto.createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
  content.payloadSha256 = expected;
  const persisted = JSON.stringify(content);
  const temporary = snapshotPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, persisted, 'utf8');
  fs.renameSync(temporary, snapshotPath);
  const actual = crypto.createHash('sha256').update(JSON.stringify({ schema: content.schema, version: content.version, channel: content.channel, data: content.data, takenAt: content.takenAt }), 'utf8').digest('hex').toUpperCase();
  if (actual !== content.payloadSha256) {
    const error = new Error('snapshot verify-failed'); error.code = 'snapshot-verify-failed'; throw error;
  }
  return { snapshotPath, sha256: expected, bytes: Buffer.byteLength(persisted, 'utf8') };
}

function readVerifiedSnapshot(snapshotPath) {
  let value;
  try { value = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); }
  catch (error) { const e = new Error('snapshot corrupt'); e.code = 'snapshot-corrupt'; throw e; }
  if (value.schema !== 1 || !value.data || typeof value.data !== 'object' || Array.isArray(value.data) || typeof value.payloadSha256 !== 'string') {
    const error = new Error('snapshot corrupt'); error.code = 'snapshot-corrupt'; throw error;
  }
  const payload = JSON.stringify({ schema: value.schema, version: value.version, channel: value.channel, data: value.data, takenAt: value.takenAt });
  const actual = crypto.createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
  if (actual !== value.payloadSha256) {
    const error = new Error('snapshot hash-mismatch'); error.code = 'snapshot-hash-mismatch'; throw error;
  }
  return value;
}

function migrateWithProtection(snapshotPath, previousData, migrateFn, meta) {
  const snapshot = createVerifiedSnapshot(snapshotPath, previousData, meta);
  let next;
  try { next = migrateFn(JSON.parse(JSON.stringify(previousData))); }
  catch (error) {
    fs.writeFileSync(snapshotPath + '.store', JSON.stringify(previousData), 'utf8');
    return { ok: false, code: 'migration-failed', restored: true, previousHash: digest(previousData), error: String(error.message || error) };
  }
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    fs.writeFileSync(snapshotPath + '.store', JSON.stringify(previousData), 'utf8');
    return { ok: false, code: 'migration-invalid-result', restored: true, previousHash: digest(previousData) };
  }
  fs.writeFileSync(snapshotPath + '.store', JSON.stringify(next), 'utf8');
  return { ok: true, code: 'migration-ok', snapshotHash: snapshot.sha256, previousHash: digest(previousData), nextHash: digest(next), nextData: next };
}

function restoreVerifiedSnapshot(snapshotPath) {
  const snapshot = readVerifiedSnapshot(snapshotPath);
  const storePath = snapshotPath + '.store';
  const temporary = storePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(snapshot.data), 'utf8');
  const descriptor = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, storePath);
  return snapshot.data;
}

function verifyRestoredData(snapshotPath, expectedData) {
  try {
    const actual = JSON.parse(fs.readFileSync(snapshotPath + '.store', 'utf8'));
    return digest(actual) === digest(expectedData);
  } catch (_) {
    return false;
  }
}

module.exports = { createVerifiedSnapshot, readVerifiedSnapshot, restoreVerifiedSnapshot, migrateWithProtection, verifyRestoredData, digest };
