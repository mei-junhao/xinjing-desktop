'use strict';

/**
 * 5.1.0 production bridge installation adapter.
 *
 * The Pi supervisor remains in the main process.  Renderer Store access is a
 * typed request/reply transport: the main process never evaluates renderer
 * JavaScript and the renderer never receives a raw ipcRenderer object.
 */
const path = require('path');
const P = require('../pi-protocol-v1.js');
const { createPiBridgeMain } = require('./pi-bridge-main-v1.js');
const { createProjectionAdapter } = require('./pi-bridge-projection-adapter-v1.js');
const { createDurableAdapter } = require('./pi-bridge-durable-adapter-v1.js');
const { createClinicalTransactionBridge } = require('../clinical/clinical-transaction-bridge.js');

const RENDERER_REQUEST_CHANNEL = 'xj:pi:renderer-request';
const RENDERER_REPLY_CHANNEL = 'xj:pi:renderer-reply';
const PUBLISH_STATE_CHANNEL = 'xj:pi:publish-state';
const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_ID_RE = /^pi_req_[A-Za-z0-9_-]{8,96}$/;
const CLINICAL_IPC_CHANNEL = 'xj-pi-clinical-v1:invoke';
const CLINICAL_METHODS = Object.freeze([
  'begin', 'draftAppend', 'commitRecord', 'approve', 'reject', 'commitDurable',
  'verify', 'pause', 'resume', 'cancel', 'status',
]);

function fail(code, message) { return P.fail(code, message); }

function cloneJson(value, maxBytes) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > maxBytes) return null;
    return JSON.parse(text);
  } catch (_) { return null; }
}

function stableKey(tool, args) {
  return String(tool || '') + '|' + JSON.stringify(args && typeof args === 'object' ? args : {});
}

function projectionShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['clientId', 'sessionId', 'sourceRefs', 'storeProjectionVersion', 'membershipProjectionVersion'];
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) return null;
  if (typeof value.clientId !== 'string' || !value.clientId.trim() || value.clientId.length > 256) return null;
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 256) return null;
  if (!Number.isSafeInteger(value.storeProjectionVersion) || value.storeProjectionVersion < 0) return null;
  if (!Number.isSafeInteger(value.membershipProjectionVersion) || value.membershipProjectionVersion < 0) return null;
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0) return null;
  const sourceRefs = [];
  for (const ref of value.sourceRefs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
    const refKeys = Object.keys(ref);
    const refAllowed = ['sourceId', 'sourceVersion', 'sourceContentHash', 'anchorContentHash'];
    if (refKeys.length !== refAllowed.length || refKeys.some((key) => !refAllowed.includes(key))) return null;
    if (typeof ref.sourceId !== 'string' || !ref.sourceId.trim() || ref.sourceId.length > 512) return null;
    if (!Number.isSafeInteger(ref.sourceVersion) || ref.sourceVersion < 0) return null;
    if (typeof ref.sourceContentHash !== 'string' || !ref.sourceContentHash.trim() || ref.sourceContentHash.length > 256) return null;
    if (typeof ref.anchorContentHash !== 'string' || !ref.anchorContentHash.trim() || ref.anchorContentHash.length > 256) return null;
    sourceRefs.push({
      sourceId: ref.sourceId,
      sourceVersion: ref.sourceVersion,
      sourceContentHash: ref.sourceContentHash,
      anchorContentHash: ref.anchorContentHash,
    });
  }
  const projection = {
    clientId: value.clientId,
    sessionId: value.sessionId,
    sourceRefs,
    storeProjectionVersion: value.storeProjectionVersion,
    membershipProjectionVersion: value.membershipProjectionVersion,
  };
  return P.computeSnapshotHash(projection) ? projection : null;
}

function projectionHash(value) {
  const shaped = projectionShape(value);
  return shaped ? P.computeSnapshotHash(shaped) : null;
}

function normalizePublishedReads(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  const tools = ['read.client.summary', 'read.session.notes', 'read.task.cards'];
  tools.forEach((tool) => {
    const rows = value[tool];
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return;
    const out = {};
    Object.keys(rows).slice(0, 200).forEach((key) => {
      const item = cloneJson(rows[key], 512 * 1024);
      if (item !== null) out[key] = item;
    });
    result[tool] = out;
  });
  return result;
}

/**
 * Create and install the production bridge.  The caller supplies the
 * account/membership projection and a trusted-renderer predicate; no secret
 * or remote credential is accepted by this module.
 */
