'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PNG } = require('D:/xinjing-electron/node_modules/pngjs');

const TASK_ID = 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297';
const ROOT = 'D:/xinjing-electron';
const CANDIDATE = path.join(ROOT, 'design-previews/5.0.0-sol-full-ui-ux-system-review-prototype-r2-297');
const TEST_ROOT = path.join(ROOT, 'tests/v5.0.0-disposable/sol-full-ui-ux-system-review-prototype-r2-297');
const WORKSPACE = path.join(ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const EVIDENCE = path.join(WORKSPACE, 'evidence');
const REPORT = path.join(WORKSPACE, 'delivery/DELIVERY_REPORT.md');
const REQUIRED_CANDIDATE = ['index.html', 'styles.css', 'app.js', 'fixtures.js', 'route-manifest.json', 'state-manifest.json', 'design-system.md', 'route-review.md', 'decision-matrix.md', 'README.md'];
const REQUIRED_TESTS = ['lineage-audit.js', 'scope-audit.js', 'run-contract.js', 'run-browser-matrix.js', 'interaction-probes.js', 'mutation-probes.js', 'verify-artifacts.js'];
const SMOKE_DIR = path.join(EVIDENCE, 'browser-matrix');
const REPORT_TAIL = 'DELIVERY_REPORT: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297/workspace/delivery/DELIVERY_REPORT.md';
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const normalize = (value) => value.replace(/\\/g, '/');
function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(file));
    else result.push(file);
  }
  return result.sort();
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function checkImage(file, width, height) {
  const image = PNG.sync.read(fs.readFileSync(file));
  return image.width === width && image.height === height;
}
function candidateManifest() {
  return REQUIRED_CANDIDATE.map((relativePath) => {
    const file = path.join(CANDIDATE, relativePath);
    const body = fs.readFileSync(file);
    return { path: normalize(relativePath), bytes: body.length, sha256: sha(body) };
  });
}
function candidateSha(files) {
  const body = files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((item) => `${item.path}\n${item.sha256.toLowerCase()}\n`).join('');
  return sha(Buffer.from(body, 'utf8'));
}
function sourceDrift() {
  const manifest = readJson(path.join(WORKSPACE, 'input/source-manifest.json'));
  const mismatches = [];
  for (const item of manifest.files) {
    const file = item.path;
    if (!fs.existsSync(file)) { mismatches.push({ path: item.path, reason: 'missing' }); continue; }
    const body = fs.readFileSync(file);
    if (body.length !== item.bytes || sha(body) !== item.sha256) mismatches.push({ path: item.path, reason: 'hash-or-bytes-drift', expected: item, actual: { bytes: body.length, sha256: sha(body) } });
  }
  return { files: manifest.files.length, mismatches };
}
function artifactManifest(candidateFiles, smoke, matrix, interactions, mutation) {
  const roots = [CANDIDATE, TEST_ROOT, path.join(WORKSPACE, 'evidence')];
  const ignored = new Set([
    path.join(WORKSPACE, 'evidence/artifact-manifest.json'),
    path.join(WORKSPACE, 'evidence/verification-result.json'),
    path.join(WORKSPACE, 'evidence/candidate-sha256.txt'),
  ]);
  const files = [];
  for (const root of roots) {
    for (const file of listFiles(root)) {
      if (ignored.has(file)) continue;
      const body = fs.readFileSync(file);
      files.push({ path: normalize(path.relative(ROOT, file)), bytes: body.length, sha256: sha(body) });
    }
  }
  return { task_id: TASK_ID, generated_at: new Date().toISOString(), candidate_files: candidateFiles, evidence_summary: { smoke: { expected: 22, actual: smoke.cells, passed: smoke.passed, failed: smoke.failed }, matrix: { expected: 126, actual: matrix.cells, passed: matrix.passed, failed: matrix.failed }, interactions: { total: interactions.total, passed: interactions.passed, failed: interactions.failed }, mutations: { total: mutation.total, killed: mutation.killed, survivors: mutation.survivors, failed: mutation.failed } }, files };
}

const checks = [];
function check(id, run) {
  try { const details = run(); checks.push({ id, status: 'PASS', ...(details || {}) }); }
  catch (error) { checks.push({ id, status: 'FAIL', message: error && error.message ? error.message : String(error) }); }
}
const writeMode = process.argv.includes('--write-manifest') && process.argv.includes('--write-result');
const smoke = readJson(path.join(SMOKE_DIR, 'smoke-results.json'));
const matrix = readJson(path.join(SMOKE_DIR, 'matrix-results.json'));
const interactions = readJson(path.join(EVIDENCE, 'interactions/interaction-results.json'));
const mutation = readJson(path.join(EVIDENCE, 'mutation/mutation-results.json'));
const cFiles = candidateManifest();

