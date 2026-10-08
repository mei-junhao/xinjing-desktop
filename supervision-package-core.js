'use strict';

/*
 * XJSUP/1 is deliberately a small, non-archive container.  This module is
 * the fail-closed domain core used by the main process and by the synthetic
 * contract tests.  It never creates signing keys and it never writes files.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from([0x58, 0x4a, 0x53, 0x55, 0x50, 0x2f, 0x31, 0x00]);
const SIGNATURE_DOMAIN = Buffer.from('XJSUP-SIG-v1\0', 'utf8');
const MAX_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMITS = Object.freeze({
  maxPackageBytes: 32 * 1024 * 1024,
  maxManifestBytes: 512 * 1024,
  maxCiphertextBytes: 24 * 1024 * 1024,
  maxPlaintextBytes: 8 * 1024 * 1024,
  maxResources: 128,
  maxResourceBytes: 2 * 1024 * 1024,
});
const CIPHER_SUITE = 'X25519-HKDF-SHA256-AES-256-GCM';
const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion', 'packageId', 'supervisorId', 'displayName',
  'packageVersion', 'minimumAppVersion', 'authorKeyId', 'cipherSuite',
  'contentNonce', 'ciphertextHash', 'contentSchemaHash', 'providerPolicy',
  'limits', 'recipientGrant',
]);
const GRANT_FIELDS = Object.freeze([
  'grantId', 'grantSequence', 'subjectIdHash', 'licenseIdHash',
  'deviceKeyId', 'devicePublicKeyHash', 'issuedAt', 'expiresAt',
  'revocationEpoch', 'entitlementKey', 'ephemeralPublicKey', 'kdfSalt',
  'wrapNonce', 'wrappedContentKey', 'wrappedKeyTag',
]);
const RESOURCE_MAP_FIELDS = Object.freeze(['schemaVersion', 'resources']);
const RESOURCE_FIELDS = Object.freeze(['mediaType', 'length', 'bytes']);
const MEDIA_TYPES = Object.freeze(new Set(['application/json', 'text/markdown', 'text/plain']));
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

class XjsupError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'XjsupError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new XjsupError(code, message || code);
}

function exactKeys(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = fields.slice().sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonempty(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && (maximum == null || value <= maximum);
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('manifest-number', 'manifest contains a non-finite number');
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
  }
  fail('manifest-type', 'manifest contains an unsupported value');
}

function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

function encodeBase64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64url(value, expectedLength, code) {
  const text = String(value || '');
  if (!text || !B64URL_RE.test(text) || text.length % 4 === 1) fail(code || 'invalid-base64url', 'invalid base64url field');
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  const decoded = Buffer.from(normalized + padding, 'base64');
  if (encodeBase64url(decoded) !== text) fail(code || 'invalid-base64url', 'non-canonical base64url field');
  if (expectedLength != null && decoded.length !== expectedLength) fail(code || 'invalid-base64url-length', 'binary field length is invalid');
  return decoded;
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function hashBytesBase64url(value) {
  return encodeBase64url(hashBytes(value));
}

function hashOpaque(value) {
  return 'sha256:' + crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function decodeUtf8(buffer, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    fail(code || 'invalid-utf8', 'value is not valid UTF-8');
  }
}

/* JSON.parse accepts duplicate object keys.  Scan the grammar first so the
 * canonical comparison cannot silently normalize an ambiguous manifest. */
