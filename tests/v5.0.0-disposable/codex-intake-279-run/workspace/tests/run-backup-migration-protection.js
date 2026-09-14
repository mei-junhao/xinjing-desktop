'use strict';

const { assert, path, CANDIDATE, syntheticData, makeSnapshotAdapter, expectCode } = require('./_helpers');
const safety = require(path.join(CANDIDATE, 'update', 'safety-snapshot'));

(async () => {
  const initial = syntheticData();
  const adapter = makeSnapshotAdapter({ data: initial });
  const snapshot = await safety.createVerifiedSnapshot(adapter, { currentDataVersion: '1' });
  assert.strictEqual(snapshot.objectCount, 2);
  const migrated = await safety.migrateWithProtection(adapter, snapshot, { currentDataVersion: '1', targetDataVersion: '2' });
  assert.strictEqual(migrated.version, '2');
  assert.strictEqual(adapter.inspect().clients.length, 1);

  const failWrite = makeSnapshotAdapter({ data: initial, failSnapshotWrite: true });
  await expectCode(() => safety.createVerifiedSnapshot(failWrite, { currentDataVersion: '1' }), 'backup-failed');
  assert.deepStrictEqual(failWrite.inspect(), initial);

  const corrupt = makeSnapshotAdapter({ data: initial, corruptSnapshot: true });
  await expectCode(() => safety.createVerifiedSnapshot(corrupt, { currentDataVersion: '1' }), 'backup-failed');
  assert.deepStrictEqual(corrupt.inspect(), initial);

  const failMigration = makeSnapshotAdapter({ data: initial, failMigration: true });
  const failSnapshot = await safety.createVerifiedSnapshot(failMigration, { currentDataVersion: '1' });
  await expectCode(() => safety.migrateWithProtection(failMigration, failSnapshot, { currentDataVersion: '1', targetDataVersion: '2' }), 'migration-failed');
  assert.deepStrictEqual(failMigration.inspect(), initial);

  const failRollback = makeSnapshotAdapter({ data: initial, failMigration: true, failRollback: true });
  const rollbackSnapshot = await safety.createVerifiedSnapshot(failRollback, { currentDataVersion: '1' });
  await expectCode(() => safety.migrateWithProtection(failRollback, rollbackSnapshot, { currentDataVersion: '1', targetDataVersion: '2' }), 'rollback-failed');

  console.log(JSON.stringify({ suite: 'backup-migration-protection', passed: 10, failed: 0 }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
