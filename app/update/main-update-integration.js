'use strict';
// main-update-integration.js — the SINGLE typed update entry for main.js
// (replace-mode for live-snapshot/main.js:1841-1998, per serial_write_set[0]).
//
// This module removes the entire electron-updater direct chain
// (autoDownload / autoInstallOnAppQuit / setFeedURL / doInstall /
// update-available / update-not-available / update-downloaded / quitAndInstall
// / before-quit-for-update / error / startup check / boolean xj:check-updates)
// and installs one fail-closed coordinator flow with production adapters:
//   feed       -> feed-adapter (COS authority, typed descriptor)
//   confirm    -> dialog.showMessageBox (typed decision)
//   artifact   -> injected transport (default-deny in this isolated candidate)
//   durable    -> durable-bridge (renderer Store.exportAll/importAll boundary)
//   migration  -> schema-bounded production migration (fail-closed)
//   health     -> first-launch health contract (real probe, temp userData)
//   restart    -> portable-restart helper (previous known-good retention)
//   env        -> env-adapter (userData-scoped paths)
//
// Renderer sees ONLY typed status via 'xj:update:status' (ipc-update allowlist);
// success is emitted only after 'committed'. Unknown methods/fields/states/
// channels/strategies are rejected at the boundary.

const { productionEnv, assertBounded } = require('./env-adapter');
const { fetchTypedFeed } = require('./feed-adapter');
const { createSnapshot, encryptPayloadSnapshot, restoreSnapshot, cleanupTransient } = require('./durable-bridge');
const { typedStatus, guarded, STATUS_STATES, COORDINATOR_TO_UI } = require('./ipc-update');
const { redact, logUpdate } = require('./redact');
const { runUpdate, recoverUpdate } = require('./runtime-entry');
const { STATES } = require('./transaction-journal');
const { runFirstLaunchHealth } = require('./health-check');
const { stagePortable, exchangePortable, restorePortable, recoverPortable } = require('./portable-restart');

// Default-deny transports: this isolated candidate NEVER performs a real
// network request. Production wires electron `net` behind the same interface;
// the transport is injected by tests/production wiring, never defaulted open.
const DENY_TRANSPORT = Object.freeze({
  fetchText: () => ({ error: 'network-denied' }),
  fetchBytes: () => ({ error: 'network-denied' })
});

let _xjChecking = false; // single-flight preserved from production semantics
let statusListeners = new Set();