function assertNoDuplicateJsonKeys(text) {
  let index = 0;
  function whitespace() { while (/\s/.test(text[index] || '')) index += 1; }
  function stringToken() {
    const start = index;
    if (text[index] !== '"') fail('manifest-json', 'invalid JSON string');
    index += 1;
    while (index < text.length) {
      const ch = text[index++];
      if (ch === '\\') {
        if (index >= text.length) fail('manifest-json', 'unterminated JSON escape');
        const escaped = text[index++];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4))) fail('manifest-json', 'invalid JSON unicode escape');
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) {
          fail('manifest-json', 'invalid JSON escape');
        }
      } else if (ch === '"') {
        return text.slice(start, index);
      } else if (ch < ' ') {
        fail('manifest-json', 'control character in JSON string');
      }
    }
    fail('manifest-json', 'unterminated JSON string');
  }
  function value() {
    whitespace();
    const ch = text[index];
    if (ch === '"') { stringToken(); return; }
    if (ch === '{') { object(); return; }
    if (ch === '[') { array(); return; }
    if (text.startsWith('true', index)) { index += 4; return; }
    if (text.startsWith('false', index)) { index += 5; return; }
    if (text.startsWith('null', index)) { index += 4; return; }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) { index += number[0].length; return; }
    fail('manifest-json', 'invalid JSON value');
  }
  function array() {
    index += 1;
    whitespace();
    if (text[index] === ']') { index += 1; return; }
    while (true) {
      value();
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      if (text[index] !== ',') fail('manifest-json', 'invalid JSON array');
      index += 1;
    }
  }
  function object() {
    index += 1;
    const keys = new Set();
    whitespace();
    if (text[index] === '}') { index += 1; return; }
    while (true) {
      whitespace();
      const token = stringToken();
      const key = JSON.parse(token);
      if (keys.has(key)) fail('manifest-duplicate-key', 'duplicate JSON object key');
      keys.add(key);
      whitespace();
      if (text[index] !== ':') fail('manifest-json', 'invalid JSON object');
      index += 1;
      value();
      whitespace();
      if (text[index] === '}') { index += 1; return; }
      if (text[index] !== ',') fail('manifest-json', 'invalid JSON object');
      index += 1;
    }
  }
  value();
  whitespace();
  if (index !== text.length) fail('manifest-json', 'trailing JSON bytes');
}

function parseCanonicalJson(bytes, noncanonicalCode) {
  const text = decodeUtf8(bytes, 'manifest-utf8');
  assertNoDuplicateJsonKeys(text);
  let value;
  try { value = JSON.parse(text); } catch (error) { fail('manifest-json', 'invalid JSON'); }
  if (canonicalize(value) !== text) fail(noncanonicalCode || 'manifest-noncanonical', 'JSON is not canonical');
  return value;
}

function exactIso(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

function parseSemver(value, code) {
  if (typeof value !== 'string') fail(code || 'invalid-version', 'version is invalid');
  const match = value.match(SEMVER_RE);
  if (!match) fail(code || 'invalid-version', 'version is invalid');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || '' };
}

function compareSemver(left, right) {
  const a = typeof left === 'string' ? parseSemver(left) : left;
  const b = typeof right === 'string' ? parseSemver(right) : right;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function checkIdentifier(value, code) {
  if (!nonempty(value, 128) || !/^[A-Za-z0-9._-]+$/.test(value)) fail(code, 'identifier is invalid');
}

function validateProviderPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.mode !== 'string') {
    fail('provider-policy', 'provider policy is invalid');
  }
  if (value.mode === 'local-only') {
    if (!exactKeys(value, ['mode'])) fail('provider-policy', 'local-only policy has unknown fields');
    return Object.freeze({ mode: 'local-only' });
  }
  if (value.mode === 'trusted-remote') {
    if (!exactKeys(value, ['mode', 'providerId', 'purpose']) || !nonempty(value.providerId, 80) || !nonempty(value.purpose, 200)) {
      fail('provider-policy', 'trusted provider policy is invalid');
    }
    return Object.freeze({ mode: value.mode, providerId: value.providerId, purpose: value.purpose });
  }
  fail('provider-policy', 'provider mode is not trusted');
}

function validateLimits(value) {
  const fields = ['maxResources', 'maxResourceBytes', 'maxPlaintextBytes', 'maxRunSeconds'];
  if (!exactKeys(value, fields)) fail('manifest-limits', 'limits fields are invalid');
  if (!safeInteger(value.maxResources, 1, DEFAULT_LIMITS.maxResources)
    || !safeInteger(value.maxResourceBytes, 1, DEFAULT_LIMITS.maxResourceBytes)
    || !safeInteger(value.maxPlaintextBytes, 1, DEFAULT_LIMITS.maxPlaintextBytes)
    || !safeInteger(value.maxRunSeconds, 1, 300)) {
    fail('manifest-limits', 'limits exceed the runtime ceiling');
  }
  return Object.freeze({
    maxResources: value.maxResources,
    maxResourceBytes: value.maxResourceBytes,
    maxPlaintextBytes: value.maxPlaintextBytes,
    maxRunSeconds: value.maxRunSeconds,
  });
}

