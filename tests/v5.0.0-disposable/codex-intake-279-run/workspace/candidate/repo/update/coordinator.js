'use strict';

const { validateMetadata, verifyArtifact } = require('./feed-validator');
const journal = require('./transaction-journal');
const safety = require('./safety-snapshot');
const strategies = require('./strategies');

function stableResult(ok, phase, record, errorCode) {
  return Object.freeze({ ok, phase, operationId: record.operationId, state: record.state, errorCode: errorCode || null, version: record.version, channel: record.channel });
}

function createCoordinator(deps) {
  if (!deps || typeof deps.fetchMetadata !== 'function' || typeof deps.downloadArtifact !== 'function' || typeof deps.confirm !== 'function' ||
      typeof deps.healthCheck !== 'function' || !deps.journalPath || !deps.snapshotAdapter || !deps.strategyAdapter) {
    throw new TypeError('invalid coordinator dependencies');
  }

  async function persist(record) {
    journal.writeAtomic(deps.journalPath, record, deps.journalIo);
    return record;
  }

  async function fail(record, code) {
    let failed = record;
    if (record.state !== 'failed' && record.state !== 'committed' && record.state !== 'rolled-back') {
      failed = await persist(journal.transition(record, 'failed', { errorCode: code }));
    }
    if (failed.state === 'failed' && typeof deps.rollback === 'function') {
      try {
        await deps.rollback({ record: failed });
        const rolledBack = await persist(journal.transition(failed, 'rolled-back'));
        return stableResult(false, 'rollback', rolledBack, code);
      } catch (_) {
        return stableResult(false, 'rollback', failed, 'rollback-failed');
      }
    }
    return stableResult(false, 'failed', failed, code);
  }

  async function run(input) {
    const base = journal.createRecord({
      operationId: input.operationId,
      version: input.targetVersion,
      channel: input.channel,
      artifactSha512: input.expectedArtifactSha512,
    });
    let record = await persist(base);
    let metadata;
    try {
      const response = await deps.fetchMetadata({ channel: input.channel, metadataName: input.metadataName });
      if (!response || response.status !== 200 || typeof response.body !== 'string') return fail(record, 'feed-unavailable');
      metadata = validateMetadata(response.body, { channel: input.channel, metadataName: input.metadataName, currentVersion: input.currentVersion });
      if (metadata.version !== input.targetVersion || metadata.sha512 !== input.expectedArtifactSha512) return fail(record, 'metadata-invalid');
    } catch (error) {
      return fail(record, error && error.code === 'channel-mismatch' ? 'channel-mismatch' : (error && error.code === 'metadata-invalid' ? 'metadata-invalid' : 'feed-unavailable'));
    }
    record = await persist(journal.transition(record, 'awaiting-confirmation'));
    const confirmed = await deps.confirm({ version: metadata.version, channel: metadata.channel });
    if (confirmed !== true) return stableResult(false, 'confirmation', record, null);
    record = await persist(journal.transition(record, 'downloading'));
    let bytes;
    try { bytes = await deps.downloadArtifact(metadata); } catch (_) { return fail(record, 'download-failed'); }
    let verified;
    try { verified = verifyArtifact(metadata, bytes); } catch (_) { return fail(record, 'artifact-mismatch'); }
    record = await persist(journal.transition(record, 'verified'));
    let snapshot;
    try {
      snapshot = await safety.createVerifiedSnapshot(deps.snapshotAdapter, { currentDataVersion: input.currentDataVersion, operationId: input.operationId });
    } catch (_) { return fail(record, 'backup-failed'); }
    record = await persist(journal.transition(record, 'backup-created'));
    try {
      await safety.migrateWithProtection(deps.snapshotAdapter, snapshot, { currentDataVersion: input.currentDataVersion, targetDataVersion: input.targetDataVersion, operationId: input.operationId });
    } catch (error) { return fail(record, error && error.code === 'rollback-failed' ? 'rollback-failed' : 'migration-failed'); }
    try {
      const context = {
        channel: input.channel,
        currentVersion: input.currentVersion,
        targetVersion: input.targetVersion,
        rollbackVersion: input.currentVersion,
        verifiedArtifact: verified,
        operationId: input.operationId,
      };
      if (input.channel === 'nsis') await strategies.runNsis(deps.strategyAdapter, context);
      else await strategies.runPortable(deps.strategyAdapter, context);
    } catch (error) { return fail(record, error && error.code === 'rollback-failed' ? 'rollback-failed' : 'replacement-failed'); }
    record = await persist(journal.transition(record, 'staged'));
    record = await persist(journal.transition(record, 'restarting'));
    record = await persist(journal.transition(record, 'health-check'));
    try {
      const healthy = await deps.healthCheck({ operationId: input.operationId, version: input.targetVersion, channel: input.channel });
      if (healthy !== true) return fail(record, 'health-check-failed');
    } catch (_) { return fail(record, 'health-check-failed'); }
    record = await persist(journal.transition(record, 'committed'));
    return stableResult(true, 'commit', record, null);
  }

  function recover(incoming) {
    const existing = journal.read(deps.journalPath, deps.journalIo);
    return journal.chooseRecovery(existing, incoming);
  }

  return Object.freeze({ run, recover });
}

module.exports = { createCoordinator };
