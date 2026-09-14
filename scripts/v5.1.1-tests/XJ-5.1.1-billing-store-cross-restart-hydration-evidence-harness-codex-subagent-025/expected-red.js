'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID,
  PROJECT_ROOT,
  SCRIPT_ROOT,
  FIXED_ORIGIN,
  ensureFreshEvidenceRoot,
  readJson,
  writeJson,
  nowUtc,
  runAndCapture,
  installSelfCapture,
  lastJsonLine,
  assertFreshEvidencePath,
} = require('./common');

const PHASE_WORKER = path.join(SCRIPT_ROOT, 'phase-worker.js');
const RULES_PATH = path.join(SCRIPT_ROOT, 'expected-red.json');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const runId = argValue('--run-id', 'run-025-unknown');
const evidenceRoot = ensureFreshEvidenceRoot(argValue('--evidence-root', ''));
const finalizeSelf = installSelfCapture({ root: evidenceRoot, runId, toolName: 'expected-red' });

async function runStage(caseId, stage, mutation) {
  const args = [
    PHASE_WORKER,
    '--run-id', runId,
    '--run-root', evidenceRoot,
    '--case-id', caseId,
    '--stage', stage,
  ];
  if (mutation) args.push('--mutation', mutation);
  const capture = await runAndCapture({
    root: evidenceRoot,
    runId,
    caseId,
    stage,
    command: process.execPath,
    argv: args,
    cwd: PROJECT_ROOT,
    verdictOnZero: stage === 'mutated' ? 'REJECTED' : 'PASS',
    verdictOnNonZero: stage === 'mutated' ? 'REJECTED' : 'FAIL',
  });
  const summary = lastJsonLine(capture.result.stdout.toString('utf8'), 'phase-summary');
  return { ...capture, summary };
}

function stageRecord(capture) {
  return {
    metaPath: capture.metaPath,
    stdoutPath: capture.stdoutPath,
    stderrPath: capture.stderrPath,
    verdict: capture.meta.verdict,
    exitCode: capture.meta.exitCode,
    summaryVerdict: capture.summary && capture.summary.verdict,
  };
}

async function main() {
  const rules = readJson(RULES_PATH);
  if (rules.taskId !== TASK_ID || !Array.isArray(rules.requiredCases) || rules.requiredCases.length !== 8) {
    throw new Error('expected-red rules are not the fixed 025 contract');
  }
  const ledger = {
    version: 'expected-red-ledger-025-v1',
    taskId: TASK_ID,
    runId,
    evidenceRoot,
    fixedOrigin: FIXED_ORIGIN,
    stageOrder: ['baseline', 'mutated', 'restore'],
    cases: [],
    startedAt: nowUtc(),
  };
  const ledgerPath = path.join(evidenceRoot, 'expected-red-ledger.json');
  for (const rule of rules.requiredCases) {
    const baseline = await runStage(rule.caseId, 'baseline', '');
    const mutated = await runStage(rule.caseId, 'mutated', rule.mutation);
    const restore = await runStage(rule.caseId, 'restore', '');
    if (!baseline.summary || baseline.summary.verdict !== 'PASS' || baseline.meta.verdict !== 'PASS' || baseline.meta.exitCode !== 0) {
      throw new Error(rule.caseId + ' baseline did not PASS');
    }
    if (!restore.summary || restore.summary.verdict !== 'PASS' || restore.meta.verdict !== 'PASS' || restore.meta.exitCode !== 0) {
      throw new Error(rule.caseId + ' restore did not PASS');
    }
    const mutationKilled = !!mutated.summary && mutated.summary.verdict === 'REJECTED' &&
      mutated.summary.semanticPass === false && (mutated.meta.verdict === 'REJECTED' || mutated.meta.exitCode !== 0);
    if (!mutationKilled) throw new Error(rule.caseId + ' mutation survived or lacked distinguishable rejection');
    ledger.cases.push({
      caseId: rule.caseId,
      mutation: rule.mutation,
      reason: rule.reason,
      stages: {
        baseline: stageRecord(baseline),
        mutated: stageRecord(mutated),
        restore: stageRecord(restore),
      },
      overall: 'KILLED',
    });
    writeJson(ledgerPath, ledger);
  }
  ledger.killed = ledger.cases.filter((entry) => entry.overall === 'KILLED').length;
  ledger.completedAt = nowUtc();
  ledger.verdict = ledger.killed === 8 ? 'PASS' : 'FAIL';
  writeJson(ledgerPath, ledger);
  for (const entry of ledger.cases) {
    for (const stage of ledger.stageOrder) {
      assertFreshEvidencePath(evidenceRoot, entry.stages[stage].stdoutPath);
      assertFreshEvidencePath(evidenceRoot, entry.stages[stage].stderrPath);
      assertFreshEvidencePath(evidenceRoot, entry.stages[stage].metaPath);
    }
  }
  process.stdout.write(JSON.stringify({ type: 'expected-red-summary', taskId: TASK_ID, runId, evidenceRoot, total: 8, killed: ledger.killed, verdict: ledger.verdict }) + '\n');
  return ledger.verdict === 'PASS' ? 0 : 1;
}

main().then((code) => {
  finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'expected-red-error', message: String(error && error.message || error), stack: String(error && error.stack || '') }) + '\n');
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
