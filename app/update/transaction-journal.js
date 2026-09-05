'use strict';

const fs = require('fs');
const path = require('path');

const STATES = Object.freeze({
  discovered: 'discovered',
  awaitingConfirmation: 'awaiting-confirmation',
  downloading: 'downloading',
  verified: 'verified',
  backupCreated: 'backup-created',
  staged: 'staged',
  restarting: 'restarting',
  healthCheck: 'health-check',
  committed: 'committed',
  failed: 'failed',
  rolledBack: 'rolled-back'
});

const TRANSITIONS = Object.freeze({
  [STATES.discovered]: new Set([STATES.awaitingConfirmation, STATES.failed]),
  [STATES.awaitingConfirmation]: new Set([STATES.downloading, STATES.failed]),
  [STATES.downloading]: new Set([STATES.verified, STATES.failed]),
  [STATES.verified]: new Set([STATES.backupCreated, STATES.failed]),
  [STATES.backupCreated]: new Set([STATES.staged, STATES.failed]),
  [STATES.staged]: new Set([STATES.restarting, STATES.failed]),
  [STATES.restarting]: new Set([STATES.healthCheck, STATES.failed]),
  [STATES.healthCheck]: new Set([STATES.committed, STATES.failed]),
  [STATES.failed]: new Set([STATES.rolledBack]),
  [STATES.committed]: new Set(),
  [STATES.rolledBack]: new Set()
});

const TERMINAL = new Set([STATES.committed, STATES.rolledBack]);
const HEX512 = /^[0-9A-F]{128}$/;
const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/;

function fail(code) {
  const error = new Error('journal rejected: ' + code);
  error.code = code;
  throw error;
}

function validateMarker(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) fail('marker-not-object');
  const allowed = new Set(['schema', 'operationId', 'version', 'channel', 'artifactSha512', 'state', 'updatedAt', 'sequence', 'errorCode']);
  for (const key of Object.keys(marker)) if (!allowed.has(key)) fail('marker-unknown-field');
  if (marker.schema !== 1 || !SAFE_ID.test(String(marker.operationId || ''))) fail('marker-bad-header');
  if (!/^\d+\.\d+\.\d+$/.test(String(marker.version || ''))) fail('marker-bad-version');
  if (!['stable', 'beta'].includes(marker.channel)) fail('marker-bad-channel');
  if (!HEX512.test(String(marker.artifactSha512 || '').toUpperCase())) fail('marker-bad-hash');
  if (!Object.values(STATES).includes(marker.state)) fail('marker-bad-state');
  if (!Number.isFinite(marker.updatedAt) || !Number.isInteger(marker.sequence) || marker.sequence < 0) fail('marker-bad-sequence');
  if (marker.errorCode !== null && marker.errorCode !== undefined && !SAFE_ID.test(String(marker.errorCode))) fail('marker-bad-error');
  const serialized = JSON.stringify(marker);
  if (/[A-Za-z]:[\\/]|Bearer\s|api[_-]?key|private\s*key|clinical|transcript|token/i.test(serialized)) fail('marker-sensitive-content');
  return true;
}

function makeMarker({ operationId, version, channel, artifactSha512, state, sequence, errorCode = null }) {
  const marker = { schema: 1, operationId, version, channel, artifactSha512, state, updatedAt: Date.now(), sequence, errorCode };
  validateMarker(marker);
  return marker;
}

function readMarker(filePath) {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') fail('marker-missing');
    fail('marker-corrupt');
  }
  validateMarker(marker);
  return marker;
}

function writeMarker(filePath, next) {
  validateMarker(next);
  let previous = null;
  if (fs.existsSync(filePath)) previous = readMarker(filePath);
  if (previous) {
    if (previous.operationId !== next.operationId) fail('operation-conflict');
    if (previous.channel !== next.channel) fail('cross-channel');
    if (next.sequence <= previous.sequence) fail(next.sequence === previous.sequence ? 'duplicate-operation' : 'stale-sequence');
    if (TERMINAL.has(previous.state)) fail('terminal-retreat');
    if (!TRANSITIONS[previous.state] || !TRANSITIONS[previous.state].has(next.state)) fail('illegal-transition');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(next), 'utf8');
  const descriptor = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  return next;
}

function recover(filePath, expectedChannel) {
  const marker = readMarker(filePath);
  if (expectedChannel && marker.channel !== expectedChannel) fail('recover-cross-channel');
  if (!TERMINAL.has(marker.state)) fail('recover-pending');
  return marker;
}

module.exports = { STATES, TRANSITIONS, TERMINAL, makeMarker, validateMarker, readMarker, writeMarker, recover };
