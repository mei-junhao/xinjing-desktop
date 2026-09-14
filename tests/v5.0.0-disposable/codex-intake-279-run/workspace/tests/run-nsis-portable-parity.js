'use strict';

const { assert, path, CANDIDATE, artifact, makeStrategyAdapter, expectCode } = require('./_helpers');
const strategies = require(path.join(CANDIDATE, 'update', 'strategies'));

function context(channel) {
  const item = artifact(channel, '5.0.0');
  return { channel, currentVersion: '4.5.0', targetVersion: '5.0.0', rollbackVersion: '4.5.0', operationId: `operation-${channel}`, verifiedArtifact: { channel, version: '5.0.0', artifact: item.name, sha512: item.sha512, bytes: item.size } };
}

(async () => {
  const nsis = makeStrategyAdapter('nsis');
  assert.strictEqual((await strategies.runNsis(nsis, context('nsis'))).state, 'restarting');
  assert.deepStrictEqual(nsis.calls, ['stage-installer', 'install']);
  const portable = makeStrategyAdapter('portable');
  assert.strictEqual((await strategies.runPortable(portable, context('portable'))).state, 'restarting');
  assert.deepStrictEqual(portable.calls, ['wait-unlock', 'stage-portable', 'replace-portable', 'restart-portable']);
  await expectCode(() => strategies.runNsis(makeStrategyAdapter('nsis'), context('portable')), 'channel-mismatch');
  await expectCode(() => strategies.runPortable(makeStrategyAdapter('portable'), context('nsis')), 'channel-mismatch');
  const nsisFail = makeStrategyAdapter('nsis', { failInstall: true });
  await expectCode(() => strategies.runNsis(nsisFail, context('nsis')), 'replacement-failed');
  assert(nsisFail.calls.includes('rollback-installer'));
  const portableFail = makeStrategyAdapter('portable', { failReplace: true });
  await expectCode(() => strategies.runPortable(portableFail, context('portable')), 'replacement-failed');
  assert(portableFail.calls.includes('rollback-portable'));
  const rollbackFail = makeStrategyAdapter('portable', { failRestart: true, failRollback: true });
  await expectCode(() => strategies.runPortable(rollbackFail, context('portable')), 'rollback-failed');
  console.log(JSON.stringify({ suite: 'nsis-portable-parity', passed: 11, failed: 0 }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