function createPiProductionRuntime(options) {
  const opts = options || {};
  const ipcMain = opts.ipcMain;
  const getMainWindow = typeof opts.getMainWindow === 'function' ? opts.getMainWindow : () => null;
  const isTrustedRendererEvent = typeof opts.isTrustedRendererEvent === 'function'
    ? opts.isTrustedRendererEvent : () => false;
  const getMembership = typeof opts.serverMembershipProjection === 'function'
    ? opts.serverMembershipProjection : () => null;
  const userDataDir = String(opts.userDataDir || '');
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') throw new Error('ipcMain required');
  if (!path.isAbsolute(userDataDir)) throw new Error('userDataDir must be absolute');

  const state = { projection: null, activeContext: null, reads: {} };
  const pending = new Map();
  const durableReceipts = new Map();
  let requestCounter = 0;
  let stopped = false;

  function trustedMainWindowEvent(event) {
    if (!isTrustedRendererEvent(event)) return false;
    const win = getMainWindow();
    if (!win || !win.webContents || win.webContents.isDestroyed()) return false;
    return !!(event && event.sender && event.sender.id === win.webContents.id);
  }

  function nextRequestId() {
    requestCounter += 1;
    return 'pi_req_' + process.pid + '_' + Date.now().toString(36) + '_' + requestCounter.toString(36);
  }

  function requestRenderer(kind, payload, timeoutMs) {
    if (stopped) return Promise.resolve(fail('XJ_PI_EVENT_VERSION', 'bridge stopped'));
    const win = getMainWindow();
    if (!win || !win.webContents || win.webContents.isDestroyed()) return Promise.resolve(fail('XJ_PI_DIRECT_WRITE_DENIED', 'renderer unavailable'));
    const requestId = nextRequestId();
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(fail('XJ_PI_VERIFY_FAILED', 'renderer request timeout'));
      }, waitMs);
      pending.set(requestId, { resolve, timer });
      try {
        win.webContents.send(RENDERER_REQUEST_CHANNEL, { requestId, kind, payload });
      } catch (_) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(fail('XJ_PI_DIRECT_WRITE_DENIED', 'renderer request failed'));
      }
    });
  }

  function onRendererReply(event, message) {
    if (!trustedMainWindowEvent(event)) return;
    if (!message || typeof message !== 'object' || !REQUEST_ID_RE.test(String(message.requestId || ''))) return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    const response = cloneJson(message.response, 1024 * 1024);
    entry.resolve(response && typeof response === 'object' ? response : fail('XJ_PI_VERIFY_FAILED', 'renderer response invalid'));
  }

  function onPublishedState(event, message) {
    if (!trustedMainWindowEvent(event)) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      state.projection = null;
      state.activeContext = null;
      state.reads = {};
      return;
    }
    const projection = projectionShape(message.projection);
    if (!projection) {
      // A malformed publication must not leave a previous context writable.
      state.projection = null;
      state.activeContext = null;
      state.reads = {};
      return;
    }
    state.projection = projection;
    state.activeContext = null;
    state.reads = normalizePublishedReads(message.reads);
  }

  ipcMain.on(RENDERER_REPLY_CHANNEL, onRendererReply);
  ipcMain.on(PUBLISH_STATE_CHANNEL, onPublishedState);

  const projectionAdapter = createProjectionAdapter({
    readSourceRefs: () => state.projection ? state.projection.sourceRefs : [],
    readStoreVersion: () => state.projection ? state.projection.storeProjectionVersion : -1,
    readMembershipVersion: () => state.projection ? state.projection.membershipProjectionVersion : -1,
  });

  const durableAdapter = createDurableAdapter({
    saveRecord: async (record) => {
      const response = await requestRenderer('durable-write', record);
      if (!response || response.ok !== true) return response || fail('XJ_PI_DIRECT_WRITE_DENIED');
      const savedObjectId = String(response.savedObjectId || '');
      const version = Number(response.version);
      const object = cloneJson(response.object, 512 * 1024);
      if (!savedObjectId || !Number.isSafeInteger(version) || !object) return fail('XJ_PI_VERIFY_FAILED', 'durable receipt invalid');
      durableReceipts.set(savedObjectId, { object, version, snapshotHash: String(record.snapshotHash || '') });
      return { ok: true, savedObjectId, version };
    },
    readRecord: (savedObjectId) => {
      const receipt = durableReceipts.get(String(savedObjectId || ''));
      if (!receipt) return fail('XJ_PI_VERIFY_FAILED', 'durable receipt unavailable');
      return { ok: true, object: receipt.object };
    },
    audit: (entry) => {
      if (opts.audit && typeof opts.audit === 'function') {
        try { opts.audit({ phase: entry && entry.phase, ok: entry && entry.ok, code: entry && entry.code }); } catch (_) {}
      }
    },
  });

  const clinicalKinds = new Map();
  function normalizeClinicalRefs(refs) {
    return Array.isArray(refs) ? refs.map((ref) => ({
      sourceId: String(ref && ref.sourceId || ''),
      sourceVersion: String(ref && ref.sourceVersion || ''),
      sourceContentHash: String(ref && ref.sourceContentHash || ''),
      anchorContentHash: String(ref && ref.anchorContentHash || ''),
    })) : [];
  }
  function clinicalContextGuard(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('XJ_PI_INVALID_CONTEXT', 'clinical context required');
    const projection = state.projection;
    if (!projection) return fail('XJ_PI_SNAPSHOT_MISMATCH', 'clinical projection unavailable');
    const clientId = String(input.clientId || '');
    const sessionId = String(input.sessionId || '');
    if (!clientId || !sessionId || clientId !== projection.clientId || sessionId !== projection.sessionId) return fail('XJ_PI_CLIENT_SESSION_MISMATCH', 'clinical context does not match live projection');
    const expectedSnapshot = P.computeSnapshotHash(projection);
    if (!expectedSnapshot || String(input.snapshotHash || '') !== expectedSnapshot) return fail('XJ_PI_SNAPSHOT_MISMATCH', 'clinical snapshot drift');
    const refs = normalizeClinicalRefs(input.sourceRefs);
    const liveRefs = normalizeClinicalRefs(projection.sourceRefs);
    if (JSON.stringify(refs) !== JSON.stringify(liveRefs) || !refs.length) return fail('XJ_PI_SNAPSHOT_MISMATCH', 'clinical source refs drift');
    const generation = String(input.generationEntitlement || 'manual');
    const membership = getMembership();
    if (generation !== 'manual') {
      if (!membership || !membership.tier) return fail('XJ_PI_MEMBERSHIP_UNKNOWN', 'server membership projection unavailable');
      if (generation === 'paid' && String(membership.tier).toLowerCase() === 'free') return fail('XJ_PI_MEMBERSHIP_UNKNOWN', 'paid clinical generation requires membership');
    }
    return null;
  }
  const clinicalDurableAdapter = {
    durableWrite: async (record) => {
      const payload = Object.assign({}, record, { kind: clinicalKinds.get(String(record && record.clinicalActionRunId || '')) || 'session' });
      return requestRenderer('durable-write', payload);
    },
    durableRead: async (savedObjectId, expected) => requestRenderer('durable-read', { savedObjectId: String(savedObjectId || ''), expected: cloneJson(expected, 512 * 1024) || null }),
  };
  const clinicalBridge = createClinicalTransactionBridge({
    sessionBelongsToClient: (clientId, sessionId) => !!state.projection && state.projection.clientId === String(clientId) && state.projection.sessionId === String(sessionId),
    sourceBelongsToClient: (ref, clientId, sessionId) => {
      if (!state.projection || state.projection.clientId !== String(clientId) || state.projection.sessionId !== String(sessionId)) return false;
      return normalizeClinicalRefs(state.projection.sourceRefs).some((live) => JSON.stringify(live) === JSON.stringify(normalizeClinicalRefs([ref])[0]));
    },
    durableWrite: clinicalDurableAdapter.durableWrite,
    durableRead: clinicalDurableAdapter.durableRead,
  });
  const clinicalApi = {
    begin(input) {
      const guard = clinicalContextGuard(input);
      if (guard) return guard;
      const result = clinicalBridge.begin(input);
      if (result && result.ok === true) clinicalKinds.set(String(result.clinicalActionRunId), String(input.kind || 'session'));
      return result;
    },
    draftAppend(runId, entry) { return clinicalBridge.draft.append(runId, entry); },
    commitRecord(runId) { return clinicalBridge.commit.record(runId); },
    approve(runId) { return clinicalBridge.approval.approve(runId); },
    reject(runId) { return clinicalBridge.approval.reject(runId); },
    async commitDurable(runId) { return clinicalBridge.commit.durableAsync(runId); },
    async verify(savedObjectId, expected) { return clinicalBridge.verifyAsync(savedObjectId, expected); },
    pause(runId, reason) { return clinicalBridge.pause(runId, reason); },
    resume(runId) { return clinicalBridge.resume(runId); },
    cancel(runId) { return clinicalBridge.cancel(runId); },
    status(runId) { return clinicalBridge.status(runId); },
  };

  const bridge = createPiBridgeMain({
    serverMembershipProjection: getMembership,
    readProjector: (tool, args) => {
      const rows = state.reads[tool];
      if (!rows) return fail('XJ_PI_SNAPSHOT_MISMATCH', 'renderer read projection unavailable');
      const key = JSON.stringify(args && typeof args === 'object' ? args : {});
      if (!Object.prototype.hasOwnProperty.call(rows, key)) return fail('XJ_PI_SNAPSHOT_MISMATCH', 'renderer read projection unavailable');
      return { ok: true, data: cloneJson(rows[key], 512 * 1024) };
    },
    liveProjection: () => {
      const ctx = state.activeContext;
      return ctx ? projectionAdapter.project(ctx.clientId, ctx.sessionId) : null;
    },
    durableWrite: durableAdapter.durableWrite,
    durableRead: durableAdapter.durableRead,
    eventFile: path.join(userDataDir, 'pi-events-v1.jsonl'),
    timeoutScanIntervalMs: 15000,
  });

  const originalStartTask = bridge.api.startTask;
  bridge.api.startTask = function startTaskWithContext(input) {
    const requested = projectionShape(input && input.projection);
    const published = state.projection;
    if (!requested || !published) return fail('XJ_PI_SNAPSHOT_MISMATCH', 'published projection required');
    const requestedHash = projectionHash(requested);
    const publishedHash = projectionHash(published);
    if (!requestedHash || !publishedHash || requestedHash !== publishedHash) {
      state.activeContext = null;
      return fail('XJ_PI_SNAPSHOT_MISMATCH', 'request projection differs from published projection');
    }
    state.activeContext = { clientId: published.clientId, sessionId: published.sessionId };
    const trustedInput = Object.assign({}, input, { projection: cloneJson(published, 64 * 1024) });
    return originalStartTask(trustedInput);
  };

  const originalRunToolStep = bridge.api.runToolStep;
  bridge.api.runToolStep = function runToolStepWithProductionGuards(taskId, step) {
    if (step && step.tool === 'supervision.note.append' && (!state.projection || state.projection.sourceRefs.length === 0)) {
      return fail('XJ_PI_SNAPSHOT_MISMATCH', 'supervision materials/sourceRefs required');
    }
    return originalRunToolStep.apply(null, arguments);
  };

  const replay = bridge.api.replayEvents();
  if (!replay || replay.ok !== true) {
    const failReplay = () => fail('XJ_PI_EVENT_VERSION', 'event replay failed; bridge is unavailable');
    Object.keys(bridge.api).forEach((method) => {
      if (typeof bridge.api[method] === 'function') bridge.api[method] = failReplay;
    });
    Object.keys(clinicalApi).forEach((method) => {
      if (typeof clinicalApi[method] === 'function') clinicalApi[method] = failReplay;
    });
  }

  // A proxy injects the production sender check without weakening the frozen
  // bridge module's test-oriented API.
  const guardedIpc = {
    handle(channel, handler) {
      return ipcMain.handle(channel, async (event, payload) => {
        if (!trustedMainWindowEvent(event)) return fail('XJ_PI_UNKNOWN_EVENT', 'untrusted sender');
        return handler(event, payload);
      });
    },
  };
  bridge.registerIpc(guardedIpc, 'xj-pi-v1');

  const clinicalIpcHandler = async (event, payload) => {
    if (!trustedMainWindowEvent(event)) return fail('XJ_PI_UNKNOWN_EVENT', 'untrusted sender');
    const method = payload && payload.method;
    if (!CLINICAL_METHODS.includes(method) || typeof clinicalApi[method] !== 'function') return fail('XJ_PI_UNKNOWN_EVENT', 'unknown clinical method');
    try { return await clinicalApi[method](...((payload && Array.isArray(payload.args)) ? payload.args : [])); }
    catch (_) { return fail('XJ_PI_UNKNOWN_EVENT', 'clinical method threw'); }
  };
  ipcMain.handle(CLINICAL_IPC_CHANNEL, clinicalIpcHandler);

  function stop() {
    if (stopped) return;
    stopped = true;
    pending.forEach((entry) => { clearTimeout(entry.timer); entry.resolve(fail('XJ_PI_EVENT_VERSION', 'bridge stopped')); });
    pending.clear();
    bridge.stop();
    clinicalKinds.clear();
    try { if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(CLINICAL_IPC_CHANNEL); } catch (_) {}
    try { ipcMain.removeListener(RENDERER_REPLY_CHANNEL, onRendererReply); } catch (_) {}
    try { ipcMain.removeListener(PUBLISH_STATE_CHANNEL, onPublishedState); } catch (_) {}
  }

  return Object.freeze({
    bridge,
    replay,
    publishState: onPublishedState,
    requestRenderer,
    stop,
    clinical: Object.freeze({ api: clinicalApi, bridge: clinicalBridge }),
    channels: Object.freeze({ RENDERER_REQUEST_CHANNEL, RENDERER_REPLY_CHANNEL, PUBLISH_STATE_CHANNEL, CLINICAL_IPC_CHANNEL }),
  });
}

module.exports = { createPiProductionRuntime, RENDERER_REQUEST_CHANNEL, RENDERER_REPLY_CHANNEL, PUBLISH_STATE_CHANNEL, CLINICAL_IPC_CHANNEL, CLINICAL_METHODS };
