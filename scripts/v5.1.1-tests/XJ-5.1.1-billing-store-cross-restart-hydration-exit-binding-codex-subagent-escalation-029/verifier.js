'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID,
  CONTRACT_ID,
  BASE_COMMIT,
  PROJECT_ROOT,
  SCRIPT_ROOT,
  FIXED_ORIGIN,
  ensureFreshEvidenceRoot,
  readJson,
  sha256File,
  nowUtc,
  lastJsonLine,
  assertMetaShape,
  assertFreshEvidencePath,
  installSelfCapture,
} = require('./common');

const EXPECTED_META_KEYS = new Set(['runId', 'caseId', 'stage', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stderrSha256', 'stdoutBytes', 'stderrBytes', 'verdict']);
const TASK_CARD_SHA256 = '7CBB06126816218494E99127E9B33245FBD9E95FEE163D27158B01304B86604E';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const rootArg = argValue('--evidence-root', '');
if (!rootArg) {
  process.stderr.write(JSON.stringify({ type: 'verifier-error', message: '--evidence-root is required' }) + '\n');
  process.exitCode = 2;
} else {
  const evidenceRoot = ensureFreshEvidenceRoot(rootArg);
  const runIdArg = argValue('--run-id', '');
  process.env.XJ_SELF_START_UTC = nowUtc();
  const finalizeSelf = installSelfCapture({ root: evidenceRoot, runId: runIdArg || 'run-029-unknown', toolName: 'verifier' });

  function fail(message) { throw new Error(message); }

  function exactPath(expected, actual, label) {
    if (path.resolve(actual) !== path.resolve(expected)) fail(label + ' path is not stage-bound');
    return assertFreshEvidencePath(evidenceRoot, actual);
  }

  function verifySelf(toolName, runId) {
    const dir = path.join(evidenceRoot, 'self', toolName);
    const metaPath = path.join(dir, 'meta.json');
    const stdoutPath = path.join(dir, 'stdout.txt');
    const stderrPath = path.join(dir, 'stderr.txt');
    if (!fs.existsSync(metaPath) || !fs.existsSync(stdoutPath) || !fs.existsSync(stderrPath)) fail(toolName + ' self raw/meta missing');
    const meta = readJson(metaPath);
    assertMetaShape(meta, evidenceRoot, { runId, caseId: '__self__', stage: toolName });
    exactPath(stdoutPath, meta.stdoutPath, toolName + ' stdout');
    exactPath(stderrPath, meta.stderrPath, toolName + ' stderr');
    if (meta.verdict !== 'PASS' || meta.exitCode !== 0) fail(toolName + ' self did not PASS');
    return meta;
  }

  function verifyPhaseSummary(summary, runId, caseId, stage) {
    if (!summary || typeof summary !== 'object') fail(caseId + '/' + stage + ' phase-summary missing');
    if (summary.type !== 'phase-summary' || summary.runId !== runId || summary.caseId !== caseId || summary.stage !== stage) {
      fail(caseId + '/' + stage + ' phase-summary identity mismatch');
    }
    if (summary.fixedOrigin !== FIXED_ORIGIN || summary.denyNetwork !== true) fail(caseId + '/' + stage + ' origin/network contract mismatch');
    if (!summary.writer || !summary.reader || !summary.writerContext || !summary.readerContext) fail(caseId + '/' + stage + ' child closure missing');
    if (!Number.isInteger(summary.writer.exitCode) || !Number.isInteger(summary.reader.exitCode)) fail(caseId + '/' + stage + ' child exit missing');
    if (typeof summary.writer.stdout !== 'string' || typeof summary.writer.stderr !== 'string' || typeof summary.reader.stdout !== 'string' || typeof summary.reader.stderr !== 'string') {
      fail(caseId + '/' + stage + ' child raw closure missing');
    }
    if (!summary.writerContext.userData || !summary.readerContext.userData || !summary.writerContext.origin || !summary.readerContext.origin) fail(caseId + '/' + stage + ' child contexts missing');
    return summary;
  }

  function verifyStage(runId, caseId, stage, expectedVerdict) {
    const dir = path.join(evidenceRoot, 'cases', caseId, stage);
    const metaPath = path.join(dir, 'meta.json');
    const stdoutPath = path.join(dir, 'stdout.txt');
    const stderrPath = path.join(dir, 'stderr.txt');
    if (!fs.existsSync(metaPath) || !fs.existsSync(stdoutPath) || !fs.existsSync(stderrPath)) fail(caseId + '/' + stage + ' raw/meta triplet missing');
    const meta = readJson(metaPath);
    if (Object.keys(meta).some((key) => !EXPECTED_META_KEYS.has(key))) fail(caseId + '/' + stage + ' metadata has unknown field');
    assertMetaShape(meta, evidenceRoot, { runId, caseId, stage });
    exactPath(stdoutPath, meta.stdoutPath, caseId + '/' + stage + ' stdout');
    exactPath(stderrPath, meta.stderrPath, caseId + '/' + stage + ' stderr');
    const summary = verifyPhaseSummary(lastJsonLine(fs.readFileSync(stdoutPath, 'utf8'), 'phase-summary'), runId, caseId, stage);
    if (summary.verdict !== expectedVerdict) fail(caseId + '/' + stage + ' summary verdict expected ' + expectedVerdict + ' got ' + summary.verdict);
    if (expectedVerdict === 'PASS') {
      if (meta.verdict !== 'PASS' || meta.exitCode !== 0 || summary.semanticPass !== true) fail(caseId + '/' + stage + ' PASS closure invalid');
      if (!summary.reader.result || summary.reader.result.ok !== true || !summary.reader.result.counts || summary.reader.result.counts.clients !== 1 || summary.reader.result.counts.sessions < 1 || summary.reader.result.counts.monthlyPayments !== 1 || summary.reader.result.counts.amount !== 520) {
        fail(caseId + '/' + stage + ' hydrated billing metrics invalid');
      }
      if (summary.writer.result && summary.writer.result.forceExit === true) fail(caseId + '/' + stage + ' graceful writer was force-exited');
      if (summary.writer.exitCode !== 0 || summary.reader.exitCode !== 0) fail(caseId + '/' + stage + ' PASS child exit invalid');
    } else {
      if (summary.semanticPass === true) fail(caseId + '/' + stage + ' mutation survived with semanticPass=true');
      if (summary.reader.result && summary.reader.result.ok === true) fail(caseId + '/' + stage + ' mutation contains forged reader ok:true');
      if (meta.verdict !== 'REJECTED' || meta.exitCode === 0) fail(caseId + '/' + stage + ' mutation must be REJECTED with a real non-zero exit');
      if (summary.verdict !== 'REJECTED') fail(caseId + '/' + stage + ' mutation summary verdict is not REJECTED');
    }
    return { metaPath, stdoutPath, stderrPath, meta, summary };
  }

  function verifyToolStage(runId, toolName) {
    const dir = path.join(evidenceRoot, 'cases', '__tools__', toolName);
    const metaPath = path.join(dir, 'meta.json');
    const stdoutPath = path.join(dir, 'stdout.txt');
    const stderrPath = path.join(dir, 'stderr.txt');
    if (!fs.existsSync(metaPath) || !fs.existsSync(stdoutPath) || !fs.existsSync(stderrPath)) fail(toolName + ' tool raw/meta triplet missing');
    const meta = readJson(metaPath);
    assertMetaShape(meta, evidenceRoot, { runId, caseId: '__tools__', stage: toolName });
    exactPath(stdoutPath, meta.stdoutPath, toolName + ' tool stdout');
    exactPath(stderrPath, meta.stderrPath, toolName + ' tool stderr');
    if (meta.verdict !== 'PASS' || meta.exitCode !== 0) fail(toolName + ' tool did not PASS');
    return { metaPath, stdoutPath, stderrPath, meta };
  }

  function verifyLedger(runId) {
    const ledgerPath = path.join(evidenceRoot, 'expected-red-ledger.json');
    if (!fs.existsSync(ledgerPath)) fail('expected-red ledger missing');
    const ledger = readJson(ledgerPath);
    if (ledger.version !== 'expected-red-ledger-029-v1' || ledger.taskId !== TASK_ID || ledger.runId !== runId || ledger.evidenceRoot !== evidenceRoot || ledger.fixedOrigin !== FIXED_ORIGIN) fail('expected-red ledger identity mismatch');
    if (!Array.isArray(ledger.cases) || ledger.cases.length !== 8 || ledger.killed !== 8 || ledger.verdict !== 'PASS') fail('expected-red ledger aggregate invalid');
    const seen = new Set();
    const stagePaths = [];
    for (const entry of ledger.cases) {
      if (!entry || typeof entry.caseId !== 'string' || typeof entry.mutation !== 'string' || entry.overall !== 'KILLED' || seen.has(entry.caseId)) fail('expected-red ledger case identity invalid');
      seen.add(entry.caseId);
      if (!entry.stages || !entry.stages.baseline || !entry.stages.mutated || !entry.stages.restore) fail(entry.caseId + ' stage ledger incomplete');
      for (const stage of ['baseline', 'mutated', 'restore']) {
        const record = entry.stages[stage];
        if (typeof record.metaPath !== 'string' || typeof record.stdoutPath !== 'string' || typeof record.stderrPath !== 'string') fail(entry.caseId + '/' + stage + ' ledger paths missing');
        const verified = verifyStage(runId, entry.caseId, stage, stage === 'mutated' ? 'REJECTED' : 'PASS');
        if (path.resolve(record.metaPath) !== path.resolve(verified.metaPath) || path.resolve(record.stdoutPath) !== path.resolve(verified.stdoutPath) || path.resolve(record.stderrPath) !== path.resolve(verified.stderrPath)) fail(entry.caseId + '/' + stage + ' ledger path mismatch');
        const meta = verified.meta;
        for (const field of ['command', 'cwd', 'startUtc', 'endUtc', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stderrSha256', 'stdoutBytes', 'stderrBytes', 'verdict']) {
          if (record[field] !== meta[field]) fail(entry.caseId + '/' + stage + ' ledger field mismatch: ' + field);
        }
        if (!Array.isArray(record.argv) || JSON.stringify(record.argv) !== JSON.stringify(meta.argv)) fail(entry.caseId + '/' + stage + ' ledger argv mismatch');
        if (record.exitCode !== meta.exitCode) fail(entry.caseId + '/' + stage + ' ledger exitCode mismatch');
        if (!record.meta || JSON.stringify(record.meta) !== JSON.stringify(meta)) fail(entry.caseId + '/' + stage + ' ledger meta snapshot mismatch');
        stagePaths.push(verified.stdoutPath, verified.stderrPath, verified.metaPath);
      }
    }
    if (seen.size !== 8 || new Set(stagePaths).size !== stagePaths.length) fail('expected-red stage paths are not unique');
    return ledger;
  }

  async function main() {
    const manifestPath = path.join(evidenceRoot, 'run-manifest.json');
    if (!fs.existsSync(manifestPath)) fail('run manifest missing');
    const manifest = readJson(manifestPath);
    const runId = runIdArg || manifest.runId;
    if (manifest.taskId !== TASK_ID || manifest.contractId !== CONTRACT_ID || manifest.runId !== runId || manifest.evidenceRoot !== evidenceRoot || manifest.fixedOrigin !== FIXED_ORIGIN || manifest.baseCommit !== BASE_COMMIT || manifest.syntheticDataOnly !== true) fail('run manifest identity mismatch');
    if (String(manifest.taskCardSha256 || '').toUpperCase() !== TASK_CARD_SHA256) fail('task card hash mismatch');
    if (!manifest.canonicalInput || manifest.canonicalInput.readOnly !== true || typeof manifest.canonicalInput.root !== 'string' || typeof manifest.canonicalInput.runManifestPath !== 'string' || typeof manifest.canonicalInput.expectedRedLedgerPath !== 'string') fail('canonical input binding missing');
    if (!fs.existsSync(manifest.canonicalInput.runManifestPath) || !fs.existsSync(manifest.canonicalInput.expectedRedLedgerPath)) fail('canonical input files missing');
    if (path.resolve(manifest.canonicalInput.root).indexOf(path.resolve(PROJECT_ROOT, 'qa/task-scratch/XJ-5.1.1-billing-store-cross-restart-hydration-evidence-harness-codex-subagent-025')) !== 0) fail('canonical input root escaped 025 read-only root');
    if (String(manifest.canonicalInput.runManifestSha256 || '').toLowerCase() !== sha256File(manifest.canonicalInput.runManifestPath).toLowerCase()) fail('canonical run manifest SHA mismatch');
    if (String(manifest.canonicalInput.expectedRedLedgerSha256 || '').toLowerCase() !== sha256File(manifest.canonicalInput.expectedRedLedgerPath).toLowerCase()) fail('canonical expected-red ledger SHA mismatch');
    const storePath = path.join(PROJECT_ROOT, 'app/js/store.js');
    if (manifest.productionStoreSha256 !== sha256File(storePath)) fail('production Store SHA drifted from evidence manifest');
    const core = verifyStage(runId, 'core', 'core', 'PASS');
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(core.summary.productionAcceptanceListen0Origin || '')) || core.summary.productionAcceptanceListen0Origin === FIXED_ORIGIN) fail('production acceptance listen(0) origin observation missing or mixed with fixed origin');
    if (core.summary.writerContext.origin !== FIXED_ORIGIN || core.summary.readerContext.origin !== FIXED_ORIGIN || path.resolve(core.summary.writerContext.userData) !== path.resolve(core.summary.readerContext.userData)) fail('core writer/reader context did not stay same-origin/same-userData');
    const ledger = verifyLedger(runId);
    const tool = verifyToolStage(runId, 'expected-red');
    const expectedSummary = lastJsonLine(fs.readFileSync(tool.stdoutPath, 'utf8'), 'expected-red-summary');
    if (!expectedSummary || expectedSummary.runId !== runId || expectedSummary.killed !== 8 || expectedSummary.mutatedNonZero !== 8 || expectedSummary.verdict !== 'PASS') fail('expected-red tool summary invalid');
    verifySelf('runner', runId);
    verifySelf('expected-red', runId);
    process.stdout.write(JSON.stringify({ type: 'verifier-summary', taskId: TASK_ID, contractId: CONTRACT_ID, runId, evidenceRoot, checkedCases: ledger.cases.length, checkedStages: ledger.cases.length * 3 + 2, self: { runner: 'PASS', expectedRed: 'PASS', verifier: 'CAPTURED_ON_EXIT' }, verdict: 'PASS', verifiedAt: nowUtc() }) + '\n');
    return 0;
  }

  main().then((code) => {
    finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ type: 'verifier-error', message: String(error && error.message || error), stack: String(error && error.stack || '') }) + '\n');
    finalizeSelf(1, 'FAIL');
    process.exitCode = 1;
  });
}
