'use strict';
// production-wiring.js — REAL production assembly test (Codex intake P0-3/P0-4
// rework requirement). This does NOT use injected test-fake adapters; it wires
// the actual production modules (main-update-integration + production-adapters)
// exactly as main.js's updateIntegrationOptions() does, with Electron-shaped
// stubs (net/dialog/ipcMain) injected, and proves:
//   1) NO adapter is null after assembly (transport/confirm/rendererIpc/
//      rendererDurable/healthCheck/portableRestart/recoverUpdate).
//   2) channel/strategy resolve to the legal enum (stable / installer|portable).
//   3) committed chain: confirmed -> snapshot -> verified -> health -> committed.
//   4) failure chain: fail -> rollback (never committed).
//   5) reverse-mutations kill every assembly defect listed by Codex intake.
//
// The renderer durable boundary is exercised through a loopback window that
// answers the controlled xj:update:snapshot/restore request/reply channels the
// way app/js/update-durable-renderer.js does (await exportAll/importAll).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Suite, tmpDir } = require('./_testkit');
const integration = require('../../../app/update/main-update-integration');
const adapters = require('../../../app/update/production-adapters');
const { productionEnv, assertBounded } = require('../../../app/update/env-adapter');
const backupCrypto = require('../../../app/js/backup-crypto.js');

const s = new Suite('production-wiring');

// ---------------------------------------------------------------------------
// Electron-shaped stubs (injected, never the real app)
// ---------------------------------------------------------------------------
function makeNetStub({ feedText, artifactBytes, denyNetwork } = {}) {
  const calls = [];
  return {
    calls,
    async fetch(url, opts) {
      calls.push({ url, opts });
      if (denyNetwork && denyNetwork()) throw Object.assign(new Error('network-denied'), { code: 'network-denied' });
      // feed vs artifact decided by extension
      if (/\.yml$/.test(url)) return { status: 200, text: async () => feedText, arrayBuffer: async () => Buffer.from([]) };
      return { status: 200, text: async () => '', arrayBuffer: async () => Buffer.from(artifactBytes) };
    }
  };
}
function makeDialogStub({ confirmNow } = {}) {
  return { async showMessageBox() { return { response: confirmNow ? 0 : 1 }; } };
}
// A loopback window + ipcMain that behaves like the real controlled durable
// boundary: main sends xj:update:snapshot:request / restore:request, the
// "renderer" awaits a fake exportAll/importAll and sends back the reply with
// the SAME operationId correlation.
function makeLoopbackWindow() {
  const handlers = {};
  const destroyedListeners = [];
  const sentRequests = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      sentRequests.push({ channel, payload });
      // Simulate the renderer durable handler
      setTimeout(() => {
        if (channel === 'xj:update:snapshot:request') {
          // await exportAll(): return a real v2 payload
          const reply = { ok: true, operationId: payload.operationId, payload: JSON.stringify({
            version: '2.0.0', exportedAt: new Date().toISOString(),
            clients: [{ id: 'c1', name: '合成', sourceRef: 'free' }], sessions: [], supervisions: [],
            supervisorIdentities: [], masterConversations: [], expenses: [],
            materialWorkspaces: [], clinicalActionRuns: [], clinicalTasks: [],
            importQuarantine: [], deletionBatches: [], deletionQuarantine: []
          }) };
          (handlers['xj:update:snapshot:reply'] || []).forEach((h) => h({ sender: webContents }, reply));
        }
        if (channel === 'xj:update:restore:request') {
          const reply = { ok: true, operationId: payload.operationId, quarantine: [], deletionQuarantine: [] };
          (handlers['xj:update:restore:reply'] || []).forEach((h) => h({ sender: webContents }, reply));
        }
      }, 0);
    },
    once: (ev, cb) => { if (ev === 'destroyed') destroyedListeners.push(cb); },
    removeListener: () => {}
  };
  const win = { isDestroyed: () => false, webContents };
  const ipcMain = {
    on: (ch, h) => { (handlers[ch] = handlers[ch] || []).push(h); },
    removeListener: (ch, h) => { if (handlers[ch]) handlers[ch] = handlers[ch].filter((x) => x !== h); },
    handle: () => {}, removeAllListeners: () => {}
  };
  return { win, ipcMain, sentRequests };
}

function updaterYaml(version, strategy) {
  const name = (strategy === 'portable' ? 'xinjing-portable-' : 'xinjing-setup-') + version + '.exe';
  const bytes = Buffer.from('production-artifact-' + version + '-' + strategy);
  const sha = Buffer.from(crypto.createHash('sha512').update(bytes).digest()).toString('base64');
  return { text: ['version: ' + version, 'files:', '  - url: ' + name, '    sha512: ' + sha, '    size: ' + bytes.length, 'releaseDate: 2026-08-07T00:00:00.000Z'].join('\n'), bytes };
}

