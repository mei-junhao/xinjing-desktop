'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-codex-main-review-039';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK_ID);
const BASE_BINDING = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035', 'binding', 'run-035-20260827063639-5a43423c511376', 'final-binding-files-035.json');
const BASE_MANIFEST = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035', 'binding', 'run-035-20260827063639-5a43423c511376', 'final-binding-manifest-035.json');
const RUNNER = path.join(__dirname, 'run-case-039.js');
const RUN_ID = `run-039-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(6).toString('hex')}`;
const RUN_ROOT = path.join(SCRATCH, 'runs', RUN_ID);

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }
function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function copyInputs(dir) {
  mkdir(dir);
  const bindingPath = path.join(dir, 'final-binding-files-035.json');
  const manifestPath = path.join(dir, 'final-binding-manifest-035.json');
  fs.copyFileSync(BASE_BINDING, bindingPath);
  fs.copyFileSync(BASE_MANIFEST, manifestPath);
  const manifest = readJson(manifestPath);
  manifest.filesPath = bindingPath;
  manifest.bindingDir = dir;
  writeJson(manifestPath, manifest);
  return { bindingPath, manifestPath };
}

function makeCase(id, mutate) {
  const caseRoot = path.join(RUN_ROOT, 'cases', id);
  const baseline = { input: copyInputs(path.join(caseRoot, 'baseline', 'input')), out: path.join(caseRoot, 'baseline', 'raw') };
  const mutated = { input: copyInputs(path.join(caseRoot, 'mutated', 'input')), out: path.join(caseRoot, 'mutated', 'raw') };
  const restore = { input: copyInputs(path.join(caseRoot, 'restore', 'input')), out: path.join(caseRoot, 'restore', 'raw') };
  mutate(mutated.input);
  return { caseId: id, baseline, mutated, restore };
}

function runStage(item, stage, comparator) {
  const target = item[stage];
  mkdir(target.out);
  const args = [RUNNER, '--binding', target.input.bindingPath, '--manifest', target.input.manifestPath, '--out', target.out, '--case', item.caseId, '--stage', stage];
  if (comparator) args.push('--comparator', comparator);
  const child = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const metaPath = path.join(target.out, 'meta.json');
  if (!fs.existsSync(metaPath)) throw new Error(`${item.caseId}/${stage}: runner did not create meta.json (exit ${child.status})`);
  const meta = readJson(metaPath);
  return { childExit: child.status, metaPath, meta };
}

function mutateJson(input, fn) {
  const binding = readJson(input.bindingPath);
  const manifest = readJson(input.manifestPath);
  fn(binding, manifest);
  writeJson(input.bindingPath, binding);
  writeJson(input.manifestPath, manifest);
}