function validateGrant(value) {
  if (!exactKeys(value, GRANT_FIELDS)) fail('grant-fields', 'recipient grant fields are invalid');
  checkIdentifier(value.grantId, 'grant-id');
  if (!safeInteger(value.grantSequence, 1)) fail('grant-sequence', 'grant sequence is invalid');
  if (!/^sha256:[0-9a-f]{64}$/.test(value.subjectIdHash) || !/^sha256:[0-9a-f]{64}$/.test(value.licenseIdHash)) {
    fail('grant-binding', 'subject or license binding is invalid');
  }
  checkIdentifier(value.deviceKeyId, 'device-key-id');
  decodeBase64url(value.devicePublicKeyHash, 32, 'device-public-key-hash');
  const issuedAt = exactIso(value.issuedAt);
  const expiresAt = exactIso(value.expiresAt);
  if (!issuedAt || !expiresAt || expiresAt <= issuedAt) fail('grant-time', 'grant time range is invalid');
  if (!safeInteger(value.revocationEpoch, 0)) fail('revocation-epoch', 'grant revocation epoch is invalid');
  if (value.entitlementKey !== 'custom-supervisors') fail('grant-entitlement', 'grant entitlement is invalid');
  decodeBase64url(value.ephemeralPublicKey, 32, 'ephemeral-public-key');
  decodeBase64url(value.kdfSalt, 16, 'kdf-salt');
  decodeBase64url(value.wrapNonce, 12, 'wrap-nonce');
  decodeBase64url(value.wrappedContentKey, 32, 'wrapped-content-key');
  decodeBase64url(value.wrappedKeyTag, 16, 'wrapped-key-tag');
  return Object.freeze(Object.assign({}, value));
}

function validateManifest(value) {
  if (!exactKeys(value, MANIFEST_FIELDS)) fail('manifest-fields', 'manifest fields are invalid');
  if (value.schemaVersion !== 1) fail('manifest-schema', 'unsupported manifest schema');
  checkIdentifier(value.packageId, 'package-id');
  checkIdentifier(value.supervisorId, 'supervisor-id');
  if (!nonempty(value.displayName, 200)) fail('display-name', 'display name is invalid');
  parseSemver(value.packageVersion, 'package-version');
  parseSemver(value.minimumAppVersion, 'minimum-app-version');
  if (!nonempty(value.authorKeyId, 80) || !/^[A-Za-z0-9._-]+$/.test(value.authorKeyId)) fail('author-key-id', 'author key id is invalid');
  if (value.cipherSuite !== CIPHER_SUITE) fail('cipher-suite', 'cipher suite is not supported');
  decodeBase64url(value.contentNonce, 12, 'content-nonce');
  decodeBase64url(value.ciphertextHash, 32, 'ciphertext-hash');
  decodeBase64url(value.contentSchemaHash, 32, 'content-schema-hash');
  const providerPolicy = validateProviderPolicy(value.providerPolicy);
  const limits = validateLimits(value.limits);
  const recipientGrant = validateGrant(value.recipientGrant);
  return Object.freeze(Object.assign({}, value, { providerPolicy, limits, recipientGrant }));
}

