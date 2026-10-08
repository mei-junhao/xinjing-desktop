'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createPiProductionRuntime,
  CLINICAL_IPC_CHANNEL,
} = require('../../../app/js/pi/bridge/pi-production-runtime-v1.js');
const P = require('../../../app/js/pi/pi-protocol-v1.js');
const evidencePath = path.join(ROOT_PLACEHOLDER(), 'qa/task-scratch/XJ-5.1.0-pi-supervision-broker-production-wiring-041/evidence/contract-results.json');

const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-contract-'));
const trustedEvent = { sender: { id: 41 } };
const sourceRef = {
  sourceId: 'session:s_041',
  sourceVersion: 1,
  sourceContentHash: 'sha256:' + 'a'.repeat(64),
  anchorContentHash: 'sha256:' + 'b'.repeat(64),
};
const projection = {
  clientId: 'c_041',
  sessionId: 's_041',
  sourceRefs: [sourceRef],
  storeProjectionVersion: 11,
  membershipProjectionVersion: 5,
};

function makeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    on(channel, fn) { const list = listeners.get(channel) || []; list.push(fn); listeners.set(channel, list); },
    removeListener(channel, fn) { listeners.set(channel, (listeners.get(channel) || []).filter((x) => x !== fn)); },
    emit(channel, event, payload) { (listeners.get(channel) || []).slice().forEach((fn) => fn(event, payload)); },
  };
}

function makeRuntime(membership = { tier: 'pro' }, eventFile, userDataDir) {
  const ipcMain = makeIpc();
  const win = { webContents: { id: 41, isDestroyed: () => false, send: (_channel, request) => {
    const response = request.kind === 'durable-write'
      ? { ok: true, savedObjectId: 'receipt-041', version: Date.now(), object: { id: 'receipt-041' } }
      : { ok: false, code: 'XJ_PI_VERIFY_FAILED' };
    ipcMain.emit('xj:pi:renderer-reply', trustedEvent, { requestId: request.requestId, response });
  } } };
  const runtime = createPiProductionRuntime({
    ipcMain,
    getMainWindow: () => win,
    isTrustedRendererEvent: (event) => !!(event && event.sender && event.sender.id === 41),
    userDataDir: userDataDir || scratch,
    serverMembershipProjection: () => membership,
  });
  return { runtime, ipcMain };
}

let pass = 0;
let fail = 0;
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail: detail === undefined ? null : detail });
  if (condition) { console.log('PASS ' + name); pass += 1; }
  else { console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); fail += 1; }
}

