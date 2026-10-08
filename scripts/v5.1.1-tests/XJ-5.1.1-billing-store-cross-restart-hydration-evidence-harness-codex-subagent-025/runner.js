'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID,
  CONTRACT_ID,
  BASE_COMMIT,
  PROJECT_ROOT,
  SCRIPT_ROOT,
  SCRATCH_ROOT,
  FIXED_ORIGIN,
  ensureDir,
  ensureFreshEvidenceRoot,
  writeJson,
  sha256File,
  nowUtc,
  makeRunId,
  runChild,
  runAndCapture,
  installSelfCapture,
  lastJsonLine,
} = require('./common');

const TASK_CARD = path.resolve(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks/' + TASK_ID + '.md');
const PHASE_WORKER = path.join(SCRIPT_ROOT, 'phase-worker.js');
const EXPECTED_RED = path.join(SCRIPT_ROOT, 'expected-red.js');
const PROTECTED_FILES_MANIFEST_SHA256 = 'D52755D4AED2E9E8D8A4CFF316B3B5F8B2D937B33AA766523998006DAA8B336C';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : '';
}

const runId = argValue('--run-id') || makeRunId();
const requestedRoot = argValue('--evidence-root');
const evidenceRoot = ensureFreshEvidenceRoot(requestedRoot || path.join(SCRATCH_ROOT, 'evidence', runId));
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: evidenceRoot, runId, toolName: 'runner' });

async function gitSnapshot() {
  const status = await runChild('git', ['status', '--short'], { cwd: PROJECT_ROOT });
  const head = await runChild('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT });
  return {
    statusExitCode: status.exitCode,
    status: status.stdout.toString('utf8'),
    statusStderr: status.stderr.toString('utf8'),
    headExitCode: head.exitCode,
    head: head.stdout.toString('utf8').trim(),
    headStderr: head.stderr.toString('utf8'),
  };
}

function childArgs(script, extra) {
  return [script].concat(extra);
}

async function main() {
  if (!fs.existsSync(TASK_CARD)) throw new Error('task card missing: ' + TASK_CARD);
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'app/js/store.js'))) throw new Error('production Store missing');
  if (!fs.existsSync(PHASE_WORKER) || !fs.existsSync(EXPECTED_RED)) throw new Error('harness script missing');
  const startSnapshot = await gitSnapshot();
  const manifest = {
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    runId,
    randomNonce: runId.slice(runId.lastIndexOf('-') + 1),
    evidenceRoot,
    fixedOrigin: FIXED_ORIGIN,
    projectRoot: PROJECT_ROOT,
    taskCard: TASK_CARD,
    taskCardSha256: sha256File(TASK_CARD),
    baseCommit: BASE_COMMIT,
    gitHeadAtStart: startSnapshot.head,
    gitStatusAtStart: startSnapshot.status,
    protectedFilesManifestSha256: PROTECTED_FILES_MANIFEST_SHA256,
    productionStoreSha256: sha256File(path.join(PROJECT_ROOT, 'app/js/store.js')),
    generatedAt: nowUtc(),
    networkPolicy: 'deny-by-default; loopback fixture origin only',
    syntheticDataOnly: true,
  };
  writeJson(path.join(evidenceRoot, 'run-manifest.json'), manifest);

  const core = await runAndCapture({
    root: evidenceRoot,
    runId,
    caseId: 'core',
    stage: 'core',
    command: process.execPath,
    argv: childArgs(PHASE_WORKER, ['--run-id', runId, '--run-root', evidenceRoot, '--case-id', 'core', '--stage', 'core']),
    cwd: PROJECT_ROOT,
    verdictOnZero: 'PASS',
    verdictOnNonZero: 'FAIL',
  });
  const coreSummary = lastJsonLine(core.result.stdout.toString('utf8'), 'phase-summary');
  if (!coreSummary || core.meta.verdict !== 'PASS' || coreSummary.verdict !== 'PASS') {
    throw new Error('core fixed-origin cross-restart phase failed');
  }
  manifest.coreMetaPath = core.metaPath;
  manifest.coreSummary = coreSummary;
  writeJson(path.join(evidenceRoot, 'run-manifest.json'), manifest);

  const expected = await runAndCapture({
    root: evidenceRoot,
    runId,
    caseId: '__tools__',
    stage: 'expected-red',
    command: process.execPath,
    argv: childArgs(EXPECTED_RED, ['--run-id', runId, '--evidence-root', evidenceRoot]),
    cwd: PROJECT_ROOT,
    verdictOnZero: 'PASS',
    verdictOnNonZero: 'FAIL',
  });
  if (expected.meta.verdict !== 'PASS') throw new Error('expected-red runner failed');
  const expectedSummary = lastJsonLine(expected.result.stdout.toString('utf8'), 'expected-red-summary');
  if (!expectedSummary || expectedSummary.verdict !== 'PASS' || expectedSummary.killed !== 8) {
    throw new Error('expected-red did not kill all 8 mutations');
  }
  manifest.expectedRedMetaPath = expected.metaPath;
  manifest.expectedRedSummary = expectedSummary;
  manifest.gitStatusAtEnd = (await gitSnapshot()).status;
  manifest.completedAt = nowUtc();
  writeJson(path.join(evidenceRoot, 'run-manifest.json'), manifest);
  process.stdout.write(JSON.stringify({ type: 'runner-summary', taskId: TASK_ID, runId, evidenceRoot, fixedOrigin: FIXED_ORIGIN, core: coreSummary, expectedRed: expectedSummary, verdict: 'PASS' }) + '\n');
  return 0;
}

main().then((code) => {
  const meta = finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
  if (meta) process.stderr.write('runner self meta: ' + path.join(evidenceRoot, 'self/runner/meta.json') + '\n');
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'runner-error', message: String(error && error.message || error), stack: String(error && error.stack || '') }) + '\n');
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
