'use strict';
// ipc-update.js — typed update IPC allowlist (decision 2.5 / contract §12).
// Replaces the boolean-only `xj:check-updates` bridge. Every method has a
// typed request/result schema; unknown methods, fields, states, channels and
// strategies are rejected at the boundary. Renderer responses never expose
// updater objects, filesystem paths, signing material, shell access or
// unrestricted network access.

const { redact, safeErrorCode } = require('./redact');

const CHANNELS = Object.freeze(['stable', 'beta']);
const STRATEGIES = Object.freeze(['installer', 'portable']);
// Contract §2.5 / §5 UI states the renderer may observe.
const STATUS_STATES = Object.freeze([
  'checking', 'available', 'awaiting-confirmation', 'downloading', 'verified',
  'restarting', 'health-check', 'committed', 'failed', 'rollback-pending',
  'rolling-back', 'rolled-back'
]);
// Internal coordinator states (transaction-journal) mapped to UI states.
const COORDINATOR_TO_UI = Object.freeze({
  discovered: 'checking',
  'awaiting-confirmation': 'awaiting-confirmation',
  downloading: 'downloading',
  verified: 'verified',
  'backup-created': 'verified',
  staged: 'verified',
  restarting: 'restarting',
  'health-check': 'health-check',
  committed: 'committed',
  failed: 'failed',
  'rolled-back': 'rolled-back'
});

function fail(code) {
  const error = new Error('ipc-update rejected: ' + code);
  error.code = code;
  throw error;
}

const REQUEST_SCHEMAS = Object.freeze({
  'xj:update:check': { fields: { channel: 'string', strategy: 'string', currentVersion: 'string' }, required: ['channel'] },
  'xj:update:confirm': { fields: { operationId: 'string', decision: 'string' }, required: ['operationId', 'decision'] },
  'xj:update:snapshot': { fields: { operationId: 'string' }, required: ['operationId'] },
  'xj:update:restore': { fields: { operationId: 'string' }, required: ['operationId'] },
  'xj:update:subscribe': { fields: {}, required: [] }
});
const ALLOWED_METHODS = Object.freeze(Object.keys(REQUEST_SCHEMAS));

function validateChannel(value) {
  if (!CHANNELS.includes(value)) fail('unknown-channel:' + String(value));
}
function validateStrategy(value) {
  if (!STRATEGIES.includes(value)) fail('unknown-strategy:' + String(value));
}
function validateState(value) {
  if (!STATUS_STATES.includes(value)) fail('unknown-state:' + String(value));
}
function validateOperationId(value) {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(String(value || ''))) fail('bad-operationId');
}

// Validate an incoming invoke request against its typed schema.
function validateRequest(method, payload) {
  if (!ALLOWED_METHODS.includes(method)) fail('unknown-method:' + String(method));
  const schema = REQUEST_SCHEMAS[method];
  const input = payload && typeof payload === 'object' ? payload : {};
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema.fields, key)) fail('unknown-field:' + key);
  }
  for (const key of schema.required) {
    if (input[key] === undefined) fail('missing-field:' + key);
    const type = schema.fields[key];
    if (type === 'string' && typeof input[key] !== 'string') fail('bad-field-type:' + key);
  }
  if (input.channel !== undefined) validateChannel(input.channel);
  if (input.strategy !== undefined) validateStrategy(input.strategy);
  if (input.operationId !== undefined) validateOperationId(input.operationId);
  if (input.decision !== undefined && input.decision !== 'now' && input.decision !== 'later') fail('bad-decision');
  return input;
}

// Build a bounded, typed status object for the renderer.
function typedStatus({ state, operationId = null, version = null, channel = null, strategy = null, progress = null, errorCode = null, committed = false }) {
  const uiState = COORDINATOR_TO_UI[state] || (STATUS_STATES.includes(state) ? state : null);
  if (!uiState) fail('unknown-state:' + String(state));
  const terminalFail = uiState === 'failed' || uiState === 'rolled-back';
  const code = errorCode ? String(errorCode).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) : null;
  return {
    ok: !terminalFail,
    state: uiState,
    committed: committed === true || uiState === 'committed',
    operationId: operationId ? String(operationId).slice(0, 80) : null,
    version: version ? String(version).slice(0, 32) : null,
    channel: channel || null,
    strategy: strategy || null,
    progress: progress == null ? null : Math.max(0, Math.min(100, Number(progress))),
    errorCode: code,
    // Renderer never receives paths, updater objects, signing material or raw errors.
    note: uiState === 'committed' ? '更新已完成' : null
  };
}

// Wrap a handler so thrown errors become typed failures and are redacted.
function guarded(method, handler) {
  return async (event, payload) => {
    try {
      const input = validateRequest(method, payload);
      return await handler(event, input);
    } catch (error) {
      const code = safeErrorCode(error);
      return { ok: false, state: 'failed', errorCode: code, detail: redact(String((error && error.message) || error)) };
    }
  };
}

module.exports = {
  CHANNELS, STRATEGIES, STATUS_STATES, ALLOWED_METHODS, REQUEST_SCHEMAS,
  COORDINATOR_TO_UI, validateRequest, validateChannel, validateStrategy,
  validateState, typedStatus, guarded, redact
};
