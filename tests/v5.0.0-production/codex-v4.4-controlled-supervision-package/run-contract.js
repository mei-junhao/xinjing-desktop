'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require(process.env.XJ_MUTANT_CORE || '../../../supervision-package-core');

const TASK_ID = 'XJ-5.0.0-codex-v4.4-controlled-supervision-package-runtime-32';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const INVENTORY = path.join(ROOT, 'docs/agent-coordination/v5.0.0/inventory/codex-v4.4-controlled-supervision-package-runtime-32');
const PREFIX = Buffer.from([0x58, 0x4a, 0x53, 0x55, 0x50, 0x2f, 0x31, 0x00]);
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function rawPublic(keyObject) {
  const publicObject = keyObject.type === 'public' ? keyObject : crypto.createPublicKey(keyObject);
  const der = publicObject.export({ format: 'der', type: 'spki' });
  assert(der.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX));
  return der.subarray(X25519_SPKI_PREFIX.length);
}

function aesEncrypt(key, nonce, aad, plain) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return { ciphertext: Buffer.concat([cipher.update(plain), cipher.final()]), tag: cipher.getAuthTag() };
}

function makeResourceMap(resourcePath, content) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    schemaVersion: 1,
    resources: {
      [resourcePath]: {
        mediaType: 'text/markdown',
        length: bytes.length,
        bytes: core.encodeBase64url(bytes),
      },
    },
  };
}

function buildContainer(manifestBytes, ciphertext, tag, signature) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifestBytes.length, 0);
  const cipherLength = Buffer.alloc(8);
  cipherLength.writeBigUInt64BE(BigInt(ciphertext.length));
  return Buffer.concat([PREFIX, Buffer.from([0, 1]), length, manifestBytes, cipherLength, ciphertext, tag, signature]);
}

function createFixture(options) {
  const input = Object.assign({ resourcePath: 'prompts/system.md', content: 'Observe only the declared material.\n' }, options || {});
  const author = crypto.generateKeyPairSync('ed25519');
  const device = crypto.generateKeyPairSync('x25519');
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const subjectIdHash = core.hashOpaque('synthetic-subject');
  const licenseIdHash = core.hashOpaque('synthetic-license');
  const devicePublicKeyHash = core.hashBytesBase64url(rawPublic(device.privateKey));
  const contentNonce = crypto.randomBytes(12);
  const contentKey = crypto.randomBytes(32);
  const salt = crypto.randomBytes(16);
  const wrapNonce = crypto.randomBytes(12);
  const resourceMap = makeResourceMap(input.resourcePath, input.content);
  const plaintext = core.canonicalBytes(resourceMap);
  const grant = {
    grantId: 'grant_synthetic_01',
    grantSequence: input.grantSequence || 1,
    subjectIdHash,
    licenseIdHash,
    deviceKeyId: 'device_synthetic_01',
    devicePublicKeyHash,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: input.expiresAt || '2027-01-01T00:00:00.000Z',
    revocationEpoch: input.revocationEpoch || 1,
    entitlementKey: 'custom-supervisors',
    ephemeralPublicKey: core.encodeBase64url(rawPublic(ephemeral.publicKey)),
    kdfSalt: core.encodeBase64url(salt),
    wrapNonce: core.encodeBase64url(wrapNonce),
    wrappedContentKey: '',
    wrappedKeyTag: '',
  };
  const manifest = {
    schemaVersion: 1,
    packageId: input.packageId || 'pkg_synthetic_01',
    supervisorId: 'supervisor_synthetic_01',
    displayName: '合成受控督导方式',
    packageVersion: input.packageVersion || '1.0.0',
    minimumAppVersion: '5.0.0',
    authorKeyId: 'author_synthetic_01',
    cipherSuite: core.CIPHER_SUITE,
    contentNonce: core.encodeBase64url(contentNonce),
    ciphertextHash: '',
    contentSchemaHash: core.hashBytesBase64url(plaintext),
    providerPolicy: { mode: 'local-only' },
    limits: { maxResources: 8, maxResourceBytes: 1024 * 1024, maxPlaintextBytes: 1024 * 1024, maxRunSeconds: 30 },
    recipientGrant: grant,
  };

  const content = aesEncrypt(contentKey, contentNonce, core.contentAad(manifest), plaintext);
  manifest.ciphertextHash = core.hashBytesBase64url(content.ciphertext);
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: device.publicKey });
  const kek = Buffer.from(crypto.hkdfSync('sha256', shared, salt, core.hkdfInfo(manifest), 32));
  const wrapped = aesEncrypt(kek, wrapNonce, core.packageKeyAad(manifest), contentKey);
  grant.wrappedContentKey = core.encodeBase64url(wrapped.ciphertext);
  grant.wrappedKeyTag = core.encodeBase64url(wrapped.tag);
  const manifestBytes = core.canonicalBytes(manifest);
  const signature = crypto.sign(null, core.signaturePayload(manifestBytes, content.ciphertext, content.tag), author.privateKey);
  const bytes = buildContainer(manifestBytes, content.ciphertext, content.tag, signature);
  return {
    bytes,
    manifest,
    author,
    device,
    publicKeys: { authors: { author_synthetic_01: author.publicKey.export({ format: 'pem', type: 'spki' }) } },
    context(overrides) {
      return Object.assign({
        entitlementAllowed: true,
        subjectIdHash,
        licenseIdHash,
        deviceKeyId: 'device_synthetic_01',
        devicePublicKeyHash,
        keyObject: device.privateKey,
        appVersion: '5.0.0',
        nowMs: Date.parse('2026-06-01T00:00:00.000Z'),
        online: true,
        revocation: { valid: true, revocationEpoch: 1, lastVerifiedOnlineAtMs: Date.parse('2026-05-01T00:00:00.000Z') },
        highWater: core.createHighWaterState(),
      }, overrides || {});
    },
  };
}