function loadKeyRegistry(input) {
  if (input && typeof input === 'object') return input;
  try {
    const file = path.join(__dirname, 'supervision-package-public-keys.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function loadPublicKeys(input) {
  const registry = loadKeyRegistry(input);
  return registry.authors && typeof registry.authors === 'object' ? registry.authors : registry;
}

function publicKeyFor(publicKeys, keyId) {
  const pem = publicKeys && typeof publicKeys[keyId] === 'string' ? publicKeys[keyId] : '';
  if (!pem || !pem.includes('BEGIN PUBLIC KEY') || /PRIVATE KEY/i.test(pem)) return null;
  try { return crypto.createPublicKey(pem); } catch (error) { return null; }
}

function makeSecurityFields(manifest) {
  const grant = manifest.recipientGrant;
  return {
    packageId: manifest.packageId,
    packageVersion: manifest.packageVersion,
    grantId: grant.grantId,
    subjectIdHash: grant.subjectIdHash,
    licenseIdHash: grant.licenseIdHash,
    deviceKeyId: grant.deviceKeyId,
    entitlementKey: grant.entitlementKey,
    expiresAt: grant.expiresAt,
    revocationEpoch: grant.revocationEpoch,
    providerPolicy: manifest.providerPolicy,
  };
}

function securityBytes(domain, manifest) {
  return Buffer.concat([Buffer.from(domain + '\0', 'utf8'), canonicalBytes(makeSecurityFields(manifest))]);
}

function signaturePayload(manifestBytes, ciphertext, contentTag) {
  return Buffer.concat([SIGNATURE_DOMAIN, manifestBytes, ciphertext, contentTag]);
}

function packageKeyAad(manifest) { return securityBytes('XJSUP-KEY-AAD-v1', manifest); }
function contentAad(manifest) { return securityBytes('XJSUP-CONTENT-AAD-v1', manifest); }
function hkdfInfo(manifest) { return securityBytes('XJSUP-HKDF-v1', manifest); }

function toPackageBuffer(input, maxBytes) {
  let value;
  if (Buffer.isBuffer(input)) value = input;
  else if (input instanceof Uint8Array) value = Buffer.from(input);
  else fail('package-input', 'package bytes are required');
  if (value.length > (maxBytes || DEFAULT_LIMITS.maxPackageBytes)) fail('package-too-large', 'package exceeds the size limit');
  return value;
}

function parseXjsup(input, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const bytes = toPackageBuffer(input, (opts.limits || DEFAULT_LIMITS).maxPackageBytes || DEFAULT_LIMITS.maxPackageBytes);
  if (opts.fileName != null && !String(opts.fileName).toLowerCase().endsWith('.xjsup')) fail('package-extension', 'only .xjsup files are accepted');
  if (bytes.length < MAGIC.length + 2 + 4 + 8 + 16 + 64) fail('package-truncated', 'package is truncated');
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) fail('package-magic', 'package magic is invalid');
  let offset = MAGIC.length;
  const formatVersion = bytes.readUInt16BE(offset); offset += 2;
  if (formatVersion !== 1) fail('package-version', 'unsupported XJSUP format version');
  const manifestLength = bytes.readUInt32BE(offset); offset += 4;
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  if (manifestLength < 2 || manifestLength > limits.maxManifestBytes || offset + manifestLength + 8 > bytes.length) fail('manifest-length', 'manifest length is invalid');
  const manifestBytes = bytes.subarray(offset, offset + manifestLength); offset += manifestLength;
  const manifest = validateManifest(parseCanonicalJson(manifestBytes, 'manifest-noncanonical'));
  const ciphertextLengthBig = bytes.readBigUInt64BE(offset); offset += 8;
  if (ciphertextLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) fail('ciphertext-length', 'ciphertext length overflows the safe integer range');
  const ciphertextLength = Number(ciphertextLengthBig);
  if (ciphertextLength > limits.maxCiphertextBytes || offset + ciphertextLength + 16 + 64 !== bytes.length) fail('ciphertext-length', 'ciphertext length is inconsistent');
  const ciphertext = bytes.subarray(offset, offset + ciphertextLength); offset += ciphertextLength;
  const contentTag = bytes.subarray(offset, offset + 16); offset += 16;
  const signature = bytes.subarray(offset, offset + 64);
  const expectedHash = encodeBase64url(hashBytes(ciphertext));
  if (expectedHash !== manifest.ciphertextHash) fail('ciphertext-hash', 'ciphertext hash does not match');
  const publicKey = publicKeyFor(loadPublicKeys(opts.publicKeys), manifest.authorKeyId);
  if (!publicKey) fail('author-key-unknown', 'author verification key is unavailable');
  if (!crypto.verify(null, signaturePayload(manifestBytes, ciphertext, contentTag), publicKey, signature)) fail('signature-invalid', 'author signature is invalid');
  return Object.freeze({
    formatVersion,
    manifest,
    manifestBytes: Buffer.from(manifestBytes),
    ciphertext: Buffer.from(ciphertext),
    contentTag: Buffer.from(contentTag),
    signature: Buffer.from(signature),
  });
}

function verifyRevocationEvidence(input, options) {
  const value = input && typeof input === 'object' ? input : null;
  const nowMs = options && Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  const fields = ['schemaVersion', 'listVersion', 'issuedAt', 'expiresAt', 'keyId', 'revocationEpoch', 'revokedPackageIds', 'revokedGrantIds', 'signature'];
  if (!exactKeys(value, fields) || value.schemaVersion !== 1 || !safeInteger(value.listVersion, 1) || !safeInteger(value.revocationEpoch, 0)) {
    return { valid: false, errorCode: 'revocation-malformed', lastVerifiedOnlineAtMs: 0 };
  }
  const issuedAt = exactIso(value.issuedAt);
  const expiresAt = exactIso(value.expiresAt);
  if (!issuedAt || !expiresAt || expiresAt <= issuedAt) return { valid: false, errorCode: 'revocation-time', lastVerifiedOnlineAtMs: 0 };
  const checkIds = (list, code) => Array.isArray(list) && list.every((id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id))
    && new Set(list).size === list.length && list.every((id, index) => index === 0 || list[index - 1] < id) || fail(code, 'revocation identifiers are invalid');
  try { checkIds(value.revokedPackageIds, 'revocation-package-ids'); checkIds(value.revokedGrantIds, 'revocation-grant-ids'); } catch (error) { return { valid: false, errorCode: error.code || 'revocation-malformed', lastVerifiedOnlineAtMs: issuedAt.getTime() }; }
  if (!nonempty(value.keyId, 80) || !/^[A-Za-z0-9._-]+$/.test(value.keyId)) return { valid: false, errorCode: 'revocation-key-id', lastVerifiedOnlineAtMs: issuedAt.getTime() };
  let signature;
  try { signature = decodeBase64url(value.signature, 64, 'revocation-signature'); } catch (error) { return { valid: false, errorCode: error.code, lastVerifiedOnlineAtMs: issuedAt.getTime() }; }
  const registry = loadKeyRegistry(options && options.publicKeys);
  const publicKeys = registry.revocations && typeof registry.revocations === 'object' ? registry.revocations : {};
  const publicKey = publicKeyFor(publicKeys, value.keyId);
  if (!publicKey) return { valid: false, errorCode: 'revocation-unknown-key', lastVerifiedOnlineAtMs: issuedAt.getTime() };
  const payload = {
    schemaVersion: value.schemaVersion,
    listVersion: value.listVersion,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    keyId: value.keyId,
    revocationEpoch: value.revocationEpoch,
    revokedPackageIds: value.revokedPackageIds,
    revokedGrantIds: value.revokedGrantIds,
  };
  const signed = Buffer.concat([Buffer.from('XJSUP-REVOCATION-v1\0', 'utf8'), canonicalBytes(payload)]);
  if (!crypto.verify(null, signed, publicKey, signature)) return { valid: false, errorCode: 'revocation-signature', lastVerifiedOnlineAtMs: issuedAt.getTime() };
  if (issuedAt.getTime() > nowMs || expiresAt.getTime() <= nowMs) return { valid: false, errorCode: expiresAt.getTime() <= nowMs ? 'revocation-expired' : 'revocation-not-yet-valid', lastVerifiedOnlineAtMs: issuedAt.getTime() };
  return {
    valid: true,
    listVersion: value.listVersion,
    revocationEpoch: value.revocationEpoch,
    revokedPackageIds: value.revokedPackageIds.slice(),
    revokedGrantIds: value.revokedGrantIds.slice(),
    lastVerifiedOnlineAtMs: issuedAt.getTime(),
  };
}

function rawX25519PublicKey(keyObject) {
  let der;
  try { der = crypto.createPublicKey(keyObject).export({ format: 'der', type: 'spki' }); } catch (error) { fail('device-key-invalid', 'device key is invalid'); }
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  if (!der.subarray(0, prefix.length).equals(prefix) || der.length !== prefix.length + 32) fail('device-key-type', 'device key is not X25519');
  return Buffer.from(der.subarray(prefix.length));
}

function publicKeyFromRaw(raw) {
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  try { return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' }); }
  catch (error) { fail('ephemeral-key-invalid', 'ephemeral key is invalid'); }
}

function authorizePackage(parsed, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const manifest = parsed.manifest;
  const grant = manifest.recipientGrant;
  if (ctx.entitlementAllowed !== true) fail('entitlement-denied', 'Flagship controlled-supervisors entitlement is required');
  if (ctx.subjectIdHash !== grant.subjectIdHash) fail('subject-mismatch', 'package subject binding does not match');
  if (ctx.licenseIdHash !== grant.licenseIdHash) fail('license-mismatch', 'package license binding does not match');
  if (ctx.deviceKeyId !== grant.deviceKeyId) fail('device-mismatch', 'package device binding does not match');
  if (ctx.devicePublicKeyHash !== grant.devicePublicKeyHash) fail('device-mismatch', 'package device public key binding does not match');
  const appVersion = parseSemver(String(ctx.appVersion || '0.0.0'), 'app-version');
  if (compareSemver(appVersion, manifest.minimumAppVersion) < 0) fail('minimum-app-version', 'application version is too old');
  const nowMs = Number.isSafeInteger(ctx.nowMs) ? ctx.nowMs : Date.now();
  const issuedMs = exactIso(grant.issuedAt).getTime();
  const expiresMs = exactIso(grant.expiresAt).getTime();
  if (nowMs < issuedMs) fail('grant-not-yet-valid', 'grant is not yet valid');
  if (nowMs >= expiresMs) fail('grant-expired', 'grant has expired');
  const highWater = ctx.highWater || createHighWaterState();
  if (!highWater || highWater.schemaVersion !== 1) fail('high-water-invalid', 'high-water state is invalid');
  if (highWater.lastSeenAtMs && nowMs < highWater.lastSeenAtMs) fail('clock-rollback', 'clock moved backwards');
  const priorGrant = highWater.grants && highWater.grants[grant.grantId];
  if (priorGrant && grant.grantSequence < priorGrant.grantSequence) fail('grant-sequence-rollback', 'grant sequence moved backwards');
  const priorPackage = highWater.packages && highWater.packages[manifest.packageId];
  if (priorPackage && compareSemver(manifest.packageVersion, priorPackage.packageVersion) < 0) fail('package-version-rollback', 'package version moved backwards');
  if (grant.revocationEpoch < Number(highWater.revocationEpoch || 0)) fail('revocation-epoch-rollback', 'revocation epoch moved backwards');

  const revocation = ctx.revocation && typeof ctx.revocation === 'object' ? ctx.revocation : {};
  const evidenceValid = revocation.valid === true || revocation.cachedValid === true;
  if (revocation.revocationEpoch != null && (!safeInteger(revocation.revocationEpoch, 0) || revocation.revocationEpoch < Number(highWater.revocationEpoch || 0))) {
    fail('revocation-epoch-rollback', 'revocation evidence moved backwards');
  }
  if (revocation.revoked === true
    || (Array.isArray(revocation.revokedPackageIds) && revocation.revokedPackageIds.includes(manifest.packageId))
    || (Array.isArray(revocation.revokedGrantIds) && revocation.revokedGrantIds.includes(grant.grantId))) {
    fail('package-revoked', 'package or grant is revoked');
  }
  if (ctx.online === true) {
    if (revocation.valid !== true) fail('revocation-unavailable', 'online verification evidence is unavailable');
  } else {
    const lastVerified = Number(revocation.lastVerifiedOnlineAtMs || 0);
    if (!evidenceValid || !safeInteger(lastVerified, 1) || nowMs < lastVerified || nowMs - lastVerified > MAX_OFFLINE_GRACE_MS) {
      fail(nowMs - lastVerified > MAX_OFFLINE_GRACE_MS ? 'offline-grace-expired' : 'offline-verification-required', 'offline package grace is unavailable');
    }
  }
  return Object.freeze({ nowMs, issuedMs, expiresMs, grantSequence: grant.grantSequence, revocationEpoch: grant.revocationEpoch });
}

function unwrapContentKey(parsed, context) {
  const keyObject = context && context.keyObject;
  if (!keyObject) fail('device-key-unavailable', 'device key is unavailable');
  const grant = parsed.manifest.recipientGrant;
  const rawPublic = rawX25519PublicKey(keyObject);
  if (encodeBase64url(hashBytes(rawPublic)) !== grant.devicePublicKeyHash) fail('device-mismatch', 'device key does not match grant');
  const ephemeral = decodeBase64url(grant.ephemeralPublicKey, 32, 'ephemeral-public-key');
  let shared;
  try { shared = crypto.diffieHellman({ privateKey: keyObject, publicKey: publicKeyFromRaw(ephemeral) }); }
  catch (error) { fail('envelope-unwrap', 'recipient envelope could not be unwrapped'); }
  const derived = crypto.hkdfSync('sha256', shared, decodeBase64url(grant.kdfSalt, 16), hkdfInfo(parsed.manifest), 32);
  const kek = Buffer.from(derived);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, decodeBase64url(grant.wrapNonce, 12));
  decipher.setAAD(packageKeyAad(parsed.manifest));
  decipher.setAuthTag(decodeBase64url(grant.wrappedKeyTag, 16));
  let contentKey;
  try { contentKey = Buffer.concat([decipher.update(decodeBase64url(grant.wrappedContentKey, 32)), decipher.final()]); }
  catch (error) { fail('envelope-unwrap', 'recipient envelope authentication failed'); }
  if (contentKey.length !== 32) fail('envelope-key-length', 'wrapped content key length is invalid');
  return contentKey;
}

function forbiddenResourceContent(text) {
  return /https?:\/\/|javascript:|data:text\/html|<\/?script\b|\b(?:require|eval|import)\s*\(|child_process|powershell|cmd(?:\.exe)?\b|shell\.open/i.test(text);
}

function validateResourcePath(resourcePath) {
  if (typeof resourcePath !== 'string' || !resourcePath || resourcePath !== resourcePath.normalize('NFC')
    || resourcePath.startsWith('/') || resourcePath.includes('\\') || resourcePath.includes(':')
    || resourcePath.includes('\0') || resourcePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('resource-path', 'resource path is not a normalized relative POSIX path');
  }
  if (resourcePath.length > 240) fail('resource-path', 'resource path is too long');
  return resourcePath;
}

function decodeResourceMap(plaintext, limits) {
  const effective = Object.assign({}, DEFAULT_LIMITS, limits || {});
  if (plaintext.length > effective.maxPlaintextBytes) fail('plaintext-too-large', 'package plaintext exceeds the limit');
  const parsed = parseCanonicalJson(plaintext, 'resource-map-noncanonical');
  if (!exactKeys(parsed, RESOURCE_MAP_FIELDS) || parsed.schemaVersion !== 1 || !parsed.resources || typeof parsed.resources !== 'object' || Array.isArray(parsed.resources)) {
    fail('resource-map-schema', 'resource map schema is invalid');
  }
  const names = Object.keys(parsed.resources).sort();
  if (names.length > effective.maxResources) fail('resource-count', 'resource count exceeds the limit');
  const resources = Object.create(null);
  let totalBytes = 0;
  for (const name of names) {
    validateResourcePath(name);
    const entry = parsed.resources[name];
    if (!exactKeys(entry, RESOURCE_FIELDS) || !MEDIA_TYPES.has(entry.mediaType) || !safeInteger(entry.length, 0, effective.maxResourceBytes)) {
      fail('resource-entry', 'resource entry is invalid');
    }
    const bytes = decodeBase64url(entry.bytes, entry.length, 'resource-bytes');
    totalBytes += bytes.length;
    if (totalBytes > effective.maxPlaintextBytes) fail('resource-total-size', 'resource total exceeds the limit');
    const text = decodeUtf8(bytes, 'resource-utf8');
    if (forbiddenResourceContent(text)) fail('resource-content', 'resource contains executable or network content');
    if (entry.mediaType === 'application/json') {
      try { assertNoDuplicateJsonKeys(text); JSON.parse(text); } catch (error) { fail('resource-json', 'JSON resource is invalid'); }
    }
    resources[name] = Object.freeze({ mediaType: entry.mediaType, length: bytes.length, bytes: Buffer.from(bytes) });
  }
  return Object.freeze({ schemaVersion: 1, resources: Object.freeze(resources), resourceCount: names.length, totalBytes });
}

function decryptResources(parsed, keyObject) {
  const contentKey = unwrapContentKey(parsed, { keyObject });
  const decipher = crypto.createDecipheriv('aes-256-gcm', contentKey, decodeBase64url(parsed.manifest.contentNonce, 12));
  decipher.setAAD(contentAad(parsed.manifest));
  decipher.setAuthTag(parsed.contentTag);
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]); }
  catch (error) { fail('content-decrypt', 'package content authentication failed'); }
  if (encodeBase64url(hashBytes(plaintext)) !== parsed.manifest.contentSchemaHash) fail('content-schema-hash', 'resource map hash does not match');
  return decodeResourceMap(plaintext, parsed.manifest.limits);
}

