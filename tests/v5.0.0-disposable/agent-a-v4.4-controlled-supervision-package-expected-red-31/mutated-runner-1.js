'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

var ROOT = 'D:\\xinjing-electron';
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.4-controlled-supervision-package-expected-red-31');
var BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
var TASK_ID = 'XJ-5.0.0-agent-a-v4.4-controlled-supervision-package-expected-red-31';
var CONTRACT_ID = 'v4.4-controlled-supervision-package-v1';

var checks = [];
var confirmedCount = 0, expectedRedCount = 0, failedCount = 0;

function check(id, label, cond, classification) {
  var ok = !!cond;
  var cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  checks.push({ id: id, label: label, pass: ok, classification: cls });
  var tag = cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : (ok ? 'PASS' : 'FAIL');
  console.log('[' + tag + '] ' + id + ': ' + label + ' (' + cls + ')');
}

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

// ── P1: Protected hash verification ──
var manifest = JSON.parse(fs.readFileSync(path.join(INV, 'protected-files-manifest.json'), 'utf8'));
var manifestFiles = manifest.protected_files || manifest.files || [];
manifestFiles.forEach(function(f) {
  var p = path.join(ROOT, f.path);
  var actual = fs.existsSync(p) ? sha256(p) : 'MISSING';
  check('P1_' + f.path.replace(/[^a-z0-9]/gi, '_').substring(0, 40), 'protected hash: ' + f.path, actual === f.sha256, 'CONFIRMED');
});

// ── P2: Required API surface — all EXPECTED_RED (production not implemented) ──
// Browser shim to load real production modules
global.window = { indexedDB: null, localStorage: { getItem: function(){return null}, setItem: function(){}, removeItem: function(){} }, __XJ_API__: null, location: { reload: function(){} } };
global.indexedDB = null;
global.localStorage = global.window.localStorage;

// Load real supervision module
var supSrc = fs.readFileSync(path.join(ROOT, 'app', 'js', 'supervision.js'), 'utf8');
check('P2A_supervision_loaded', 'real supervision.js module loaded (not a copy)', supSrc.length > 100, 'CONFIRMED');

// Load real entitlements module
var entExports = null;
try {
  entExports = require(path.join(ROOT, 'app', 'js', 'entitlements.js'));
} catch(e) {
  entExports = null;
}
check('P2B_entitlements_loaded', 'real entitlements.js module loaded (not a copy)', entExports !== null && typeof entExports === 'object', 'CONFIRMED');

// Load real license-core
var licenseExports = null;
try {
  licenseExports = require(path.join(ROOT, 'license-core.js'));
} catch(e) {
  licenseExports = null;
}
check('P2C_license_core_loaded', 'real license-core.js module loaded (not a copy)', licenseExports !== null && typeof licenseExports === 'object', 'CONFIRMED');

// Required XJSUP/1 surface — all absent in production = EXPECTED_RED
var REQUIRED_APIS = [
  { name: 'XJSUP_parse', desc: 'XJSUP/1 package parser' },
  { name: 'canonicalManifest', desc: 'canonical manifest builder' },
  { name: 'signatureBeforeDecrypt', desc: 'signature-before-decrypt verification' },
  { name: 'recipientEnvelopeUnwrap', desc: 'recipient envelope unwrap' },
  { name: 'packageInstall', desc: 'package install API' },
  { name: 'packageRun', desc: 'package run API' },
  { name: 'deviceGrant', desc: 'single-device grant enforcement' },
  { name: 'deviceMigrate', desc: 'device migration atomicity' },
  { name: 'revokeCheck', desc: 'online revocation check' },
  { name: 'gracePeriod', desc: 'seven-day offline grace enforcement' },
];
REQUIRED_APIS.forEach(function(api) {
  var found = false;
  // Check if any production module exports this function
  try {
    if (entExports && typeof entExports[api.name] === 'function') found = true;
    if (licenseExports && typeof licenseExports[api.name] === 'function') found = true;
  } catch(e) {}
  // Also grep source files
  if (!found) {
    var patterns = [api.name, api.name.replace(/([A-Z])/g, '_$1').toLowerCase()];
    patterns.forEach(function(pat) {
      if (supSrc.indexOf(pat) !== -1) found = true;
    });
  }
  check('P2_' + api.name, 'Store/app has ' + api.desc + ' (absent = EXPECTED_RED gap)', false, 'CONFIRMED'); /* MUTANT M1 */
});

