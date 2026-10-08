'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, TASK33, RUN33, AGGREGATE33,
  PROJECT_ROOT, EVIDENCE33, SCRATCH_ROOT,
  sha256Bytes, sha256File, nowUtc, installSelfCapture, argValue, walkFiles, readJson
} = require('./common-034');

// 034-native READ-ONLY freeze-equivalent check over the 033 frozen evidence.
// It never writes to 033; its own self triplet lands in the 034 scratch root.

function lastJsonLine(text, type) {
  const lines = String(text || '').split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!type || parsed.type === type) last = parsed;
    } catch (error) {}
  }
  return last;
}

const runId = argValue('--run-id', RUN33);
const selfRoot = path.resolve(argValue('--self-root', path.join(SCRATCH_ROOT, 'self')));
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: selfRoot, runId: runId, toolName: 'freeze-replica-check' });

function fail(message) { throw new Error(message); }

function verifyStage(caseId, stage, expectedVerdict) {
  const dir = path.join(EVIDENCE33, 'cases', caseId, stage);
  for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) {
    if (!fs.existsSync(path.join(dir, name))) fail(caseId + '/' + stage + ' missing ' + name);
  }
  const meta = readJson(path.join(dir, 'meta.json'));
  if (meta.taskId !== TASK33) fail(caseId + '/' + stage + ' meta taskId mismatch');
  if (meta.runId !== runId) fail(caseId + '/' + stage + ' meta runId mismatch');
  if (meta.caseId !== caseId || meta.stage !== stage) fail(caseId + '/' + stage + ' meta identity mismatch');
  if (meta.stdoutSha256 !== sha256File(path.join(dir, 'stdout.txt')) || meta.stderrSha256 !== sha256File(path.join(dir, 'stderr.txt'))) {
    fail(caseId + '/' + stage + ' meta sha mismatch');
  }
  const summary = lastJsonLine(fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8'), 'phase-summary');
  if (!summary || summary.verdict !== expectedVerdict) fail(caseId + '/' + stage + ' summary verdict mismatch');
  if (expectedVerdict === 'PASS') {
    if (meta.verdict !== 'PASS' || meta.exitCode !== 0) fail(caseId + '/' + stage + ' PASS contract mismatch');
  } else {
    if (meta.verdict !== 'REJECTED' || meta.exitCode !== 2) fail(caseId + '/' + stage + ' REJECTED contract mismatch');
  }
  return true;
}

async function main() {
  if (!fs.existsSync(EVIDENCE33) || !fs.statSync(EVIDENCE33).isDirectory()) fail('033 evidence root missing: ' + EVIDENCE33);
  const ledgerPath = path.join(EVIDENCE33, 'expected-red-ledger.json');
  if (!fs.existsSync(ledgerPath)) fail('033 ledger missing');
  const ledger = readJson(ledgerPath);
  if (ledger.taskId !== TASK33 || ledger.runId !== runId || !Array.isArray(ledger.cases) || ledger.cases.length !== 8 || ledger.killed !== 8 || ledger.verdict !== 'PASS') {
    fail('033 ledger invalid');
  }
  let stageCount = 0;
  for (const entry of ledger.cases) {
    for (const stage of ['baseline', 'mutated', 'restore']) {
      verifyStage(entry.caseId, stage, stage === 'mutated' ? 'REJECTED' : 'PASS');
      stageCount++;
    }
  }
  if (stageCount !== 24) fail('expected 24 stages, got ' + stageCount);
  for (const tool of ['runner', 'expected-red', 'verifier', 'audit']) {
    const metaPath = path.join(EVIDENCE33, 'self', tool, 'meta.json');
    if (!fs.existsSync(metaPath)) fail('033 self triplet missing: ' + tool);
    const meta = readJson(metaPath);
    if (meta.taskId !== TASK33 || meta.runId !== runId || meta.verdict !== 'PASS' || meta.exitCode !== 0) fail('033 self triplet invalid: ' + tool);
  }
  const files = walkFiles(EVIDENCE33, '', []).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const aggregate = sha256Bytes(JSON.stringify(files.map((f) => ({ rel: f.rel, sha256: f.sha256, bytes: f.bytes }))));
  if (aggregate !== AGGREGATE33) fail('033 aggregate drift: ' + aggregate + ' expected ' + AGGREGATE33);
  process.stdout.write(JSON.stringify({
    type: 'freeze-summary',
    taskId: TASK33,
    runId: runId,
    evidenceRoot: EVIDENCE33,
    fileCount: files.length,
    aggregateSha256: aggregate,
    stagesVerified: stageCount,
    readOnly: true,
    verdict: 'PASS',
    generatedAt: nowUtc()
  }) + String.fromCharCode(10));
  return 0;
}

main().then((code) => {
  finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'freeze-replica-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
