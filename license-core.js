/**
 * XinJing v2 license verification.
 * The packaged client contains public keys only and cannot issue licenses.
 */
'use strict';

const crypto = require('crypto');
const KEY_REGISTRY = require('./license-public-keys');

const TRIAL_DAYS = 90;
const AI_TRIAL_DAYS = 60;
const PAID_TIERS = Object.freeze(['pro', 'custom']);
const LICENSE_SCHEMA_VERSION = 2;
const REVOCATION_SCHEMA_VERSION = 1;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const CLAIM_FIELDS = Object.freeze([
  'schemaVersion', 'licenseId', 'tier', 'subjectId', 'machineCodeHash',
  'issuedAt', 'expiresAt', 'keyId', 'signature',
]);
const REVOCATION_FIELDS = Object.freeze([
  'schemaVersion', 'listVersion', 'issuedAt', 'expiresAt', 'keyId',
  'revokedLicenseIds', 'signature',
]);

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function base64urlDecode(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('invalid base64url');
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return Buffer.from(normalized + padding, 'base64');
}

function machineCodeHash(machineCode) {
  const normalized = String(machineCode || '').trim();
  if (!normalized) return '';
  return 'sha256:' + crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function exactIso(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return null;
  return date;
}

function hasExactFields(object, fields) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  const actual = Object.keys(object).sort();
  const expected = fields.slice().sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function publicKeyFor(registry, keyId) {
  const pem = registry && Object.prototype.hasOwnProperty.call(registry, keyId) ? registry[keyId] : '';
  if (typeof pem !== 'string' || !pem.includes('BEGIN PUBLIC KEY')) return null;
  try { return crypto.createPublicKey(pem); } catch (error) { return null; }
}

function verifySignature(payload, signature, publicKey) {
  try {
    const bytes = base64urlDecode(signature);
    if (bytes.length !== 64) return false;
    return crypto.verify(null, Buffer.from(stableJson(payload), 'utf8'), publicKey, bytes);
  } catch (error) {
    return false;
  }
}

function decodeActivationCode(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return { ok: true, claim: input };
  const text = String(input || '').trim();
  if (!text) return { ok: false, errorCode: 'empty' };
  if (!text.startsWith('XJ2-')) {
    return { ok: false, errorCode: 'legacy-license', migrationRequired: /^XJ-/i.test(text) };
  }
  try {
    const compact = text.slice(4).replace(/\s/g, '');
    if (!compact || compact.length > 16384) return { ok: false, errorCode: 'malformed' };
    const claim = JSON.parse(base64urlDecode(compact).toString('utf8'));
    return { ok: true, claim };
  } catch (error) {
    return { ok: false, errorCode: 'malformed' };
  }
}

function normalizeClaim(raw) {
  if (!hasExactFields(raw, CLAIM_FIELDS)) return { ok: false, errorCode: 'malformed' };
  if (raw.schemaVersion !== LICENSE_SCHEMA_VERSION) return { ok: false, errorCode: 'unsupported-schema' };
  if (!/^lic_[A-Za-z0-9_-]{8,80}$/.test(raw.licenseId)) return { ok: false, errorCode: 'malformed' };
  if (!PAID_TIERS.includes(raw.tier)) return { ok: false, errorCode: 'invalid-tier' };
  if (!/^sub_[A-Za-z0-9_-]{6,120}$/.test(raw.subjectId)) return { ok: false, errorCode: 'malformed' };
  if (!/^sha256:[a-f0-9]{64}$/.test(raw.machineCodeHash)) return { ok: false, errorCode: 'malformed' };
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(raw.keyId)) return { ok: false, errorCode: 'unknown-key' };
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(raw.signature)) return { ok: false, errorCode: 'invalid-signature' };
  const issuedAt = exactIso(raw.issuedAt);
  const expiresAt = exactIso(raw.expiresAt);
  if (!issuedAt || !expiresAt || expiresAt <= issuedAt) return { ok: false, errorCode: 'invalid-time' };
  return { ok: true, claim: Object.assign({}, raw), issuedAt, expiresAt };
}

function licensePayload(claim) {
  return {
    schemaVersion: claim.schemaVersion,
    licenseId: claim.licenseId,
    tier: claim.tier,
    subjectId: claim.subjectId,
    machineCodeHash: claim.machineCodeHash,
    issuedAt: claim.issuedAt,
    expiresAt: claim.expiresAt,
    keyId: claim.keyId,
  };
}

function revocationPayload(list) {
  return {
    schemaVersion: list.schemaVersion,
    listVersion: list.listVersion,
    issuedAt: list.issuedAt,
    expiresAt: list.expiresAt,
    keyId: list.keyId,
    revokedLicenseIds: list.revokedLicenseIds,
  };
}

