'use strict';

function strategyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertContext(context, channel) {
  if (!context || context.channel !== channel || !context.verifiedArtifact || context.verifiedArtifact.channel !== channel ||
      context.verifiedArtifact.version !== context.targetVersion || context.rollbackVersion !== context.currentVersion) {
    throw strategyError('channel-mismatch');
  }
}

async function runNsis(adapter, context) {
  assertContext(context, 'nsis');
  if (!adapter || typeof adapter.stageInstaller !== 'function' || typeof adapter.install !== 'function' || typeof adapter.rollbackInstaller !== 'function') {
    throw strategyError('replacement-failed');
  }
  try {
    await adapter.stageInstaller(context.verifiedArtifact, context);
    const installResult = await adapter.install(context);
    if (!installResult || installResult.started !== true) throw strategyError('replacement-failed');
    return { strategy: 'nsis', state: 'restarting', previousVersionPreserved: true };
  } catch (error) {
    try {
      const rollback = await adapter.rollbackInstaller(context);
      if (!rollback || rollback.version !== context.currentVersion) throw strategyError('rollback-failed');
    } catch (rollbackError) {
      throw strategyError('rollback-failed');
    }
    throw strategyError('replacement-failed');
  }
}

async function runPortable(adapter, context) {
  assertContext(context, 'portable');
  if (!adapter || typeof adapter.waitForUnlock !== 'function' || typeof adapter.stagePortable !== 'function' || typeof adapter.replacePortable !== 'function' || typeof adapter.restartPortable !== 'function' || typeof adapter.rollbackPortable !== 'function') {
    throw strategyError('replacement-failed');
  }
  try {
    const unlocked = await adapter.waitForUnlock(context);
    if (unlocked !== true) throw strategyError('replacement-failed');
    const staged = await adapter.stagePortable(context.verifiedArtifact, context);
    if (!staged || staged.oldVersionPreserved !== true) throw strategyError('replacement-failed');
    await adapter.replacePortable(context);
    const restarted = await adapter.restartPortable(context);
    if (restarted !== true) throw strategyError('replacement-failed');
    return { strategy: 'portable', state: 'restarting', previousVersionPreserved: true };
  } catch (error) {
    try {
      const rollback = await adapter.rollbackPortable(context);
      if (!rollback || rollback.version !== context.currentVersion || rollback.oldVersionPreserved !== true) throw strategyError('rollback-failed');
    } catch (rollbackError) {
      throw strategyError('rollback-failed');
    }
    throw strategyError('replacement-failed');
  }
}

module.exports = { strategyError, runNsis, runPortable };
