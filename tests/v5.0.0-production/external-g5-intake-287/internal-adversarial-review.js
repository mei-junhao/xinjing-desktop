'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { workspace, candidateRoot: candidate, inputRoot: input, evidenceFile } = require('./harness-paths');
const data = fs.readFileSync(path.join(candidate, 'app', 'js', 'settings-data-safety-controller.js'), 'utf8');
const settings = fs.readFileSync(path.join(candidate, 'app', 'js', 'settings.js'), 'utf8');
const runtime = fs.readFileSync(path.join(candidate, 'app', 'js', 'privacy-observability-runtime.js'), 'utf8');
const store = fs.readFileSync(path.join(input, 'app', 'js', 'store.js'), 'utf8');
const html = fs.readFileSync(path.join(candidate, 'app', 'settings.html'), 'utf8');
const findings = [];
let passed = 0;
function check(name, work) {
  try { work(); passed += 1; process.stdout.write('PASS ' + name + '\n'); }
  catch (error) { findings.push({ severity: 'P0', name, message: error.message }); process.stdout.write('FAIL ' + name + ': ' + error.message + '\n'); }
}

check('restore awaits decrypt import and readback', () => {
  assert.match(data, /await bridge\.decryptBackup/);
  assert.match(data, /await store\.importAll\(decrypted\.payload\)/);
  assert.match(data, /var readback = await store\.exportAll\(\)/);
});
check('success is gated after readback and input clears only there', () => {
  const readback = data.indexOf('var readback = await store.exportAll()');
  const clear = data.indexOf("inputElement.value = ''");
  const success = data.indexOf("'数据已恢复；当前设置和 API 密钥未改变'");
  assert.ok(readback >= 0 && clear > readback && success > clear);
});
check('passphrase is runtime-only and cleared', () => {
  assert.match(data, /request\.passphrase = ''/);
  assert.doesNotMatch(data, /saveSettings\([^)]*passphrase/);
});
check('backup and restore have no commercial, tier, balance, AI, or fetch dependency', () => {
  assert.doesNotMatch(data, /commercial|tier|balance|fetch\(|AI\./i);
});
check('payload rejects settings and unknown top-level fields', () => {
  assert.match(data, /var allowed = \['version', 'exportedAt'\]\.concat\(COLLECTIONS\)/);
  assert.match(data, /allowed\.indexOf\(key\) === -1/);
});
check('rollback is attempted and read back after post-import mismatch', () => {
  assert.match(data, /await store\.importAll\(before\)/);
  assert.match(data, /sameProjection\(before, rollbackReadback\)/);
});
check('Store prepareImport is internal and unavailable to candidate controller', () => {
  assert.match(store, /function prepareImport\(data\)/);
  const publicTail = store.slice(store.lastIndexOf('return {'));
  assert.doesNotMatch(publicTail, /prepareImport\s*:/);
  assert.doesNotMatch(data, /prepareImport/);
});
check('observability revocation fences and clears runtime before persistence', () => {
  const fence = runtime.indexOf('revocationFence = true');
  const revoke = runtime.indexOf('var revoked = runtime.revokeConsent()', fence);
  const persist = runtime.indexOf('return saveConsent(false)', revoke);
  assert.ok(fence >= 0 && revoke > fence && persist > revoke);
});
check('settings handlers remain exported and controllers are loaded', () => {
  assert.match(settings, /window\.backupData = function/);
  assert.match(settings, /window\.restoreData = function/);
  assert.match(html, /settings-data-safety-controller\.js/);
  assert.match(html, /settings-observability-controller\.js/);
});
check('real DOM runtime is explicitly delegated, never falsely claimed', () => {
  const runtimeRoot = process.env.XJ_287_RUNTIME_EVIDENCE_ROOT;
  if (!runtimeRoot) {
    assert.strictEqual(process.env.XJ_287_RUNTIME_STATUS || 'OUT_OF_SCOPE_G7', 'OUT_OF_SCOPE_G7');
    return;
  }
  const evidence = JSON.parse(fs.readFileSync(path.join(path.resolve(runtimeRoot), 'minimal-sandbox-true.json'), 'utf8'));
  const control = JSON.parse(fs.readFileSync(path.join(path.resolve(runtimeRoot), 'minimal-sandbox-false.json'), 'utf8'));
  assert.strictEqual(evidence.ok, false);
  assert.strictEqual(evidence.stage, 'render-process-gone');
  assert.strictEqual(control.ok, true);
});

const review = {
  status: findings.length ? 'FAIL' : 'PASS',
  passed,
  failed: findings.length,
  findings,
  residualRisks: [
    {
      severity: 'P2',
      code: 'REAL_DOM_ELECTRON_OUT_OF_SCOPE',
      detail: '真实 Electron 证据由 G7 任务承担；本 G5 harness 只验证设置安全合同，不宣称当前版本 P0。'
    },
    {
      severity: 'P1',
      code: 'PREPARE_IMPORT_NOT_PUBLIC',
      detail: 'Frozen Store.prepareImport exists but is not public. The allowlisted controller can only use importAll/exportAll and compensating rollback, not database-level single-transaction rollback.'
    },
    {
      severity: 'P2',
      code: 'READBACK_PROJECTION_PARTIAL_SEMANTICS',
      detail: 'Readback validates collection counts, stable ids, and selected references, but is not a proof of full prepareImport normalization equivalence.'
    }
  ]
};
const evidence = evidenceFile('internal-adversarial-review.json');
fs.mkdirSync(path.dirname(evidence), { recursive: true });
fs.writeFileSync(evidence, JSON.stringify(review, null, 2) + '\n', 'utf8');
console.log('SUMMARY ' + passed + '/' + (passed + findings.length) + ' PASS; status=' + review.status);
if (findings.length) process.exitCode = 1;
