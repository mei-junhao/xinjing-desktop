'use strict';
// production-adapters.js — REAL Electron-backed update-integrity adapters
// (fix for Codex intake P0-3/P0-4). main.js wires these into
// updateIntegrationOptions() so NO adapter is left null. Every adapter is
// fail-closed and bounded; none may weaken a candidate check. Acceptance mode
// forces default-deny network and never starts a real update.
//
// This module deliberately does NOT require('electron') at load time: all
// Electron APIs (net / dialog / ipcMain) are injected by main.js, so the
// production wiring is unit-testable in plain Node with injected fakes while
// remaining the real production path when main.js passes the real APIs.
//
// Adapters provided (contract decisions 2.1-2.5):
//   transport       -> real Electron `net` (bounded timeout + default-deny)
//   confirmDecision -> dialog.showMessageBox (typed now/later; close = later)
//   rendererIpc     -> main->renderer request/reply with operationId
//                      correlation, timeout, duplicate-reply rejection and
//                      window-destroy handling (no raw ipcRenderer is ever
//                      exposed to the page)
//   rendererDurable -> renderer Store.exportAll/importAll via rendererIpc
//   healthCheck     -> real first-launch health probe (temp userData,
//                      synthetic data, default-deny network)
//   portableRestart -> portable staging/exchange confirmation bound to the
//                      coordinator's staged executable
//   recoverUpdate   -> transaction-journal recovery bound to the marker file

const fs = require('fs');
const { runFirstLaunchHealth } = require('./health-check');
const { recover } = require('./transaction-journal');

// ---------------------------------------------------------------------------
// Real Electron net transport (decision 2.1). Default-deny: denyNetwork() true,
// missing net, timeout, or non-200 all fail closed. Single attempt; the
// coordinator owns feed-level retries. Never crosses to a fallback host.
// ---------------------------------------------------------------------------
function createNetTransport(net, options) {
  const timeoutMs = (options && options.timeoutMs) || 30000;
  const denyNetwork = (options && typeof options.denyNetwork === 'function') ? options.denyNetwork : () => false;

  async function fetchUrl(url, expectBytes) {
    if (!net || typeof net.fetch !== 'function') return { error: 'no-transport' };
    if (denyNetwork()) return { error: 'network-denied' };
    let timer = null;
    try {
      const responsePromise = net.fetch(url, { method: 'GET', redirect: 'follow' });
      const response = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('update-net-timeout'), { code: 'update-net-timeout' })), timeoutMs);
        responsePromise.then(resolve, reject);
      });
      clearTimeout(timer);
      if (!response || typeof response.status !== 'number') return { error: 'download-failed' };
      if (response.status !== 200) return { status: response.status };
      if (expectBytes) {
        const buf = Buffer.from(await response.arrayBuffer());
        return { status: 200, bytes: buf };
      }
      return { status: 200, bodyText: await response.text() };
    } catch (error) {
      if (timer) clearTimeout(timer);
      return { error: (error && error.code) || 'download-failed' };
    }
  }

  return {
    fetchText: (url) => fetchUrl(url, false),
    fetchBytes: (url) => fetchUrl(url, true)
  };
}

// ---------------------------------------------------------------------------
// Real confirmation adapter (dialog, decision 2.5). Only an explicit 'now'
// proceeds; any other response, cancel, or window close declines (the flow
// never enters downloading).
// ---------------------------------------------------------------------------
function createConfirmAdapter(dialog, getMainWindow) {
  return async (metadata) => {
    if (!dialog || typeof dialog.showMessageBox !== 'function') return 'later';
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    try {
      const { response } = await dialog.showMessageBox(win || null, {
        type: 'question',
        buttons: ['立即更新', '稍后'],
        defaultId: 1,
        cancelId: 1,
        title: '发现新版本',
        message: '发现新版本 v' + String((metadata && metadata.version) || '') + '，是否立即更新？',
        detail: '更新前会自动创建本地安全快照，失败可回滚到当前版本。'
      });
      return response === 0 ? 'now' : 'later';
    } catch (_) {
      return 'later';
    }
  };
}

