#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const License = require(path.join(ROOT, 'license-core.js'));
const NOW = Date.parse('2026-07-20T12:00:00.000Z');
const MACHINE_A = 'SYNTHETIC-MACHINE-A';
const MACHINE_B = 'SYNTHETIC-MACHINE-B';
const licensePair = crypto.generateKeyPairSync('ed25519');
const revocationPair = crypto.generateKeyPairSync('ed25519');
const LICENSE_KEY_ID = 'test-license-key';
const REVOCATION_KEY_ID = 'test-revocation-key';
const licenseKeys = { [LICENSE_KEY_ID]: licensePair.publicKey.export({ type: 'spki', format: 'pem' }) };
const revocationKeys = { [REVOCATION_KEY_ID]: revocationPair.publicKey.export({ type: 'spki', format: 'pem' }) };

const source = {
  core: fs.readFileSync(path.join(ROOT, 'license-core.js'), 'utf8'),
  keys: fs.readFileSync(path.join(ROOT, 'license-public-keys.js'), 'utf8'),
  main: fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'),
  cloud: fs.readFileSync(path.join(ROOT, 'cloud-verify.js'), 'utf8'),
  activation: fs.readFileSync(path.join(ROOT, 'app', 'activation.html'), 'utf8'),
  package: fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
};
const packageJson = JSON.parse(source.package);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('[PASS] ' + name);
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error && error.message ? error.message : String(error) });
    console.log('[FAIL] ' + name + ': ' + failures[failures.length - 1].error);
  }
}

function signature(payload, privateKey) {
  return crypto.sign(null, Buffer.from(License.stableJson(payload), 'utf8'), privateKey).toString('base64url');
}

function signedClaim(overrides) {
  const payload = Object.assign({
    schemaVersion: 2,
    licenseId: 'lic_synthetic_0001',
    tier: 'pro',
    subjectId: 'sub_synthetic_user',
    machineCodeHash: License.machineCodeHash(MACHINE_A),
    issuedAt: '2026-07-19T12:00:00.000Z',
    expiresAt: '2027-07-20T12:00:00.000Z',
    keyId: LICENSE_KEY_ID,
  }, overrides || {});
  return Object.assign({}, payload, { signature: signature(payload, licensePair.privateKey) });
}

function signedRevocations(overrides) {
  const payload = Object.assign({
    schemaVersion: 1,
    listVersion: 3,
    issuedAt: '2026-07-19T12:00:00.000Z',
    expiresAt: '2027-07-20T12:00:00.000Z',
    keyId: REVOCATION_KEY_ID,
    revokedLicenseIds: [],
  }, overrides || {});
  return Object.assign({}, payload, { signature: signature(payload, revocationPair.privateKey) });
}

function verifyClaim(claim, options) {
  return License.verifyKey(claim, MACHINE_A, Object.assign({
    now: NOW,
    publicKeys: licenseKeys,
    revocationList: signedRevocations(),
    revocationPublicKeys: revocationKeys,
    minimumRevocationVersion: 3,
  }, options || {}));
}

function encodeClaim(claim) {
  return 'XJ2-' + Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
}

function mutateSignature(value) {
  const first = value.charAt(0) === 'A' ? 'B' : 'A';
  return first + value.slice(1);
}

test('L1 valid Pro and Custom claims verify with Ed25519', () => {
  const pro = verifyClaim(signedClaim());
  const custom = verifyClaim(signedClaim({ licenseId: 'lic_synthetic_0002', tier: 'custom' }));
  assert.strictEqual(pro.valid, true);
  assert.strictEqual(pro.tier, 'pro');
  assert.strictEqual(custom.valid, true);
  assert.strictEqual(custom.tier, 'custom');
  assert.strictEqual(verifyClaim(signedClaim({ tier: 'full' })).valid, false, 'legacy full must not be a v2 paid tier');
});

test('L2 activation code decoding preserves the exact signed claim', () => {
  const claim = signedClaim();
  const result = verifyClaim(encodeClaim(claim));
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.claim, claim);
});

test('L3 tier, expiry, machine hash and signature tampering fail closed', () => {
  const original = signedClaim();
  const forgedTier = Object.assign({}, original, { tier: 'custom' });
  const forgedExpiry = Object.assign({}, original, { expiresAt: '2028-07-20T12:00:00.000Z' });
  const forgedMachine = Object.assign({}, original, { machineCodeHash: License.machineCodeHash(MACHINE_B) });
  const forgedSignature = Object.assign({}, original, { signature: mutateSignature(original.signature) });
  [forgedTier, forgedExpiry, forgedMachine, forgedSignature].forEach((claim) => {
    assert.strictEqual(verifyClaim(claim).valid, false);
  });
});

test('L4 cross-device reuse and unknown keyId fail closed', () => {
  const crossDevice = License.verifyKey(signedClaim(), MACHINE_B, {
    now: NOW, publicKeys: licenseKeys, revocationList: signedRevocations(),
    revocationPublicKeys: revocationKeys, minimumRevocationVersion: 3,
  });
  assert.strictEqual(crossDevice.valid, false);
  assert.strictEqual(crossDevice.errorCode, 'machine-mismatch');
  const unknown = signedClaim({ keyId: 'unknown-license-key' });
  assert.strictEqual(verifyClaim(unknown).errorCode, 'unknown-key');
});

