'use strict';
// env-adapter.js — production environment adapter (decision: env).
// Bounds marker/snapshot/portable staging paths to userData and provides the
// production file layout the coordinator + adapters consume. Every path is
// userData-scoped, operation-bounded and atomic-write safe; no path crosses
// into shared or live directories.

const path = require('path');
const { makeEnv } = require('./runtime-entry');

// Production update directory under the canonical userData dir.
function productionEnv(userDataDir, previousInstallerPath) {
  const workDir = path.join(userDataDir, 'update-integrity');
  const base = makeEnv(workDir);
  return Object.assign(base, {
    workDir,
    markerPath: path.join(workDir, 'update.marker.json'),
    snapshotPath: path.join(workDir, 'store.snapshot.json'),
    portableWorkDir: path.join(workDir, 'portable'),
    previousInstaller: previousInstallerPath || null,
    // COS-only authority; no fallback provider is ever configured.
    feedAuthority: 'cos',
    channel: 'stable'
  });
}

function assertBounded(env) {
  const userData = path.resolve(env.workDir.split(path.sep + 'update-integrity')[0]);
  for (const key of ['workDir', 'markerPath', 'snapshotPath', 'portableWorkDir']) {
    const value = env[key];
    if (!value || path.resolve(value).indexOf(userData + path.sep) !== 0 && path.resolve(value) !== userData) {
      const error = new Error('env path out of bounds: ' + key);
      error.code = 'env-path-out-of-bounds';
      throw error;
    }
  }
  return true;
}

module.exports = { productionEnv, assertBounded };
