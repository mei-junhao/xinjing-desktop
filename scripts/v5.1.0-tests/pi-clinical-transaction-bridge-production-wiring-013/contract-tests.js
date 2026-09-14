'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPiProductionRuntime, CLINICAL_IPC_CHANNEL } = require('../../../app/js/pi/bridge/pi-production-runtime-v1.js');
const P = require('../../../app/js/pi/pi-protocol-v1.js');

const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-013-contract-'));
const sourceRef = { sourceId: 'session:s_013', sourceVersion: 1, sourceContentHash: 'sha256:' + '1'.repeat(64), anchorContentHash: 'sha256:' + '2'.repeat(64) };
const projection = { clientId: 'c_013', sessionId: 's_013', sourceRefs: [sourceRef], storeProjectionVersion: 7, membershipProjectionVersion: 4 };
const snapshotHash = P.computeSnapshotHash(projection);
const trustedEvent = { sender: { id: 7 } };
const store = { s_013: { id: 's_013', clientId: 'c_013', notes: '', piClinical: null } };

function makeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    on(channel, fn) { const list = listeners.get(channel) || []; list.push(fn); listeners.set(channel, list); },
    removeListener(channel, fn) { const list = listeners.get(channel) || []; listeners.set(channel, list.filter((x) => x !== fn)); },
    emit(channel, event, payload) { (listeners.get(channel) || []).slice().forEach((fn) => fn(event, payload)); },
  };
}

function makeRuntime(membership = { tier: 'pro' }) {
  const ipcMain = makeIpc();
  let runtime;
  const win = { webContents: { id: 7, isDestroyed: () => false, send: (_channel, request) => {
    if (request.kind === 'durable-write') {
      const record = request.payload;
      const target = store.s_013;
      const version = Date.now();
      target.notes = record.fields.map((x) => x.text).join('\n');
      target.piClinical = { schemaVersion: 1, clinicalActionRunId: record.clinicalActionRunId, taskId: record.taskId, clientId: record.clientId, sessionId: record.sessionId, snapshotHash: record.snapshotHash, sourceRefs: record.sourceRefs, generationEntitlement: record.generationEntitlement, version, savedAt: version };
      ipcMain.emit('xj:pi:renderer-reply', trustedEvent, { requestId: request.requestId, response: { ok: true, savedObjectId: 's_013', version, savedAt: version, object: target } });
    } else if (request.kind === 'durable-read') {
      const target = store[request.payload.savedObjectId];
      const meta = target && target.piClinical;
      const response = meta ? { ok: true, savedObjectId: request.payload.savedObjectId, version: meta.version, savedAt: meta.savedAt, clientId: meta.clientId, sessionId: meta.sessionId, snapshotHash: meta.snapshotHash, sourceRefs: meta.sourceRefs, object: target } : { ok: false, code: 'XJ_PI_VERIFY_FAILED' };
      ipcMain.emit('xj:pi:renderer-reply', trustedEvent, { requestId: request.requestId, response });
    }
  } } };
  runtime = createPiProductionRuntime({
    ipcMain,
    getMainWindow: () => win,
    isTrustedRendererEvent: (event) => !!(event && event.sender && event.sender.id === 7),
    userDataDir: scratch,
    serverMembershipProjection: () => membership,
  });
  runtime.publishState(trustedEvent, { projection, reads: {} });
  return { runtime, ipcMain };
}

async function invoke(runtime, method, ...args) {
  return runtime.channels && runtime.channels.CLINICAL_IPC_CHANNEL
    ? runtime.clinical.api[method](...args)
    : null;
}

let pass = 0;
function test(name, fn) {
  try { fn(); console.log('PASS ' + name); pass += 1; } catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); process.exitCode = 1; }
}
async function asyncTest(name, fn) {
  try { await fn(); console.log('PASS ' + name); pass += 1; } catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); process.exitCode = 1; }
}

(async () => {
  const first = makeRuntime();
  const ctx = { ...projection, snapshotHash, taskId: 'transcript-ai-detect', generationEntitlement: 'paid', sourceRefs: [Object.assign({}, sourceRef)] };
  test('P13-01-context-snapshot', () => assert.strictEqual(first.runtime.clinical.api.begin({ ...ctx, snapshotHash: 'sha256:' + 'f'.repeat(64) }).code, 'XJ_PI_SNAPSHOT_MISMATCH'));
  await asyncTest('P13-02-unknown-sender', async () => {
    const result = await first.ipcMain.handlers.get(CLINICAL_IPC_CHANNEL)({ sender: { id: 99 } }, { method: 'begin', args: [ctx] });
    assert.strictEqual(result.code, 'XJ_PI_UNKNOWN_EVENT');
  });
  test('P13-03-membership-unknown', () => {
    const unknown = makeRuntime(null);
    assert.strictEqual(unknown.runtime.clinical.api.begin(ctx).code, 'XJ_PI_MEMBERSHIP_UNKNOWN');
    unknown.runtime.stop();
  });
  const begin = first.runtime.clinical.api.begin(ctx);
  test('P13-04-begin', () => assert.strictEqual(begin.ok, true));
  const runId = begin.clinicalActionRunId;
  test('P13-05-draft', () => assert.strictEqual(first.runtime.clinical.api.draftAppend(runId, { entryType: 'notes', text: 'synthetic note' }).ok, true));
  const record = first.runtime.clinical.api.commitRecord(runId);
  test('P13-06-approval-required', () => assert.strictEqual(record.status, 'awaiting_approval'));
  test('P13-07-approval', () => assert.strictEqual(first.runtime.clinical.api.approve(runId).ok, true));
  const durable = await first.runtime.clinical.api.commitDurable(runId);
  test('P13-08-await-durable', () => assert.strictEqual(durable.ok, true));
  const expected = { clientId: ctx.clientId, sessionId: ctx.sessionId, snapshotHash, version: durable.version, sourceRefs: ctx.sourceRefs.map((x) => ({ sourceId: String(x.sourceId), sourceVersion: String(x.sourceVersion), sourceContentHash: x.sourceContentHash, anchorContentHash: x.anchorContentHash })) };
  const verified = await first.runtime.clinical.api.verify(durable.savedObjectId, expected);
  test('P13-09-real-readback', () => assert.strictEqual(verified.ok, true));
  test('P13-10-cancel-after-success-rejected', () => assert.strictEqual(first.runtime.clinical.api.cancel(runId).ok, false));
  first.runtime.stop();
  const second = makeRuntime();
  const restarted = await second.runtime.clinical.api.verify(durable.savedObjectId, expected);
  test('P13-11-restart-store-readback', () => assert.strictEqual(restarted.ok, true));
  store.s_013.piClinical.sourceRefs[0].sourceVersion = '2';
  const drift = await second.runtime.clinical.api.verify(durable.savedObjectId, expected);
  test('P13-12-source-drift', () => assert.strictEqual(drift.code, 'XJ_PI_VERIFY_MISMATCH'));
  const paused = second.runtime.clinical.api.begin({ ...ctx, taskId: 'growth-summary', generationEntitlement: 'manual' });
  second.runtime.clinical.api.pause(paused.clinicalActionRunId, 'test');
  test('P13-13-pause-gate', () => assert.strictEqual(second.runtime.clinical.api.draftAppend(paused.clinicalActionRunId, { text: 'x' }).code, 'XJ_PI_APPROVAL_REQUIRED'));
  second.runtime.stop();
  console.log('CONTRACT 13/' + pass + ' PASS');
})().catch((e) => { console.error('FATAL', e.stack || e); process.exitCode = 1; });