(() => {
  const noPublish = makeRuntime();
  const noProjection = noPublish.runtime.bridge.api.startTask({
    taskId: 'xj_task_041_nopublish', mode: 'observe', projection,
  });
  check('C01-unpublished-projection-rejected', noProjection.code === 'XJ_PI_SNAPSHOT_MISMATCH', JSON.stringify(noProjection));

  noPublish.runtime.publishState(trustedEvent, { projection: { ...projection, sourceRefs: [] }, reads: {} });
  const emptyAfterClear = noPublish.runtime.bridge.api.startTask({
    taskId: 'xj_task_041_empty', mode: 'observe', projection,
  });
  check('C02-empty-sourceRefs-clears-and-rejects', emptyAfterClear.code === 'XJ_PI_SNAPSHOT_MISMATCH', JSON.stringify(emptyAfterClear));
  noPublish.runtime.publishState(trustedEvent, { projection, reads: {} });
  noPublish.runtime.publishState(trustedEvent, null);
  const nullAfterClear = noPublish.runtime.bridge.api.startTask({ taskId: 'xj_task_041_null', mode: 'observe', projection });
  check('C03-null-publication-clears-and-rejects', nullAfterClear.code === 'XJ_PI_SNAPSHOT_MISMATCH', JSON.stringify(nullAfterClear));
  noPublish.runtime.stop();

  const good = makeRuntime();
  good.runtime.publishState(trustedEvent, {
    projection,
    reads: {
      'read.client.summary': { '{"clientId":"c_041"}': { clientId: 'c_041', summary: '合成摘要' } },
      'read.task.cards': { '{}': { cards: [] } },
    },
  });
  const started = good.runtime.bridge.api.startTask({
    taskId: 'xj_task_041_good', mode: 'supervision', projection,
  });
  check('C04-published-equal-projection-starts', started.ok === true, JSON.stringify(started));
  check('C05-context-check-keeps-snapshot', good.runtime.bridge.api.contextCheck('xj_task_041_good').ok === true);
  check('C06-plan-accepted', good.runtime.bridge.api.plan('xj_task_041_good', [{ tool: 'read.client.summary' }]).ok === true);
  const read = good.runtime.bridge.api.runToolStep('xj_task_041_good', { tool: 'read.client.summary', args: { clientId: 'c_041' } });
  check('C07-read-broker-real-projection', read.ok === true && read.result && read.result.data.summary === '合成摘要', JSON.stringify(read));
  const supervision = good.runtime.bridge.api.runToolStep('xj_task_041_good', { tool: 'supervision.note.append', args: { noteText: '合成督导草稿' } });
  check('C08-supervision-draft-only', supervision.ok === true && supervision.result && supervision.result.draft, JSON.stringify(supervision));
  const command = good.runtime.bridge.api.runToolStep('xj_task_041_good', { tool: 'command.navigate', args: {} });
  check('C09-command-whitelist', command.ok === true, JSON.stringify(command));
  const unknownTool = good.runtime.bridge.api.runToolStep('xj_task_041_good', { tool: 'shell.exec', args: {} });
  check('C10-unknown-tool-rejected', unknownTool.code === 'XJ_PI_UNKNOWN_TOOL', JSON.stringify(unknownTool));
  const tampered = good.runtime.bridge.api.startTask({
    taskId: 'xj_task_041_tampered', mode: 'observe', projection: { ...projection, storeProjectionVersion: 12 },
  });
  check('C11-request-projection-tamper-rejected', tampered.code === 'XJ_PI_SNAPSHOT_MISMATCH', JSON.stringify(tampered));
  const trustedAgain = good.runtime.bridge.api.startTask({ taskId: 'xj_task_041_again', mode: 'observe', projection });
  check('C12-authority-not-overwritten-after-tamper', trustedAgain.ok === true, JSON.stringify(trustedAgain));

  const ipcHandler = good.ipcMain.handlers.get('xj-pi-v1:invoke');
  const hostile = ipcHandler({ sender: { id: 999 } }, { method: 'diagnose', args: ['xj_task_041_good'] });
  Promise.resolve(hostile).then((hostileResult) => {
    check('C13-untrusted-sender-rejected', hostileResult.code === 'XJ_PI_UNKNOWN_EVENT', JSON.stringify(hostileResult));
    return ipcHandler(trustedEvent, { method: 'unknownMethod', args: [] });
  }).then((unknownResult) => {
    check('C14-unknown-ipc-rejected', unknownResult.code === 'XJ_PI_UNKNOWN_EVENT', JSON.stringify(unknownResult));
    good.runtime.stop();

    const unknownMembership = makeRuntime(null);
    unknownMembership.runtime.publishState(trustedEvent, { projection, reads: { 'read.client.summary': { '{"clientId":"c_041"}': {} } } });
    const unknownStart = unknownMembership.runtime.bridge.api.startTask({ taskId: 'xj_task_041_unknown_mem', mode: 'observe', projection });
    const unknownRead = unknownMembership.runtime.bridge.api.runToolStep('xj_task_041_unknown_mem', { tool: 'read.client.summary', args: { clientId: 'c_041' } });
    check('C15-membership-unknown-fail-closed', unknownStart.ok === true && unknownRead.code === 'XJ_PI_MEMBERSHIP_UNKNOWN', JSON.stringify(unknownRead));
    unknownMembership.runtime.stop();

    const badDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-bad-replay-'));
    const badFile = path.join(badDir, 'pi-events-v1.jsonl');
    fs.writeFileSync(badFile, '{not-json\n', 'utf8');
    const bad = makeRuntime({ tier: 'pro' }, badFile, badDir);
    const badReplayStart = bad.runtime.bridge.api.startTask({ taskId: 'xj_task_041_bad_replay', mode: 'observe', projection });
    check('C16-bad-replay-runtime-unavailable', badReplayStart.code === 'XJ_PI_EVENT_VERSION', JSON.stringify(badReplayStart));
    bad.runtime.stop();
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify({ schema: 'pi-production-041-contract-v1', taskId: 'XJ-5.1.0-pi-supervision-broker-production-wiring-041', pass, fail, results }, null, 2), 'utf8');
    console.log('CONTRACT 16/' + pass + ' PASS; failures=' + fail);
    process.exitCode = fail === 0 ? 0 : 1;
  }).catch((error) => { console.error('FATAL', error.stack || error); process.exitCode = 1; });
})()

function ROOT_PLACEHOLDER() { return path.resolve(__dirname, '../../../'); }