check('artifacts:exact-route-count', () => { const m = readJson(path.join(CANDIDATE, 'route-manifest.json')); if (m.route_count !== 22) throw new Error(`route_count=${m.route_count}`); return { route_count: m.route_count }; });
check('artifacts:smoke-22', () => { if (smoke.cells !== 22 || smoke.passed !== 22 || smoke.failed !== 0) throw new Error('smoke not 22/22'); return { cells: smoke.cells }; });
check('artifacts:matrix-126', () => { if (matrix.cells !== 126 || matrix.passed !== 126 || matrix.failed !== 0) throw new Error('matrix not 126/126'); return { cells: matrix.cells }; });
check('artifacts:png-and-dom-counts', () => { const pngs = listFiles(path.join(SMOKE_DIR, 'screenshots')).filter((file) => file.endsWith('.png')); const doms = listFiles(path.join(SMOKE_DIR, 'dom-snapshots')).filter((file) => file.endsWith('.html')); if (pngs.length !== 148 || doms.length !== 148) throw new Error(`png=${pngs.length}, dom=${doms.length}`); return { screenshots: pngs.length, dom_snapshots: doms.length }; });
check('artifacts:smoke-dimensions', () => { const items = smoke.results.filter((item) => item.kind === 'smoke'); if (items.length !== 22 || items.some((item) => item.screenshot_width !== 1366 || item.screenshot_height !== 768)) throw new Error('smoke screenshot dimensions invalid'); return { dimensions: '1366x768' }; });
check('artifacts:matrix-dimensions', () => { const bad = matrix.results.filter((item) => item.screenshot_width !== item.viewport.width || item.screenshot_height !== item.viewport.height); if (bad.length) throw new Error(`${bad.length} matrix dimensions invalid`); return { dimensions: 'per-cell viewport dimensions' }; });
check('artifacts:browser-clean', () => { const all = [...smoke.results, ...matrix.results]; const bad = all.filter((item) => item.console_errors || item.page_errors || item.external_network_requests.length || item.layout.horizontalOverflow || item.layout.overlapCount || item.layout.clippedCount || item.layout.blankCanvas); if (bad.length) throw new Error(`${bad.length} browser cells have errors/layout issues`); return { cells: all.length, console_errors: 0, page_errors: 0 }; });
check('artifacts:interactions', () => { if (interactions.total !== 12 || interactions.passed !== 12 || interactions.failed !== 0 || interactions.console_errors || interactions.page_errors) throw new Error('interactions not 12/12 clean'); return { interactions: interactions.total }; });
check('artifacts:mutations', () => { if (mutation.total !== 24 || mutation.killed !== 24 || mutation.survivors !== 0 || mutation.failed !== 0) throw new Error('mutations not 24/24 killed'); return { mutations: mutation.total }; });
check('artifacts:source-no-drift', () => { const result = sourceDrift(); if (result.mismatches.length) throw new Error(`${result.mismatches.length} source files drifted`); return result; });
check('artifacts:report-tail', () => { const lines = fs.readFileSync(REPORT, 'utf8').trimEnd().split(/\r?\n/); if (lines[lines.length - 1] !== REPORT_TAIL) throw new Error('report tail mismatch'); return { last_line: lines[lines.length - 1] }; });
check('artifacts:candidate-sha', () => { if (cFiles.length !== 10) throw new Error('candidate file count invalid'); return { candidate_sha256: candidateSha(cFiles) }; });
check('artifacts:task-local-tests', () => { const missing = REQUIRED_TESTS.filter((name) => !fs.existsSync(path.join(TEST_ROOT, name))); if (missing.length) throw new Error(`missing tests: ${missing.join(',')}`); return { tests: REQUIRED_TESTS.length }; });

const failed = checks.filter((item) => item.status === 'FAIL');
const manifest = artifactManifest(cFiles, smoke, matrix, interactions, mutation);
const result = { task_id: TASK_ID, suite: 'verify-artifacts', write_mode: writeMode, total: checks.length, passed: checks.length - failed.length, failed: failed.length, candidate_sha256: candidateSha(cFiles), source_manifest_sha256: sha(fs.readFileSync(path.join(WORKSPACE, 'input/source-manifest.json'))), checks, manifest_file_count: manifest.files.length };
if (writeMode) {
  fs.writeFileSync(path.join(EVIDENCE, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(EVIDENCE, 'candidate-sha256.txt'), result.candidate_sha256 + '\n', 'utf8');
  fs.writeFileSync(path.join(EVIDENCE, 'verification-result.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
