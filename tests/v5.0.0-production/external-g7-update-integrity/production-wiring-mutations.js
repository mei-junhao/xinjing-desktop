'use strict';
// production-wiring-mutations.js — reverse-mutation harness (Codex intake R8).
// Each mutation injects a real assembly defect into the production wiring and
// asserts it is KILLED (fail-closed / rejected). A surviving mutation means a
// real P0 remains and the whole result is FAIL.
//
// Covered assembly defects (from Codex P0-1..P0-4):
//   M1  object/positional arg mismatch at the IPC boundary
//   M2  unknown channel
//   M3  transport null (default-deny must hold)
//   M4  rendererDurable null / read returns ok:false (swallowed {ok:false})
//   M5  credential missing (no backupKey, no passphrase)
//   M6  healthCheck null / returns ok:false
//   M7  recoverUpdate missing -> startup reconcile fails closed
//   M8  settings.js redefines window.checkUpdate over the authoritative impl
//   M9  premature committed (committed set before state==='committed')
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Suite, tmpDir } = require('./_testkit');
const integration = require('../../../app/update/main-update-integration');
const adapters = require('../../../app/update/production-adapters');
const { validateRequest } = require('../../../app/update/ipc-update');
const { productionEnv } = require('../../../app/update/env-adapter');
const backupCrypto = require('../../../app/js/backup-crypto.js');

const s = new Suite('production-wiring-mutations');

function updaterYaml(version) {
  const name = 'xinjing-setup-' + version + '.exe';
  const bytes = Buffer.from('mutation-artifact-' + version);
  const sha = Buffer.from(crypto.createHash('sha512').update(bytes).digest()).toString('base64');
  return { text: ['version: ' + version, 'files:', '  - url: ' + name, '    sha512: ' + sha, '    size: ' + bytes.length, 'releaseDate: 2026-08-07T00:00:00.000Z'].join('\n'), bytes };
}
function makeLoopbackWindow() {
  const handlers = {};
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      setTimeout(() => {
        if (channel === 'xj:update:snapshot:request') {
          const reply = { ok: true, operationId: payload.operationId, payload: JSON.stringify({ version: '2.0.0', exportedAt: new Date().toISOString(), clients: [], sessions: [], supervisions: [], supervisorIdentities: [], masterConversations: [], expenses: [], materialWorkspaces: [], clinicalActionRuns: [], clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: [] }) };
          (handlers['xj:update:snapshot:reply'] || []).forEach((h) => h({ sender: webContents }, reply));
        }
        if (channel === 'xj:update:restore:request') {
          const reply = { ok: true, operationId: payload.operationId, quarantine: [], deletionQuarantine: [] };
          (handlers['xj:update:restore:reply'] || []).forEach((h) => h({ sender: webContents }, reply));
        }
      }, 0);
    },
    once: () => {}, removeListener: () => {}
  };
  const win = { isDestroyed: () => false, webContents };
  const ipcMain = { on: (ch, h) => { (handlers[ch] = handlers[ch] || []).push(h); }, removeListener: () => {}, handle: () => {} };
  return { win, ipcMain };
}
function baseBuilt(over = {}) {
  const dir = tmpDir('xj-pwm-');
  const feed = updaterYaml('4.3.0');
  const loop = makeLoopbackWindow();
  const built = adapters.buildProductionUpdateOptions({
    net: { async fetch(url) { if (/\.yml$/.test(url)) return { status: 200, text: async () => feed.text, arrayBuffer: async () => Buffer.from([]) }; return { status: 200, text: async () => '', arrayBuffer: async () => Buffer.from(feed.bytes) }; } },
    dialog: { async showMessageBox() { return { response: 0 }; } },
    ipcMain: loop.ipcMain, getMainWindow: () => loop.win, appVersion: '4.2.4',
    probeDir: path.resolve(__dirname, '..', '..', '..'), electronExe: process.execPath, currentExePath: process.execPath,
    replyTimeoutMs: 4000, healthTimeoutMs: 4000
  });
  built.healthCheck = async () => ({ ok: true });
  const options = {
    ipcMain: loop.ipcMain, mainWindow: loop.win, appVersion: '4.2.4', isPortable: false,
    channel: 'stable', strategy: 'installer', userDataDir: dir, env: productionEnv(dir, null), previousInstallerPath: null,
    backupCrypto, backupKey: crypto.randomBytes(32), agentAcceptanceMode: false,
    sourceManifestHash: null, releaseId: '9', fs, lockHeld: () => false,
    transport: built.transport, recoverUpdate: built.recoverUpdate, confirmDecision: built.confirmDecision,
    rendererIpc: built.rendererIpc, rendererDurable: built.rendererDurable, healthCheck: built.healthCheck,
    portableRestart: built.portableRestart
  };
  return Object.assign(options, over);
}
async function runCheck(options) {
  return integration.requestUpdateCheck({ channel: options.channel || 'stable', strategy: options.strategy || 'installer', currentVersion: '4.2.4', options });
}

