'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CORE = path.join(ROOT, 'supervision-package-core.js');
const RUNNER = path.join(__dirname, 'run-contract.js');
const mutations = [
  ['M01', 'remove author signature verification', 'if (!crypto.verify(null, signaturePayload(manifestBytes, ciphertext, contentTag), publicKey, signature)) fail(\'signature-invalid\', \'author signature is invalid\');', 'if (false) fail(\'signature-invalid\', \'author signature is invalid\');'],
  ['M02', 'remove ciphertext hash verification', 'if (expectedHash !== manifest.ciphertextHash) fail(\'ciphertext-hash\', \'ciphertext hash does not match\');', 'if (false) fail(\'ciphertext-hash\', \'ciphertext hash does not match\');'],
  ['M03', 'remove subject binding gate', 'if (ctx.subjectIdHash !== grant.subjectIdHash) fail(\'subject-mismatch\', \'package subject binding does not match\');', 'if (false) fail(\'subject-mismatch\', \'package subject binding does not match\');'],
  ['M04', 'remove license binding gate', 'if (ctx.licenseIdHash !== grant.licenseIdHash) fail(\'license-mismatch\', \'package license binding does not match\');', 'if (false) fail(\'license-mismatch\', \'package license binding does not match\');'],
  ['M05', 'remove device key id gate', 'if (ctx.deviceKeyId !== grant.deviceKeyId) fail(\'device-mismatch\', \'package device binding does not match\');', 'if (false) fail(\'device-mismatch\', \'package device binding does not match\');'],
  ['M06', 'remove device public hash gates', [
    'if (ctx.devicePublicKeyHash !== grant.devicePublicKeyHash) fail(\'device-mismatch\', \'package device public key binding does not match\');',
    'if (encodeBase64url(hashBytes(rawPublic)) !== grant.devicePublicKeyHash) fail(\'device-mismatch\', \'device key does not match grant\');',
  ], [
    'if (false) fail(\'device-mismatch\', \'package device public key binding does not match\');',
    'if (false) fail(\'device-mismatch\', \'device key does not match grant\');',
  ]],
  ['M07', 'remove Flagship entitlement gate', 'if (ctx.entitlementAllowed !== true) fail(\'entitlement-denied\', \'Flagship controlled-supervisors entitlement is required\');', 'if (false) fail(\'entitlement-denied\', \'Flagship controlled-supervisors entitlement is required\');'],
  ['M08', 'remove online package revocation gate', '|| (Array.isArray(revocation.revokedPackageIds) && revocation.revokedPackageIds.includes(manifest.packageId))', '|| false'],
  ['M09', 'remove online evidence requirement', 'if (revocation.valid !== true) fail(\'revocation-unavailable\', \'online verification evidence is unavailable\');', 'if (false) fail(\'revocation-unavailable\', \'online verification evidence is unavailable\');'],
  ['M10', 'remove offline seven-day ceiling', 'if (!evidenceValid || !safeInteger(lastVerified, 1) || nowMs < lastVerified || nowMs - lastVerified > MAX_OFFLINE_GRACE_MS)', 'if (false)'],
  ['M11', 'remove clock rollback gate', 'if (highWater.lastSeenAtMs && nowMs < highWater.lastSeenAtMs) fail(\'clock-rollback\', \'clock moved backwards\');', 'if (false) fail(\'clock-rollback\', \'clock moved backwards\');'],
  ['M12', 'remove grant sequence high-water', 'if (priorGrant && grant.grantSequence < priorGrant.grantSequence) fail(\'grant-sequence-rollback\', \'grant sequence moved backwards\');', 'if (false) fail(\'grant-sequence-rollback\', \'grant sequence moved backwards\');'],
  ['M13', 'remove package version high-water', 'if (priorPackage && compareSemver(manifest.packageVersion, priorPackage.packageVersion) < 0) fail(\'package-version-rollback\', \'package version moved backwards\');', 'if (false) fail(\'package-version-rollback\', \'package version moved backwards\');'],
  ['M14', 'remove normalized resource path gate', /if \(typeof resourcePath !== 'string'[\s\S]*?resourcePath\.split\('\/'\)\.some\(\(part\) => !part \|\| part === '\.' \|\| part === '\.\.'\)\) \{/, 'if (false) {'],
  ['M15', 'remove executable and network content gate', 'if (forbiddenResourceContent(text)) fail(\'resource-content\', \'resource contains executable or network content\');', 'if (false) fail(\'resource-content\', \'resource contains executable or network content\');'],
  ['M16', 'remove migration target finality gate', /if \(event\.phase === 'complete'\) \{\n    if \(next\.pendingDeviceKeyId !== event\.targetDeviceKeyId\) return \{ ok: false, errorCode: 'migration-target-mismatch', state \};/, "if (event.phase === 'complete') {\n    if (false) return { ok: false, errorCode: 'migration-target-mismatch', state };"],
  ['M17', 'reverse mutation: permit all entitlement decisions', 'if (ctx.entitlementAllowed !== true) fail(\'entitlement-denied\', \'Flagship controlled-supervisors entitlement is required\');', 'if (ctx.entitlementAllowed !== true) { /* reverse mutation intentionally neutralized by test */ }'],
];

function mutate(source, from, to) {
  if (Array.isArray(from)) {
    let next = source;
    from.forEach((anchor, index) => { next = mutate(next, anchor, to[index]); });
    return next;
  }
  if (from instanceof RegExp) {
    const next = source.replace(from, to);
    if (next === source) throw new Error('mutation anchor not found');
    return next;
  }
  if (!source.includes(from)) throw new Error('mutation anchor not found');
  return source.replace(from, to);
}

const first = spawnSync(process.execPath, [RUNNER], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
if (first.status !== 0) {
  console.error('[FAIL] healthy runner is not green before mutation phase');
  process.exit(1);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-xjsup-mutants-'));
const results = [];
try {
  const source = fs.readFileSync(CORE, 'utf8');
  mutations.forEach(([id, title, from, to], index) => {
    const mutantPath = path.join(temp, 'core-' + id + '.js');
    let mutated;
    try { mutated = mutate(source, from, to); }
    catch (error) {
      results.push({ id, title, verdict: 'harness_error', error: error.message });
      console.log('[HARNESS_ERROR] ' + id + ' — ' + title);
      return;
    }
    fs.writeFileSync(mutantPath, mutated, 'utf8');
    const result = spawnSync(process.execPath, [RUNNER], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, process.env, { XJ_MUTANT_CORE: mutantPath }),
    });
    const killed = result.status !== 0 && result.status !== null;
    results.push({ id, title, verdict: killed ? 'killed' : (result.status === null ? 'harness_error' : 'survived') });
    console.log('[' + (killed ? 'PASS' : 'FAIL') + '] ' + id + ' — ' + title);
  });
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (error) {}
}

const killed = results.filter((result) => result.verdict === 'killed').length;
const survived = results.filter((result) => result.verdict === 'survived').length;
const harnessErrors = results.filter((result) => result.verdict === 'harness_error').length;
fs.writeFileSync(path.join(__dirname, 'mutation-result.json'), JSON.stringify({ task_id: 'XJ-5.0.0-codex-v4.4-controlled-supervision-package-runtime-32', mutant_total: results.length, killed, survived, harness_errors: harnessErrors, results }, null, 2) + '\n', 'utf8');

const healthy = spawnSync(process.execPath, [RUNNER], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
if (healthy.status !== 0) {
  console.error('[FAIL] healthy runner did not recover after mutation phase');
  process.exit(1);
}
console.log('----------------------------------------');
console.log('Mutation total=' + results.length + ' | killed=' + killed + ' | survived=' + survived + ' | harness_errors=' + harnessErrors);
console.log('mutation_phase: ' + (survived === 0 && harnessErrors === 0 ? 'ALL-MUTATIONS-KILLED' : 'SURVIVORS_FOUND'));
process.exitCode = survived === 0 && harnessErrors === 0 ? 0 : 1;
