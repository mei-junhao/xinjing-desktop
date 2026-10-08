'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const manifestPath = path.join(ROOT, 'docs/agent-coordination/v5.0.0/inventory/codex-v4.4-controlled-supervision-package-runtime-32/protected-files-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const targetFiles = new Set(['main.js', 'preload.js', 'app/js/supervision.js', 'app/supervision.html']);
const checks = [];

function check(id, title, fn) {
  try { fn(); checks.push({ id, title, status: 'PASS' }); console.log('[PASS] ' + id + ' — ' + title); }
  catch (error) { checks.push({ id, title, status: 'FAIL', error: error.message }); console.log('[FAIL] ' + id + ' — ' + title + ' — ' + error.message); }
}

function source(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8'); }
function hash(name) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, name))).digest('hex').toUpperCase(); }

check('A1', 'runtime files and focused evidence exist', () => {
  ['supervision-package-core.js', 'supervision-package-public-keys.json', 'app/js/supervision-package.js', 'tests/v5.0.0-production/codex-v4.4-controlled-supervision-package/run-contract.js', 'tests/v5.0.0-production/codex-v4.4-controlled-controlled-supervision-package/mutation-probes.js'.replace('controlled-controlled', 'controlled'), 'tests/v5.0.0-production/codex-v4.4-controlled-supervision-package/verify-artifacts.js'].forEach((name) => assert(fs.existsSync(path.join(ROOT, name)), name));
});
check('A2', 'public key registry contains no private key material', () => {
  const text = source('supervision-package-public-keys.json');
  assert(!/PRIVATE KEY|authorPrivateKey|devicePrivateKey|BEGIN/i.test(text));
});
check('A3', 'core exports no signing or plaintext persistence API', () => {
  const core = require(path.join(ROOT, 'supervision-package-core.js'));
  ['parseXjsup', 'inspectPackage', 'authorizePackage', 'openPackage', 'verifyRevocationEvidence', 'advanceHighWater', 'applyGrantMigration'].forEach((name) => assert.strictEqual(typeof core[name], 'function', name));
  assert.strictEqual(typeof core.signPackage, 'undefined');
  assert.strictEqual(typeof core.writePackage, 'undefined');
});
check('A4', 'main process owns all package IPC handlers', () => {
  const text = source('main.js');
  ['supervision-package-core', 'xj:supervisionSkill:inspectPackage', 'xj:supervisionSkill:installPackage', 'xj:supervisionSkill:listInstalled', 'xj:supervisionSkill:getRuntimeDescriptor', 'xj:supervisionSkill:run', 'xj:supervisionSkill:removePackage'].forEach((needle) => assert(text.includes(needle), needle));
  assert(text.includes('atomicWriteBytes'));
  assert(text.includes('supervisionPackageRuntimeCache.clear()'));
});
check('A5', 'preload bridge exposes typed sanitized operations only', () => {
  const text = source('preload.js');
  ['supervisionSkill', 'inspectPackage', 'installPackage', 'listInstalled', 'getRuntimeDescriptor', 'run', 'removePackage'].forEach((needle) => assert(text.includes(needle), needle));
  assert(!/contentKey|plaintext|devicePrivateKey|authorPrivateKey|BEGIN PRIVATE KEY/i.test(text));
});
check('A6', 'renderer facade never parses or persists package plaintext', () => {
  const text = source('app/js/supervision-package.js');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(text.includes('inspectPackage'));
  assert(text.includes('arrayBuffer'));
  assert(!/localStorage|sessionStorage|decrypt|contentKey|plaintext|innerHTML/i.test(code));
});
check('A7', 'supervision page has explicit inspect, confirm-install, run and remove states', () => {
  const html = source('app/supervision.html');
  ['sup-package-import', 'sup-package-install', 'sup-package-run', 'sup-package-remove', 'sup-package-status', 'supervision-package.js'].forEach((needle) => assert(html.includes(needle), needle));
});
check('A8', 'unchanged protected inputs retain their checkpoint hashes', () => {
  const changed = [];
  manifest.files.forEach((entry) => {
    const actual = hash(entry.path);
    if (actual !== entry.sha256.toUpperCase()) {
      if (!targetFiles.has(entry.path)) changed.push(entry.path);
    }
  });
  assert.deepStrictEqual(changed, []);
});
check('A9', 'no package endpoint accepts arbitrary path or network policy', () => {
  const coreText = source('supervision-package-core.js');
  assert(coreText.includes("value.mode === 'local-only'"));
  assert(coreText.includes('trusted-remote'));
  assert(coreText.includes('provider mode is not trusted'));
  assert(coreText.includes('resource path is not a normalized relative POSIX path'));
});
check('A10', 'main storage records encrypted bytes and minimal descriptors only', () => {
  const text = source('main.js');
  assert(text.includes("'supervision-packages'"));
  assert(text.includes("'.xjsup'"));
  assert(text.includes('descriptor,'));
  assert(!/fs\.writeFileSync\([^\n]+(?:resources|contentKey|plaintext)/i.test(text));
});

const failed = checks.filter((item) => item.status !== 'PASS');
const outDir = path.join(ROOT, 'docs/agent-coordination/v5.0.0/inventory/codex-v4.4-controlled-supervision-package-runtime-32');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'artifact-result.json'), JSON.stringify({ task_id: 'XJ-5.0.0-codex-v4.4-controlled-supervision-package-runtime-32', passed: checks.length - failed.length, failed: failed.length, checks }, null, 2) + '\n', 'utf8');
console.log('----------------------------------------');
console.log('Artifact checks: ' + (checks.length - failed.length) + ' PASS | ' + failed.length + ' FAIL');
process.exitCode = failed.length ? 1 : 0;
