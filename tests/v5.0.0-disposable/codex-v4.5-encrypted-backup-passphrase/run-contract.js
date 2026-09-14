'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const backupCrypto = require(path.resolve(__dirname, '../../../app/js/backup-crypto.js'));

const syntheticPayload = JSON.stringify({
  version: '2.0.0',
  exportedAt: '2026-08-01T00:00:00.000Z',
  clients: [{ id: 'client-synthetic-1', name: 'Synthetic Client' }],
  sessions: [{ id: 'session-synthetic-1', clientId: 'client-synthetic-1', transcript: 'synthetic clinical text' }],
});
const sensitivePayload = JSON.stringify({
  version: '2.0.0',
  settings: { apiConfig: { baseUrl: 'https://example.invalid/v1', model: 'synthetic-model', apiKey: 'xj-enc:must-not-leave-device' } }
});

function expectCode(fn, code) {
  return Promise.resolve().then(fn).then(
    () => { throw new Error('expected error ' + code); },
    (error) => { assert.strictEqual(error && error.code, code, 'expected stable error code'); }
  );
}

async function main() {
  assert.strictEqual(backupCrypto.FORMAT, 'xj-encrypted-backup');
  assert.strictEqual(backupCrypto.PASSPHRASE_MIN_LENGTH, 12);

  await expectCode(() => backupCrypto.encryptPayload(syntheticPayload, 'too-short'), 'XJ_BACKUP_PASSPHRASE_TOO_SHORT');

  const passphrase = 'synthetic recovery phrase 2026';
  const packageText = await backupCrypto.encryptPayload(syntheticPayload, passphrase, { kind: 'user-export' });
  const pkg = JSON.parse(packageText);
  assert.strictEqual(pkg.format, 'xj-encrypted-backup');
  assert.strictEqual(pkg.kind, 'user-export');
  assert.strictEqual(pkg.payloadVersion, '2.0.0');
  assert.ok(pkg.ciphertext && pkg.authTag && pkg.payloadSha256);
  assert.ok(!packageText.includes('synthetic clinical text'), 'package must not contain plaintext payload');
  assert.ok(!packageText.includes(passphrase), 'package must not contain recovery passphrase');

  const roundTrip = await backupCrypto.decryptPayload(packageText, passphrase);
  assert.deepStrictEqual(roundTrip && JSON.parse(roundTrip), backupCrypto.sanitizeExportPayload(JSON.parse(syntheticPayload)));
  await expectCode(() => backupCrypto.decryptPayload(packageText, 'wrong recovery phrase 2026'), 'XJ_BACKUP_AUTH_FAILED');

  const tamperedCipher = JSON.parse(packageText);
  tamperedCipher.ciphertext = tamperedCipher.ciphertext.slice(0, -2) + 'aa';
  await expectCode(() => backupCrypto.decryptPayload(JSON.stringify(tamperedCipher), passphrase), 'XJ_BACKUP_AUTH_FAILED');

  const tamperedAad = JSON.parse(packageText);
  tamperedAad.createdAt = '2026-08-01T00:00:01.000Z';
  tamperedAad.aad.createdAt = tamperedAad.createdAt;
  await expectCode(() => backupCrypto.decryptPayload(JSON.stringify(tamperedAad), passphrase), 'XJ_BACKUP_AUTH_FAILED');

  const tamperedHash = JSON.parse(packageText);
  tamperedHash.payloadSha256 = crypto.createHash('sha256').update('different').digest('hex');
  await expectCode(() => backupCrypto.decryptPayload(JSON.stringify(tamperedHash), passphrase), 'XJ_BACKUP_PAYLOAD_HASH_MISMATCH');

  const unknownField = JSON.parse(packageText);
  unknownField.extra = 'reject';
  await expectCode(() => backupCrypto.decryptPayload(JSON.stringify(unknownField), passphrase), 'XJ_BACKUP_PACKAGE_INVALID');

  const sanitized = backupCrypto.sanitizeExportPayload(JSON.parse(syntheticPayload));
  const sanitizedSensitive = backupCrypto.sanitizeExportPayload(JSON.parse(sensitivePayload));
  assert.strictEqual(sanitizedSensitive.settings.apiConfig.apiKey, undefined);
  assert.strictEqual(sanitizedSensitive.settings.apiConfig.model, 'synthetic-model');
  await expectCode(() => backupCrypto.encryptPayload(sensitivePayload, passphrase, { kind: 'user-export' }), 'XJ_BACKUP_PAYLOAD_INVALID');

  const deviceKey = crypto.randomBytes(32);
  const devicePackage = backupCrypto.encryptPayloadWithKey(JSON.stringify({ version: '1.0.0', kind: 'user-data-snapshot', files: [] }), deviceKey, { kind: 'user-data-snapshot', payloadVersion: '1.0.0' });
  const deviceRoundTrip = backupCrypto.decryptPayloadWithKey(devicePackage, deviceKey);
  assert.deepStrictEqual(JSON.parse(deviceRoundTrip), { version: '1.0.0', kind: 'user-data-snapshot', files: [] });
  const wrongDeviceKey = crypto.randomBytes(32);
  assert.throws(() => backupCrypto.decryptPayloadWithKey(devicePackage, wrongDeviceKey), (error) => error.code === 'XJ_BACKUP_AUTH_FAILED');

  console.log('BACKUP_CONTRACT=PASS');
  console.log('BACKUP_ASSERTIONS=18');
}

main().catch((error) => {
  console.error('BACKUP_CONTRACT=FAIL', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