const definitions = [
  ['E01-tamper-entry-sha', (input) => mutateJson(input, (b) => { b.entries[0].sha256 = '0'.repeat(64); })],
  ['E02-tamper-entry-bytes', (input) => mutateJson(input, (b) => { b.entries[0].bytes += 1; })],
  ['E03-delete-entry', (input) => mutateJson(input, (b) => { b.entries.pop(); })],
  ['E04-duplicate-entry', (input) => mutateJson(input, (b) => { b.entries.push(clone(b.entries[0])); })],
  ['E05-unknown-entry-field', (input) => mutateJson(input, (b) => { b.entries[0].unexpected = true; })],
  ['E06-binding-aggregate', (input) => mutateJson(input, (b) => { b.aggregateSha256 = 'f'.repeat(64); })],
  ['E07-aggregate-input', (input) => mutateJson(input, (b) => { b.aggregateInput[0].sha256 = 'f'.repeat(64); })],
  ['E08-manifest-metadata', (input) => mutateJson(input, (_b, m) => { m.metadata['035-card-sha'] = '0'.repeat(64); })],
  ['E09-manifest-objects', (input) => mutateJson(input, (_b, m) => { m.objects.store = 2; })],
  ['E10-capturedFrom', (input) => mutateJson(input, (_b, m) => { m.freezeCapture.capturedFrom = path.join(ROOT, 'scripts', 'v5.1.1-tests', 'replica-freeze-verifier.js'); })],
  ['E11-executed-source-sha', (input) => mutateJson(input, (_b, m) => { m.freezeCapture.executedSourceSha256 = '0'.repeat(64); })],
  ['E12-hook-sha', (input) => mutateJson(input, (_b, m) => { m.freezeCapture.hookSha256 = '0'.repeat(64); })],
  ['E13-freeze-raw-sha', (input) => mutateJson(input, (_b, m) => { const x = m.freezeCapture.isolationOutputs.find((v) => v.rel === 'self/freeze-verifier/stdout.txt'); x.sha256 = '0'.repeat(64); })],
  ['E14-child-meta-missing', (input) => mutateJson(input, (_b, m) => { m.freezeCapture.childSelfTriplet.metaPath = path.join(m.freezeCapture.redirectRoot, 'self', 'freeze-verifier', 'missing.json'); })],
  ['E15-redirect-sibling', (input) => mutateJson(input, (_b, m) => { m.freezeCapture.redirectRoot = `${m.freezeCapture.redirectRoot}-sibling`; })],
  ['E16-release-ready-forge', (input) => mutateJson(input, (_b, m) => { m.flags.releaseReady = true; })],
  ['E17-wrong-task-id', (input) => mutateJson(input, (_b, m) => { m.taskId = 'wrong-task'; })],
  ['E18-source-path-missing', (input) => mutateJson(input, (b) => { b.entries[0].sourcePath = path.join(SCRATCH, 'missing-source.bin'); })],
  ['E19-locale-comparator', (_input) => {}],
  ['E20-relative-isolation-output', (input) => mutateJson(input, (_b, m) => { m.freezeCapture.isolationOutputs[0].rel = '../escape.json'; })]
];

function main() {
  mkdir(RUN_ROOT);
  const cases = [];
  for (const [caseId, mutate] of definitions) {
    const item = makeCase(caseId, mutate);
    const baseline = runStage(item, 'baseline');
    const mutated = runStage(item, 'mutated', caseId === 'E19-locale-comparator' ? 'locale' : undefined);
    const restore = runStage(item, 'restore');
    if (baseline.meta.exitCode !== 0 || baseline.meta.verdict !== 'PASS') throw new Error(`${caseId}: baseline did not PASS`);
    if (mutated.meta.exitCode === 0 || mutated.meta.verdict === 'PASS') throw new Error(`${caseId}: mutation survived`);
    if (restore.meta.exitCode !== 0 || restore.meta.verdict !== 'PASS') throw new Error(`${caseId}: restore did not PASS`);
    cases.push({
      caseId,
      attack: caseId === 'E19-locale-comparator' ? 'localeCompare comparator mutation' : 'input binding/manifest mutation',
      baseline,
      mutated,
      restore,
      killed: true
    });
  }
  const result = {
    schema: 'xj.v511.codex-main-review-expected-red.v1',
    taskId: TASK_ID,
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    caseCount: cases.length,
    killed: cases.filter((x) => x.killed).length,
    restorePass: cases.filter((x) => x.restore.meta.exitCode === 0).length,
    verdict: cases.length >= 15 && cases.every((x) => x.killed && x.baseline.meta.exitCode === 0 && x.restore.meta.exitCode === 0) ? 'PASS' : 'FAIL',
    cases
  };
  writeJson(path.join(RUN_ROOT, 'expected-red-results.json'), result);
  process.stdout.write(`${JSON.stringify({ type: 'expected-red-summary', taskId: TASK_ID, runId: RUN_ID, caseCount: result.caseCount, killed: result.killed, restorePass: result.restorePass, verdict: result.verdict, resultsPath: path.join(RUN_ROOT, 'expected-red-results.json') })}\n`);
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}

try { main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ type: 'expected-red-error', taskId: TASK_ID, error: String(error.message || error), stack: String(error.stack || '') })}\n`);
  process.exitCode = 1;
}