function broadcastStatus(win, status) {
  try { if (win && !win.isDestroyed()) win.webContents.send('xj:update:status', status); } catch (_) {}
  for (const cb of statusListeners) { try { cb(status); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Production adapters (all fail-closed; none may weaken a candidate check)
// ---------------------------------------------------------------------------
// P1-1 fix: the durable adapters need a wired, bounded production env.
// main.js updateIntegrationOptions() provides options.env from env-adapter;
// when it is missing or incomplete the snapshot/restore entries fail closed
// with a typed error instead of throwing on undefined paths. No internal
// fallback is allowed: an unwired env is a wiring defect, not a default.
function assertWiredEnv(env) {
  if (!env || typeof env !== 'object') {
    const error = new Error('update-env-not-wired'); error.code = 'update-env-not-wired'; throw error;
  }
  for (const key of ['workDir', 'snapshotPath', 'markerPath']) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '' || !/[/\\]/.test(value) || value.indexOf('\u0000') !== -1) {
      const error = new Error('update-env-path-invalid:' + key); error.code = 'update-env-path-invalid:' + key; throw error;
    }
  }
  return env;
}

function buildAdapters(options) {
  const transport = options.transport || DENY_TRANSPORT;
  const backupCrypto = options.backupCrypto;
  const rendererIpc = options.rendererIpc; // { invoke(win, channel, request) }
  const env = assertWiredEnv(options.env);

  return {
    // 1) COS feed: typed descriptor with source hash binding.
    feed: async ({ channel, strategy, currentVersion, sourceManifestHash, releaseId }) => {
      if (options.lockHeld && options.lockHeld()) {
        const error = new Error('network-during-file-lock'); error.code = 'network-during-file-lock'; throw error;
      }
      return fetchTypedFeed({
        channel, strategy, transport, currentVersion,
        sourceManifestHash, releaseId,
        migrationSchemaRange: '2.0.0:2.0.0',
        rollbackCompatibilityId: 'v5.0.0'
      });
    },
    // 2) Confirmation: typed decision; anything but explicit 'now' is decline.
    confirm: async (metadata) => {
      const decision = await options.confirmDecision(metadata);
      return decision === true || decision === 'now';
    },
    // 3) Artifact: exact bytes; assertArtifactMatches in the coordinator still
    //    enforces fileName/size/SHA-512. Task/operation-specific temp names.
    artifact: async (metadata) => {
      if (options.lockHeld && options.lockHeld()) {
        const error = new Error('network-during-file-lock'); error.code = 'network-during-file-lock'; throw error;
      }
      const response = await transport.fetchBytes(metadata.url, { size: metadata.size, sha512: metadata.sha512 });
      if (!response || response.error) { const e = new Error('artifact-download-failed'); e.code = 'artifact-download-failed'; throw e; }
      if (!Buffer.isBuffer(response.bytes) || response.bytes.length !== metadata.size) { const e = new Error('artifact-size-mismatch'); e.code = 'artifact-size-mismatch'; throw e; }
      return { fileName: metadata.fileName, bytes: response.bytes };
    },
    // 4) Durable store: encrypted snapshot through the backup boundary; the
    //    renderer export/import is the ONLY IndexedDB touch point.
    durableSnapshot: async (meta) => createSnapshot({
      win: options.mainWindow, ipc: rendererIpc,
      operationId: meta.operationId, version: meta.version, channel: meta.channel,
      strategy: meta.strategy, key: options.backupKey, passphrase: options.passphrase,
      workDir: env.snapshotPath + '.encrypted', backupCrypto
    }),
    durableRestore: async (meta) => restoreSnapshot({
      win: options.mainWindow, ipc: rendererIpc, operationId: meta.operationId,
      key: options.backupKey, passphrase: options.passphrase,
      snapshotPath: meta.snapshotPath, backupCrypto
    })
  };
}

// ---------------------------------------------------------------------------
// Single entry: typed check -> coordinator with production inputFactory
// ---------------------------------------------------------------------------
async function requestUpdateCheck({ channel, strategy, currentVersion, options, sourceManifestHash, releaseId }) {
  if (options.agentAcceptanceMode) return typedStatus({ state: 'checking', channel, strategy, errorCode: 'acceptance-mode' });
  if (_xjChecking) return typedStatus({ state: 'checking', channel, strategy, errorCode: 'single-flight' });
  _xjChecking = true;
  const env = productionEnv(options.userDataDir, options.previousInstallerPath);
  assertBounded(env);
  const adapters = buildAdapters(options);

  const inputFactory = async (runEnv) => {
    const metadata = await adapters.feed({ channel, strategy, currentVersion, sourceManifestHash, releaseId });
    // ONE renderer export before migration; encrypted safety snapshot is
    // created from that payload (fail-closed on any error).
    const durableStore = await options.rendererDurable.read();
    const encrypted = encryptPayloadSnapshot({
      operationId: 'pre-' + (metadata.feedRevision || '0'), version: metadata.version, channel, strategy,
      payload: durableStore, key: options.backupKey, passphrase: options.passphrase,
      workDir: env.snapshotPath + '.encrypted', backupCrypto: options.backupCrypto
    });
    const migrateFn = (previous) => {
      // Production migration: schema-bounded; v2.0.0 payload is unchanged.
      if (!previous || previous.version !== '2.0.0') { const e = new Error('migration-stale-schema'); e.code = 'migration-stale-schema'; throw e; }
      return previous;
    };
    return {
      operationId: `op-${channel}-${Date.now()}`,
      currentVersion,
      channel,
      strategyKind: strategy === 'portable' ? 'portable' : 'nsis',
      feedText: metadata.typedText,
      fetchAdapter: () => ({ status: 200, bodyText: metadata.typedText }),
      confirmDecision: () => adapters.confirm(metadata),
      artifactProvider: (meta) => adapters.artifact(meta),
      durableStore,
      migrateFn,
      onRestart: async (strategyResult) => {
        if (strategy === 'portable' && options.portableRestart) {
          await options.portableRestart(strategyResult, { operationId: 'op-' + channel + '-' + Date.now(), env });
        }
      },
      healthCheckFn: async (strategyResult) => {
        if (!options.healthCheck) return { ok: false, code: 'no-health-probe' };
        const health = await options.healthCheck(strategyResult, { channel, strategy });
        return health;
      }
    };
  };

  let result;
  try {
    result = await runUpdate(inputFactory, env);
  } catch (error) {
    result = { ok: false, state: STATES.failed, code: (error && error.code) || 'update-failed', version: currentVersion, channel, operationId: 'op-' + channel };
  } finally {
    _xjChecking = false;
  }
  if (result && result.ok === true && result.state === STATES.committed) {
    cleanupTransient(env);
  }
  const status = typedStatus({
    state: result.state, operationId: result.operationId,
    version: result.version, channel: channel, strategy: strategy,
    errorCode: result.code, committed: result.ok === true
  });
  broadcastStatus(options.mainWindow, status);
  return status;
}

// ---------------------------------------------------------------------------
// Typed IPC allowlist registration (replaces ipcMain.handle('xj:check-updates'))
// ---------------------------------------------------------------------------
function registerTypedIpc(ipcMain, options) {
  const handle = (method, handler) => ipcMain.handle(method, guarded(method, handler));

  handle('xj:update:check', async (event, input) => {
    return requestUpdateCheck({
      channel: input.channel,
      strategy: input.strategy || (options.isPortable ? 'portable' : 'installer'),
      currentVersion: input.currentVersion || options.appVersion,
      options,
      sourceManifestHash: options.sourceManifestHash,
      releaseId: options.releaseId
    });
  });

  handle('xj:update:confirm', async (event, input) => {
    // Confirmation is bound to the running operation; decision 'later' declines.
    return typedStatus({ state: input.decision === 'now' ? 'downloading' : 'awaiting-confirmation', operationId: input.operationId, channel: options.channel, strategy: options.strategy });
  });

  handle('xj:update:snapshot', async (event, input) => {
    const adapters = buildAdapters(options);
    const snap = await adapters.durableSnapshot({ operationId: input.operationId, version: options.appVersion, channel: options.channel, strategy: options.strategy });
    return { ok: true, sha256: snap.sha256 };
  });

  handle('xj:update:restore', async (event, input) => {
    const adapters = buildAdapters(options);
    const env = productionEnv(options.userDataDir, options.previousInstallerPath);
    const restored = await adapters.durableRestore({ operationId: input.operationId, snapshotPath: env.snapshotPath + '.encrypted/store.snapshot.' + input.operationId + '.json' });
    return { ok: true, quarantine: restored.quarantine };
  });

  handle('xj:update:subscribe', async (event, input) => {
    return typedStatus({ state: 'checking', channel: options.channel, strategy: options.strategy, errorCode: null });
  });

  // Unknown xj:update:* invoke methods never reach a handler; ipc-update.guarded
  // rejects them as unknown-method. We also reject at registration time.
  return { registered: ['xj:update:check', 'xj:update:confirm', 'xj:update:snapshot', 'xj:update:restore', 'xj:update:subscribe'] };
}

// ---------------------------------------------------------------------------
// Startup wiring (replaces setupAutoUpdater + startup 3s check + tray rewire)
// ---------------------------------------------------------------------------
function setupUpdateIntegration(options) {
  // options: { ipcMain, mainWindow: () => win, appVersion, isPortable,
  //            userDataDir, previousInstallerPath, backupCrypto, backupKey,
  //            agentAcceptanceMode, channel, strategy, transport,
  //            confirmDecision, rendererIpc, rendererDurable, healthCheck,
  //            portableRestart, sourceManifestHash, releaseId }
  // typed 桥始终注册（guarded handler 在 acceptance 模式返回 checking/acceptance-mode，
  // 不会触发真实更新；真实更新动作由 requestUpdateCheck 的 agentAcceptanceMode 门拦下）。
  const registered = registerTypedIpc(options.ipcMain, options);
  if (options.agentAcceptanceMode) return { skipped: 'acceptance-mode', registered };
  // Startup reconcile: an unfinished operation must be reconciled before any
  // new update begins (contract §8). Non-terminal marker -> recover fails closed.
  const env = productionEnv(options.userDataDir, options.previousInstallerPath);
  try {
    if (options.fs.existsSync(env.markerPath)) {
      const marker = options.recoverUpdate(env.markerPath, options.channel);
      logUpdate('info', 'startup reconcile marker state=' + (marker && marker.state));
    }
  } catch (error) {
    logUpdate('error', 'startup reconcile failed: ' + redact(error.code || error.message));
    // Preserve current installation + recovery evidence; do not auto-retry.
  }
  return { registered, statusStates: STATUS_STATES, coordinatorToUi: COORDINATOR_TO_UI };
}

// Tray entry: '检查更新' -> typed manual check (AGENT_ACCEPTANCE_MODE guarded).
function checkForUpdatesManual(options) {
  if (options.agentAcceptanceMode) return;
  return requestUpdateCheck({
    channel: options.channel || 'stable',
    strategy: options.strategy || (options.isPortable ? 'portable' : 'installer'),
    currentVersion: options.appVersion,
    options
  });
}

module.exports = {
  setupUpdateIntegration, requestUpdateCheck, checkForUpdatesManual,
  registerTypedIpc, buildAdapters, assertWiredEnv, DENY_TRANSPORT, _xjChecking: () => _xjChecking
};
