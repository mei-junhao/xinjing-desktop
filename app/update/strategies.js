'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha512(bytes) { return crypto.createHash('sha512').update(bytes).digest('hex').toUpperCase(); }

function artifactKind(fileName) {
  if (/^xinjing-setup-\d+\.\d+\.\d+\.exe$/.test(fileName)) return 'nsis';
  if (/^xinjing-portable-\d+\.\d+\.\d+\.exe$/.test(fileName)) return 'portable';
  return null;
}

function assertArtifactMatches(artifact, metadata) {
  if (!artifact || !Buffer.isBuffer(artifact.bytes)) { const e = new Error('artifact-missing'); e.code = 'artifact-missing'; throw e; }
  if (artifact.fileName !== metadata.fileName) { const e = new Error('artifact-filename-mismatch'); e.code = 'artifact-filename-mismatch'; throw e; }
  if (artifact.bytes.length !== metadata.size) { const e = new Error('artifact-size-mismatch'); e.code = 'artifact-size-mismatch'; throw e; }
  if (sha512(artifact.bytes) !== metadata.sha512) { const e = new Error('artifact-sha512-mismatch'); e.code = 'artifact-sha512-mismatch'; throw e; }
}

function nsisStrategy(artifact, metadata, env) {
  if (artifactKind(artifact.fileName) !== 'nsis') { const e = new Error('nsis-rejects-portable'); e.code = 'nsis-rejects-portable'; throw e; }
  assertArtifactMatches(artifact, metadata);
  const stagedPath = path.join(env.workDir, 'staged-installer.exe');
  fs.writeFileSync(stagedPath, artifact.bytes);
  return { ok: true, kind: 'nsis', stagedPath, stageSha512: sha512(fs.readFileSync(stagedPath)), rollback: { previous: env.previousInstaller || null } };
}

function portableStrategy(artifact, metadata, env) {
  if (artifactKind(artifact.fileName) !== 'portable') { const e = new Error('portable-rejects-nsis'); e.code = 'portable-rejects-nsis'; throw e; }
  assertArtifactMatches(artifact, metadata);
  const current = path.join(env.workDir, 'current-portable.exe');
  const previous = path.join(env.workDir, 'previous-portable.exe');
  if (fs.existsSync(current)) fs.renameSync(current, previous);
  fs.writeFileSync(current, artifact.bytes);
  return { ok: true, kind: 'portable', current, previous, prevPath: previous, newSha512: sha512(fs.readFileSync(current)), rollback: { previous } };
}

function rollbackStrategy(result, env) {
  const previous = result && result.rollback && result.rollback.previous;
  if (!previous || !fs.existsSync(previous)) { const e = new Error('rollback-previous-missing'); e.code = 'rollback-previous-missing'; throw e; }
  const target = result.kind === 'portable' ? path.join(env.workDir, 'current-portable.exe') : path.join(env.workDir, 'staged-installer.exe');
  fs.renameSync(previous, target);
  return { ok: true, restored: target };
}

module.exports = { sha512, artifactKind, assertArtifactMatches, nsisStrategy, portableStrategy, rollbackStrategy };