function verifyRevocationList(input, options) {
  options = options || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const registry = options.publicKeys || KEY_REGISTRY.revocation;
  if (!hasExactFields(input, REVOCATION_FIELDS)) return { valid: false, errorCode: 'revocation-malformed' };
  if (input.schemaVersion !== REVOCATION_SCHEMA_VERSION) return { valid: false, errorCode: 'revocation-schema' };
  if (!Number.isInteger(input.listVersion) || input.listVersion < 1) return { valid: false, errorCode: 'revocation-version' };
  const issuedAt = exactIso(input.issuedAt);
  const expiresAt = exactIso(input.expiresAt);
  if (!issuedAt || !expiresAt || expiresAt <= issuedAt) return { valid: false, errorCode: 'revocation-time' };
  if (issuedAt.getTime() > now + CLOCK_SKEW_MS) return { valid: false, errorCode: 'revocation-not-yet-valid' };
  if (expiresAt.getTime() < now) return { valid: false, errorCode: 'revocation-expired' };
  const minimumVersion = Number(options.minimumVersion || 0);
  if (input.listVersion < minimumVersion) return { valid: false, errorCode: 'revocation-rollback' };
  if (!Array.isArray(input.revokedLicenseIds)) return { valid: false, errorCode: 'revocation-malformed' };
  const revoked = input.revokedLicenseIds.map(String);
  if (revoked.some((id) => !/^lic_[A-Za-z0-9_-]{8,80}$/.test(id))) return { valid: false, errorCode: 'revocation-malformed' };
  if (new Set(revoked).size !== revoked.length || revoked.some((id, index) => index > 0 && revoked[index - 1] > id)) {
    return { valid: false, errorCode: 'revocation-order' };
  }
  const publicKey = publicKeyFor(registry, input.keyId);
  if (!publicKey) return { valid: false, errorCode: 'revocation-unknown-key' };
  if (!verifySignature(revocationPayload(input), input.signature, publicKey)) return { valid: false, errorCode: 'revocation-signature' };
  return { valid: true, list: Object.assign({}, input), listVersion: input.listVersion, revokedLicenseIds: revoked };
}

function invalidResult(errorCode, extra) {
  return Object.assign({
    valid: false,
    errorCode,
    identity: '',
    subjectId: '',
    tier: 'free',
    licenseId: '',
    machineCodeHash: '',
    machineMatch: true,
    issuedAt: '',
    expiresAt: 0,
    expired: errorCode === 'expired',
    migrationRequired: errorCode === 'legacy-license' || errorCode === 'legacy-record',
  }, extra || {});
}

function verifyKey(input, machineCode, options) {
  options = options || {};
  const decoded = decodeActivationCode(input);
  if (!decoded.ok) return invalidResult(decoded.errorCode, { migrationRequired: !!decoded.migrationRequired });
  const normalized = normalizeClaim(decoded.claim);
  if (!normalized.ok) return invalidResult(normalized.errorCode);
  const claim = normalized.claim;
  const registry = options.publicKeys || KEY_REGISTRY.license;
  const publicKey = publicKeyFor(registry, claim.keyId);
  if (!publicKey) return invalidResult('unknown-key', { licenseId: claim.licenseId, keyId: claim.keyId });
  if (!verifySignature(licensePayload(claim), claim.signature, publicKey)) {
    return invalidResult('invalid-signature', { licenseId: claim.licenseId, keyId: claim.keyId });
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (normalized.issuedAt.getTime() > now + CLOCK_SKEW_MS) return invalidResult('not-yet-valid', { licenseId: claim.licenseId });
  if (normalized.expiresAt.getTime() < now) return invalidResult('expired', { licenseId: claim.licenseId, expiresAt: normalized.expiresAt.getTime() });
  const expectedMachineHash = machineCodeHash(machineCode);
  const machineMatch = !!expectedMachineHash && crypto.timingSafeEqual(Buffer.from(claim.machineCodeHash), Buffer.from(expectedMachineHash));
  if (!machineMatch) return invalidResult('machine-mismatch', { licenseId: claim.licenseId, machineCodeHash: claim.machineCodeHash, machineMatch: false });

  if (options.requireRevocation !== false) {
    const revocation = verifyRevocationList(options.revocationList, {
      now,
      minimumVersion: options.minimumRevocationVersion,
      publicKeys: options.revocationPublicKeys,
    });
    if (!revocation.valid) return invalidResult(revocation.errorCode, { licenseId: claim.licenseId });
    if (revocation.revokedLicenseIds.includes(claim.licenseId)) return invalidResult('revoked', { licenseId: claim.licenseId });
  }

  return {
    valid: true,
    errorCode: '',
    claim,
    identity: claim.subjectId,
    subjectId: claim.subjectId,
    tier: claim.tier,
    licenseId: claim.licenseId,
    machineCodeHash: claim.machineCodeHash,
    machineMatch: true,
    issuedAt: claim.issuedAt,
    expiresAt: normalized.expiresAt.getTime(),
    expired: false,
    migrationRequired: false,
    keyId: claim.keyId,
  };
}

function verifyStoredRecord(record, machineCode, options) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return invalidResult('missing-record');
  }
  if (record.schemaVersion !== LICENSE_SCHEMA_VERSION || !record.claim || typeof record.claim !== 'object' || Array.isArray(record.claim)) {
    return invalidResult('legacy-record', { migrationRequired: true });
  }
  return verifyKey(record.claim, machineCode, options);
}

function trialStatus(firstLaunchTs, nowTs) {
  const now = nowTs || Date.now();
  const daysPassed = Math.floor((now - firstLaunchTs) / 86400000);
  const daysLeft = TRIAL_DAYS - daysPassed;
  return daysLeft > 0 ? { state: 'active', daysLeft } : { state: 'expired', daysLeft: 0 };
}

function aiTrialStatus(firstInstallTs, nowTs) {
  const now = nowTs || Date.now();
  const daysPassed = Math.floor((now - firstInstallTs) / 86400000);
  const daysLeft = AI_TRIAL_DAYS - daysPassed;
  return daysLeft > 0 ? { active: true, daysLeft } : { active: false, daysLeft: 0 };
}

function overallMode(activated, trial) {
  if (activated) return 'full';
  return trial.state === 'active' ? 'trial' : 'limited';
}

module.exports = {
  TRIAL_DAYS,
  AI_TRIAL_DAYS,
  PAID_TIERS,
  LICENSE_SCHEMA_VERSION,
  REVOCATION_SCHEMA_VERSION,
  decodeActivationCode,
  machineCodeHash,
  stableJson,
  verifyKey,
  verifyStoredRecord,
  verifyRevocationList,
  trialStatus,
  aiTrialStatus,
  overallMode,
};
