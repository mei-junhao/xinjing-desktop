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

  // 2026-09-14（更新功能「一次失败即永久失效」根因修复）：回滚必须总能走到终态。
  // 原实现把「写 failed 标记」与「回滚动作」放进同一个 try：任何回滚动作抛错
  // （生产 nsis 路径的 rollback.previous 恒为 null，见 main.js previousInstallerPath: null
  //  -> rollback-previous-missing）都会让标记永远停在非终态 failed；而 writeMarker
  // 对任何新 operationId 一律 operation-conflict，于是更新功能被永久锁死，
  // 且全代码库没有任何删除该标记的路径（cleanupTransient 明确「保留 marker」）。
  // 冻结契约本就要求「终态 rolled-back + 保留原始错误码」，见
  // tests/v5.0.0-production/external-g7-update-integrity/coordinator-production.js
  // 的 'health fail -> rolled back'；该用例只在自造了 previousInstaller 的情况下通过，
  // 生产中 previousInstaller 为 null 故必然落回 failed —— 此处让生产接线回到契约。
  const rollback = async (code) => {
    const recoveryErrors = [];
    await transition(STATES.failed, code);
    // 回滚动作改为 best-effort：只记录失败，绝不阻断终态写入。
    try {
      if (strategy) rollbackStrategy(strategy, env);
    } catch (error) {
      recoveryErrors.push(String((error && error.code) || (error && error.message) || 'rollback-strategy-failed'));
    }
    if (snapshot && input.durableStore) {
      try {
        restoreVerifiedSnapshot(env.snapshotPath);
        const restored = verifyRestoredData(env.snapshotPath, input.durableStore);
        if (!restored) recoveryErrors.push('restore-verify-failed');
      } catch (error) {
        recoveryErrors.push(String((error && error.code) || 'snapshot-restore-failed'));
      }
    }
    try {
      await transition(STATES.rolledBack, code);
    } catch (error) {
      return { ok: false, state: STATES.failed, code, rolledBack: false, recoveryErrors, events };
    }
    // code 始终是原始失败原因（如 health-check-failed），不被次级回滚错误掩盖。
    return { ok: false, state: STATES.rolledBack, code, rolledBack: recoveryErrors.length === 0, recoveryErrors, events };
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
