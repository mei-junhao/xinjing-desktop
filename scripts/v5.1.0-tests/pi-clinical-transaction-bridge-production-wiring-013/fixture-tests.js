'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPiProductionRuntime } = require('../../../app/js/pi/bridge/pi-production-runtime-v1.js');
const P = require('../../../app/js/pi/pi-protocol-v1.js');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-013-fixture-'));
const ref = { sourceId: 'material:m_013', sourceVersion: 2, sourceContentHash: 'sha256:' + 'a'.repeat(64), anchorContentHash: 'sha256:' + 'b'.repeat(64) };
const projection = { clientId: 'c_fixture', sessionId: 's_fixture', sourceRefs: [ref], storeProjectionVersion: 1, membershipProjectionVersion: 1 };
const context = { ...projection, snapshotHash: P.computeSnapshotHash(projection), taskId: 'supervision-ai', generationEntitlement: 'manual' };

function runtimeWith(options = {}) {
  const listeners = new Map();
  const handlers = new Map();
  const event = { sender: { id: 1 } };
  const store = options.store || { id: 's_fixture', clientId: 'c_fixture', piClinical: null };
  const win = { webContents: { id: 1, isDestroyed: () => false, send: (_ch, req) => {
    let response = options.reply ? options.reply(req, store) : { ok: false, code: 'XJ_TEST_REPLY_MISSING' };
    if (response && typeof response.then === 'function') response.then((x) => emit('xj:pi:renderer-reply', { requestId: req.requestId, response: x }));
    else emit('xj:pi:renderer-reply', { requestId: req.requestId, response });
  } } };
  function emit(channel, payload) { (listeners.get(channel) || []).slice().forEach((fn) => fn(event, payload)); }
  const ipc = {
    handlers,
    handle(ch, fn) { handlers.set(ch, fn); },
    removeHandler(ch) { handlers.delete(ch); },
    on(ch, fn) { const list = listeners.get(ch) || []; list.push(fn); listeners.set(ch, list); },
    removeListener(ch, fn) { listeners.set(ch, (listeners.get(ch) || []).filter((x) => x !== fn)); },
  };
  const runtime = createPiProductionRuntime({ ipcMain: ipc, getMainWindow: () => win, isTrustedRendererEvent: (e) => !!(e && e.sender && e.sender.id === 1), userDataDir: tmp, serverMembershipProjection: () => options.membership === undefined ? { tier: 'pro' } : options.membership });
  runtime.publishState(event, { projection, reads: {} });
  return { runtime, ipc, store, event };
}

let pass = 0;
function t(name, fn) { try { fn(); console.log('PASS ' + name); pass++; } catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); process.exitCode = 1; } }
async function at(name, fn) { try { await fn(); console.log('PASS ' + name); pass++; } catch (e) { console.log('FAIL ' + name + ' :: ' + e.message); process.exitCode = 1; } }

