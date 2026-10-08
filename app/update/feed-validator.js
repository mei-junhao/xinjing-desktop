'use strict';

const crypto = require('crypto');

const ALLOWED_CHANNELS = new Set(['stable', 'beta']);
const MAX_FEED_BYTES = 64 * 1024;
const SHA512 = /^[0-9A-F]{128}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(code) {
  const error = new Error('feed rejected: ' + code);
  error.code = code;
  throw error;
}

function parseVersion(value) {
  const match = VERSION.exec(String(value || '').trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function compareVersion(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function parseFeed(text) {
  const result = {};
  let artifact = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === 'artifacts:') {
      if (artifact) fail('duplicate-artifacts');
      artifact = {};
      result.artifact = artifact;
      continue;
    }
    const match = line.match(/^-\s+([A-Za-z][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (match) {
      if (!artifact) fail('unexpected-list');
      if (Object.prototype.hasOwnProperty.call(artifact, match[1])) fail('duplicate-artifact-field');
      artifact[match[1]] = match[2].trim();
      continue;
    }
    if (/^\s/.test(rawLine)) fail('unexpected-indent');
    const top = line.match(/^([A-Za-z][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (!top) fail('malformed-line');
    if (artifact) fail('top-level-after-artifact');
    if (Object.prototype.hasOwnProperty.call(result, top[1])) fail('duplicate-top-level-field');
    result[top[1]] = top[2].trim();
  }
  return result;
}

function safeFileName(value) {
  return /^(xinjing-(?:setup|portable)-\d+\.\d+\.\d+\.exe)$/.test(value);
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && /^[A-Za-z0-9.-]+$/.test(parsed.hostname) && /^\/[A-Za-z0-9._-]+\.exe$/.test(parsed.pathname) && !parsed.search && !parsed.hash;
  } catch (_) {
    return false;
  }
}

function urlFileName(value) {
  try { return decodeURIComponent(new URL(value).pathname.slice(1)); } catch (_) { return ''; }
}

function validateFeed({ currentVersion, channel, feedText, fetchAdapter }) {
  if (!ALLOWED_CHANNELS.has(channel)) fail('unknown-channel');
  if (typeof fetchAdapter !== 'function') fail('no-fetch-adapter');
  if (Buffer.byteLength(String(feedText || ''), 'utf8') > MAX_FEED_BYTES) fail('oversized-response');
  const response = fetchAdapter({ channel });
  if (!response || response.error) fail('download-failed');
  if (response.status !== 200) fail('http-' + response.status);
  if (typeof response.bodyText !== 'string' || !response.bodyText.trim()) fail('empty-feed-body');
  if (Buffer.byteLength(response.bodyText, 'utf8') > MAX_FEED_BYTES) fail('oversized-response');
  if (String(feedText || '') !== response.bodyText) fail('feed-body-mismatch');
  const raw = parseFeed(response.bodyText);
  if (raw.channel !== channel) fail('feed-channel-mismatch');
  const version = parseVersion(raw.version);
  const current = parseVersion(currentVersion);
  if (!version) fail('invalid-version');
  if (!current) fail('invalid-current-version');
  if (compareVersion(version, current) <= 0) fail('stale-or-downgrade-version');
  if (!raw.artifact) fail('missing-artifact');
  const artifact = raw.artifact;
  if (artifact.channel !== channel) fail('artifact-channel-mismatch');
  if (artifact.version !== raw.version) fail('mixed-version');
  const fileName = String(artifact.fileName || '');
  if (!safeFileName(fileName)) fail(fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') ? 'illegal-path' : 'fileName-not-matching-channel-version');
  const expectedPrefix = fileName.startsWith('xinjing-portable-') ? 'xinjing-portable-' : 'xinjing-setup-';
  if (fileName !== expectedPrefix + raw.version + '.exe') fail('fileName-version-mismatch');
  const url = String(artifact.url || '');
  if (!safeUrl(url)) fail('illegal-url');
  if (urlFileName(url) !== fileName) fail('url-fileName-mismatch');
  const size = Number(artifact.size);
  if (!Number.isInteger(size) || size <= 0) fail('invalid-size');
  const sha512 = String(artifact.sha512 || '').toUpperCase();
  if (!SHA512.test(sha512)) fail('invalid-sha512');
  return {
    version: raw.version,
    channel,
    fileName,
    url,
    size,
    sha512,
    metadataSha256: crypto.createHash('sha256').update(response.bodyText, 'utf8').digest('hex').toUpperCase()
  };
}

module.exports = { ALLOWED_CHANNELS, MAX_FEED_BYTES, parseFeed, parseVersion, compareVersion, validateFeed };