function descriptorFor(manifest, resources, status, reason) {
  const grant = manifest.recipientGrant;
  const summary = resources ? {
    count: resources.resourceCount,
    totalBytes: resources.totalBytes,
    mediaTypes: Array.from(new Set(Object.keys(resources.resources).map((key) => resources.resources[key].mediaType))).sort(),
  } : null;
  return Object.freeze({
    packageId: manifest.packageId,
    supervisorId: manifest.supervisorId,
    displayName: manifest.displayName,
    packageVersion: manifest.packageVersion,
    minimumAppVersion: manifest.minimumAppVersion,
    authorKeyId: manifest.authorKeyId,
    expiresAt: grant.expiresAt,
    grantSequence: grant.grantSequence,
    revocationEpoch: grant.revocationEpoch,
    entitlementKey: grant.entitlementKey,
    providerPolicy: manifest.providerPolicy,
    contentHash: manifest.contentSchemaHash,
    bindingSummary: hashBytesBase64url(Buffer.from(grant.grantId, 'utf8')).slice(0, 16),
    resourceSummary: summary,
    status: status || 'available',
    reason: reason || '',
  });
}

function inspectPackage(input, options) {
  const parsed = parseXjsup(input, options);
  return Object.freeze({ descriptor: descriptorFor(parsed.manifest, null, 'inspectable', ''), parsed });
}

