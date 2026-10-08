'use strict';

const crypto = require('crypto');
const path = require('path');

const CHANNELS = Object.freeze({
  nsis: Object.freeze({ metadata: 'latest.yml', artifact: /^xinjing-setup-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.exe$/ }),
  portable: Object.freeze({ metadata: 'latest-portable.yml', artifact: /^xinjing-portable-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.exe$/ }),
});
const MAX_METADATA_BYTES = 64 * 1024;

function updateError(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
  return value;
}

function parseMetadata(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) {
    throw updateError('metadata-invalid');
  }
  const result = {};
  let currentFile = null;
  const files = [];
  const seenTop = new Set();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (/\t/.test(raw)) throw updateError('metadata-invalid');
    let match = raw.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) {
      const key = match[1];
      if (key === 'files') {
        if (seenTop.has(key) || match[2].trim()) throw updateError('metadata-invalid');
        seenTop.add(key);
        result.files = files;
        currentFile = null;
        continue;
      }
      if (seenTop.has(key)) throw updateError('metadata-invalid');
      seenTop.add(key);
      result[key] = parseScalar(match[2]);
      currentFile = null;
      continue;
    }
    match = raw.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match && result.files === files) {
      currentFile = {};
      files.push(currentFile);
      currentFile[match[1]] = parseScalar(match[2]);
      continue;
    }
    match = raw.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match && currentFile) {
      if (Object.prototype.hasOwnProperty.call(currentFile, match[1])) throw updateError('metadata-invalid');
      currentFile[match[1]] = parseScalar(match[2]);
      continue;
    }
    throw updateError('metadata-invalid');
  }
  return result;
}

function parseVersion(value) {
  if (typeof value !== 'string') throw updateError('metadata-invalid');
  const match = value.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw updateError('metadata-invalid');
  return { raw: value, parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || '' };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease > b.prerelease ? 1 : -1;
}

function assertArtifactName(value, channel) {
  if (typeof value !== 'string' || !value || value.length > 180) throw updateError('metadata-invalid');
  if (value.includes('..') || value.includes('/') || value.includes('\\') || path.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /^\\\\/.test(value)) {
    throw updateError('metadata-invalid');
  }
  if (!CHANNELS[channel].artifact.test(value)) throw updateError('channel-mismatch');
  return value;
}

function assertSha512(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) throw updateError('metadata-invalid');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== value) throw updateError('metadata-invalid');
  return value;
}

function assertSize(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw updateError('metadata-invalid');
  return value;
}

function validateMetadata(input, options) {
  const opts = options || {};
  const channel = opts.channel;
  if (!Object.prototype.hasOwnProperty.call(CHANNELS, channel)) throw updateError('channel-mismatch');
  if (false) throw updateError('channel-mismatch');
  const metadata = typeof input === 'string' ? parseMetadata(input) : input;
  if (!isPlainObject(metadata)) throw updateError('metadata-invalid');
  const version = parseVersion(metadata.version).raw;
  if (typeof opts.currentVersion !== 'string' || compareVersions(version, opts.currentVersion) <= 0) throw updateError('metadata-invalid');
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1 || !isPlainObject(metadata.files[0])) throw updateError('metadata-invalid');
  const file = metadata.files[0];
  const url = assertArtifactName(file.url, channel);
  const declaredPath = assertArtifactName(metadata.path, channel);
  if (url !== declaredPath) throw updateError('metadata-invalid');
  const sha512 = assertSha512(file.sha512);
  const rootSha = assertSha512(metadata.sha512);
  if (sha512 !== rootSha) throw updateError('metadata-invalid');
  const size = assertSize(file.size);
  if (metadata.channel !== channel) throw updateError('channel-mismatch');
  if (typeof metadata.releaseDate !== 'string' || Number.isNaN(Date.parse(metadata.releaseDate))) throw updateError('metadata-invalid');
  return Object.freeze({ version, channel, metadataName: opts.metadataName, artifact: url, sha512, size, releaseDate: metadata.releaseDate });
}

function verifyArtifact(metadata, bytes) {
  if (!metadata || !Buffer.isBuffer(bytes)) throw updateError('artifact-mismatch');
  if (bytes.length !== metadata.size) throw updateError('artifact-mismatch');
  const digest = crypto.createHash('sha512').update(bytes).digest('base64');
  if (digest !== metadata.sha512) throw updateError('artifact-mismatch');
  return Object.freeze({ artifact: metadata.artifact, bytes: bytes.length, sha512: digest, channel: metadata.channel, version: metadata.version });
}

module.exports = { CHANNELS, MAX_METADATA_BYTES, updateError, parseMetadata, parseVersion, compareVersions, validateMetadata, verifyArtifact };
