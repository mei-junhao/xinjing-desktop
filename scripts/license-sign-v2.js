'use strict';

// Developer-only signer. electron-builder files never include scripts/**.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 86400000;
const DEFAULT_KEY_ROOT = path.join(os.homedir(), '.xinjing', 'license-signing');
const DEFAULT_LICENSE_KEY = path.join(DEFAULT_KEY_ROOT, 'license-ed25519-2026-01-private.pem');
const DEFAULT_REVOCATION_KEY = path.join(DEFAULT_KEY_ROOT, 'revocation-ed25519-2026-01-private.pem');

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function machineCodeHash(machineCode) {
  const normalized = String(machineCode || '').trim();
  if (!normalized) throw new Error('machineCode is required');
  return 'sha256:' + crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function readPrivateKey(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error('Private key not found: ' + resolved);
  return fs.readFileSync(resolved, 'utf8');
}

function signPayload(payload, privateKey) {
  return base64url(crypto.sign(null, Buffer.from(stableJson(payload), 'utf8'), privateKey));
}

function encodeActivationCode(claim) {
  return 'XJ2-' + base64url(Buffer.from(JSON.stringify(claim), 'utf8'));
}

function signLicenseClaim(input) {
  const now = input.issuedAt ? new Date(input.issuedAt) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('issuedAt is invalid');
  const expires = input.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + 365 * DAY_MS);
  if (!Number.isFinite(expires.getTime()) || expires <= now) throw new Error('expiresAt must be after issuedAt');
  const tier = String(input.tier || '').toLowerCase();
  if (!['pro', 'custom'].includes(tier)) throw new Error('tier must be pro or custom');
  const licenseId = String(input.licenseId || '').trim();
  const subjectId = String(input.subjectId || '').trim();
  if (!/^lic_[A-Za-z0-9_-]{8,80}$/.test(licenseId)) throw new Error('licenseId must start with lic_');
  if (!/^sub_[A-Za-z0-9_-]{6,120}$/.test(subjectId)) throw new Error('subjectId must be opaque and start with sub_');
  const payload = {
    schemaVersion: 2,
    licenseId,
    tier,
    subjectId,
    machineCodeHash: machineCodeHash(input.machineCode),
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    keyId: String(input.keyId || 'ed25519-2026-01'),
  };
  const privateKey = readPrivateKey(input.privateKeyPath || process.env.XJ_LICENSE_PRIVATE_KEY || DEFAULT_LICENSE_KEY);
  return Object.assign({}, payload, { signature: signPayload(payload, privateKey) });
}

function signRevocationList(input) {
  const now = input.issuedAt ? new Date(input.issuedAt) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('issuedAt is invalid');
  const expires = input.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + 365 * DAY_MS);
  const listVersion = Number(input.listVersion);
  if (!Number.isInteger(listVersion) || listVersion < 1) throw new Error('listVersion must be a positive integer');
  if (!Number.isFinite(expires.getTime()) || expires <= now) throw new Error('expiresAt must be after issuedAt');
  const revokedLicenseIds = Array.from(new Set((input.revokedLicenseIds || []).map(String))).sort();
  if (revokedLicenseIds.some((id) => !/^lic_[A-Za-z0-9_-]{8,80}$/.test(id))) throw new Error('revokedLicenseIds contains an invalid ID');
  const payload = {
    schemaVersion: 1,
    listVersion,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    keyId: String(input.keyId || 'revocation-ed25519-2026-01'),
    revokedLicenseIds,
  };
  const privateKey = readPrivateKey(input.privateKeyPath || process.env.XJ_REVOCATION_PRIVATE_KEY || DEFAULT_REVOCATION_KEY);
  return Object.assign({}, payload, { signature: signPayload(payload, privateKey) });
}

function parseFlags(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    result[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return result;
}

function writeGeneratedFile(file, content) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, target);
  return target;
}

function cli() {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));
  if (command === 'license') {
    const claim = signLicenseClaim({
      licenseId: flags['license-id'], subjectId: flags['subject-id'], tier: flags.tier,
      machineCode: flags['machine-code'], issuedAt: flags['issued-at'], expiresAt: flags['expires-at'],
      privateKeyPath: flags['private-key'], keyId: flags['key-id'],
    });
    process.stdout.write(encodeActivationCode(claim) + '\n');
    return;
  }
  if (command === 'revocations') {
    const list = signRevocationList({
      listVersion: Number(flags.version), issuedAt: flags['issued-at'], expiresAt: flags['expires-at'],
      revokedLicenseIds: String(flags.revoked || '').split(',').filter(Boolean),
      privateKeyPath: flags['private-key'], keyId: flags['key-id'],
    });
    const output = JSON.stringify(list, null, 2) + '\n';
    if (flags.out) {
      const target = writeGeneratedFile(flags.out, output);
      process.stdout.write('Signed revocation list written: ' + target + '\n');
    } else {
      process.stdout.write(output);
    }
    return;
  }
  throw new Error('Usage: license-sign-v2.js license|revocations --...');
}

if (require.main === module) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { stableJson, machineCodeHash, signLicenseClaim, signRevocationList, encodeActivationCode, writeGeneratedFile };
