'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { workspace, inputRoot, candidateRoot, evidenceFile } = require('./harness-paths');
const checks = [];
function add(name, ok, detail) { checks.push({ name, ok: ok === true, detail: detail || '' }); }
function shaFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }

const manifestPath = path.join(inputRoot, 'INPUT_MANIFEST.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let frozenOk = true;
for (const entry of manifest.files) {
  const file = path.join(inputRoot, entry.path);
  if (!fs.existsSync(file) || fs.statSync(file).size !== entry.bytes || shaFile(file) !== entry.sha256) frozenOk = false;
}
add('frozen manifest 46/46 still matches', frozenOk && manifest.files.length === 46);
add('manifest self SHA matches task card', shaFile(manifestPath) === '0919B3A124FCDBAE1E31D0968BFC16082FC9BBE4696A9CB0909868F906DCC9D7');

const candidateFiles = [
  'app/settings.html', 'app/js/settings.js', 'app/js/settings-data-safety-controller.js',
  'app/js/settings-observability-controller.js', 'app/js/backup-crypto.js',
  'app/js/privacy-observability-boundary.js', 'app/js/privacy-observability-core.js',
  'app/js/privacy-observability-runtime.js'
];
const candidateHashes = {};
for (const relative of candidateFiles) {
  const file = path.join(candidateRoot, relative);
  candidateHashes[relative] = fs.existsSync(file) ? shaFile(file) : null;
}
add('all eight allowlisted candidate files exist', Object.values(candidateHashes).every(Boolean));

const evidenceRoot = path.dirname(evidenceFile('artifact-verification.json'));
const requiredEvidence = [
  'expected-red-backup.txt', 'expected-red-observability.txt', 'mutation-results.json',
  'internal-adversarial-review.json', 'electron/runtime-1024x700.json',
  'electron/minimal-sandbox-true.json', 'electron/minimal-sandbox-false.json'
];
add('required deterministic and runtime evidence exists', requiredEvidence.every((relative) => fs.existsSync(path.join(evidenceRoot, relative))));
const mutation = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'mutation-results.json'), 'utf8'));
add('all mutation probes killed', mutation.total >= 7 && mutation.survived === 0, JSON.stringify({ total: mutation.total, killed: mutation.killed, survived: mutation.survived }));
const review = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'internal-adversarial-review.json'), 'utf8'));
add('internal adversarial checks have no new assertion failures', review.failed === 0, review.status);
const sandboxProbe = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'electron', 'minimal-sandbox-true.json'), 'utf8'));
const noSandboxProbe = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'electron', 'minimal-sandbox-false.json'), 'utf8'));
add('Electron 43 sandbox capability available', sandboxProbe.ok === true, sandboxProbe.stage);
add('Electron locator control proves harness can load without sandbox', noSandboxProbe.ok === true, noSandboxProbe.stage);
const screenshots = ['settings-1024x700.png', 'settings-1366x768.png', 'settings-1920x1080.png'];
add('three current compliant viewport PNGs exist', screenshots.every((name) => fs.existsSync(path.join(evidenceRoot, 'electron', name))));

const passed = checks.filter((check) => check.ok).length;
const failed = checks.length - passed;
const status = failed === 2 && !checks.find((check) => check.name === 'Electron 43 sandbox capability available').ok &&
  !checks.find((check) => check.name === 'three current compliant viewport PNGs exist').ok
  ? 'BLOCKED_AT_REAL_SANDBOX_RUNTIME_ENVIRONMENT'
  : (failed ? 'FAIL' : 'PASS');
const result = { status, passed, failed, candidateHashes, checks };
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.writeFileSync(evidenceFile('artifact-verification.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
for (const check of checks) console.log((check.ok ? 'PASS ' : 'BLOCKED/FAIL ') + check.name + (check.detail ? ' -- ' + check.detail : ''));
console.log('SUMMARY ' + passed + '/' + checks.length + ' PASS; status=' + status);
if (status === 'FAIL') process.exitCode = 1;
if (status.startsWith('BLOCKED')) process.exitCode = 2;
