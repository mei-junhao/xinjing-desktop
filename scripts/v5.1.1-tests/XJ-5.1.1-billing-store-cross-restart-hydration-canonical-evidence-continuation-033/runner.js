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
  PROTECTED_FILES_MANIFEST_SHA256,
  TASK_CARD_SHA256,
  ensureFreshEvidenceRoot,
  writeJson,
  sha256File,
  nowUtc,
  makeRunId,
  runChild,
  runAndCapture,
  installSelfCapture,
  lastJsonLine
} = require('./common');

const TASK_CARD = path.resolve(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks/' + TASK_ID + '.md');
const EXPECTED_RED = path.join(SCRIPT_ROOT, 'expected-red.js');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : '';
}

const runId = argValue('--run-id') || makeRunId();
const requestedRoot = argValue('--evidence-root');
const evidenceRoot = ensureFreshEvidenceRoot(requestedRoot || path.join(SCRATCH_ROOT, 'evidence', runId));
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: evidenceRoot, runId: runId, toolName: 'runner' });

async function gitSnapshot() {
  const status = await runChild('git', ['status', '--short'], { cwd: PROJECT_ROOT });
  const head = await runChild('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT });
  return {
    statusExitCode: status.exitCode,
    status: status.stdout.toString('utf8'),
    statusStderr: status.stderr.toString('utf8'),
    headExitCode: head.exitCode,
    head: head.stdout.toString('utf8').trim(),
    headStderr: head.stderr.toString('utf8')
  };
}

async function main() {
  if (!fs.existsSync(TASK_CARD)) throw new Error('task card missing: ' + TASK_CARD);
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'app/js/store.js'))) throw new Error('production Store missing');
  if (!fs.existsSync(EXPECTED_RED)) throw new Error('harness script missing');
  const startSnapshot = await gitSnapshot();
  const storePath = path.join(PROJECT_ROOT, 'app/js/store.js');
  const manifest = {
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    baseCommit: BASE_COMMIT,
    runId: runId,
    randomNonce: runId.slice(runId.lastIndexOf('-') + 1),
    evidenceRoot: evidenceRoot,
    fixedOrigin: FIXED_ORIGIN,
    projectRoot: PROJECT_ROOT,
    taskCard: TASK_CARD,
    taskCardSha256: sha256File(TASK_CARD),
    expectedTaskCardSha256: TASK_CARD_SHA256,
    protectedFilesManifestSha256: PROTECTED_FILES_MANIFEST_SHA256,
    productionStoreSha256: sha256File(storePath),
    expectedProductionStoreSha256: '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D',
    productionStoreBytes: fs.statSync(storePath).size,
    gitHeadAtStart: startSnapshot.head,
    gitStatusAtStart: startSnapshot.status,
    generatedAt: nowUtc(),
    networkPolicy: 'deny-by-default; loopback fixed origin only',
    syntheticDataOnly: true
  };
  writeJson(path.join(evidenceRoot, 'run-manifest.json'), manifest);

  const expected = await runAndCapture({
    root: evidenceRoot,
    runId: runId,
    caseId: '__tools__',
    stage: 'expected-red',
    command: process.execPath,
    argv: [EXPECTED_RED, '--run-id', runId, '--evidence-root', evidenceRoot],
    cwd: PROJECT_ROOT,
    verdictOnZero: 'PASS',
    verdictOnNonZero: 'FAIL'
  });
  if (expected.meta.verdict !== 'PASS' || expected.meta.exitCode !== 0) throw new Error('expected-red tool run failed (' + expected.meta.exitCode + ')');
  const expectedSummary = lastJsonLine(expected.result.stdout.toString('utf8'), 'expected-red-summary');
  if (!expectedSummary || expectedSummary.verdict !== 'PASS' || expectedSummary.killed !== 8 || expectedSummary.mutatedNonZero !== 8) {
    throw new Error('expected-red did not kill all 8 mutations');
  }
  if (!fs.existsSync(path.join(evidenceRoot, 'expected-red-ledger.json'))) throw new Error('expected-red ledger missing');

  manifest.expectedRedMetaPath = expected.metaPath;
  manifest.expectedRedSummary = expectedSummary;
  manifest.gitStatusAtEnd = (await gitSnapshot()).status;
  manifest.completedAt = nowUtc();
  writeJson(path.join(evidenceRoot, 'run-manifest.json'), manifest);
  process.stdout.write(JSON.stringify({
    type: 'runner-summary',
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    runId: runId,
    evidenceRoot: evidenceRoot,
    fixedOrigin: FIXED_ORIGIN,
    expectedRed: expectedSummary,
    verdict: 'PASS'
  }) + String.fromCharCode(10));
  return 0;
}

main().then((code) => {
  const meta = finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
  if (meta) process.stderr.write('runner self meta: ' + path.join(evidenceRoot, 'self/runner/meta.json') + String.fromCharCode(10));
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'runner-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