function openPackage(input, context, options) {
  const parsed = parseXjsup(input, options);
  const authorization = authorizePackage(parsed, context);
  const resources = decryptResources(parsed, context && context.keyObject);
  return Object.freeze({ parsed, authorization, resources, descriptor: descriptorFor(parsed.manifest, resources, 'available', '') });
}

function createHighWaterState() {
  return { schemaVersion: 1, lastSeenAtMs: 0, revocationEpoch: 0, grants: {}, packages: {} };
}

function advanceHighWater(state, manifest, nowMs) {
  if (!state || state.schemaVersion !== 1) fail('high-water-invalid', 'high-water state is invalid');
  const next = JSON.parse(JSON.stringify(state));
  const grant = manifest.recipientGrant;
  next.lastSeenAtMs = Math.max(Number(next.lastSeenAtMs || 0), Number(nowMs));
  next.revocationEpoch = Math.max(Number(next.revocationEpoch || 0), grant.revocationEpoch);
  const oldGrant = next.grants[grant.grantId];
  if (!oldGrant || grant.grantSequence > oldGrant.grantSequence) next.grants[grant.grantId] = { grantSequence: grant.grantSequence };
  const oldPackage = next.packages[manifest.packageId];
  if (!oldPackage || compareSemver(manifest.packageVersion, oldPackage.packageVersion) > 0) {
    next.packages[manifest.packageId] = { packageVersion: manifest.packageVersion };
  }
  return next;
}

