'use strict';

const { assert, fs, path, CANDIDATE, artifact, tempDir, expectCode } = require('./_helpers');
const journal = require(path.join(CANDIDATE, 'update', 'transaction-journal'));

(async () => {
  const item = artifact('nsis', '5.0.0');
  let record = journal.createRecord({ operationId: 'operation-0001', version: '5.0.0', channel: 'nsis', artifactSha512: item.sha512 });
  const states = ['awaiting-confirmation', 'downloading', 'verified', 'backup-created', 'staged', 'restarting', 'health-check', 'committed'];
  for (const state of states) record = journal.transition(record, state);
  assert.strictEqual(record.state, 'committed');
  await expectCode(() => journal.transition(record, 'failed', { errorCode: 'health-check-failed' }), 'invalid-transition');
  let failed = journal.createRecord({ operationId: 'operation-0002', version: '5.0.0', channel: 'nsis', artifactSha512: item.sha512 });
  failed = journal.transition(failed, 'failed', { errorCode: 'metadata-invalid' });
  failed = journal.transition(failed, 'rolled-back');
  assert.strictEqual(failed.state, 'rolled-back');
  const dir = tempDir('xj279-journal-');
  const marker = path.join(dir, 'marker.json');
  journal.writeAtomic(marker, record);
  assert.deepStrictEqual(journal.read(marker), record);
  fs.writeFileSync(marker, '{"partial":', 'utf8');
  await expectCode(() => journal.read(marker), 'journal-invalid');
  const committed = record;
  const older = Object.assign({}, committed, { state: 'health-check', sequence: committed.sequence - 1 });
  assert.strictEqual(journal.chooseRecovery(committed, older).state, 'committed');
  const other = journal.createRecord({ operationId: 'operation-9999', version: '5.0.0', channel: 'nsis', artifactSha512: item.sha512 });
  await expectCode(() => journal.chooseRecovery(committed, other), 'stale-pending');
  await expectCode(() => journal.validateRecord(Object.assign({}, committed, { token: 'forbidden' })), 'journal-sensitive-or-unknown-field');
  const brokenIo = Object.assign({}, fs, { renameSync() { throw new Error('synthetic rename failure'); } });
  await expectCode(() => journal.writeAtomic(path.join(dir, 'broken.json'), committed, brokenIo), 'journal-write-failed');
  journal.writeAtomic(marker, committed);
  let renameCount = 0;
  const replacementFailIo = Object.assign({}, fs, { renameSync(source, target) { renameCount += 1; if (renameCount === 2) throw new Error('synthetic replacement rename failure'); return fs.renameSync(source, target); } });
  const advanced = Object.assign({}, committed, { updatedAt: new Date().toISOString(), sequence: committed.sequence + 1 });
  await expectCode(() => journal.writeAtomic(marker, advanced, replacementFailIo), 'journal-write-failed');
  assert.strictEqual(journal.read(marker).state, 'committed');
  console.log(JSON.stringify({ suite: 'update-state-machine', passed: 17, failed: 0, finalState: committed.state }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