(async () => {
  const unavailable = runtimeWith({ reply: () => ({ ok: false, code: 'XJ_TEST_STORE_FAILURE' }) });
  const b0 = unavailable.runtime.clinical.api.begin(context);
  const r0 = unavailable.runtime.clinical.api.draftAppend(b0.clinicalActionRunId, { text: 'x' });
  unavailable.runtime.clinical.api.commitRecord(b0.clinicalActionRunId);
  unavailable.runtime.clinical.api.approve(b0.clinicalActionRunId);
  const f0 = await unavailable.runtime.clinical.api.commitDurable(b0.clinicalActionRunId);
  t('F13-01-store-ok-false', () => assert.strictEqual(f0.code, 'XJ_TEST_STORE_FAILURE'));
  unavailable.runtime.stop();

  const malformed = runtimeWith({ reply: () => ({ ok: false, code: 'XJ_PI_VERIFY_FAILED' }) });
  t('F13-02-source-ref-unknown', () => assert.strictEqual(malformed.runtime.clinical.api.begin({ ...context, sourceRefs: [{ ...ref, sourceId: 'unknown' }] }).code, 'XJ_PI_SNAPSHOT_MISMATCH'));
  t('F13-03-context-cross-client', () => assert.strictEqual(malformed.runtime.clinical.api.begin({ ...context, clientId: 'other', snapshotHash: P.computeSnapshotHash({ ...projection, clientId: 'other' }) }).code, 'XJ_PI_CLIENT_SESSION_MISMATCH'));
  malformed.runtime.stop();

  const paused = runtimeWith({ reply: () => ({ ok: false, code: 'XJ_TEST' }) });
  const bp = paused.runtime.clinical.api.begin(context);
  paused.runtime.clinical.api.pause(bp.clinicalActionRunId, 'fixture');
  t('F13-04-pause-blocks-draft', () => assert.strictEqual(paused.runtime.clinical.api.draftAppend(bp.clinicalActionRunId, { text: 'x' }).ok, false));
  t('F13-05-resume-restores-draft', () => { paused.runtime.clinical.api.resume(bp.clinicalActionRunId); assert.strictEqual(paused.runtime.clinical.api.draftAppend(bp.clinicalActionRunId, { text: 'x' }).ok, true); });
  paused.runtime.stop();

  const badLogDir = fs.mkdtempSync(path.join(tmp, 'bad-log-'));
  fs.writeFileSync(path.join(badLogDir, 'pi-events-v1.jsonl'), '{bad-json\n', 'utf8');
  const badLog = runtimeWith({ reply: () => ({ ok: true }) });
  // The runtime uses its own userData path; create a second runtime directly with the bad log directory.
  badLog.runtime.stop();
  const noWindow = createPiProductionRuntime({ ipcMain: { handle() {}, on() {}, removeListener() {}, removeHandler() {} }, getMainWindow: () => null, isTrustedRendererEvent: () => false, userDataDir: badLogDir, serverMembershipProjection: () => ({ tier: 'pro' }) });
  t('F13-06-bad-replay-fail-closed', () => assert.strictEqual(noWindow.clinical.api.begin(context).code, 'XJ_PI_EVENT_VERSION'));
  noWindow.stop();

  const sender = runtimeWith({ reply: () => ({ ok: false, code: 'XJ_TEST' }) });
  const handler = sender.ipc.handlers.get('xj-pi-clinical-v1:invoke');
  const unknown = await handler({ sender: { id: 99 } }, { method: 'begin', args: [context] });
  t('F13-07-untrusted-clinical-ipc', () => assert.strictEqual(unknown.code, 'XJ_PI_UNKNOWN_EVENT'));
  sender.runtime.stop();

  const noMembership = runtimeWith({ membership: null, reply: () => ({ ok: true }) });
  t('F13-08-paid-membership-unknown', () => assert.strictEqual(noMembership.runtime.clinical.api.begin({ ...context, generationEntitlement: 'paid' }).code, 'XJ_PI_MEMBERSHIP_UNKNOWN'));
  noMembership.runtime.stop();

  const malformedReply = runtimeWith({ reply: () => ({ ok: true, savedObjectId: 's_fixture', version: 'not-int', savedAt: 0, object: {} }) });
  const bm = malformedReply.runtime.clinical.api.begin(context);
  malformedReply.runtime.clinical.api.draftAppend(bm.clinicalActionRunId, { text: 'x' });
  malformedReply.runtime.clinical.api.commitRecord(bm.clinicalActionRunId);
  malformedReply.runtime.clinical.api.approve(bm.clinicalActionRunId);
  const fm = await malformedReply.runtime.clinical.api.commitDurable(bm.clinicalActionRunId);
  t('F13-09-invalid-receipt', () => assert.strictEqual(fm.ok, false));
  malformedReply.runtime.stop();

  console.log('FIXTURE ' + pass + '/9 PASS');
})().catch((e) => { console.error('FATAL', e.stack || e); process.exitCode = 1; });