function createGrantState(options) {
  const input = options && typeof options === 'object' ? options : {};
  checkIdentifier(input.grantId, 'grant-id');
  checkIdentifier(input.deviceKeyId, 'device-key-id');
  if (!safeInteger(input.grantSequence, 1) || !safeInteger(input.revocationEpoch, 0)) fail('grant-state', 'grant state counters are invalid');
  return {
    schemaVersion: 1,
    grantId: input.grantId,
    activeDeviceKeyId: input.deviceKeyId,
    pendingDeviceKeyId: '',
    grantSequence: input.grantSequence,
    revocationEpoch: input.revocationEpoch,
  };
}

function applyGrantMigration(state, event) {
  if (!state || state.schemaVersion !== 1 || !event || typeof event !== 'object' || event.signatureValid !== true) {
    return { ok: false, errorCode: 'migration-invalid', state };
  }
  if (event.grantId !== state.grantId || !safeInteger(event.grantSequence, state.grantSequence + 1)
    || event.grantSequence <= state.grantSequence || !nonempty(event.targetDeviceKeyId, 128)
    || event.targetDeviceKeyId === state.activeDeviceKeyId) {
    return { ok: false, errorCode: 'migration-target-invalid', state };
  }
  const next = JSON.parse(JSON.stringify(state));
  if (event.phase === 'pending') {
    if (next.pendingDeviceKeyId && next.pendingDeviceKeyId !== event.targetDeviceKeyId) return { ok: false, errorCode: 'migration-conflict', state };
    next.pendingDeviceKeyId = event.targetDeviceKeyId;
    return { ok: true, state: next };
  }
  if (event.phase === 'rollback') {
    if (next.pendingDeviceKeyId !== event.targetDeviceKeyId) return { ok: false, errorCode: 'migration-target-mismatch', state };
    next.pendingDeviceKeyId = '';
    return { ok: true, state: next };
  }
  if (event.phase === 'complete') {
    if (next.pendingDeviceKeyId !== event.targetDeviceKeyId) return { ok: false, errorCode: 'migration-target-mismatch', state };
    if (event.oldDeviceRevoked !== true || !safeInteger(event.revocationEpoch, next.revocationEpoch + 1)) return { ok: false, errorCode: 'migration-revocation-required', state };
    next.activeDeviceKeyId = event.targetDeviceKeyId;
    next.pendingDeviceKeyId = '';
    next.grantSequence = event.grantSequence;
    next.revocationEpoch = Math.max(next.revocationEpoch, Number(event.revocationEpoch || 0));
    return { ok: true, state: next };
  }
  return { ok: false, errorCode: 'migration-phase', state };
}

module.exports = Object.freeze({
  MAGIC,
  CIPHER_SUITE,
  DEFAULT_LIMITS,
  MAX_OFFLINE_GRACE_MS,
  XjsupError,
  canonicalize,
  canonicalBytes,
  encodeBase64url,
  decodeBase64url,
  hashBytesBase64url,
  hashOpaque,
  signaturePayload,
  verifyRevocationEvidence,
  packageKeyAad,
  contentAad,
  hkdfInfo,
  parseXjsup,
  inspectPackage,
  authorizePackage,
  openPackage,
  decodeResourceMap,
  descriptorFor,
  createHighWaterState,
  advanceHighWater,
  createGrantState,
  applyGrantMigration,
});
