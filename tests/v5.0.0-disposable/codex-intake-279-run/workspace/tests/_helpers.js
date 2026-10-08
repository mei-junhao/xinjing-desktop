'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN = path.resolve(__dirname, '..', '..');
const CANDIDATE = path.join(RUN, 'workspace', 'candidate', 'repo');

function artifact(channel, version) {
  const bytes = Buffer.from(`synthetic-${channel}-${version}-artifact-bytes`, 'utf8');
  return {
    bytes,
    sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
    size: bytes.length,
    name: channel === 'nsis' ? `xinjing-setup-${version}.exe` : `xinjing-portable-${version}.exe`,
  };
}

function metadata(channel, version, item, overrides) {
  const values = Object.assign({
    version,
    channel,
    url: item.name,
    fileSha: item.sha512,
    rootSha: item.sha512,
    size: item.size,
    path: item.name,
    releaseDate: '2026-08-03T04:00:00.000Z',
  }, overrides || {});
  return [
    `version: ${values.version}`,
    `channel: ${values.channel}`,
    'files:',
    `  - url: ${values.url}`,
    `    sha512: ${values.fileSha}`,
    `    size: ${values.size}`,
    `path: ${values.path}`,
    `sha512: ${values.rootSha}`,
    `releaseDate: ${values.releaseDate}`,
    '',
  ].join('\n');
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function syntheticData() {
  return { clients: [{ id: 'synthetic-client-1' }], sessions: [{ id: 'synthetic-session-1' }], notes: [] };
}

function makeSnapshotAdapter(options) {
  const opts = options || {};
  let stable = JSON.parse(JSON.stringify(opts.data || syntheticData()));
  let snapshot = null;
  return {
    async readStableData() { return JSON.parse(JSON.stringify(stable)); },
    async writeSnapshot(value) { if (opts.failSnapshotWrite) throw new Error('synthetic snapshot write failure'); snapshot = JSON.parse(JSON.stringify(value)); },
    async readSnapshot() { if (opts.corruptSnapshot) return Object.assign({}, snapshot, { payloadHash: '0'.repeat(64) }); return JSON.parse(JSON.stringify(snapshot)); },
    async migrate(value) { if (opts.failMigration) throw new Error('synthetic migration failure'); return Object.assign({}, value, { migration: [{ version: '2' }] }); },
    async replaceStableData(value, context) { if (opts.failRollback && context && context.rollback) throw new Error('synthetic rollback failure'); stable = JSON.parse(JSON.stringify(value)); },
    inspect() { return JSON.parse(JSON.stringify(stable)); },
  };
}

function makeStrategyAdapter(channel, options) {
  const opts = options || {};
  const calls = [];
  const adapter = {
    calls,
    async stageInstaller() { calls.push('stage-installer'); if (opts.failStage) throw new Error('fail'); },
    async install() { calls.push('install'); return opts.failInstall ? { started: false } : { started: true }; },
    async rollbackInstaller(context) { calls.push('rollback-installer'); if (opts.failRollback) throw new Error('fail'); return { version: context.currentVersion }; },
    async waitForUnlock() { calls.push('wait-unlock'); return !opts.failUnlock; },
    async stagePortable() { calls.push('stage-portable'); return { oldVersionPreserved: !opts.dropOld }; },
    async replacePortable() { calls.push('replace-portable'); if (opts.failReplace) throw new Error('fail'); },
    async restartPortable() { calls.push('restart-portable'); return !opts.failRestart; },
    async rollbackPortable(context) { calls.push('rollback-portable'); if (opts.failRollback) throw new Error('fail'); return { version: context.currentVersion, oldVersionPreserved: true }; },
  };
  return adapter;
}

async function expectCode(fn, code) {
  let caught = null;
  try { await fn(); } catch (error) { caught = error; }
  assert(caught, `expected error ${code}`);
  assert.strictEqual(caught.code, code);
}

module.exports = { assert, crypto, fs, os, path, RUN, CANDIDATE, artifact, metadata, tempDir, syntheticData, makeSnapshotAdapter, makeStrategyAdapter, expectCode };
