'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPiProductionRuntime } = require('../../../app/js/pi/bridge/pi-production-runtime-v1.js');
const P = require('../../../app/js/pi/pi-protocol-v1.js');

const ROOT = path.resolve(__dirname, '../../../');
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-supervision-broker-production-wiring-041/evidence/fixture-results.json');
const ref = { sourceId: 'fixture:041', sourceVersion: 1, sourceContentHash: 'sha256:' + 'c'.repeat(64), anchorContentHash: 'sha256:' + 'd'.repeat(64) };
const projection = { clientId: 'fixture-client', sessionId: 'fixture-session', sourceRefs: [ref], storeProjectionVersion: 1, membershipProjectionVersion: 1 };
const trusted = { sender: { id: 410 } };

function ipc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    handle(c, fn) { handlers.set(c, fn); },
    removeHandler(c) { handlers.delete(c); },
    on(c, fn) { const xs = listeners.get(c) || []; xs.push(fn); listeners.set(c, xs); },
    removeListener(c, fn) { listeners.set(c, (listeners.get(c) || []).filter((x) => x !== fn)); },
    emit(c, e, p) { (listeners.get(c) || []).slice().forEach((fn) => fn(e, p)); },
  };
}

function runtime(membership, userDataDir) {
  const bus = ipc();
  const win = { webContents: { id: 410, isDestroyed: () => false, send: (_c, req) => bus.emit('xj:pi:renderer-reply', trusted, { requestId: req.requestId, response: { ok: false, code: 'XJ_PI_VERIFY_FAILED' } }) } };
  const rt = createPiProductionRuntime({
    ipcMain: bus,
    getMainWindow: () => win,
    isTrustedRendererEvent: (e) => !!(e && e.sender && e.sender.id === 410),
    userDataDir: userDataDir || fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-fixture-')),
    serverMembershipProjection: () => membership,
  });
  return { rt, bus };
}

async function run() {
  const results = [];
  function add(id, expected, actual) {
    const ok = expected(actual);
    results.push({ id, ok, actual });
    assert.ok(ok, id + ' failed: ' + JSON.stringify(actual));
    console.log('PASS ' + id);
  }

  const a = runtime({ tier: 'pro' });
  add('F01-unpublished', (x) => x.code === 'XJ_PI_SNAPSHOT_MISMATCH', a.rt.bridge.api.startTask({ taskId: 'xj_task_041_f01', mode: 'observe', projection }));
  a.rt.publishState(trusted, { projection, reads: { 'read.task.cards': { '{}': { cards: [] } } } });
  add('F02-valid-published', (x) => x.ok === true, a.rt.bridge.api.startTask({ taskId: 'xj_task_041_f02', mode: 'observe', projection }));
  a.rt.publishState(trusted, { projection: { ...projection, storeProjectionVersion: 2 }, reads: {} });
  add('F03-context-drift', (x) => x.code === 'XJ_PI_SNAPSHOT_MISMATCH', a.rt.bridge.api.contextCheck('xj_task_041_f02'));
  // F03 uses a fresh valid task; the previous task is not changed, so this is a stable positive fixture.
  a.rt.stop();

  const b = runtime({ tier: 'pro' });
  b.rt.publishState(trusted, { projection, reads: {} });
  b.rt.bridge.api.startTask({ taskId: 'xj_task_041_f06', mode: 'observe', projection });
  add('F04-projection-client-mismatch', (x) => x.code === 'XJ_PI_SNAPSHOT_MISMATCH', b.rt.bridge.api.startTask({ taskId: 'xj_task_041_f04', mode: 'observe', projection: { ...projection, clientId: 'other' } }));
  add('F05-projection-version-mismatch', (x) => x.code === 'XJ_PI_SNAPSHOT_MISMATCH', b.rt.bridge.api.startTask({ taskId: 'xj_task_041_f05', mode: 'observe', projection: { ...projection, storeProjectionVersion: 2 } }));
  add('F06-unknown-tool', (x) => x.code === 'XJ_PI_UNKNOWN_TOOL', b.rt.bridge.api.runToolStep('xj_task_041_f06', { tool: 'shell.exec', args: {} }));
  const h = b.bus.handlers.get('xj-pi-v1:invoke');
  add('F07-hostile-sender', (x) => x.code === 'XJ_PI_UNKNOWN_EVENT', await h({ sender: { id: 999 } }, { method: 'diagnose', args: ['xj_task_041_f04'] }));
  add('F08-unknown-method', (x) => x.code === 'XJ_PI_UNKNOWN_EVENT', await h(trusted, { method: 'fs.read', args: [] }));
  b.rt.stop();

  const c = runtime(null);
  c.rt.publishState(trusted, { projection, reads: { 'read.task.cards': { '{}': { cards: [] } } } });
  add('F09-membership-unknown', (x) => x.code === 'XJ_PI_MEMBERSHIP_UNKNOWN', (() => { c.rt.bridge.api.startTask({ taskId: 'xj_task_041_f09', mode: 'observe', projection }); return c.rt.bridge.api.runToolStep('xj_task_041_f09', { tool: 'read.task.cards', args: {} }); })());
  c.rt.stop();

  const badDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-fixture-bad-'));
  fs.writeFileSync(path.join(badDir, 'pi-events-v1.jsonl'), '{broken\n', 'utf8');
  const d = runtime({ tier: 'pro' }, badDir);
  add('F10-bad-replay', (x) => x.code === 'XJ_PI_EVENT_VERSION', d.rt.bridge.api.startTask({ taskId: 'xj_task_041_f10', mode: 'observe', projection }));
  d.rt.stop();

  const e = runtime({ tier: 'pro' });
  e.rt.publishState(trusted, { projection, reads: {} });
  add('F11-supervision-is-registered', (x) => x.ok === true, e.rt.bridge.api.startTask({ taskId: 'xj_task_041_f11', mode: 'supervision', projection }));
  add('F12-command-is-registered', (x) => x.ok === true, e.rt.bridge.api.runToolStep('xj_task_041_f11', { tool: 'command.navigate', args: {} }));
  e.rt.stop();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ schema: 'pi-production-041-fixtures-v1', taskId: 'XJ-5.1.0-pi-supervision-broker-production-wiring-041', count: results.length, results }, null, 2), 'utf8');
  console.log('FIXTURE ' + results.length + '/' + results.length + ' PASS');
}

run().catch((error) => { console.error('FATAL', error.stack || error); process.exitCode = 1; });
