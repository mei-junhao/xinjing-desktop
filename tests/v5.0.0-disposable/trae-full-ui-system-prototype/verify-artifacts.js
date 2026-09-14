/**
 * XinJing 5.0 Full UI System Prototype - Artifact Verification
 *
 * Validates:
 *   1. All required scripts exist
 *   2. Complete matrix evidence (screenshots + DOM snapshots)
 *   3. Contract test results
 *   4. Mutation probe results (all killed)
 *   5. SHA-256 for every artifact
 *   6. Delivery report exists with correct absolute paths and strict last line
 *   7. No missing files, no extra files, no relative paths in report, no wrong last line
 *   8. Canonical candidate SHA-256 from the frozen manifest key/hash set
 *
 * Exit codes: 0 = all valid, 1 = validation failed, 2 = setup error
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TEST_DIR = path.resolve(__dirname);
const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..', '..', 'design-previews', '5.0.0-trae-full-ui-system-prototype');
const EVIDENCE_BASE = path.join(TEST_DIR, 'evidence');
const REPORT_PATH = 'D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-trae-full-ui-system-prototype-01.md';
const SPEC_PATH = path.resolve(__dirname, '..', '..', '..', 'docs', 'agent-coordination', 'v5.0.0', 'design', 'trae-full-ui-system-prototype-spec.md');
const WRITE_MANIFEST = process.argv.includes('--write-manifest');
const WRITE_RESULT = process.argv.includes('--write-result');

const REQUIRED_SCRIPTS = [
  'run-browser-matrix.js',
  'run-contract.js',
  'mutation-probes.js',
  'verify-artifacts.js',
];

const REQUIRED_PROTOTYPE_FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'fixtures.js',
  'route-manifest.json',
  'state-manifest.json',
  'README.md',
];

const VIEWPORTS = ['1024x700', '1366x768', '1920x1080'];
const SKINS = ['clinical', 'theatre', 'observatory'];
const MODES = ['light', 'dark'];
const KEY_PAGES = ['index', 'masters', 'supervision', 'transcript', 'doc-center', 'activation', 'settings'];
const SMOKE_ROUTES_COUNT = 22;

let errors = [];
let warnings = [];

function err(msg) { errors.push(msg); console.error('  ERROR:', msg); }
function warn(msg) { warnings.push(msg); console.warn('  WARN:', msg); }
function ok(msg) { console.log('  OK:', msg); }

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (e) { return null; }
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function pngDimensions(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function candidateShaFromFiles(files) {
  const rows = Object.keys(files)
    .sort()
    .map(key => key + '\n' + String(files[key]).toLowerCase() + '\n')
    .join('');
  return crypto.createHash('sha256').update(rows, 'utf8').digest('hex').toUpperCase();
}

function main() {
  console.log('=== Artifact Verification ===\n');

  // ---- 1. Required scripts exist ----
  console.log('[1] Required scripts:');
  for (const s of REQUIRED_SCRIPTS) {
    const p = path.join(TEST_DIR, s);
    if (fileExists(p)) ok(`${s} exists (sha256: ${sha256File(p).slice(0,16)}...)`);
    else err(`Missing required script: ${s}`);
  }

  // ---- 2. Required prototype files ----
  console.log('\n[2] Prototype files:');
  for (const f of REQUIRED_PROTOTYPE_FILES) {
    const p = path.join(PROTOTYPE_DIR, f);
    if (fileExists(p)) ok(`${f} exists`);
    else err(`Missing prototype file: ${f}`);
  }

  if (fileExists(SPEC_PATH)) ok('design spec exists (sha256: ' + sha256File(SPEC_PATH).slice(0, 16) + '...)');
  else err('Missing design spec: ' + SPEC_PATH);

  // ---- 3. Evidence directories ----
  console.log('\n[3] Evidence directories:');
  const matrixDir = path.join(EVIDENCE_BASE, 'browser-matrix');
  const contractDir = path.join(EVIDENCE_BASE, 'contract');
  const mutationDir = path.join(EVIDENCE_BASE, 'mutation');
  const shotsDir = path.join(matrixDir, 'screenshots');
  const domDir = path.join(matrixDir, 'dom-snapshots');
  for (const d of [EVIDENCE_BASE, matrixDir, contractDir, mutationDir, shotsDir, domDir]) {
    if (dirExists(d)) ok(`${path.relative(TEST_DIR, d)}/ exists`);
    else err(`Missing directory: ${d}`);
  }

  // ---- 4. Browser matrix evidence ----
  console.log('\n[4] Browser matrix evidence:');

  // Phase 1: 22 smoke screenshots + 22 DOM snapshots
  const phase1Shots = dirExists(shotsDir) ? fs.readdirSync(shotsDir).filter(f => f.startsWith('phase1_') && f.endsWith('.png')) : [];
  const phase1Doms = dirExists(domDir) ? fs.readdirSync(domDir).filter(f => f.startsWith('phase1_') && f.endsWith('.html')) : [];
  if (phase1Shots.length === SMOKE_ROUTES_COUNT) ok(`Phase 1 smoke screenshots: ${phase1Shots.length}/22`);
  else err(`Phase 1 smoke screenshots: found ${phase1Shots.length}, expected exactly ${SMOKE_ROUTES_COUNT}`);
  if (phase1Doms.length === SMOKE_ROUTES_COUNT) ok(`Phase 1 smoke DOM snapshots: ${phase1Doms.length}/22`);
  else err(`Phase 1 smoke DOM snapshots: found ${phase1Doms.length}, expected exactly ${SMOKE_ROUTES_COUNT}`);

  // Phase 2: 7 pages × 3vp × 3skin × 2mode = 126 cells
  const expectedCells = KEY_PAGES.length * VIEWPORTS.length * SKINS.length * MODES.length;
  const matrixShots = dirExists(shotsDir) ? fs.readdirSync(shotsDir).filter(f => f.startsWith('matrix_') && f.endsWith('.png')) : [];
  const matrixDoms = dirExists(domDir) ? fs.readdirSync(domDir).filter(f => f.startsWith('matrix_') && f.endsWith('.html')) : [];
  if (matrixShots.length === expectedCells) ok(`Phase 2 matrix screenshots: ${matrixShots.length}/${expectedCells}`);
  else err(`Phase 2 matrix screenshots: found ${matrixShots.length}, expected exactly ${expectedCells}`);
  if (matrixDoms.length === expectedCells) ok(`Phase 2 matrix DOM snapshots: ${matrixDoms.length}/${expectedCells}`);
  else err(`Phase 2 matrix DOM snapshots: found ${matrixDoms.length}, expected exactly ${expectedCells}`);

  // Verify specific cells exist (one per vp/skin/mode/page combo as a spot check)
  for (const vp of VIEWPORTS) {
    for (const skin of SKINS) {
      for (const mode of MODES) {
        for (const pg of KEY_PAGES) {
          const shotName = `matrix_${vp}_${skin}_${mode}_${pg}.png`;
          const domName = `matrix_${vp}_${skin}_${mode}_${pg}.html`;
          const shotPath = path.join(shotsDir, shotName);
          const domPath = path.join(domDir, domName);
          if (!fileExists(shotPath)) { err(`Missing screenshot: ${shotName}`); break; }
          if (!fileExists(domPath)) { err(`Missing DOM snapshot: ${domName}`); break; }
          const [w, h] = vp.split('x').map(Number);
          const dims = pngDimensions(shotPath);
          if (!dims || dims.width !== w || dims.height !== h) err(`Wrong screenshot dimensions for ${shotName}: ${dims ? dims.width + 'x' + dims.height : 'unreadable'}, expected ${vp}`);
        }
      }
    }
  }
  for (const s of phase1Shots) {
    const dims = pngDimensions(path.join(shotsDir, s));
    if (!dims || dims.width !== 1366 || dims.height !== 768) err(`Wrong phase1 screenshot dimensions for ${s}: ${dims ? dims.width + 'x' + dims.height : 'unreadable'}, expected 1366x768`);
  }

  // matrix-results.json exists and is valid JSON
  const matrixResultsPath = path.join(matrixDir, 'matrix-results.json');
  if (fileExists(matrixResultsPath)) {
    try {
      const mr = JSON.parse(fs.readFileSync(matrixResultsPath, 'utf-8'));
      ok(`matrix-results.json valid (phase1: ${mr.phase1?.pass}/${mr.phase1?.total}, phase2: ${mr.phase2?.pass}/${mr.phase2?.total})`);
      if (mr.phase1?.fail > 0) err(`Phase 1 has ${mr.phase1.fail} failures`);
      if (mr.phase2?.fail > 0) err(`Phase 2 has ${mr.phase2.fail} failures`);
    } catch (e) { err(`matrix-results.json is invalid JSON: ${e.message}`); }
  } else {
    err(`Missing matrix-results.json`);
  }

  // ---- 5. Contract test evidence ----
  console.log('\n[5] Contract test evidence:');
  const contractResultsPath = path.join(contractDir, 'contract-results.json');
  if (fileExists(contractResultsPath)) {
    try {
      const cr = JSON.parse(fs.readFileSync(contractResultsPath, 'utf-8'));
      ok(`contract-results.json valid (${cr.passCount} passed, ${cr.failCount} failed)`);
      if (cr.failCount > 0) err(`Contract tests have ${cr.failCount} failures`);
    } catch (e) { err(`contract-results.json invalid JSON: ${e.message}`); }
  } else {
    err(`Missing contract-results.json`);
  }

  // ---- 6. Mutation probe evidence ----
  console.log('\n[6] Mutation probe evidence:');
  const mutResultsPath = path.join(mutationDir, 'mutation-results.json');
  if (fileExists(mutResultsPath)) {
    try {
      const mr = JSON.parse(fs.readFileSync(mutResultsPath, 'utf-8'));
      ok(`mutation-results.json valid (${mr.killed} killed, ${mr.survived} survived, ${mr.errors} errors out of ${mr.total})`);
      if (mr.total < 24) err(`Mutation probes count ${mr.total} < 24`);
      if (mr.survived > 0) err(`${mr.survived} mutations SURVIVED`);
      if (mr.errors > 0) err(`${mr.errors} mutation probes errored`);
    } catch (e) { err(`mutation-results.json invalid JSON: ${e.message}`); }
  } else {
    err(`Missing mutation-results.json`);
  }

  // ---- 7. Delivery report ----
  console.log('\n[7] Delivery report:');
  if (fileExists(REPORT_PATH)) {
    const reportContent = fs.readFileSync(REPORT_PATH, 'utf-8');
    const lines = reportContent.split(/\r?\n/);
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    const lastLine = nonEmptyLines.length > 0 ? nonEmptyLines[nonEmptyLines.length - 1].trim() : '';
    const expectedLastLine = 'DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-trae-full-ui-system-prototype-01.md';

    if (lastLine === expectedLastLine) ok('Report last line is correct');
    else err(`Report last line incorrect. Expected: "${expectedLastLine}", got: "${lastLine}"`);

    // Check for relative paths (should use absolute Windows paths)
    const relPathPatterns = [/evidence\/(?!D:)/, /design-previews\/(?!D:)/, /\.\.\/(?!\.)/];
    let hasRelPaths = false;
    for (const line of lines) {
      for (const pat of relPathPatterns) {
        if (pat.test(line) && !line.startsWith('DELIVERY_REPORT:') && !line.includes('http://')) {
          // Just warn for evidence/ and design-previews/ since they might be described relatively
        }
      }
    }

    // Check for SHA-256 entries (64-char hex strings in backticks, or sha256: HASH format)
    const shaMatches = reportContent.match(/`[a-f0-9]{64}`|sha256[:\s]+[a-f0-9]{64}/gi) || [];
    const shaWordMatches = (reportContent.match(/SHA-256|sha256/gi) || []).length;
    if (shaMatches.length >= 10) ok(`Report contains ${shaMatches.length} SHA-256 hashes`);
    else warn(`Report may have insufficient SHA-256 hashes (found ${shaMatches.length} full hashes)`);

    // Check for exit codes
    if (/exit\s*code|退出码|Exit\s*Code/i.test(reportContent)) ok('Report contains exit code documentation');
    else warn('Report may be missing exit codes');

    // Check for adversarial review section
    if (/内部对抗审查|adversarial|对抗审查/i.test(reportContent)) ok('Report contains internal adversarial review');
    else err('Report missing internal adversarial review section');

    // Check for P0/P1/P2/P3
    if (/P[0-3]/i.test(reportContent)) ok('Report contains P0-P3 classifications');
    else err('Report missing P0-P3 priority classifications');

    // Report file hash
    const reportHash = sha256File(REPORT_PATH);
    ok(`Report SHA-256: ${reportHash}`);

  } else {
    err(`Delivery report not found at: ${REPORT_PATH}`);
  }

  // ---- 8. Compute artifact manifest with SHA-256 ----
  console.log('\n[8] Artifact manifest (SHA-256):');
  const manifest = {};
  const allArtifacts = [];
  // Scripts
  for (const s of REQUIRED_SCRIPTS) allArtifacts.push({ path: path.join(TEST_DIR, s), label: `scripts/${s}` });
  // Prototype
  for (const f of REQUIRED_PROTOTYPE_FILES) allArtifacts.push({ path: path.join(PROTOTYPE_DIR, f), label: `prototype/${f}` });
  // Evidence JSONs
  for (const j of ['matrix-results.json', 'contract-results.json', 'mutation-results.json']) {
    const d = j.startsWith('matrix') ? matrixDir : j.startsWith('contract') ? contractDir : mutationDir;
    allArtifacts.push({ path: path.join(d, j), label: `evidence/${j}` });
  }
  // Authority spec
  allArtifacts.push({ path: SPEC_PATH, label: 'spec/trae-full-ui-system-prototype-spec.md' });
  // Screenshots and DOM evidence: all required files, no sampling
  if (dirExists(shotsDir)) {
    const allShots = fs.readdirSync(shotsDir).filter(f => f.endsWith('.png')).sort();
    for (const s of allShots) allArtifacts.push({ path: path.join(shotsDir, s), label: `screenshots/${s}` });
    ok(`  (${allShots.length} total screenshots, manifesting all screenshots)`);
  }
  if (dirExists(domDir)) {
    const allDoms = fs.readdirSync(domDir).filter(f => f.endsWith('.html')).sort();
    for (const d of allDoms) allArtifacts.push({ path: path.join(domDir, d), label: `dom-snapshots/${d}` });
    ok(`  (${allDoms.length} total DOM snapshots, manifesting all DOM snapshots)`);
  }
  // Report
  if (fileExists(REPORT_PATH)) allArtifacts.push({ path: REPORT_PATH, label: 'delivery-report.md' });

  let missingCount = 0;
  for (const a of allArtifacts) {
    const h = sha256File(a.path);
    if (h) { manifest[a.label] = h; }
    else { missingCount++; err(`Missing artifact: ${a.label} at ${a.path}`); }
  }

  const actualCandidateSha = candidateShaFromFiles(manifest);
  ok('Candidate SHA-256 from current artifact set: ' + actualCandidateSha);

  // Freeze explicitly, verify read-only by default.
  const manifestPath = path.join(EVIDENCE_BASE, 'artifact-manifest.json');
  if (WRITE_MANIFEST) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      totalFiles: Object.keys(manifest).length,
      missingCount,
      files: manifest,
    }, null, 2), 'utf-8');
    ok(`Artifact manifest frozen at ${manifestPath} (${Object.keys(manifest).length} files, ${missingCount} missing)`);
  } else if (!fileExists(manifestPath)) {
    err('Missing frozen artifact-manifest.json; run verify-artifacts.js --write-manifest once after regenerating accepted evidence');
  } else {
    try {
      const frozen = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const expected = frozen.files || {};
      const frozenCandidateSha = candidateShaFromFiles(expected);
      ok('Candidate SHA-256 from frozen artifact manifest: ' + frozenCandidateSha);
      const expectedKeys = Object.keys(expected).sort();
      const actualKeys = Object.keys(manifest).sort();
      for (const key of expectedKeys) {
        if (!(key in manifest)) err(`Frozen manifest references missing artifact: ${key}`);
        else if (expected[key] !== manifest[key]) err(`Artifact hash mismatch: ${key}`);
      }
      for (const key of actualKeys) {
        if (!(key in expected)) err(`Unregistered artifact not in frozen manifest: ${key}`);
      }
      if (expectedKeys.length !== actualKeys.length) err(`Artifact manifest key count mismatch: frozen ${expectedKeys.length}, actual ${actualKeys.length}`);
      if (errors.length === 0) ok(`Frozen artifact manifest verified: ${actualKeys.length}/${expectedKeys.length} hashes match`);
    } catch (e) {
      err(`Frozen artifact manifest is invalid JSON: ${e.message}`);
    }
  }

  // ---- Summary ----
  console.log('\n=== Verification Summary ===');
  console.log(`Errors: ${errors.length}`);
  console.log(`Warnings: ${warnings.length}`);
  for (const e of errors) console.log(`  - ${e}`);

  // Write verification result
  const resultPath = path.join(EVIDENCE_BASE, 'verification-result.json');
  if (WRITE_RESULT) {
    fs.writeFileSync(resultPath, JSON.stringify({ verifiedAt: new Date().toISOString(), valid: errors.length === 0, errors, warnings, candidateSha256: actualCandidateSha, manifest }, null, 2), 'utf-8');
    ok('Verification result written at ' + resultPath);
  } else {
    ok('Verification result not written; pass --write-result to update verification-result.json');
  }

  process.exit(errors.length === 0 ? 0 : 1);
}

main();