// ---------------------------------------------------------------------------
// Real main<->renderer request/reply bridge for the durable snapshot boundary
// (decision 2.2). Correlates by operationId, enforces a timeout, rejects
// duplicate/mismatched replies, and fails closed when the target window is
// destroyed mid-flight. `ipcMain` is injected (real one from main.js).
// ---------------------------------------------------------------------------
function createRendererIpc(ipcMain, options) {
  const replyTimeoutMs = (options && options.replyTimeoutMs) || 60000;
  const getMainWindow = (options && options.getMainWindow) || (() => null);

  function invoke(win, channel, request) {
    return new Promise((resolve, reject) => {
      const target = win || getMainWindow();
      if (!target || (typeof target.isDestroyed === 'function' && target.isDestroyed())) {
        reject(Object.assign(new Error('renderer-window-unavailable'), { code: 'renderer-window-unavailable' }));
        return;
      }
      if (!ipcMain || typeof ipcMain.on !== 'function') {
        reject(Object.assign(new Error('renderer-no-ipcMain'), { code: 'renderer-no-ipcMain' }));
        return;
      }
      const requestChannel = channel + ':request';
      const replyChannel = channel + ':reply';
      const correlationId = String((request && request.operationId) || ('corr-' + Date.now()));
      let settled = false;
      const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('renderer-reply-timeout'), { code: 'renderer-reply-timeout' })); }, replyTimeoutMs);
      const replyHandler = (event, reply) => {
        if (settled) return; // ignore duplicate/late replies
        if (!event || !event.sender || target.webContents !== event.sender) return; // only the target window
        if (!reply || reply.operationId !== correlationId) return; // mismatched correlation
        cleanup();
        resolve(reply);
      };
      const destroyedHandler = () => { cleanup(); reject(Object.assign(new Error('renderer-window-destroyed'), { code: 'renderer-window-destroyed' })); };
      function cleanup() {
        settled = true;
        clearTimeout(timer);
        try { ipcMain.removeListener(replyChannel, replyHandler); } catch (_) {}
        try { if (target.webContents && typeof target.webContents.removeListener === 'function') target.webContents.removeListener('destroyed', destroyedHandler); } catch (_) {}
      }
      ipcMain.on(replyChannel, replyHandler);
      try { if (target.webContents && typeof target.webContents.once === 'function') target.webContents.once('destroyed', destroyedHandler); } catch (_) {}
      try { target.webContents.send(requestChannel, request); }
      catch (_) { cleanup(); reject(Object.assign(new Error('renderer-send-failed'), { code: 'renderer-send-failed' })); }
    });
  }

  return { invoke };
}

// ---------------------------------------------------------------------------
// Renderer durable boundary (decision 2.2): the ONLY IndexedDB touch point is
// the renderer Store.exportAll()/importAll() reached through rendererIpc.
// ---------------------------------------------------------------------------
function createRendererDurable(rendererIpc, getMainWindow) {
  async function read() {
    const correlationId = 'read-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const result = await rendererIpc.invoke(getMainWindow ? getMainWindow() : null, 'xj:update:snapshot', { operationId: correlationId });
    if (!result || result.ok !== true || typeof result.payload !== 'string') {
      const error = new Error('renderer-export-failed');
      error.code = 'renderer-export-failed';
      throw error;
    }
    return JSON.parse(result.payload);
  }
  async function write(payloadObject) {
    const correlationId = 'write-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const result = await rendererIpc.invoke(getMainWindow ? getMainWindow() : null, 'xj:update:restore', { operationId: correlationId, payload: JSON.stringify(payloadObject) });
    if (!result || result.ok !== true) {
      const error = new Error('renderer-import-failed');
      error.code = 'renderer-import-failed';
      throw error;
    }
    return result;
  }
  return { read, write };
}