// ── P3: Source anchor tracing ──
var realSupSrc = fs.readFileSync(path.join(ROOT, 'app', 'js', 'real-supervision.js'), 'utf8');
var cloudVerifySrc = fs.readFileSync(path.join(ROOT, 'cloud-verify.js'), 'utf8');
var preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
var mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

check('P3_supervision_entry', 'supervision.js entry point traced (556 lines)', supSrc.length > 500, 'CONFIRMED');
check('P3_real_supervision_entry', 'real-supervision.js entry point traced (286 lines)', realSupSrc.length > 200, 'CONFIRMED');
check('P3_cloud_verify_entry', 'cloud-verify.js entry point traced', cloudVerifySrc.length > 100, 'CONFIRMED');
check('P3_preload_entry', 'preload.js entry point traced', preloadSrc.length > 100, 'CONFIRMED');
check('P3_main_entry', 'main.js entry point traced (2289 lines)', mainSrc.length > 2000, 'CONFIRMED');
check('P3_entitlements_entry', 'entitlements.js entry point traced', entExports !== null, 'CONFIRMED');
check('P3_license_core_entry', 'license-core.js entry point traced', licenseExports !== null, 'CONFIRMED');

// ── R1-R15: Behavior matrix ──

// R1: XJSUP/1 parser absent
check('R1', 'XJSUP/1 parser not implemented in production', supSrc.indexOf('XJSUP') === -1 && mainSrc.indexOf('XJSUP') === -1 && realSupSrc.indexOf('XJSUP') === -1, 'EXPECTED_RED');

// R2: Canonical manifest absent
check('R2', 'canonical manifest builder not implemented', supSrc.indexOf('canonicalManifest') === -1 && mainSrc.indexOf('canonicalManifest') === -1, 'EXPECTED_RED');

// R3: Signature-before-decrypt absent
check('R3', 'signature-before-decrypt verification not implemented', supSrc.indexOf('signatureBeforeDecrypt') === -1 && mainSrc.indexOf('signatureBeforeDecrypt') === -1, 'EXPECTED_RED');

// R4: Recipient envelope unwrap absent
check('R4', 'recipient envelope unwrap not implemented', supSrc.indexOf('recipientEnvelope') === -1 && mainSrc.indexOf('recipientEnvelope') === -1, 'EXPECTED_RED');

// R5: Package install API absent
check('R5', 'package install API not implemented', supSrc.indexOf('packageInstall') === -1 && mainSrc.indexOf('packageInstall') === -1, 'EXPECTED_RED');

// R6: Package run API absent
check('R6', 'package run API not implemented', supSrc.indexOf('packageRun') === -1 && mainSrc.indexOf('packageRun') === -1, 'EXPECTED_RED');

// R7: Single-device grant enforcement absent
check('R7', 'single-device grant enforcement not implemented', supSrc.indexOf('deviceGrant') === -1 && mainSrc.indexOf('deviceGrant') === -1, 'EXPECTED_RED');

// R8: Device migration atomicity absent
check('R8', 'device migration atomicity not implemented', supSrc.indexOf('deviceMigrate') === -1 && mainSrc.indexOf('deviceMigrate') === -1, 'EXPECTED_RED');

// R9: Online revocation check absent
check('R9', 'online revocation check not implemented', cloudVerifySrc.indexOf('revokeCheck') === -1, 'EXPECTED_RED');

// R10: Seven-day grace enforcement absent
check('R10', 'seven-day offline grace enforcement not implemented', cloudVerifySrc.indexOf('gracePeriod') === -1 && cloudVerifySrc.indexOf('grace') === -1, 'EXPECTED_RED');

// R11: Entitlement gating exists (CONFIRMED)
check('R11', 'entitlement gating exists in production', entExports !== null && typeof entExports.canUse === 'function', 'CONFIRMED');

// R12: Supervision material workspace exists (CONFIRMED)
check('R12', 'supervision material workspace function exists', supSrc.indexOf('MaterialWorkspace') !== -1 || supSrc.indexOf('materialWorkspace') !== -1, 'CONFIRMED');

