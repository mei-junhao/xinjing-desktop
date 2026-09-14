'use strict';
// p1-env-wiring.test.js — P1-1 behavioral regression: the durable adapters
// (xj:update:snapshot / xj:update:restore) only work when main.js wires a
// bounded production env into updateIntegrationOptions(). Exercises the REAL
// main-update-integration + durable-bridge + production-adapters bytes through
// the typed guarded handlers with a loopback renderer answering the controlled
// request/reply channels exactly like app/js/update-durable-renderer.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Suite, tmpDir, sha256 } = require('./_testkit');
const integration = require('../../../app/update/main-update-integration');
const adapters = require('../../../app/update/production-adapters');
const { productionEnv, assertBounded } = require('../../../app/update/env-adapter');
const { readSnapshot } = require('../../../app/update/durable-bridge');
const backupCrypto = require('../../../app/js/backup-crypto.js');

const s = new Suite('p1-env-wiring');

const SYNTHETIC_PAYLOAD = {
  version: '2.0.0', exportedAt: '2026-01-01T00:00:00.000Z',
  clients: [{ id: 'syn-c1', name: '合成来访者', sourceRef: 'free-manual' }],
  sessions: [{ id: 'syn-s1', clientId: 'syn-c1', kind: 'manual' }],
  supervisions: [], supervisorIdentities: [], masterConversations: [],
  expenses: [], materialWorkspaces: [], clinicalActionRuns: [],
  clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: []
};
const SYNTHETIC_PAYLOAD_HASH = sha256(JSON.stringify(SYNTHETIC_PAYLOAD));

// Loopback renderer answering the controlled durable channels. `exportMode`:
// 'ok' (real v2 payload), 'fail' (ok:false export-thrown), 'stale' (v1.9.9).
function makeLoopbackWindow({ exportMode = 'ok', failImport = false } = {}) {
  const replyHandlers = {};
  const sent = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      sent.push({ channel, payload });
      setTimeout(() => {
        if (channel === 'xj:update:snapshot:request') {
          let reply;
          if (exportMode === 'fail') reply = { ok: false, code: 'export-thrown' };
          else if (exportMode === 'stale') reply = { ok: true, operationId: payload.operationId, payload: JSON.stringify({ version: '1.9.9', exportedAt: 'x' }) };
          else reply = { ok: true, operationId: payload.operationId, payload: JSON.stringify(SYNTHETIC_PAYLOAD) };
          (replyHandlers['xj:update:snapshot:reply'] || []).forEach((h) => h({ sender: webContents }, reply));
        }
        if (channel === 'xj:update:restore:request') {
          const reply = failImport
            ? { ok: false, code: 'import-durable-failed' }
            : { ok: true, operationId: payload.operationId, quarantine: [], deletionQuarantine: [] };
          (replyHandlers['xj:update:restore:reply'] || []).forEach((h) => h({ sender: webContents }, reply));
        }
      }, 0);
    },
    once: () => {}, removeListener: () => {}
  };
  const win = { isDestroyed: () => false, webContents };
  const registered = {};
  const ipcMain = {
    handle: (method, handler) => { registered[method] = handler; },
    on: (ch, h) => { (replyHandlers[ch] = replyHandlers[ch] || []).push(h); },
    removeListener: (ch, h) => { if (replyHandlers[ch]) replyHandlers[ch] = replyHandlers[ch].filter((x) => x !== h); },
    removeAllListeners: () => {}
  };
  return { win, ipcMain, registered, sent };
}

// Assemble options exactly the way FIXED production main.js does:
// env = productionEnv(userDataDir, null) + assertBounded, wired into opts;
// rendererIpc from the REAL production-adapters bytes.
function assemble(opts = {}) {
  const dir = tmpDir('xj-p1env-');
  const loop = makeLoopbackWindow(opts.renderer || {});
  let env = productionEnv(dir, null);
  assertBounded(env);
  if (opts.envOverride) env = Object.assign(env, opts.envOverride);
  const options = {
    ipcMain: loop.ipcMain,
    mainWindow: loop.win,
    appVersion: '4.2.4',
    isPortable: false,
    channel: 'stable',
    strategy: 'installer',
    userDataDir: dir,
    previousInstallerPath: null,
    backupCrypto,
    backupKey: crypto.randomBytes(32),
    agentAcceptanceMode: false,
    sourceManifestHash: null,
    releaseId: 'p1',
    fs,
    lockHeld: () => false,
    healthCheck: async () => ({ ok: true, code: 'health-ok' }),
    portableRestart: async () => ({ ok: true, kind: 'nsis-noop' }),
    recoverUpdate: () => null,
    confirmDecision: async () => 'later',
    transport: null
  };
  if (!opts.omitEnv) options.env = env;
  options.rendererIpc = adapters.createRendererIpc(loop.ipcMain, { replyTimeoutMs: opts.replyTimeoutMs || 5000, getMainWindow: () => loop.win });
  options.rendererDurable = adapters.createRendererDurable(options.rendererIpc, () => loop.win);
  integration.registerTypedIpc(loop.ipcMain, options);
  return { options, loop, dir };
}

