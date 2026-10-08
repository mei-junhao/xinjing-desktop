'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const candidateRoot = process.env.XJ279_CANDIDATE_ROOT;
if (!candidateRoot) throw new Error('XJ279_CANDIDATE_ROOT required');
const { validateMetadata, verifyArtifact } = require(path.join(candidateRoot, 'update', 'feed-validator'));
const journal = require(path.join(candidateRoot, 'update', 'transaction-journal'));
const safety = require(path.join(candidateRoot, 'update', 'safety-snapshot'));
const strategies = require(path.join(candidateRoot, 'update', 'strategies'));
const { createCoordinator } = require(path.join(candidateRoot, 'update', 'coordinator'));

function artifact(channel) {
  const version = '5.0.0';
  const bytes = Buffer.from(`synthetic-${channel}-${version}-artifact-bytes`);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const name = channel === 'nsis' ? `xinjing-setup-${version}.exe` : `xinjing-portable-${version}.exe`;
  return { version, bytes, sha512, name };
}
function metadata(channel, item) {
  return `version: ${item.version}\nchannel: ${channel}\nfiles:\n  - url: ${item.name}\n    sha512: ${item.sha512}\n    size: ${item.bytes.length}\npath: ${item.name}\nsha512: ${item.sha512}\nreleaseDate: 2026-08-03T04:00:00.000Z\n`;
}
function dataAdapter(options) {
  const opts = options || {};
  let stable = { clients: [{ id: 'c1' }], sessions: [{ id: 's1' }] };
  let snapshot = null;
  return {
    async readStableData() { return JSON.parse(JSON.stringify(stable)); },
    async writeSnapshot(value) { if (opts.backupFail) throw new Error('fail'); snapshot = JSON.parse(JSON.stringify(value)); },
    async readSnapshot() { return JSON.parse(JSON.stringify(snapshot)); },
    async migrate(value) { if (opts.migrationFail) throw new Error('fail'); return Object.assign({}, value, { migrated: [] }); },
    async replaceStableData(value) { stable = JSON.parse(JSON.stringify(value)); },
    inspect() { return JSON.parse(JSON.stringify(stable)); },
  };
}
function strategyAdapter(channel, options) {
  const opts = options || {};
  return {
    async stageInstaller() {}, async install() { return { started: true }; }, async rollbackInstaller(context) { if (opts.rollbackFail) throw new Error('fail'); return { version: context.currentVersion }; },
    async waitForUnlock() { return true; }, async stagePortable() { return { oldVersionPreserved: true }; }, async replacePortable() {}, async restartPortable() { return true; }, async rollbackPortable(context) { if (opts.rollbackFail) throw new Error('fail'); return { version: context.currentVersion, oldVersionPreserved: true }; },
  };
}
function makeRun(channel, options) {
  const opts = options || {};
  const item = artifact(channel);
  const expectedArtifactSha512 = opts.expectedHashMismatch ? Buffer.alloc(64, 9).toString('base64') : item.sha512;
  const adapter = dataAdapter(opts);
  const events = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj279-mutant-target-'));
  const coordinator = createCoordinator({
    journalPath: path.join(dir, 'marker.json'),
    async fetchMetadata() { events.push('check'); return { status: 200, body: metadata(channel, item) }; },
    async confirm() { events.push('confirm'); return opts.confirmed !== false; },
    async downloadArtifact() { events.push('download'); if (opts.downloadFail) throw new Error('fail'); return item.bytes; },
    snapshotAdapter: adapter,
    strategyAdapter: strategyAdapter(channel, opts),
    async healthCheck() { events.push('health'); return !opts.healthFail; },
    async rollback() { events.push('rollback'); if (opts.rollbackFail) throw new Error('fail'); },
  });
  return { coordinator, adapter, events, input: { operationId: `operation-${channel}-mutation`, channel, metadataName: channel === 'nsis' ? 'latest.yml' : 'latest-portable.yml', currentVersion: '4.5.0', targetVersion: '5.0.0', currentDataVersion: '1', targetDataVersion: '2', expectedArtifactSha512 } };
}

