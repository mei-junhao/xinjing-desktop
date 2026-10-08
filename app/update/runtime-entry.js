'use strict';

const crypto = require('crypto');
const path = require('path');
const { runUpdate, recoverUpdate } = require('./coordinator');

function makeEnv(workDir) {
  return {
    workDir,
    markerPath: path.join(workDir, 'update.marker.json'),
    snapshotPath: path.join(workDir, 'store.snapshot.json')
  };
}

function sha512(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('hex').toUpperCase();
}

function buildSyntheticFeed(version, channel, fileName, bytes, url) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return [
    `version: ${version}`,
    `channel: ${channel}`,
    'artifacts:',
    `- channel: ${channel}`,
    `- version: ${version}`,
    `- fileName: ${fileName}`,
    `- size: ${payload.length}`,
    `- sha512: ${sha512(payload)}`,
    `- url: ${url}`
  ].join('\n');
}

module.exports = { makeEnv, sha512, buildSyntheticFeed, runUpdate, recoverUpdate };
