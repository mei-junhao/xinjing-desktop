'use strict';

const fs = require('fs');
const path = require('path');

const STATES = Object.freeze([
  'discovered', 'awaiting-confirmation', 'downloading', 'verified', 'backup-created',
  'staged', 'restarting', 'health-check', 'committed', 'failed', 'rolled-back',
]);
const FAILURE_CODES = new Set([
  'feed-unavailable', 'metadata-invalid', 'artifact-mismatch', 'channel-mismatch',
  'download-failed', 'backup-failed', 'migration-failed', 'replacement-failed',
  'health-check-failed', 'stale-pending', 'rollback-failed',
]);
const TRANSITIONS = Object.freeze({
  discovered: new Set(['awaiting-confirmation', 'failed']),
  'awaiting-confirmation': new Set(['downloading', 'failed']),
  downloading: new Set(['verified', 'failed']),
  verified: new Set(['backup-created', 'failed']),
  'backup-created': new Set(['staged', 'failed']),
  staged: new Set(['restarting', 'failed']),
  restarting: new Set(['health-check', 'failed']),
  'health-check': new Set(['committed', 'failed']),
  failed: new Set(['rolled-back']),
  'rolled-back': new Set(),
  committed: new Set(),
});
const ALLOWED_KEYS = new Set(['schemaVersion', 'operationId', 'version', 'channel', 'artifactSha512', 'state', 'updatedAt', 'errorCode', 'sequence']);
const SAFE_ID = /^[A-Za-z0-9._-]{8,100}$/;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_SHA512 = /^[A-Za-z0-9+/]{86}==$/;

function journalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw journalError('journal-invalid');
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw journalError('journal-sensitive-or-unknown-field');
  if (input.schemaVersion !== 1 || !SAFE_ID.test(input.operationId) || !SAFE_VERSION.test(input.version) || !['nsis', 'portable'].includes(input.channel) ||
      !SAFE_SHA512.test(input.artifactSha512) || !STATES.includes(input.state) || typeof input.updatedAt !== 'string' || Number.isNaN(Date.parse(input.updatedAt)) ||
      !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw journalError('journal-invalid');
  }
  if (input.errorCode != null && (!FAILURE_CODES.has(input.errorCode) || input.state !== 'failed')) throw journalError('journal-invalid');
  if (input.state === 'failed' && !FAILURE_CODES.has(input.errorCode)) throw journalError('journal-invalid');
  return Object.freeze({
    schemaVersion: 1,
    operationId: input.operationId,
    version: input.version,
    channel: input.channel,
    artifactSha512: input.artifactSha512,
    state: input.state,
    updatedAt: input.updatedAt,
    errorCode: input.errorCode || null,
    sequence: input.sequence,
  });
}

function createRecord(input) {
  return validateRecord(Object.assign({}, input, { schemaVersion: 1, state: 'discovered', updatedAt: new Date().toISOString(), errorCode: null, sequence: 0 }));
}

function transition(record, nextState, options) {
  const current = validateRecord(record);
  if (!STATES.includes(nextState) || !TRANSITIONS[current.state].has(nextState)) throw journalError('invalid-transition');
  const opts = options || {};
  const next = Object.assign({}, current, {
    state: nextState,
    updatedAt: opts.updatedAt || new Date().toISOString(),
    errorCode: nextState === 'failed' ? opts.errorCode : null,
    sequence: current.sequence + 1,
  });
  return validateRecord(next);
}

function writeAtomic(filePath, record, io) {
  const adapter = io || fs;
  const valid = validateRecord(record);
  const directory = path.dirname(filePath);
  const temp = `${filePath}.${valid.operationId}.${valid.sequence}.tmp`;
  const payload = `${JSON.stringify(valid)}\n`;
  adapter.mkdirSync(directory, { recursive: true });
  try {
    adapter.writeFileSync(temp, payload, { encoding: 'utf8', flag: 'w' });
    if (typeof adapter.openSync === 'function' && typeof adapter.fsyncSync === 'function' && typeof adapter.closeSync === 'function') {
      const fd = adapter.openSync(temp, 'r+');
      try { adapter.fsyncSync(fd); } finally { adapter.closeSync(fd); }
    }
    if (adapter.existsSync(filePath)) {
      const previous = `${filePath}.previous`;
      try { if (adapter.existsSync(previous)) adapter.unlinkSync(previous); } catch (_) {}
      adapter.renameSync(filePath, previous);
      try {
        adapter.renameSync(temp, filePath);
        try { if (adapter.existsSync(previous)) adapter.unlinkSync(previous); } catch (_) {}
      } catch (error) {
        try { if (!adapter.existsSync(filePath) && adapter.existsSync(previous)) adapter.renameSync(previous, filePath); } catch (_) {}
        throw error;
      }
    } else {
      adapter.renameSync(temp, filePath);
    }
  } catch (error) {
    try { if (adapter.existsSync(temp)) adapter.unlinkSync(temp); } catch (_) {}
    throw journalError('journal-write-failed');
  }
  return valid;
}

function read(filePath, io) {
  const adapter = io || fs;
  let parsed;
  try {
    const text = adapter.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 8192) throw journalError('journal-invalid');
    parsed = JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error && String(error.code || '').startsWith('journal-')) throw error;
    throw journalError('journal-invalid');
  }
  return validateRecord(parsed);
}

function chooseRecovery(current, incoming) {
  const existing = current ? validateRecord(current) : null;
  const candidate = validateRecord(incoming);
  if (!existing) return candidate;
  if (existing.operationId !== candidate.operationId) throw journalError('stale-pending');
  if (existing.channel !== candidate.channel || existing.version !== candidate.version || existing.artifactSha512 !== candidate.artifactSha512) throw journalError('stale-pending');
  if (candidate.sequence < existing.sequence) return existing;
  if (candidate.sequence === existing.sequence && candidate.state !== existing.state) throw journalError('stale-pending');
  if (existing.state === 'committed' && candidate.state !== 'committed') return existing;
  return candidate;
}

module.exports = { STATES, FAILURE_CODES, TRANSITIONS, journalError, validateRecord, createRecord, transition, writeAtomic, read, chooseRecovery };