function replaceManifest(bytes, manifestBytes) {
  const oldLength = bytes.readUInt32BE(10);
  const oldStart = 14;
  const oldEnd = oldStart + oldLength;
  return Buffer.concat([bytes.subarray(0, 10), Buffer.from([(manifestBytes.length >>> 24) & 255, (manifestBytes.length >>> 16) & 255, (manifestBytes.length >>> 8) & 255, manifestBytes.length & 255]), manifestBytes, bytes.subarray(oldEnd)]);
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error && error.code === code, 'expected ' + code);
}

const results = [];
function check(id, title, fn) {
  try { fn(); results.push({ id, title, status: 'PASS' }); console.log('[PASS] ' + id + ' — ' + title); }
  catch (error) { results.push({ id, title, status: 'FAIL', error: error.message }); console.log('[FAIL] ' + id + ' — ' + title + ' — ' + error.message); }
}

const fixture = createFixture();
const parseOptions = { fileName: 'synthetic.xjsup', publicKeys: fixture.publicKeys };

check('P1', 'XJSUP/1 parser verifies exact framing and author signature', () => {
  const parsed = core.parseXjsup(fixture.bytes, parseOptions);
  assert.strictEqual(parsed.manifest.packageId, fixture.manifest.packageId);
  assert.strictEqual(parsed.ciphertext.length > 0, true);
});
check('P2', 'inspect returns only a sanitized descriptor', () => {
  const result = core.inspectPackage(fixture.bytes, parseOptions);
  assert.strictEqual(result.descriptor.supervisorId, fixture.manifest.supervisorId);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.descriptor, 'subjectIdHash'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.descriptor, 'ciphertext'), false);
});
check('P3', 'main-process open path unwraps and authenticates declarative resources', () => {
  const result = core.openPackage(fixture.bytes, fixture.context(), parseOptions);
  const resource = result.resources.resources['prompts/system.md'];
  assert(resource);
  assert.strictEqual(resource.bytes.toString('utf8'), fixture.manifest ? 'Observe only the declared material.\n' : '');
});
check('N1', 'signature is checked before any recipient decryption', () => {
  const corrupted = Buffer.from(fixture.bytes);
  corrupted[corrupted.length - 1] ^= 1;
  expectCode('signature-invalid', () => core.parseXjsup(corrupted, parseOptions));
});
check('N2', 'ciphertext hash rejects tampering before decryption', () => {
  const corrupted = Buffer.from(fixture.bytes);
  corrupted[corrupted.length - 81] ^= 1;
  expectCode('ciphertext-hash', () => core.parseXjsup(corrupted, parseOptions));
});
check('N3', 'wrong subject binding fails closed', () => expectCode('subject-mismatch', () => core.openPackage(fixture.bytes, fixture.context({ subjectIdHash: core.hashOpaque('other') }), parseOptions)));
check('N4', 'wrong license binding fails closed', () => expectCode('license-mismatch', () => core.openPackage(fixture.bytes, fixture.context({ licenseIdHash: core.hashOpaque('other') }), parseOptions)));
check('N5', 'wrong device binding fails closed', () => expectCode('device-mismatch', () => core.openPackage(fixture.bytes, fixture.context({ deviceKeyId: 'device_other' }), parseOptions)));
check('N5B', 'wrong device public key binding fails closed', () => expectCode('device-mismatch', () => core.openPackage(fixture.bytes, fixture.context({ devicePublicKeyHash: core.encodeBase64url(Buffer.alloc(32, 7)) }), parseOptions)));
check('N6', 'Flagship entitlement is a separate gate from possession of the file', () => expectCode('entitlement-denied', () => core.openPackage(fixture.bytes, fixture.context({ entitlementAllowed: false }), parseOptions)));
check('N7', 'online revoked evidence disables new runs immediately', () => expectCode('package-revoked', () => core.openPackage(fixture.bytes, fixture.context({ revocation: { valid: true, revokedPackageIds: [fixture.manifest.packageId], lastVerifiedOnlineAtMs: Date.parse('2026-05-01T00:00:00.000Z') } }), parseOptions)));
check('N8', 'online verification without current evidence fails closed', () => expectCode('revocation-unavailable', () => core.openPackage(fixture.bytes, fixture.context({ revocation: { valid: false } }), parseOptions)));
check('P4', 'offline grace is allowed only within seven days of online evidence', () => {
  const now = Date.parse('2026-05-07T00:00:00.000Z');
  const result = core.openPackage(fixture.bytes, fixture.context({ online: false, nowMs: now, revocation: { valid: false, cachedValid: true, lastVerifiedOnlineAtMs: Date.parse('2026-05-01T00:00:00.000Z') } }), parseOptions);
  assert.strictEqual(result.descriptor.status, 'available');
});
check('N9', 'offline grace expires at the seven-day ceiling', () => expectCode('offline-grace-expired', () => core.openPackage(fixture.bytes, fixture.context({ online: false, nowMs: Date.parse('2026-05-09T00:00:01.000Z'), revocation: { valid: false, cachedValid: true, lastVerifiedOnlineAtMs: Date.parse('2026-05-01T00:00:00.000Z') } }), parseOptions)));
check('N10', 'clock rollback rejects package runs', () => expectCode('clock-rollback', () => core.openPackage(fixture.bytes, fixture.context({ highWater: Object.assign(core.createHighWaterState(), { lastSeenAtMs: Date.parse('2026-06-02T00:00:00.000Z') }), nowMs: Date.parse('2026-06-01T00:00:00.000Z') }), parseOptions)));
check('N11', 'grant sequence high-water rejects an older recipient grant', () => expectCode('grant-sequence-rollback', () => core.openPackage(fixture.bytes, fixture.context({ highWater: { schemaVersion: 1, lastSeenAtMs: 0, revocationEpoch: 1, grants: { [fixture.manifest.recipientGrant.grantId]: { grantSequence: 2 } }, packages: {} } }), parseOptions)));
check('N12', 'package version high-water rejects rollback', () => expectCode('package-version-rollback', () => core.openPackage(fixture.bytes, fixture.context({ highWater: { schemaVersion: 1, lastSeenAtMs: 0, revocationEpoch: 1, grants: {}, packages: { [fixture.manifest.packageId]: { packageVersion: '2.0.0' } } } }), parseOptions)));
check('N13', 'revocation epoch high-water rejects rollback', () => expectCode('revocation-epoch-rollback', () => core.openPackage(fixture.bytes, fixture.context({ highWater: { schemaVersion: 1, lastSeenAtMs: 0, revocationEpoch: 2, grants: {}, packages: {} } }), parseOptions)));
check('N14', 'noncanonical manifest bytes are rejected before signature use', () => {
  const noncanonical = Buffer.from(JSON.stringify(fixture.manifest));
  expectCode('manifest-noncanonical', () => core.parseXjsup(replaceManifest(fixture.bytes, noncanonical), parseOptions));
});
check('N15', 'duplicate manifest keys are rejected', () => {
  const duplicate = Buffer.from('{"schemaVersion":1,"schemaVersion":1}');
  expectCode('manifest-duplicate-key', () => core.parseXjsup(replaceManifest(fixture.bytes, duplicate), parseOptions));
});
check('N16', 'path traversal resource is rejected after authenticated decrypt', () => {
  const bad = createFixture({ resourcePath: '../outside.md' });
  expectCode('resource-path', () => core.openPackage(bad.bytes, bad.context(), { fileName: 'bad.xjsup', publicKeys: bad.publicKeys }));
});
check('N17', 'executable/network resource content is rejected', () => {
  const bad = createFixture({ content: 'https://not-allowed.example\n' });
  expectCode('resource-content', () => core.openPackage(bad.bytes, bad.context(), { fileName: 'bad.xjsup', publicKeys: bad.publicKeys }));
});
check('P5', 'high-water update is monotonic and stores no binding plaintext', () => {
  const state = core.advanceHighWater(core.createHighWaterState(), fixture.manifest, Date.parse('2026-06-01T00:00:00.000Z'));
  assert.strictEqual(state.grants[fixture.manifest.recipientGrant.grantId].grantSequence, 1);
  assert.strictEqual(JSON.stringify(state).includes('synthetic-subject'), false);
});
check('P6', 'interrupted migration can roll back or complete without dual-active state', () => {
  const start = core.createGrantState({ grantId: 'grant_synthetic_01', deviceKeyId: 'device_old', grantSequence: 1, revocationEpoch: 1 });
  const pending = core.applyGrantMigration(start, { grantId: start.grantId, targetDeviceKeyId: 'device_new', grantSequence: 2, phase: 'pending', signatureValid: true });
  assert.strictEqual(pending.ok, true);
  const rollback = core.applyGrantMigration(pending.state, { grantId: start.grantId, targetDeviceKeyId: 'device_new', grantSequence: 2, phase: 'rollback', signatureValid: true });
  assert.strictEqual(rollback.state.activeDeviceKeyId, 'device_old');
  const pendingAgain = core.applyGrantMigration(start, { grantId: start.grantId, targetDeviceKeyId: 'device_new', grantSequence: 2, phase: 'pending', signatureValid: true });
  const complete = core.applyGrantMigration(pendingAgain.state, { grantId: start.grantId, targetDeviceKeyId: 'device_new', grantSequence: 2, phase: 'complete', signatureValid: true, oldDeviceRevoked: true, revocationEpoch: 2 });
  assert.strictEqual(complete.state.activeDeviceKeyId, 'device_new');
  assert.strictEqual(complete.state.pendingDeviceKeyId, '');
});
check('N18', 'migration cannot complete for an untracked target', () => {
  const start = core.createGrantState({ grantId: 'grant_synthetic_01', deviceKeyId: 'device_old', grantSequence: 1, revocationEpoch: 1 });
  const result = core.applyGrantMigration(start, { grantId: start.grantId, targetDeviceKeyId: 'device_new', grantSequence: 2, phase: 'complete', signatureValid: true });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'migration-target-mismatch');
});
check('N19', 'migration cannot activate the new device before old-device revocation', () => {
  const start = core.createGrantState({ grantId: 'grant_synthetic_01', deviceKeyId: 'device_old', grantSequence: 1, revocationEpoch: 1 });
  const pending = core.applyGrantMigration(start, { grantId: start.grantId, targetDeviceKeyId: 'device_new', grantSequence: 2, phase: 'pending', signatureValid: true });
  const result = core.applyGrantMigration(pending.state, { grantId: start.grantId, targetDeviceKeyId: 'device_new', grantSequence: 2, phase: 'complete', signatureValid: true, revocationEpoch: 2 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'migration-revocation-required');
});
check('P7', 'signed revocation evidence verifies with a public key only', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const evidence = { schemaVersion: 1, listVersion: 1, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', keyId: 'revocation_synthetic_01', revocationEpoch: 2, revokedPackageIds: [], revokedGrantIds: [] };
  const signed = Buffer.concat([Buffer.from('XJSUP-REVOCATION-v1\0'), core.canonicalBytes(evidence)]);
  evidence.signature = core.encodeBase64url(crypto.sign(null, signed, pair.privateKey));
  const checked = core.verifyRevocationEvidence(evidence, { nowMs: Date.parse('2026-06-01T00:00:00.000Z'), publicKeys: { revocations: { revocation_synthetic_01: pair.publicKey.export({ format: 'pem', type: 'spki' }) } } });
  assert.strictEqual(checked.valid, true);
});

const failed = results.filter((item) => item.status !== 'PASS');
fs.mkdirSync(INVENTORY, { recursive: true });
fs.writeFileSync(path.join(INVENTORY, 'contract-result.json'), JSON.stringify({ task_id: TASK_ID, confirmed: results.length - failed.length, failed: failed.length, checks: results }, null, 2) + '\n', 'utf8');
console.log('----------------------------------------');
console.log('Confirmed: ' + (results.length - failed.length) + ' | Failed: ' + failed.length);
process.exitCode = failed.length ? 1 : 0;
