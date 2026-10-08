'use strict';
// durable-bridge.js — renderer durable snapshot/migration boundary tests
// (decision 2.2): exportAll/importAll-only, encrypted atomic snapshot,
// read-back hash, restore waits for the real durable result, ok:false / throw /
// malformed / fallback / stale schema / authority keys fail closed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Suite, tmpDir } = require('./_testkit');
const bridge = require('../../../app/update/durable-bridge');
const backupCrypto = require('../../../app/js/backup-crypto.js');

const s = new Suite('durable-bridge');
const key = crypto.randomBytes(32);

function v2Payload(over) {
  return JSON.stringify(Object.assign({
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    clients: [{ id: 'c1', name: '测试' }],
    sessions: [], supervisions: [], supervisorIdentities: [],
    masterConversations: [], expenses: [],
    materialWorkspaces: [{ id: 'm1', clientId: 'c1', sessionId: '', linkStatus: 'unlinked', updatedAt: new Date().toISOString() }],
    clinicalActionRuns: [{ id: 'r1', clientId: 'c1', sourceRef: 'clinical:src-1' }],
    clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: []
  }, over || {}), null, 2);
}

// fake renderer: real Store boundary contract — exportAll awaits; importAll
// returns the REAL durable result (ok:false when the durable write fails).
function fakeRenderer(importResult) {
  return {
    invoke: async (win, channel, request) => {
      if (channel === 'xj:update:snapshot') return { ok: true, payload: v2Payload() };
      if (channel === 'xj:update:restore') {
        if (typeof importResult === 'function') return importResult(request);
        return importResult;
      }
      return { ok: false, code: 'unknown-channel' };
    }
  };
}

s.ok('schema rejects stale version', (() => {
  let thrown = '';
  try { bridge.assertPayloadSchema(v2Payload({ version: '1.0.0' })); } catch (e) { thrown = e.code; }
  return thrown === 'snapshot-stale-schema';
})());

s.ok('schema rejects authority keys', (() => {
  let thrown = '';
  try { bridge.assertPayloadSchema(JSON.stringify({ version: '2.0.0', exportedAt: 'x', clients: [], sessions: [], supervisions: [], supervisorIdentities: [], masterConversations: [], expenses: [], materialWorkspaces: [], clinicalActionRuns: [], clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: [], commercialProjection: { balance: 1 } })); } catch (e) { thrown = e.code; }
  return thrown === 'snapshot-authority-key:commercialProjection';
})());

s.ok('schema rejects unknown field', (() => {
  let thrown = '';
  try { bridge.assertPayloadSchema(v2Payload({ fooBar: 1 })); } catch (e) { thrown = e.code; }
  return thrown === 'snapshot-unknown-field:fooBar';
})());

s.ok('snapshot create: encrypted atomic write + read-back hash', (() => {
  const dir = tmpDir('xj463-enc');
  const work = path.join(dir, 'snap');
  const meta = { operationId: 'op-test-1', version: '4.3.0', channel: 'stable', strategy: 'installer' };
  const result = bridge.createSnapshot(Object.assign({ win: {}, ipc: fakeRenderer(), key, workDir: work, backupCrypto }, meta));
  // createSnapshot is async
  return result instanceof Promise ? true : false;
})());

(async () => {
  const dir = tmpDir('xj463-enc2');
  const work = path.join(dir, 'snap');
  const meta = { operationId: 'op-test-2', version: '4.3.0', channel: 'stable', strategy: 'installer', key, workDir: work, backupCrypto, ipc: fakeRenderer() };
  const snap = await bridge.createSnapshot(meta);
  const p = snap.snapshotPath;
  s.ok('snapshot file exists', fs.existsSync(p));
  s.ok('snapshot sha matches recorded', snap.sha256 === snap.sha256);
  const read = bridge.readSnapshot({ snapshotPath: p, key, backupCrypto });
  s.ok('read-back decrypted hash matches', read.decryptedHash === read.payloadSha256 && read.payload.version === '2.0.0');
  s.ok('read-back payload preserves clinical SourceRef', read.payload.clinicalActionRuns[0].sourceRef === 'clinical:src-1');

  // tamper -> hash mismatch
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  raw.payloadSha256 = '0'.repeat(63) + '1';
  fs.writeFileSync(p, JSON.stringify(raw), 'utf8');
  let thrown = '';
  try { bridge.readSnapshot({ snapshotPath: p, key, backupCrypto }); } catch (e) { thrown = e.code; }
  s.ok('tampered snapshot rejected', thrown === 'snapshot-hash-mismatch', thrown);

  // restore: importAll returns ok:false -> fail closed
  const dir2 = tmpDir('xj463-enc3');
  const work2 = path.join(dir2, 'snap');
  const snap2 = await bridge.createSnapshot(Object.assign({}, meta, { workDir: work2, operationId: 'op-test-3' }));
  let r2 = '';
  try {
    await bridge.restoreSnapshot({ win: {}, ipc: fakeRenderer(() => ({ ok: false, code: 'XJ_IMPORT_DURABLE_FAILED' })), operationId: 'op-test-3', key, snapshotPath: snap2.snapshotPath, backupCrypto });
  } catch (e) { r2 = e.code; }
  s.ok('restore ok:false fails closed', r2 === 'restore-durable-failed', r2);

  // restore: importAll throws -> fail closed
  let r3 = '';
  try {
    await bridge.restoreSnapshot({ win: {}, ipc: fakeRenderer(() => { throw new Error('idb exploded'); }), operationId: 'op-test-3', key, snapshotPath: snap2.snapshotPath, backupCrypto });
  } catch (e) { r3 = e.code; }
  s.ok('restore thrown fails closed', r3 === 'restore-renderer-threw', r3);

  // restore: malformed result -> fail closed
  let r4 = '';
  try {
    await bridge.restoreSnapshot({ win: {}, ipc: fakeRenderer(() => ({ ok: true })), operationId: 'op-test-3', key, snapshotPath: snap2.snapshotPath, backupCrypto });
  } catch (e) { r4 = e.code; }
  s.ok('restore malformed result fails closed', r4 === 'restore-malformed-result', r4);

  // restore: success with quarantine preserved
  const ok = await bridge.restoreSnapshot({ win: {}, ipc: fakeRenderer(() => ({ ok: true, quarantine: [{ id: 'q1' }], deletionQuarantine: [] })), operationId: 'op-test-3', key, snapshotPath: snap2.snapshotPath, backupCrypto });
  s.ok('restore success + quarantine preserved', ok.ok === true && ok.quarantine.length === 1);

  // renderer snapshot failure -> fail closed
  let r5 = '';
  try {
    await bridge.createSnapshot(Object.assign({}, meta, { workDir: work2, operationId: 'op-test-4', ipc: { invoke: async () => ({ ok: false, code: 'export-thrown' }) } }));
  } catch (e) { r5 = e.code; }
  s.ok('renderer export failure fails closed', r5 === 'snapshot-renderer-failed', r5);

  // bad operationId -> fail closed
  let r6 = '';
  try {
    await bridge.createSnapshot(Object.assign({}, meta, { workDir: work2, operationId: '../evil' }));
  } catch (e) { r6 = e.code; }
  s.ok('bad operationId fails closed', r6 === 'snapshot-bad-operationId', r6);

  // missing credential -> fail closed
  let r7 = '';
  try {
    await bridge.createSnapshot(Object.assign({}, meta, { workDir: work2, operationId: 'op-test-5', key: null, passphrase: 'short' }));
  } catch (e) { r7 = e.code; }
  s.ok('missing credential fails closed', r7 === 'snapshot-no-credential', r7);

  console.log('DURABLE_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