(async () => {
  // T1: wired env -> real snapshot through typed handler, hash preserved.
  const a1 = assemble();
  const snap1 = await a1.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-1' });
  s.ok('T1 snapshot succeeds with wired env', snap1 && snap1.ok === true && typeof snap1.sha256 === 'string', JSON.stringify(snap1));
  s.ok('T1 snapshot hash equals synthetic payload hash', snap1.sha256 === SYNTHETIC_PAYLOAD_HASH, String(snap1.sha256));
  const snapFile1 = path.join(a1.options.env.snapshotPath + '.encrypted', 'store.snapshot.op-p1-1.json');
  s.ok('T1 snapshot file written inside userData-scoped env', fs.existsSync(snapFile1) && snapFile1.startsWith(a1.dir), snapFile1);
  // Independent read-back through the REAL durable-bridge decrypt path.
  const rb1 = readSnapshot({ snapshotPath: snapFile1, key: a1.options.backupKey, backupCrypto });
  s.ok('T1 read-back decrypted hash matches', rb1.payloadSha256 === SYNTHETIC_PAYLOAD_HASH && rb1.payload.clients[0].id === 'syn-c1', String(rb1.payloadSha256).slice(0, 16));

  // T2: restore through typed handler consumes the SAME snapshot bytes.
  const rest1 = await a1.loop.registered['xj:update:restore']({}, { operationId: 'op-p1-1' });
  s.ok('T2 restore succeeds after snapshot', rest1 && rest1.ok === true && Array.isArray(rest1.quarantine), JSON.stringify(rest1));
  s.ok('T2 renderer durable boundary used controlled channels', a1.loop.sent.some((r) => r.channel === 'xj:update:snapshot:request') && a1.loop.sent.some((r) => r.channel === 'xj:update:restore:request'), JSON.stringify(a1.loop.sent.map((r) => r.channel)));

  // T3: restart durability — a FRESH registration over a fresh assembly can
  // snapshot again and produce the identical content hash (payload stable);
  // the earlier snapshot file stays readable (no destructive restart path).
  const a3 = assemble();
  const snapA = await a3.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-2' });
  const snapFileA = path.join(a3.options.env.snapshotPath + '.encrypted', 'store.snapshot.op-p1-2.json');
  const a3b = assemble();
  const snapB = await a3b.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-3' });
  const rbA = readSnapshot({ snapshotPath: snapFileA, key: a3.options.backupKey, backupCrypto });
  s.ok('T3 restart: snapshot readable again, identical hash, prior file intact', snapA.ok === true && snapB.ok === true && snapA.sha256 === snapB.sha256 && snapB.sha256 === SYNTHETIC_PAYLOAD_HASH && rbA.payloadSha256 === SYNTHETIC_PAYLOAD_HASH, String(snapB.sha256));

  // T4 (P1-1 kill proof at handler level): unwired env fails closed typed.
  const a4 = assemble({ omitEnv: true });
  const snap4 = await a4.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-4' });
  s.ok('T4 missing env fails closed with typed error', snap4.ok === false && snap4.state === 'failed' && snap4.errorCode === 'update-env-not-wired', JSON.stringify(snap4));

  // T5: empty snapshotPath fails closed (env validation, not TypeError).
  const a5 = assemble({ envOverride: { snapshotPath: '' } });
  const snap5 = await a5.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-5' });
  s.ok('T5 empty snapshotPath fails closed typed', snap5.ok === false && /^update-env-path-invalid/.test(String(snap5.errorCode || '')), JSON.stringify(snap5));

  // T6: renderer export ok:false is NOT swallowed -> typed failure. The real
  // renderer answers failures WITHOUT operationId (see update-durable-renderer.js),
  // so the production correlation boundary fails closed via reply timeout.
  const a6 = assemble({ renderer: { exportMode: 'fail' }, replyTimeoutMs: 1200 });
  const snap6 = await a6.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-6' });
  s.ok('T6 renderer export failure fails closed', snap6.ok === false && /^snapshot-renderer-(failed|threw)$/.test(String(snap6.errorCode || '')), JSON.stringify(snap6));

  // T7: corrupt snapshot file -> restore fails closed, never silent success.
  const a7 = assemble();
  await a7.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-7' });
  const snapFile7 = path.join(a7.options.env.snapshotPath + '.encrypted', 'store.snapshot.op-p1-7.json');
  fs.writeFileSync(snapFile7, '{corrupted', 'utf8');
  const rest7 = await a7.loop.registered['xj:update:restore']({}, { operationId: 'op-p1-7' });
  s.ok('T7 corrupt snapshot fails closed on restore', rest7.ok === false && /snapshot-corrupt/.test(String(rest7.errorCode || '')), JSON.stringify(rest7));

  // T8: stale schema payload from renderer is rejected at the boundary.
  const a8 = assemble({ renderer: { exportMode: 'stale' } });
  const snap8 = await a8.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-8' });
  s.ok('T8 stale schema rejected at boundary', snap8.ok === false && /snapshot-stale-schema/.test(String(snap8.errorCode || '')), JSON.stringify(snap8));

  // T9: typed boundary rejects unknown fields (no bypass).
  const a9 = assemble();
  const snap9 = await a9.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-9', evil: 1 });
  s.ok('T9 unknown field rejected', snap9.ok === false && /^unknown-field/.test(String(snap9.errorCode || '')), JSON.stringify(snap9));

  // T10: renderer import ok:false -> restore fails closed (no swallow).
  const a10 = assemble({ renderer: { failImport: true }, replyTimeoutMs: 1200 });
  const snap10 = await a10.loop.registered['xj:update:snapshot']({}, { operationId: 'op-p1-10' });
  const rest10 = await a10.loop.registered['xj:update:restore']({}, { operationId: 'op-p1-10' });
  s.ok('T10 renderer import failure fails closed on restore', snap10.ok === true && rest10.ok === false && /^restore-(durable-failed|renderer-threw)$/.test(String(rest10.errorCode || '')), JSON.stringify(rest10));

  console.log('P1_ENV_WIRING_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