// ---------------------------------------------------------------------------
// Real first-launch health adapter (decision 2.3). Spawns the candidate
// executable with a temporary userData, synthetic data only, and a
// default-deny network wrapper.
// ---------------------------------------------------------------------------
function createHealthAdapter(options) {
  const electronExe = (options && options.electronExe) || process.execPath;
  const probeDir = (options && options.probeDir) || process.cwd();
  const expectedVersion = (options && options.appVersion) || '';
  return async (strategyResult, meta) => {
    return runFirstLaunchHealth({
      electronExe,
      probeDir,
      expectedVersion,
      channel: (meta && meta.channel) || 'stable',
      strategy: (meta && meta.strategy) || 'installer',
      timeoutMs: (options && options.healthTimeoutMs) || 60000
    });
  };
}

// ---------------------------------------------------------------------------
// Portable restart adapter (decision 2.4). The coordinator's portableStrategy
// already retains the previous known-good and stages+verifies the new bytes;
// this adapter confirms both exist (fail-closed) before the OS-level restart.
// NSIS installs are handled by the installer itself (no-op here).
// ---------------------------------------------------------------------------
function createPortableRestartAdapter() {
  return async (strategyResult, meta) => {
    if (!strategyResult || strategyResult.kind !== 'portable') return { ok: true, kind: 'nsis-noop' };
    const env = (meta && meta.env) || {};
    if (!env.workDir && !env.portableWorkDir) throw Object.assign(new Error('portable-workdir-missing'), { code: 'portable-workdir-missing' });
    if (!strategyResult.current || !fs.existsSync(strategyResult.current)) throw Object.assign(new Error('portable-staged-missing'), { code: 'portable-staged-missing' });
    if (!strategyResult.previous || !fs.existsSync(strategyResult.previous)) throw Object.assign(new Error('portable-previous-missing'), { code: 'portable-previous-missing' });
    return { ok: true, kind: 'portable', current: strategyResult.current, previous: strategyResult.previous };
  };
}

// ---------------------------------------------------------------------------
// Real recover adapter: transaction-journal recovery bound to the marker file.
// ---------------------------------------------------------------------------
function createRecoverAdapter() {
  return (markerPath, expectedChannel) => recover(markerPath, expectedChannel);
}

// ---------------------------------------------------------------------------
// Build the complete production options object main.js merges into
// updateIntegrationOptions(). Every adapter is REAL (non-null). Optional
// overrides exist ONLY so the production wiring can be exercised in plain Node
// tests for boundaries that inherently require a live renderer (durable IPC)
// or a spawned process (health); production passes no overrides.
// ---------------------------------------------------------------------------
function buildProductionUpdateOptions(deps) {
  const getMainWindow = deps.getMainWindow || (() => null);
  const appVersion = deps.appVersion || '';

  const transport = createNetTransport(deps.net || null, { timeoutMs: deps.timeoutMs, denyNetwork: deps.denyNetwork });
  const confirmDecision = createConfirmAdapter(deps.dialog || null, getMainWindow);
  const rendererIpc = deps.rendererIpc || createRendererIpc(deps.ipcMain || null, { replyTimeoutMs: deps.replyTimeoutMs, getMainWindow });
  const rendererDurable = deps.rendererDurable || createRendererDurable(rendererIpc, getMainWindow);
  const healthCheck = deps.healthCheck || createHealthAdapter({ electronExe: deps.electronExe, probeDir: deps.probeDir, appVersion, healthTimeoutMs: deps.healthTimeoutMs });
  const portableRestart = deps.portableRestart || createPortableRestartAdapter();
  const recoverUpdate = deps.recoverUpdate || createRecoverAdapter();

  return { transport, confirmDecision, rendererIpc, rendererDurable, healthCheck, portableRestart, recoverUpdate };
}

module.exports = {
  createNetTransport, createConfirmAdapter, createRendererIpc, createRendererDurable,
  createHealthAdapter, createPortableRestartAdapter, createRecoverAdapter,
  buildProductionUpdateOptions
};
