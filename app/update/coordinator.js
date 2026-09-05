'use strict';

const { STATES, makeMarker, writeMarker, readMarker, recover } = require('./transaction-journal');
const { validateFeed } = require('./feed-validator');
const { nsisStrategy, portableStrategy, rollbackStrategy, assertArtifactMatches } = require('./strategies');
const { migrateWithProtection, restoreVerifiedSnapshot, verifyRestoredData } = require('./safety-snapshot');

const MAX_RETRIES = 3;

function markerFor(input, state, sequence, meta, errorCode) {
  return makeMarker({
    operationId: input.operationId,
    version: meta ? meta.version : input.currentVersion,
    channel: input.channel,
    artifactSha512: meta ? meta.sha512 : '0'.repeat(128),
    state,
    sequence,
    errorCode: errorCode || null
  });
}

async function runUpdate(inputFactory, env) {
  const input = await inputFactory(env);
  const operationId = input.operationId || `op-${input.channel}-${Date.now()}`;
  input.operationId = operationId;
  let sequence = 0;
  let metadata = null;
  let strategy = null;
  let snapshot = null;
  let state = STATES.discovered;
  const events = [];

  const transition = async (nextState, errorCode) => {
    const marker = markerFor(input, nextState, sequence++, metadata, errorCode);
    writeMarker(env.markerPath, marker);
    state = nextState;
    events.push(nextState);
    return marker;
  };

  const rollback = async (code) => {
    try {
      await transition(STATES.failed, code);
      if (strategy) rollbackStrategy(strategy, env);
      if (snapshot && input.durableStore) {
        restoreVerifiedSnapshot(env.snapshotPath);
        const restored = verifyRestoredData(env.snapshotPath, input.durableStore);
        if (!restored) throw Object.assign(new Error('restore verification failed'), { code: 'restore-verify-failed' });
      }
      await transition(STATES.rolledBack, code);
      return { ok: false, state: STATES.rolledBack, code, rolledBack: true, events };
    } catch (error) {
      return { ok: false, state: STATES.failed, code: error.code || 'rollback-failed', rolledBack: false, events };
    }
  };

  try {
    await transition(STATES.discovered);
    await transition(STATES.awaitingConfirmation);
    const confirmed = await input.confirmDecision();
    if (confirmed !== true) return await rollback('declined-by-user');

    await transition(STATES.downloading);
    let attempt = 0;
    for (;;) {
      try {
        metadata = validateFeed({ currentVersion: input.currentVersion, channel: input.channel, feedText: input.feedText, fetchAdapter: input.fetchAdapter });
        break;
      } catch (error) {
        if (attempt >= MAX_RETRIES) throw error;
        attempt += 1;
        await Promise.resolve(input.retryDelay ? input.retryDelay(attempt) : undefined);
      }
    }

    await transition(STATES.verified);
    const artifact = await input.artifactProvider(metadata);
    assertArtifactMatches(artifact, metadata);
    if ((input.strategyKind === 'nsis' && !metadata.fileName.startsWith('xinjing-setup-')) || (input.strategyKind === 'portable' && !metadata.fileName.startsWith('xinjing-portable-'))) {
      throw Object.assign(new Error('strategy artifact mismatch'), { code: 'strategy-artifact-mismatch' });
    }

    await transition(STATES.backupCreated);
    snapshot = migrateWithProtection(env.snapshotPath, input.durableStore, input.migrateFn, { version: metadata.version, channel: input.channel });
    if (!snapshot.ok) {
      if (!verifyRestoredData(env.snapshotPath, input.durableStore)) throw Object.assign(new Error('restore verification failed'), { code: 'restore-verify-failed' });
      throw Object.assign(new Error('migration failed'), { code: snapshot.code });
    }

    await transition(STATES.staged);
    strategy = input.strategyKind === 'nsis' ? nsisStrategy(artifact, metadata, env) : portableStrategy(artifact, metadata, env);
    await transition(STATES.restarting);
    if (typeof input.onRestart === 'function') await input.onRestart(strategy);
    await transition(STATES.healthCheck);
    const health = await input.healthCheckFn(strategy);
    if (!health || health.ok !== true) throw Object.assign(new Error('health-check failed'), { code: 'health-check-failed' });
    await transition(STATES.committed);
    return { ok: true, state: STATES.committed, version: metadata.version, channel: input.channel, events };
  } catch (error) {
    return await rollback(error.code || 'update-failed');
  }
}

async function recoverUpdate(markerPath, expectedChannel) {
  const marker = recover(markerPath, expectedChannel);
  return { ok: true, state: marker.state, version: marker.version, channel: marker.channel };
}

module.exports = { runUpdate, recoverUpdate, MAX_RETRIES, STATES };