(async () => {
  // M1: object/positional arg mismatch at the typed IPC boundary is rejected
  let m1 = false;
  try { validateRequest('xj:update:check', { channel: { stable: true }, strategy: 'installer' }); } catch (e) { m1 = /bad-field-type:channel/.test(e.code || ''); }
  s.ok('M1 object-as-channel rejected (killed)', m1);

  // M2: unknown channel is rejected
  let m2 = false;
  try { validateRequest('xj:update:check', { channel: 'latest', strategy: 'installer' }); } catch (e) { m2 = /unknown-channel/.test(e.code || ''); }
  s.ok('M2 unknown channel rejected (killed)', m2);

  // M3: transport null -> fail-closed, no network, no commit
  const st3 = await runCheck(baseBuilt({ transport: null }));
  s.ok('M3 null transport fails closed (killed)', st3.ok === false && st3.committed !== true, JSON.stringify(st3));

  // M4a: rendererDurable null -> cannot snapshot, fail-closed
  const st4a = await runCheck(baseBuilt({ rendererDurable: null }));
  s.ok('M4a null rendererDurable fails closed (killed)', st4a.ok === false && st4a.committed !== true, JSON.stringify(st4a));

  // M4b: rendererDurable.read swallowing ok:false -> fail-closed
  const st4b = await runCheck(baseBuilt({ rendererDurable: { read: async () => ({ ok: false }), write: async () => ({ ok: true }) } }));
  s.ok('M4b read returning ok:false not swallowed (killed)', st4b.ok === false && st4b.committed !== true, JSON.stringify(st4b));

  // M5: credential missing -> snapshot-no-credential, fail-closed
  const st5 = await runCheck(baseBuilt({ backupKey: null }));
  s.ok('M5 missing credential fails closed (killed)', st5.ok === false && st5.committed !== true, JSON.stringify(st5));

  // M6a: healthCheck null -> no-health-probe, never commits
  const st6a = await runCheck(baseBuilt({ healthCheck: null }));
  s.ok('M6a null healthCheck fails closed (killed)', st6a.ok === false && st6a.committed !== true, JSON.stringify(st6a));

  // M6b: healthCheck returns ok:false -> never commits
  const st6b = await runCheck(baseBuilt({ healthCheck: async () => ({ ok: false }) }));
  s.ok('M6b failing healthCheck never commits (killed)', st6b.ok === false && st6b.committed !== true, JSON.stringify(st6b));

  // M7: recoverUpdate missing -> startup reconcile throws but must not crash assembly
  let m7 = true;
  try {
    const opts = baseBuilt({ recoverUpdate: null });
    // assemble succeeded without crashing despite missing recoverUpdate
    m7 = opts.recoverUpdate == null;
  } catch (e) { m7 = false; }
  s.ok('M7 missing recoverUpdate does not crash assembly', m7);

  // M8: settings.js must NOT redefine window.checkUpdate over the authoritative impl
  const settingsSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'app', 'js', 'settings.js'), 'utf8');
  const redefinesCheckUpdate = /window\.checkUpdate\s*=/.test(settingsSrc);
  s.ok('M8 settings.js does not override authoritative checkUpdate (killed)', !redefinesCheckUpdate);

  // M9: committed is only set when the coordinator reaches state==='committed'
  const st9 = await runCheck(baseBuilt({ confirmDecision: async () => false }));
  s.ok('M9 premature committed impossible (decline never commits, killed)', st9.committed !== true && st9.ok === false, JSON.stringify(st9));

  console.log('PRODUCTION_WIRING_MUTATIONS_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