test('L5 future-issued and expired claims fail closed', () => {
  const future = signedClaim({ issuedAt: '2026-07-21T12:00:00.000Z', expiresAt: '2027-07-21T12:00:00.000Z' });
  const expired = signedClaim({ issuedAt: '2025-07-19T12:00:00.000Z', expiresAt: '2026-07-19T12:00:00.000Z' });
  assert.strictEqual(verifyClaim(future).errorCode, 'not-yet-valid');
  assert.strictEqual(verifyClaim(expired).errorCode, 'expired');
});

test('L6 malformed, extra-field and invalid-signature claims fail closed', () => {
  const extra = Object.assign({}, signedClaim(), { editableTier: 'custom' });
  const malformed = Object.assign({}, signedClaim(), { subjectId: 'real customer name' });
  assert.strictEqual(verifyClaim(extra).valid, false);
  assert.strictEqual(verifyClaim(malformed).valid, false);
  assert.strictEqual(verifyClaim({}).valid, false);
});

test('L7 legacy HMAC code and editable legacy license file enter migration state', () => {
  const legacyCode = License.verifyKey('XJ-AAAA-BBBB-CCCC', MACHINE_A, { requireRevocation: false });
  const legacyRecord = License.verifyStoredRecord({
    identity: 'editable', tier: 'custom', expiresAt: 4102444800000, activatedAt: Date.now(),
  }, MACHINE_A, { requireRevocation: false });
  assert.strictEqual(legacyCode.valid, false);
  assert.strictEqual(legacyCode.migrationRequired, true);
  assert.strictEqual(legacyRecord.valid, false);
  assert.strictEqual(legacyRecord.tier, 'free');
  assert.strictEqual(legacyRecord.migrationRequired, true);
});

test('L8 stored v2 record grants only after the nested claim is verified', () => {
  const claim = signedClaim();
  const valid = License.verifyStoredRecord({ schemaVersion: 2, claim, tier: 'free' }, MACHINE_A, {
    now: NOW, publicKeys: licenseKeys, revocationList: signedRevocations(),
    revocationPublicKeys: revocationKeys, minimumRevocationVersion: 3,
  });
  const forged = License.verifyStoredRecord({ schemaVersion: 2, claim: Object.assign({}, claim, { tier: 'custom' }), tier: 'custom' }, MACHINE_A, {
    now: NOW, publicKeys: licenseKeys, revocationList: signedRevocations(),
    revocationPublicKeys: revocationKeys, minimumRevocationVersion: 3,
  });
  assert.strictEqual(valid.valid, true);
  assert.strictEqual(valid.tier, 'pro');
  assert.strictEqual(forged.valid, false);
});

test('L9 valid, expired, malformed and rolled-back revocation lists are distinguished', () => {
  assert.strictEqual(License.verifyRevocationList(signedRevocations(), { now: NOW, publicKeys: revocationKeys, minimumVersion: 3 }).valid, true);
  const expired = signedRevocations({ issuedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(License.verifyRevocationList(expired, { now: NOW, publicKeys: revocationKeys }).errorCode, 'revocation-expired');
  const rollback = signedRevocations({ listVersion: 2 });
  assert.strictEqual(License.verifyRevocationList(rollback, { now: NOW, publicKeys: revocationKeys, minimumVersion: 3 }).errorCode, 'revocation-rollback');
  const malformed = Object.assign({}, signedRevocations(), { revokedLicenseIds: ['bad-id'] });
  assert.strictEqual(License.verifyRevocationList(malformed, { now: NOW, publicKeys: revocationKeys }).valid, false);
});

test('L10 revoked licenseId cannot activate', () => {
  const claim = signedClaim();
  const revoked = signedRevocations({ revokedLicenseIds: [claim.licenseId] });
  const result = License.verifyKey(claim, MACHINE_A, {
    now: NOW, publicKeys: licenseKeys, revocationList: revoked,
    revocationPublicKeys: revocationKeys, minimumRevocationVersion: 3,
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.errorCode, 'revoked');
});

test('L11 production empty revocation list verifies with packaged public key', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'license-revocations.json'), 'utf8'));
  const result = License.verifyRevocationList(list, { now: Date.now(), minimumVersion: 1 });
  assert.strictEqual(result.valid, true, result.errorCode || 'production revocation verification failed');
  assert.strictEqual(result.listVersion, 1);
  assert.deepStrictEqual(result.revokedLicenseIds, []);
});