(async () => {
  const channelItem = artifact('nsis');
  assert.throws(() => validateMetadata(metadata('portable', artifact('portable')), { channel: 'portable', metadataName: 'latest.yml', currentVersion: '4.5.0' }));
  const validMetadata = validateMetadata(metadata('nsis', channelItem), { channel: 'nsis', metadataName: 'latest.yml', currentVersion: '4.5.0' });
  const sameSizeChanged = Buffer.from(channelItem.bytes); sameSizeChanged[0] ^= 1;
  assert.throws(() => verifyArtifact(validMetadata, Buffer.concat([channelItem.bytes, Buffer.from('extra')])));
  assert.throws(() => verifyArtifact(validMetadata, sameSizeChanged));
  assert.throws(() => validateMetadata(metadata('nsis', Object.assign({}, channelItem, { name: '../escape.exe' })), { channel: 'nsis', metadataName: 'latest.yml', currentVersion: '4.5.0' }));
  assert.throws(() => validateMetadata(metadata('nsis', Object.assign({}, channelItem, { version: '4.4.9' })), { channel: 'nsis', metadataName: 'latest.yml', currentVersion: '4.5.0' }));
  const declined = makeRun('nsis', { confirmed: false });
  const declinedResult = await declined.coordinator.run(declined.input);
  assert.strictEqual(declinedResult.state, 'awaiting-confirmation');
  assert.deepStrictEqual(declined.events, ['check', 'confirm']);
  const download = makeRun('nsis', { downloadFail: true });
  assert.strictEqual((await download.coordinator.run(download.input)).errorCode, 'download-failed');
  assert(!download.events.includes('health'));
  const staleMetadata = makeRun('nsis', { expectedHashMismatch: true });
  assert.strictEqual((await staleMetadata.coordinator.run(staleMetadata.input)).errorCode, 'metadata-invalid');
  const backup = makeRun('nsis', { backupFail: true });
  assert.strictEqual((await backup.coordinator.run(backup.input)).errorCode, 'backup-failed');
  assert.strictEqual(backup.adapter.inspect().clients.length, 1);
  const migration = makeRun('nsis', { migrationFail: true });
  assert.strictEqual((await migration.coordinator.run(migration.input)).errorCode, 'migration-failed');
  assert.strictEqual(migration.adapter.inspect().sessions.length, 1);
  const health = makeRun('portable', { healthFail: true });
  assert.strictEqual((await health.coordinator.run(health.input)).errorCode, 'health-check-failed');
  const rollback = makeRun('portable', { healthFail: true, rollbackFail: true });
  assert.strictEqual((await rollback.coordinator.run(rollback.input)).errorCode, 'rollback-failed');
  const portableContext = { channel: 'portable', currentVersion: '4.5.0', targetVersion: '5.0.0', rollbackVersion: '4.5.0', verifiedArtifact: { channel: 'nsis', version: '5.0.0', sha512: channelItem.sha512 } };
  await assert.rejects(() => strategies.runPortable(strategyAdapter('portable'), portableContext));
  const invalidRollbackAdapter = strategyAdapter('nsis');
  invalidRollbackAdapter.install = async () => ({ started: false });
  invalidRollbackAdapter.rollbackInstaller = async () => ({ version: '0.0.0' });
  const nsisContext = { channel: 'nsis', currentVersion: '4.5.0', targetVersion: '5.0.0', rollbackVersion: '4.5.0', verifiedArtifact: { channel: 'nsis', version: '5.0.0', sha512: channelItem.sha512 } };
  await assert.rejects(() => strategies.runNsis(invalidRollbackAdapter, nsisContext), (error) => error.code === 'rollback-failed');
  assert.throws(() => journal.createRecord({ operationId: 'operation-invalid-hash', version: '5.0.0', channel: 'nsis', artifactSha512: 'bad' }));
  let committed = journal.createRecord({ operationId: 'operation-stale-mutation', version: '5.0.0', channel: 'nsis', artifactSha512: channelItem.sha512 });
  for (const state of ['awaiting-confirmation', 'downloading', 'verified', 'backup-created', 'staged', 'restarting', 'health-check', 'committed']) committed = journal.transition(committed, state);
  assert.strictEqual(journal.chooseRecovery(committed, Object.assign({}, committed, { state: 'health-check', sequence: committed.sequence + 1, updatedAt: new Date().toISOString() })).state, 'committed');
  assert.throws(() => journal.validateRecord(Object.assign({}, committed, { token: 'secret' })));
  const source = fs.readFileSync(path.join(candidateRoot, 'update', 'coordinator.js'), 'utf8');
  assert(!/https?:\/\//.test(source));
  assert(!source.includes('deleteStableData'));
  console.log(JSON.stringify({ suite: 'mutation-target', passed: 20, failed: 0 }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
