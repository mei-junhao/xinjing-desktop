'use strict';

const { assert, fs, path, CANDIDATE, artifact, metadata, tempDir, makeSnapshotAdapter, makeStrategyAdapter } = require('./_helpers');
const { createCoordinator } = require(path.join(CANDIDATE, 'update', 'coordinator'));
const { registerUpdateIntegrityIpc } = require(path.join(CANDIDATE, 'update', 'runtime-entry'));

function makeRun(channel, options) {
  const opts = options || {};
  const item = artifact(channel, '5.0.0');
  const dir = tempDir(`xj279-${channel}-`);
  const snapshotAdapter = makeSnapshotAdapter(opts.snapshot || {});
  const strategyAdapter = makeStrategyAdapter(channel, opts.strategy || {});
  const events = [];
  const coordinator = createCoordinator({
    journalPath: path.join(dir, 'marker.json'),
    async fetchMetadata() { events.push('check'); if (opts.feedFail) return { status: 503, body: '' }; return { status: 200, body: metadata(channel, '5.0.0', item) }; },
    async confirm() { events.push('confirm'); return opts.confirmed !== false; },
    async downloadArtifact() { events.push('download'); if (opts.downloadFail) throw new Error('fail'); return opts.badBytes ? Buffer.from('bad') : item.bytes; },
    snapshotAdapter,
    strategyAdapter,
    async healthCheck() { events.push('health'); return !opts.healthFail; },
    async rollback() { events.push('rollback'); if (opts.rollbackFail) throw new Error('fail'); return true; },
  });
  const input = { operationId: `operation-${channel}-${Date.now()}`, channel, metadataName: channel === 'nsis' ? 'latest.yml' : 'latest-portable.yml', currentVersion: '4.5.0', targetVersion: '5.0.0', currentDataVersion: '1', targetDataVersion: '2', expectedArtifactSha512: item.sha512 };
  return { coordinator, input, events, dir, snapshotAdapter, strategyAdapter };
}

(async () => {
  const ipcHandlers = new Map();
  const ipcMain = { handle(name, handler) { ipcHandlers.set(name, handler); } };
  const runs = {};
  registerUpdateIntegrityIpc({
    ipcMain,
    inputFactory(request) { const run = makeRun(request.channel, request.options); runs[request.channel] = run; return run.input; },
    createCoordinator(channel) { return runs[channel].coordinator; },
  });
  assert(ipcHandlers.has('xj:update-integrity:run'));
  const nsis = await ipcHandlers.get('xj:update-integrity:run')(null, { channel: 'nsis' });
  assert.strictEqual(nsis.ok, true);
  assert.deepStrictEqual(runs.nsis.events, ['check', 'confirm', 'download', 'health']);
  const portable = await ipcHandlers.get('xj:update-integrity:run')(null, { channel: 'portable' });
  assert.strictEqual(portable.ok, true);

  const declined = makeRun('nsis', { confirmed: false });
  const declinedResult = await declined.coordinator.run(declined.input);
  assert.strictEqual(declinedResult.state, 'awaiting-confirmation');
  assert.deepStrictEqual(declined.events, ['check', 'confirm']);

  const healthFail = makeRun('portable', { healthFail: true });
  const healthResult = await healthFail.coordinator.run(healthFail.input);
  assert.strictEqual(healthResult.ok, false);
  assert.strictEqual(healthResult.errorCode, 'health-check-failed');
  assert(healthFail.events.includes('rollback'));

  const downloadFail = makeRun('nsis', { downloadFail: true });
  const downloadResult = await downloadFail.coordinator.run(downloadFail.input);
  assert.strictEqual(downloadResult.errorCode, 'download-failed');
  assert(!downloadFail.events.includes('health'));

  const source = fs.readFileSync(path.join(CANDIDATE, 'main.js'), 'utf8');
  assert(source.includes("ipcMain.handle('xj:check-updates'"));
  assert(source.includes('autoUpdater.autoDownload = false'));

  const electronAvailable = (() => { try { require.resolve('electron', { paths: [CANDIDATE] }); return true; } catch (_) { return false; } })();
  console.log(JSON.stringify({ suite: 'electron-update-runtime', passed: 13, failed: 0, realElectronProcess: electronAvailable ? 'not-launched-by-contract-no-complete-frozen-app' : 'blocked-electron-module-unavailable', candidateIpcRuntime: 'confirmed', realSourceEntryObserved: 'xj:check-updates' }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