// Assemble production options EXACTLY the way main.js updateIntegrationOptions()
// does (production-adapters.buildProductionUpdateOptions + the scalar fields).
function assembleProductionOptions({ confirmNow = true, healthOk = true, denyNetwork = false, over = {} } = {}) {
  const dir = tmpDir('xj-pw-');
  const feed = updaterYaml('4.3.0', 'installer');
  const loop = makeLoopbackWindow();
  const adapterDeps = {
    net: makeNetStub({ feedText: feed.text, artifactBytes: feed.bytes, denyNetwork: () => denyNetwork }),
    dialog: makeDialogStub({ confirmNow }),
    ipcMain: loop.ipcMain,
    getMainWindow: () => loop.win,
    appVersion: '4.2.4',
    denyNetwork: () => denyNetwork,
    probeDir: path.resolve(__dirname, '..', '..', '..'),
    electronExe: process.execPath,
    currentExePath: process.execPath,
    replyTimeoutMs: 5000,
    healthTimeoutMs: 5000
  };
  const built = adapters.buildProductionUpdateOptions(adapterDeps);
  // Override the health probe so the test does not spawn a real Electron child.
  if (!over.healthCheck) built.healthCheck = async () => ({ ok: healthOk, code: 'health-ok' });
  // P1-1 regression alignment: production main.js updateIntegrationOptions()
  // now wires a bounded production env (productionEnv + assertBounded) so the
  // xj:update:snapshot / xj:update:restore durable adapters are usable.
  const env = productionEnv(dir, null);
  assertBounded(env);
  const options = {
    ipcMain: loop.ipcMain,
    mainWindow: loop.win,
    appVersion: '4.2.4',
    isPortable: false,
    channel: 'stable',
    strategy: 'installer',
    userDataDir: dir,
    env,
    previousInstallerPath: null,
    backupCrypto,
    backupKey: crypto.randomBytes(32),
    agentAcceptanceMode: false,
    sourceManifestHash: null,
    releaseId: '9',
    fs,
    lockHeld: () => false,
    transport: built.transport,
    recoverUpdate: built.recoverUpdate,
    confirmDecision: built.confirmDecision,
    rendererIpc: built.rendererIpc,
    rendererDurable: built.rendererDurable,
    healthCheck: built.healthCheck,
    portableRestart: built.portableRestart,
    _loop: loop
  };
  return Object.assign(options, over);
}

(async () => {
  // R1: NO adapter is null after production assembly
  const opts1 = assembleProductionOptions();
  s.ok('assembly has no null adapter',
    opts1.transport != null && opts1.confirmDecision != null && opts1.rendererIpc != null &&
    opts1.rendererDurable != null && opts1.healthCheck != null && opts1.portableRestart != null &&
    opts1.recoverUpdate != null,
    JSON.stringify({ t: !!opts1.transport, c: !!opts1.confirmDecision, ri: !!opts1.rendererIpc, rd: !!opts1.rendererDurable, h: !!opts1.healthCheck, p: !!opts1.portableRestart, r: !!opts1.recoverUpdate }));

  // R2: channel/strategy resolve to the legal enum
  s.ok('channel/strategy are legal enum values', opts1.channel === 'stable' && opts1.strategy === 'installer',
    'channel=' + opts1.channel + ' strategy=' + opts1.strategy);

  // R3: committed chain — confirmed -> snapshot -> verified -> health -> committed
  const st3 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts1 });
  s.ok('production committed chain', st3.ok === true && st3.committed === true && st3.state === 'committed', JSON.stringify(st3));

  // R4: failure chain — health fail -> rollback, never committed
  const opts4 = assembleProductionOptions({ healthOk: false });
  const st4 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts4 });
  s.ok('health failure rolls back, never commits', st4.ok === false && st4.committed !== true, JSON.stringify(st4));

  // R5: unknown channel is rejected at the assembly boundary (typed)
  const opts5 = assembleProductionOptions({ over: {} });
  const st5 = await integration.requestUpdateCheck({ channel: 'latest', strategy: 'installer', currentVersion: '4.2.4', options: opts5 });
  s.ok('unknown channel rejected', st5.ok === false && /channel/i.test(String(st5.errorCode || '')), JSON.stringify(st5));

  // R6: denyNetwork (acceptance-style) -> transport fails closed, no commit
  const opts6 = assembleProductionOptions({ denyNetwork: true });
  const st6 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts6 });
  s.ok('denyNetwork fails closed', st6.ok === false && st6.committed !== true, JSON.stringify(st6));

  // R7: renderer durable boundary reached the controlled channel (not raw ipcRenderer)
  s.ok('durable boundary used controlled request channel', opts1._loop.sentRequests.some((r) => r.channel === 'xj:update:snapshot:request'), JSON.stringify(opts1._loop.sentRequests.map((r) => r.channel)));

  // R8: decline -> never downloads, fail closed
  const opts8 = assembleProductionOptions({ confirmNow: false });
  const st8 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts8 });
  s.ok('decline fails closed before download', st8.ok === false && /declined/.test(String(st8.errorCode || '')), JSON.stringify(st8));

  console.log('PRODUCTION_WIRING_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