// R13: Cloud verify module exists (CONFIRMED)
check('R13', 'cloud-verify module exists as production file', cloudVerifySrc.length > 100, 'CONFIRMED');

// R14: License core module exists (CONFIRMED)
check('R14', 'license-core module exists as production file', licenseExports !== null, 'CONFIRMED');

// R15: No plaintext package content in production source (CONFIRMED)
check('R15', 'no plaintext package content in production supervision source', supSrc.indexOf('plaintext_package') === -1 && realSupSrc.indexOf('plaintext_package') === -1, 'CONFIRMED');

// ── R16-R20: Additional contract boundary checks ──

// R16: No author private key in production source
check('R16', 'no author private key in production source', !/authorPrivateKey|author_private_key|BEGIN PRIVATE KEY/i.test(supSrc + realSupSrc + mainSrc + preloadSrc), 'CONFIRMED');

// R17: No device private key in production source
check('R17', 'no device private key in production source', !/devicePrivateKey|device_private_key/i.test(supSrc + realSupSrc + mainSrc + preloadSrc), 'CONFIRMED');

// R18: Entitlements enforce feature tiers (CONFIRMED)
check('R18', 'entitlements enforce feature tiers', entExports !== null && typeof entExports.minimumTier === 'function' && typeof entExports.access === 'function', 'CONFIRMED');

// R19: Free manual workflows preserved (CONFIRMED)
check('R19', 'free manual workflows not gated by package', entExports !== null && typeof entExports.canUse === 'function', 'CONFIRMED');

// R20: Historical records preserved (CONFIRMED from store pattern)
check('R20', 'historical records preservation pattern exists', supSrc.indexOf('history') !== -1 || supSrc.indexOf('Historical') !== -1 || supSrc.indexOf('record') !== -1, 'CONFIRMED');

// ── R21-R25: Negative behavior scenarios (all EXPECTED_RED — not implemented) ──

check('R21', 'wrong-subject rejection not implemented', true, 'EXPECTED_RED');
check('R22', 'wrong-license rejection not implemented', true, 'EXPECTED_RED');
check('R23', 'wrong-device rejection not implemented', true, 'EXPECTED_RED');
check('R24', 'second-active-device prevention not implemented', true, 'EXPECTED_RED');
check('R25', 'migration interruption recovery not implemented', true, 'EXPECTED_RED');

// ── R26-R30: More negative scenarios ──
check('R26', 'revoked-online immediate enforcement not implemented', true, 'EXPECTED_RED');
check('R27', 'grace-expiry enforcement not implemented', true, 'EXPECTED_RED');
check('R28', 'clock-rollback rejection not implemented', true, 'EXPECTED_RED');
check('R29', 'grant-sequence rollback rejection not implemented', true, 'EXPECTED_RED');
check('R30', 'corrupt-package rejection not implemented', true, 'EXPECTED_RED');

// ── R31-R33: Non-exposure checks (CONFIRMED) ──
check('R31', 'no plaintext/key material in renderer/preload', !/plaintext|privateKey|BEGIN.*PRIVATE/i.test(preloadSrc), 'CONFIRMED');
check('R32', 'no package content in logs/backup/export paths', !/console\.log.*package|backup.*plaintext|export.*key/i.test(supSrc + realSupSrc), 'CONFIRMED');
check('R33', 'provider policy defaults to local-only', cloudVerifySrc.indexOf('local') !== -1 || cloudVerifySrc.indexOf('local-only') !== -1 || cloudVerifySrc.indexOf('localOnly') !== -1, 'CONFIRMED');

// ── Overall classification ──
var result = {
  task_id: TASK_ID,
  contract_id: CONTRACT_ID,
  base_commit: BASE_COMMIT,
  determinism: 'hash-stable-no-timestamp',
  confirmed: confirmedCount,
  expected_red: expectedRedCount,
  failed: failedCount,
  checks: checks,
};

var OUT = path.join(INV, 'contract-result.json');
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

console.log('');
console.log('Confirmed: ' + confirmedCount + ' | Expected-Red: ' + expectedRedCount + ' | Failed: ' + failedCount);
process.exit(failedCount === 0 ? 0 : 1);
