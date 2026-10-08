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
// 2026-09-14：事务已结束（concluded）的状态集合。failed 是回滚流程的中间态，
// 但 coordinator 已保证它必然被推进到 rolled-back；把 failed 一并视为「已结束」，
// 可让历史遗留的 failed 标记被新事务正常超越（自愈），而不是永久锁死更新功能。
const CONCLUDED = new Set([STATES.committed, STATES.rolledBack, STATES.failed]);
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
    // 2026-09-14（更新功能「一次失败/一次成功即永久失效」根因修复）：已结束的
    // 事务不得阻断新事务。原实现只要磁盘残留任何标记，新 operationId 一律
    // operation-conflict（committed 标记则 terminal-retreat），而 cleanupTransient
    // 明确「保留 marker」、全代码库无任何删除路径 —— 结果是更新器每台机器只能
    // 用一次，之后必须人工删文件。in-flight（崩溃中断）仍保持 fail-closed 语义。
    const concluded = CONCLUDED.has(previous.state);
    if (previous.operationId !== next.operationId) {
      if (!concluded) fail('operation-conflict');
    } else {
      if (previous.channel !== next.channel) fail('cross-channel');
      if (next.sequence <= previous.sequence) fail(next.sequence === previous.sequence ? 'duplicate-operation' : 'stale-sequence');
      if (TERMINAL.has(previous.state)) fail('terminal-retreat');
      if (!TRANSITIONS[previous.state] || !TRANSITIONS[previous.state].has(next.state)) fail('illegal-transition');
    }
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

module.exports = { STATES, TRANSITIONS, TERMINAL, CONCLUDED, makeMarker, validateMarker, readMarker, writeMarker, recover };
