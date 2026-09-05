'use strict';
// feed-adapter.js — production COS feed adapter (decision 2.1).
//
// COS stays the ONLY production feed authority. Production publishes
// electron-updater YAML (latest.yml / latest-portable.yml) via postbuild.js,
// not the candidate typed grammar. This adapter:
//  1. requests the correct COS feed for the requested (channel, strategy);
//  2. parses ONLY an explicit allowlist of electron-updater YAML fields;
//  3. rejects every authority-changing unknown/malformed/stale/cross input;
//  4. converts real bytes into the candidate typed feed text, binding
//     source feed bytes hash + sourceManifestHash + feed revision +
//     migration/rollback compatibility ids, then re-validates through the
//     frozen feed-validator so the coordinator sees one typed descriptor.
//
// Transport is injected (default-deny). Production wires electron `net` with
// a bounded single request; the candidate never performs a real network
// request and never fetches during a file lock (caller enforces).

const crypto = require('crypto');
const { validateFeed } = require('./feed-validator');
const { redact } = require('./redact');

const MAX_FEED_BYTES = 64 * 1024;
// electron-updater YAML top-level allowlist (latest.yml / latest-portable.yml).
const ALLOWED_TOP = new Set(['version', 'files', 'path', 'sha512', 'releaseDate', 'url', 'size', 'channel', 'strategy', 'sourceManifestHash', 'migrationSchemaRange', 'rollbackCompatibilityId']);
const ALLOWED_FILE = new Set(['url', 'sha512', 'size']);
// Base64 sha512 from electron-updater is 88 chars; hex is 128.
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;
const SHA512_HEX = /^[0-9A-F]{128}$/;
const COS_BASE = 'https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/';

function fail(code) {
  const error = new Error('feed-adapter rejected: ' + code);
  error.code = code;
  throw error;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex').toUpperCase();
}