test('L12 packaged client exposes verification keys only and no HMAC issuer', () => {
  assert.ok(!/\bencodeKey\b|\bSECRET\b|createHmac|HMAC-SHA256/.test(source.core));
  assert.ok(!/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(source.keys));
  assert.ok(/verifyKey/.test(source.core) && /verifyRevocationList/.test(source.core));
  // 真实包内清单：必须来自 @electron/asar 读取真实 dist/win-unpacked/resources/app.asar，
  // 绝不回退到构建配置里的打包文件清单（当前 package.json 无 build 节点，引用它会抛错）。
  const asarPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
  assert.ok(fs.existsSync(asarPath), '真实 app.asar 必须存在：' + asarPath);
  let inventory;
  try {
    const asar = require('@electron/asar');
    inventory = asar.listPackage(asarPath);
  } catch (err) {
    assert.ok(false, '无法用 @electron/asar 读取真实 app.asar（解析器不可用或需联网时应明确失败）：' + err.message);
  }
  assert.ok(Array.isArray(inventory) && inventory.length > 0,
    '@electron/asar 必须同步返回非空包内清单；解析器不可用/返回 Promise 时应明确失败');
  const files = inventory.map((f) => String(f).split('\\').join('/'));
  // 必需的运行时验证材料必须存在
  assert.ok(files.some((f) => /^[/]?license-public-keys\.js$/.test(f)), '包必须包含 license-public-keys.js');
  assert.ok(files.some((f) => /^[/]?license-revocations\.json$/.test(f)), '包必须包含 license-revocations.json');
  // 代理密钥由有效账号会话鉴权，不进入客户端包；把它打入 app.asar 会扩大可逆向的信任边界。
  assert.ok(!files.some((f) => /^[/]?proxy-secret\.generated\.js$/.test(f)), '包必须不含 proxy-secret.generated.js');
  // 禁止：签发密钥、私钥、签发脚本、开发脚本目录
  assert.ok(!files.some((f) => /^[/]?secret\.generated\.js$/.test(f)), '包必须不含 secret.generated.js');
  assert.ok(!files.some((f) => /private[._-]?key|PRIVATE\s+KEY|\.pem$/i.test(f)), '包必须不含私钥');
  assert.ok(!files.some((f) => /license-sign-v2|sign-v2|gen-license|codegen-secret/i.test(f)), '包必须不含签发脚本');
  assert.ok(!files.some((f) => /^[/]?scripts\//.test(f)), '包必须不含 scripts/ 开发目录');
});

test('L13 startup and activation reverify claims, sender and revocation state', () => {
  assert.ok(/verifyStoredRecord\(/.test(source.main));
  assert.ok(/loadVerifiedRevocationList\(now\)/.test(source.main));
  assert.ok(/minimumRevocationVersion/.test(source.main));
  assert.ok(/atomicWriteJson\(licenseFilePath\(\)/.test(source.main));
  assert.ok(/ipcMain\.handle\('xj:activate',[\s\S]*?isTrustedRendererEvent\(event\)/.test(source.main));
  assert.ok(!/require\('\.\/secret\.generated'\)/.test(source.main));
  assert.ok(!/bonusDays|finalExpires/.test(source.main));
});

test('L14 cloud response is bounded and locally verified before persistence', () => {
  assert.ok(/MAX_RESPONSE_BYTES/.test(source.cloud));
  assert.ok(/signedClaim/.test(source.cloud));
  assert.ok(/resolvePublicAddresses/.test(source.cloud) && /isPrivateNetworkAddress/.test(source.cloud));
  assert.ok(/lookup:\s*\(_hostname, options, callback\)/.test(source.cloud));
  assert.ok(!/identity:\s*String\(j\.identity\)|tier:\s*String\(j\.tier/.test(source.cloud));
  assert.ok(/activateSignedClaim\(response\.signedClaim, 'cloud'\)/.test(source.main));
});

test('L15 activation utility exposes v2, migration and accurate trial/BYOK language', () => {
  assert.ok(/XJ2-/.test(source.activation));
  assert.ok(/旧版 XJ- 激活码需要人工迁移/.test(source.activation));
  assert.ok(/AI 试用不代表已购买会员或旗舰版/.test(source.activation));
  assert.ok(/自带 API Key（仅算力配置）/.test(source.activation));
  assert.ok(/基础 Markdown、TXT、Word 导出与打印/.test(source.activation));
  assert.ok(!/[✓✗]/.test(source.activation));
  assert.ok(/border-radius:\s*6px/.test(source.activation));
});

const candidateFiles = [
  'license-core.js', 'license-public-keys.js', 'license-revocations.json', 'main.js',
  'cloud-verify.js', 'app/activation.html', 'package.json', 'scripts/codegen-secret.js',
  'scripts/gen-license.js', 'scripts/license-sign-v2.js', 'scripts/v4.2.1-tests/license-v2.contract.js',
];
const candidateHash = crypto.createHash('sha256');
candidateFiles.forEach((file) => {
  candidateHash.update(file.replace(/\\/g, '/') + '\0');
  candidateHash.update(fs.readFileSync(path.join(ROOT, file)));
  candidateHash.update('\0');
});

console.log('\nLicense v2 candidate scope SHA-256: ' + candidateHash.digest('hex'));
console.log('Passed ' + passed + ' / Failed ' + failed);
if (failures.length) failures.forEach((item) => console.log('- ' + item.name + ': ' + item.error));
process.exitCode = failed > 0 ? 1 : 0;
