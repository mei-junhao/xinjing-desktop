'use strict';
/**
 * pi-protocol-v1.js — Pi Workbench 协议常量与校验（contract-v510-pi-workbench-control-plane-v1）
 * 来源：pi-workbench-task-v1.md / pi-broker-boundary-v1.md / pi-workbench-architecture-decisions-v1.md（D1-D5）
 * 纯本地、零 IO、零凭据；未接入生产运行时。
 */
const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const MODES = Object.freeze(['observe', 'draft', 'commit', 'supervision']);
const SUPERVISOR_PHASES = Object.freeze(['INTAKE', 'CONTEXT_CHECK', 'PLAN', 'TOOL_LOOP', 'APPROVAL', 'COMMIT', 'VERIFY', 'RESPOND']);
const TASK_STATUSES = Object.freeze(['queued', 'planning', 'awaiting_confirmation', 'executing', 'paused', 'succeeded', 'failed', 'cancelled']);
const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled']);
const EVENT_TYPES = Object.freeze([
  'task.created', 'phase.entered', 'plan.updated', 'tool.call.requested', 'tool.call.result',
  'approval.requested', 'approval.resolved', 'approval.timeout',
  'clinical.action.run', 'task.paused', 'task.resumed', 'task.committed', 'task.cancelled', 'task.failed', 'task.responded',
]);
const ERROR_CODES = Object.freeze([
  'XJ_PI_UNKNOWN_MODE', 'XJ_PI_UNKNOWN_STATUS', 'XJ_PI_UNKNOWN_EVENT', 'XJ_PI_UNKNOWN_TOOL', 'XJ_PI_UNKNOWN_FIELD',
  'XJ_PI_TASK_NOT_FOUND', 'XJ_PI_TASK_ID_REPLAY', 'XJ_PI_DUPLICATE_COMMIT', 'XJ_PI_WRITE_AFTER_CANCEL',
  'XJ_PI_CLIENT_SESSION_MISMATCH', 'XJ_PI_SNAPSHOT_MISMATCH', 'XJ_PI_APPROVAL_REQUIRED', 'XJ_PI_APPROVAL_REJECTED',
  'XJ_PI_MEMBERSHIP_UNKNOWN', 'XJ_PI_DIRECT_WRITE_DENIED', 'XJ_PI_LEGACY_TOOL_UNMAPPED', 'XJ_PI_EVENT_VERSION', 'XJ_PI_EVENT_SEQ', 'XJ_PI_VERIFY_FAILED',
]);

// 工具注册表（001 契约冻结集；shell/fs/net 不存在）
const TOOL_REGISTRY = Object.freeze({
  'read.client.summary': { broker: 'Read', risk: 'low', approval: false, argKeys: ['clientId'] },
  'read.session.notes': { broker: 'Read', risk: 'low', approval: false, argKeys: ['sessionId'] },
  'read.task.cards': { broker: 'Read', risk: 'low', approval: false, argKeys: [] },
  'clinical.draft.append': { broker: 'Clinical', risk: 'medium', approval: false, argKeys: ['draftText'] },
  'clinical.commit.record': { broker: 'Clinical', risk: 'high', approval: true, approvalScope: 'clinical.write', argKeys: ['kind', 'fields'] },
  'supervision.note.append': { broker: 'Supervision', risk: 'medium', approval: false, argKeys: ['noteText'] },
  'command.hash': { broker: 'Command', risk: 'low', approval: false, argKeys: ['value'] },
  'command.navigate': { broker: 'Command', risk: 'low', approval: false, argKeys: [] }, // D2：v1 无参
});

// AgentCore 兼容映射（裁决 D4：仅显式安全别名；未列出 → XJ_PI_LEGACY_TOOL_UNMAPPED，绝不回退旧 writer）
const LEGACY_TOOL_MAP = Object.freeze({
  'client.query': { tool: 'read.client.summary', note: 'D4：只读，必须绑定当前 ClinicalContext' },
  'session.query': { tool: 'read.session.notes', note: 'D4：只读，必须绑定当前 ClinicalContext' },
});

// 权限矩阵（001 冻结 + D5：free 档 clinical.commit.record 不叠加计费闸门）
const PERMISSION_MATRIX = Object.freeze({
  'read.client.summary': { free: true, pro: true, flagship: true },
  'read.session.notes': { free: true, pro: true, flagship: true },
  'read.task.cards': { free: true, pro: true, flagship: true },
  'clinical.draft.append': { free: true, pro: true, flagship: true },
  'clinical.commit.record': { free: true, pro: true, flagship: true },
  'supervision.note.append': { free: true, pro: true, flagship: true },
  'command.hash': { free: true, pro: true, flagship: true },
  'command.navigate': { free: true, pro: true, flagship: true },
});

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // D3：5 分钟

function fail(code, message) { return { ok: false, code, message: message || code }; }
function isFail(v) { return v && typeof v === 'object' && v.ok === false; }
function nsec(prefix) { return prefix + '_' + crypto.randomBytes(13).toString('hex'); }
function isSha256(v) { return typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v); }
function taskIdOk(v) { return typeof v === 'string' && /^xj_task_[A-Za-z0-9_-]{1,64}$/.test(v); }
function hasOnlyKeys(obj, allowed) {
  return Object.keys(obj).every((k) => allowed.indexOf(k) !== -1);
}

/** D1：snapshotHash 规范化输入（按 ClinicalContext 限定的投影；稳定键排序后 sha256:<64hex>） */
function computeSnapshotHash(projection) {
  if (!projection || typeof projection !== 'object') return null;
  const keys = ['clientId', 'sessionId', 'sourceRefs', 'storeProjectionVersion', 'membershipProjectionVersion'];
  if (!hasOnlyKeys(projection, keys)) return null;
  if (typeof projection.clientId !== 'string' || typeof projection.sessionId !== 'string') return null;
  if (!Number.isSafeInteger(projection.storeProjectionVersion) || !Number.isSafeInteger(projection.membershipProjectionVersion)) return null;
  if (!Array.isArray(projection.sourceRefs)) return null;
  for (const ref of projection.sourceRefs) {
    if (!ref || typeof ref !== 'object' || !hasOnlyKeys(ref, ['sourceId', 'sourceVersion', 'sourceContentHash', 'anchorContentHash'])) return null;
    if (typeof ref.sourceId !== 'string' || !Number.isSafeInteger(ref.sourceVersion)) return null;
  }
  const canonical = JSON.stringify(projection, Object.keys(projection).sort());
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  PROTOCOL_VERSION, MODES, SUPERVISOR_PHASES, TASK_STATUSES, TERMINAL_STATUSES, EVENT_TYPES, ERROR_CODES,
  TOOL_REGISTRY, LEGACY_TOOL_MAP, PERMISSION_MATRIX, APPROVAL_TIMEOUT_MS,
  fail, isFail, nsec, isSha256, taskIdOk, hasOnlyKeys, computeSnapshotHash,
};