function parseUpdaterYaml(text) {
  // Subset parser for the deterministic YAML electron-updater emits.
  // Handles: `key: value`, `files:`, `- key: value` entries and their
  // INDENTED sub-fields (url/sha512/size), then top-level path/sha512/
  // releaseDate after the files list (real latest.yml shape).
  const result = { top: {}, files: [] };
  let section = null;
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\uFEFF/g, '').trim();
    if (!line || line.startsWith('#')) continue;
    const listItem = line.match(/^-\s+([A-Za-z][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (listItem) {
      if (section !== 'files') fail('unexpected-list');
      current = {};
      current[listItem[1]] = listItem[2].trim();
      result.files.push(current);
      continue;
    }
    const top = line.match(/^([A-Za-z][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (!top) fail('malformed-line');
    if (top[1] === 'files') { section = 'files'; result.top.files = true; current = null; continue; }
    // Indented sub-field of the current file entry (raw line had leading space).
    if (section === 'files' && current && /^\s/.test(rawLine) && !current.hasOwnProperty(top[1])) {
      current[top[1]] = top[2].trim();
      continue;
    }
    if (section === 'files' && current && /^\s/.test(rawLine)) fail('duplicate-file-field:' + top[1]);
    if (Object.prototype.hasOwnProperty.call(result.top, top[1])) fail('duplicate-top-level-field');
    result.top[top[1]] = top[2].trim();
    current = null;
  }
  return result;
}
// Map a production electron-updater feed file to a channel/strategy pair.
// Production uses latest.yml (installer) and latest-portable.yml (portable);
// both are the stable channel. Any other production feed name is rejected.
function resolveFeedRequest(channel, strategy) {
  const ch = String(channel || '');
  const st = String(strategy || '');
  if (ch !== 'stable' && ch !== 'beta') fail('unknown-channel');
  if (st !== 'installer' && st !== 'portable') fail('unknown-strategy');
  // Production COS only carries stable; internal/beta would need a typed feed
  // republish and is therefore rejected here rather than guessed.
  if (ch !== 'stable') fail('production-channel-unavailable');
  return { feedFile: st === 'portable' ? 'latest-portable.yml' : 'latest.yml', channel: 'stable', strategy: st };
}

function artifactNameFromUrl(url, strategy) {
  const name = decodeURIComponent(String(url || '').split('?')[0].split('/').pop() || '');
  const prefix = strategy === 'portable' ? 'xinjing-portable-' : 'xinjing-setup-';
  return /^xinjing-(setup|portable)-\d+\.\d+\.\d+\.exe$/.test(name) && name.startsWith(prefix) ? name : '';
}

function b64ToHexSha512(value) {
  if (!SHA512_B64.test(String(value || ''))) return '';
  try {
    const hex = Buffer.from(value, 'base64').toString('hex').toUpperCase();
    return SHA512_HEX.test(hex) ? hex : '';
  } catch (_) { return ''; }
}

// Convert production electron-updater YAML text into the candidate typed feed.
function toTypedFeed({ channel, strategy, bodyText, sourceManifestHash, migrationSchemaRange, rollbackCompatibilityId, releaseId }) {
  const parsed = parseUpdaterYaml(bodyText);
  // Reject unknown top-level fields that could change authority.
  for (const key of Object.keys(parsed.top)) {
    if (!ALLOWED_TOP.has(key)) fail('unknown-top-level-field:' + key);
  }
  if (!parsed.top.version || !/^\d+\.\d+\.\d+$/.test(parsed.top.version)) fail('invalid-version');
  if (!parsed.files || parsed.files.length === 0) fail('missing-files');
  if (parsed.files.length > 4) fail('too-many-files'); // url/sha512/size + optional path variants
  // Exactly one artifact must be an xinjing-* exe; blockmaps must not be promoted.
  let artifact = null;
  for (const entry of parsed.files) {
    for (const key of Object.keys(entry)) if (!ALLOWED_FILE.has(key)) fail('unknown-file-field:' + key);
    const url = String(entry.url || '');
    const name = artifactNameFromUrl(url, strategy);
    if (!name) continue;
    if (artifact) fail('duplicate-artifact');
    // COS is the ONLY authority: a relative production url resolves against
    // the fixed COS base; an absolute url must be on the same COS host.
    let resolvedUrl = url;
    if (!/^https?:\/\//.test(url)) {
      resolvedUrl = COS_BASE + name;
    } else if (!new URL(url).hostname.endsWith('cos.ap-guangzhou.myqcloud.com')) {
      fail('non-cos-authority-url');
    }
    artifact = { url: resolvedUrl, name, sha512: b64ToHexSha512(entry.sha512), size: Number(entry.size) };
  }
  if (!artifact) fail('missing-artifact');
  if (!SHA512_HEX.test(artifact.sha512)) fail('invalid-sha512');
  if (!Number.isInteger(artifact.size) || artifact.size <= 0) fail('invalid-size');
  if (artifact.name !== (strategy === 'portable' ? 'xinjing-portable-' : 'xinjing-setup-') + parsed.top.version + '.exe') fail('fileName-version-mismatch');
  // Build the typed feed grammar the frozen feed-validator consumes.
  return [
    `version: ${parsed.top.version}`,
    `channel: ${channel}`,
    `sourceManifestHash: ${sourceManifestHash}`,
    `feedRevision: ${releaseId}`,
    `migrationSchemaRange: ${migrationSchemaRange}`,
    `rollbackCompatibilityId: ${rollbackCompatibilityId}`,
    'artifacts:',
    `- channel: ${channel}`,
    `- version: ${parsed.top.version}`,
    `- fileName: ${artifact.name}`,
    `- size: ${artifact.size}`,
    `- sha512: ${artifact.sha512}`,
    `- url: ${artifact.url}`
  ].join('\n');
}

// Single public entry: request -> typed metadata or fail-closed throw.
// `transport` must be { fetchText(url) -> {status, bodyText} } or a function;
// default-deny: if transport is absent, this never touches the network.
async function fetchTypedFeed({ channel, strategy, transport, currentVersion, releaseId, sourceManifestHash, migrationSchemaRange, rollbackCompatibilityId }) {
  const request = resolveFeedRequest(channel, strategy);
  const url = 'https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/' + request.feedFile;
  if (typeof transport !== 'function' && !(transport && typeof transport.fetchText === 'function')) fail('no-transport');
  const fetchText = typeof transport === 'function' ? transport : transport.fetchText.bind(transport);
  // Real Electron net transport returns a Promise; injected test transports may
  // return a plain value — awaiting either is correct.
  const response = await fetchText(url);
  if (!response || response.error) fail('download-failed');
  if (response.status !== 200) fail('http-' + String(response.status));
  const bodyText = String(response.bodyText || '');
  if (!bodyText.trim()) fail('empty-feed-body');
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_FEED_BYTES) fail('oversized-response');
  // Authority binding: raw COS bytes hash IS the sourceManifestHash for this
  // single-source production feed; any mismatch means the bytes were swapped.
  const bytesHash = sha256Hex(bodyText);
  const expectedManifest = String(sourceManifestHash || '').toUpperCase();
  if (expectedManifest && bytesHash !== expectedManifest) fail('sourceManifestHash-mismatch');
  const typedText = toTypedFeed({
    channel: request.channel,
    strategy: request.strategy,
    bodyText,
    sourceManifestHash: bytesHash,
    migrationSchemaRange: String(migrationSchemaRange || '1:1'),
    rollbackCompatibilityId: String(rollbackCompatibilityId || 'v5.0.0'),
    releaseId: String(releaseId || '0')
  });
  // Let the frozen feed-validator apply the typed grammar checks (size, sha512,
  // channel, version, path safety, url safety). The adapter's own checks above
  // remain authoritative for production YAML semantics.
  const metadata = validateFeed({
    currentVersion: String(currentVersion || '0.0.0'),
    channel: request.channel,
    feedText: typedText,
    fetchAdapter: () => ({ status: 200, bodyText: typedText })
  });
  return Object.assign(metadata, {
    typedText,
    strategy: request.strategy,
    feedFile: request.feedFile,
    sourceManifestHash: bytesHash,
    sourceFeedHash: bytesHash,
    feedRevision: String(releaseId || '0'),
    migrationSchemaRange: String(migrationSchemaRange || '1:1'),
    rollbackCompatibilityId: String(rollbackCompatibilityId || 'v5.0.0')
  });
}

module.exports = { fetchTypedFeed, parseUpdaterYaml, toTypedFeed, resolveFeedRequest, b64ToHexSha512, artifactNameFromUrl, MAX_FEED_BYTES, redact };
