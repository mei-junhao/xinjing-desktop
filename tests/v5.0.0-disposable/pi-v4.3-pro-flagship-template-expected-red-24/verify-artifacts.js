'use strict';
/**
 * XJ-5.0.0 Pi v4.3 Pro/Flagship Template Expected-Red — Artifact Verifier (task 24)
 *
 * Verifies the three deterministic artifacts are well-formed, internally
 * consistent, hash-stable (no volatile fields), and that the module/manifest
 * hashes they record match the REAL production files on disk. Also confirms
 * no stray temp files pollute the harness directory and that re-running the
 * runner produces byte-identical contract-result.json (determinism).
 *
 * Exit 0 = all checks pass. Exit 1 = any check fails.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve('D:\\xinjing-electron');
const HARNESS_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'pi-v4.3-pro-flagship-template-expected-red-24');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'pi-v4.3-pro-flagship-template-expected-red-24', 'protected-files-manifest.json');

const CONTRACT_RESULT = path.join(HARNESS_DIR, 'contract-result.json');
const CONTRACT_MATRIX = path.join(HARNESS_DIR, 'contract-matrix.json');
const MUTATION_RESULT = path.join(HARNESS_DIR, 'mutation-result.json');

const EXPECTED_FILES = ['run-contract.js', 'mutation-probes.js', 'verify-artifacts.js', 'contract-result.json', 'contract-matrix.json', 'mutation-result.json', 'verify-result.json'];

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('[FAIL] ' + name + (detail ? ' — ' + detail : '')); }
}
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function sha256Str(s) { return crypto.createHash('sha256').update(s).digest('hex').toUpperCase(); }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

const VOLATILE_KEYS = ['timestamp', 'createdAt', 'updatedAt', 'date', 'time', 'now', 'random', 'uuid', 'runId'];
function hasVolatile(obj, pathStr) {
  if (obj === null || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    const full = pathStr ? pathStr + '.' + k : k;
    if (VOLATILE_KEYS.includes(k)) return full;
    if (typeof obj[k] === 'object' && obj[k] !== null) { const v = hasVolatile(obj[k], full); if (v) return v; }
  }
  return null;
}

console.log('XJ-5.0.0 task 24 — verify-artifacts.js');
console.log('----------------------------------------');

// 1. All three artifact files exist
check('contract-result.json exists', fs.existsSync(CONTRACT_RESULT));
check('contract-matrix.json exists', fs.existsSync(CONTRACT_MATRIX));
check('mutation-result.json exists', fs.existsSync(MUTATION_RESULT));

if (!fs.existsSync(CONTRACT_RESULT) || !fs.existsSync(CONTRACT_MATRIX) || !fs.existsSync(MUTATION_RESULT)) {
  console.log('FATAL: artifact files missing, cannot continue.');
  process.exit(1);
}

const cr = readJSON(CONTRACT_RESULT);
const cm = readJSON(CONTRACT_MATRIX);
const mr = readJSON(MUTATION_RESULT);

// 2. contract-result.json structure (uses top-level counts, checks array, pass field)
check('contract-result schema_version absent (deterministic)', cr.schema_version === undefined || cr.schema_version === 1);
check('contract-result task_id correct', cr.task_id === 'XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24');
check('contract-result base_commit correct', cr.base_commit === '9971787eb6e443ab5a5c80aee118b9b43285c093', cr.base_commit);
check('contract-result contract_id correct', cr.contract_id === 'v4.3-pro-flagship-template-expected-red-v1');
check('contract-result write_lock_id correct', cr.write_lock_id === 'lock-XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24');
check('contract-result has checks array', Array.isArray(cr.checks));
check('contract-result check count=17', cr.checks && cr.checks.length === 17, 'got ' + (cr.checks ? cr.checks.length : 'none'));
check('contract-result confirmed=13', cr.confirmed === 13, 'got ' + cr.confirmed);
check('contract-result expected_red=4', cr.expected_red === 4, 'got ' + cr.expected_red);
check('contract-result failed=0', cr.failed === 0, 'got ' + cr.failed);
check('contract-result unverified=0', cr.unverified === 0, 'got ' + cr.unverified);
check('contract-result row_counts.total=17', cr.row_counts && cr.row_counts.total === 17, JSON.stringify(cr.row_counts));

// 3. Invariants all true
if (cr.invariants) {
  const invKeys = Object.keys(cr.invariants);
  check('contract-result invariants all true', invKeys.every((k) => cr.invariants[k] === true), JSON.stringify(cr.invariants));
  check('contract-result invariants.zeroFailed=true', cr.invariants.zeroFailed === true);
  check('contract-result invariants.expectedRedAllGreen=true', cr.invariants.expectedRedAllGreen === true);
} else {
  check('contract-result invariants present', false, 'missing');
}

// 4. contract-matrix.json structure
check('contract-matrix task_id correct', cm.task_id === 'XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24');
check('contract-matrix base_commit correct', cm.base_commit === '9971787eb6e443ab5a5c80aee118b9b43285c093');
check('contract-matrix has rows array', Array.isArray(cm.rows));
check('contract-matrix row count=17', cm.rows && cm.rows.length === 17, 'got ' + (cm.rows ? cm.rows.length : 'none'));

// 5. Matrix row IDs and classifications match result checks
if (cr.checks && cm.rows) {
  const crIds = cr.checks.map((r) => r.id).sort();
  const cmIds = cm.rows.map((r) => r.id).sort();
  check('contract-matrix IDs match contract-result IDs', JSON.stringify(crIds) === JSON.stringify(cmIds), crIds.join(','));

  const erChecks = cr.checks.filter((r) => r.classification === 'EXPECTED_RED');
  check('exactly 4 EXPECTED_RED checks', erChecks.length === 4, 'got ' + erChecks.length);
  const erIds = erChecks.map((r) => r.id).sort();
  const expectedErIds = ['FLAG-DEF', 'FLAG-VAL', 'PRO-AI-GEN', 'PRO-AI-ORCH'];
  check('EXPECTED_RED check IDs correct', JSON.stringify(erIds) === JSON.stringify(expectedErIds), erIds.join(','));
  check('all EXPECTED_RED checks pass=true', erChecks.every((r) => r.pass === true), erChecks.map((r) => r.id + '=' + r.pass).join(','));

  const confChecks = cr.checks.filter((r) => r.classification === 'CONFIRMED');
  check('exactly 13 CONFIRMED checks', confChecks.length === 13, 'got ' + confChecks.length);
  check('all CONFIRMED checks pass=true', confChecks.every((r) => r.pass === true), confChecks.map((r) => r.id + '=' + r.pass).join(','));

  // Matrix evidence present on all rows
  check('all matrix rows have evidence', cm.rows.every((r) => typeof r.evidence === 'string' && r.evidence.length > 0), cm.rows.filter((r) => !r.evidence).map((r) => r.id).join(',') || 'all present');
  check('all matrix rows have production_entry_point', cm.rows.every((r) => typeof r.production_entry_point === 'string' && r.production_entry_point.length > 0));
  check('all matrix rows have classification', cm.rows.every((r) => typeof r.classification === 'string'));
  check('all matrix rows have category', cm.rows.every((r) => typeof r.category === 'string'));
}

// 6. mutation-result.json structure
check('mutation-result schema_version=1', mr.schema_version === 1);
check('mutation-result task_id correct', mr.task_id === 'XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24');
check('mutation-result probe_count=12', mr.probe_count === 12, 'got ' + mr.probe_count);
check('mutation-result killed=12', mr.killed === 12, 'got ' + mr.killed);
check('mutation-result survived=0', mr.survived === 0, 'got ' + mr.survived);
check('mutation-result harness_errors=0', mr.harness_errors === 0, 'got ' + mr.harness_errors);
check('mutation-result all_killed=true', mr.all_killed === true);
if (mr.probes) {
  const probeIds = mr.probes.map((p) => p.id).sort();
  const expectedProbeIds = ['M1-FAKE-MODULE', 'M10-FLIP-CLASSIFICATION', 'M11-PROTECTED-FILE-DRIFT', 'M12-MANIFEST-BYTE-DRIFT', 'M2-PROMOTE-TIER', 'M3-SWALLOW-FAILURE', 'M4-AWAIT-ORDER', 'M5-BYPASS-ENTRY', 'M6-TIER-MISMATCH', 'M7-UNSAFE-CUSTOM', 'M8-BODY-FIELDS', 'M9-MISSING-ROW'];
  check('mutation-result probe IDs correct', JSON.stringify(probeIds) === JSON.stringify(expectedProbeIds), probeIds.join(','));
  check('all probes verdict=killed', mr.probes.every((p) => p.verdict === 'killed'), mr.probes.map((p) => p.id + '=' + p.verdict).join(','));
  // M11/M12 must prove drift-before-write: one-byte protected-input drift forces nonzero exit with ZERO artifact writes
  const m11 = mr.probes.find((p) => p.id === 'M11-PROTECTED-FILE-DRIFT');
  const m12 = mr.probes.find((p) => p.id === 'M12-MANIFEST-BYTE-DRIFT');
  check('M11-PROTECTED-FILE-DRIFT killed', !!m11 && m11.verdict === 'killed', m11 ? m11.verdict : 'missing');
  check('M12-MANIFEST-BYTE-DRIFT killed', !!m12 && m12.verdict === 'killed', m12 ? m12.verdict : 'missing');
}

// 7. Module hashes match REAL production files
const realStoreHash = sha256(path.join(ROOT, 'app', 'js', 'store.js'));
const realEntHash = sha256(path.join(ROOT, 'app', 'js', 'entitlements.js'));
const realStvmHash = sha256(path.join(ROOT, 'app', 'js', 'session-template-view-model.js'));
const realQrHash = sha256(path.join(ROOT, 'app', 'js', 'quick-record.js'));

if (cr.module_hashes) {
  check('contract-result store.js hash matches real', cr.module_hashes['store.js'] === realStoreHash, cr.module_hashes['store.js'] + ' vs ' + realStoreHash);
  check('contract-result entitlements.js hash matches real', cr.module_hashes['entitlements.js'] === realEntHash);
  check('contract-result session-template-view-model.js hash matches real', cr.module_hashes['session-template-view-model.js'] === realStvmHash);
  check('contract-result quick-record.js hash matches real', cr.module_hashes['quick-record.js'] === realQrHash);
} else {
  check('contract-result module_hashes present', false, 'missing');
}

if (mr.store_hash) {
  check('mutation-result store.js hash matches real', mr.store_hash === realStoreHash, mr.store_hash + ' vs ' + realStoreHash);
  check('mutation-result entitlements.js hash matches real', mr.entitlements_hash === realEntHash);
  check('mutation-result stvm hash matches real', mr.stvm_hash === realStvmHash);
}

// 8. Manifest hash in contract-result matches real manifest
const realManifestHash = sha256(MANIFEST_PATH);
check('contract-result manifest hash matches real', cr.protected_files_manifest_sha256 === realManifestHash, cr.protected_files_manifest_sha256 + ' vs ' + realManifestHash);

// 9. Determinism: no volatile fields in any artifact
const volCr = hasVolatile(cr, '');
const volCm = hasVolatile(cm, '');
const volMr = hasVolatile(mr, '');
check('contract-result has no volatile fields', volCr === null, volCr ? 'found ' + volCr : 'clean');
check('contract-matrix has no volatile fields', volCm === null, volCm ? 'found ' + volCm : 'clean');
check('mutation-result has no volatile fields', volMr === null, volMr ? 'found ' + volMr : 'clean');

// 10. Determinism: re-run runner, compare contract-result.json byte-for-byte
console.log('--- determinism re-run ---');
const tmpOut = path.join(HARNESS_DIR, '.verify-tmp');
try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(tmpOut, { recursive: true });
const r = spawnSync('node', [path.join(HARNESS_DIR, 'run-contract.js')], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000,
  env: Object.assign({}, process.env, { XJ_TASK24_OUT_DIR: tmpOut }),
});
const tmpResult = path.join(tmpOut, 'contract-result.json');
const tmpMatrix = path.join(tmpOut, 'contract-matrix.json');
check('determinism: re-run exit 0', r.status === 0, 'exit=' + r.status + (r.stderr ? ' ' + r.stderr.split('\n')[0].slice(0, 100) : ''));
if (r.status === 0 && fs.existsSync(tmpResult)) {
  const origBytes = fs.readFileSync(CONTRACT_RESULT);
  const tmpBytes = fs.readFileSync(tmpResult);
  check('determinism: contract-result.json byte-identical on re-run', origBytes.equals(tmpBytes), sha256Str(origBytes.toString()) + ' vs ' + sha256Str(tmpBytes.toString()));
  if (fs.existsSync(tmpMatrix)) {
    const origMx = fs.readFileSync(CONTRACT_MATRIX);
    const tmpMx = fs.readFileSync(tmpMatrix);
    check('determinism: contract-matrix.json byte-identical on re-run', origMx.equals(tmpMx));
  }
} else {
  check('determinism: re-run produced contract-result.json', false, 'exit=' + r.status);
}
try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch (_) {}

// 11. No stray files in harness directory (only expected files)
const dirFiles = fs.readdirSync(HARNESS_DIR).filter((f) => !f.startsWith('.'));
const stray = dirFiles.filter((f) => !EXPECTED_FILES.includes(f));
check('no stray files in harness directory', stray.length === 0, stray.length ? 'stray: ' + stray.join(', ') : 'clean (' + dirFiles.length + ' files)');

console.log('----------------------------------------');
console.log('verify-artifacts: pass=' + pass + ' fail=' + fail);
if (fail > 0) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }

const out = {
  schema_version: 1,
  task_id: 'XJ-5.0.0-pi-v4.3-pro-flagship-template-expected-red-24',
  checks_passed: pass,
  checks_failed: fail,
  all_passed: fail === 0,
  failures: failures,
  real_store_hash: realStoreHash,
  real_entitlements_hash: realEntHash,
  real_stvm_hash: realStvmHash,
  real_quick_record_hash: realQrHash,
  real_manifest_hash: realManifestHash,
};
fs.writeFileSync(path.join(HARNESS_DIR, 'verify-result.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('Wrote: ' + path.join(HARNESS_DIR, 'verify-result.json'));

process.exit(fail === 0 ? 0 : 1);
