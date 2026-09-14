'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID,
  CONTRACT_ID,
  PROJECT_ROOT,
  SCRATCH_ROOT,
  FIXED_ORIGIN,
  BASE_COMMIT,
  TASK_CARD_SHA256,
  ensureFreshEvidenceRoot,
  readJson,
  writeJson,
  sha256Bytes,
  sha256File,
  nowUtc,
  lastJsonLine,
  assertMetaShape,
  assertFreshEvidencePath,
  installSelfCapture
} = require('./common');

const EXPECTED_STORE_SHA = '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const rootArg = argValue('--evidence-root', '');
if (!rootArg) {
  process.stderr.write(JSON.stringify({ type: 'freeze-error', message: '--evidence-root is required' }) + String.fromCharCode(10));
  process.exitCode = 2;
} else {
  const evidenceRoot = ensureFreshEvidenceRoot(rootArg);
  const manifest = readJson(path.join(evidenceRoot, 'run-manifest.json'));
  const runId = argValue('--run-id', '') || manifest.runId;
  const candidateDir = ensureFreshEvidenceRoot(path.join(SCRATCH_ROOT, 'candidate', runId));
  process.env.XJ_SELF_START_UTC = nowUtc();
  const finalizeSelf = installSelfCapture({ root: candidateDir, runId: runId, toolName: 'freeze-verifier' });

  function fail(message) { throw new Error(message); }

  function walkFiles(dir, out, relPrefix) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = relPrefix ? relPrefix + '/' + name : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) fail('symbolic link inside evidence root: ' + abs);
      if (st.isDirectory()) walkFiles(abs, out, rel);
      else if (st.isFile()) out.push({ rel: rel, path: abs, bytes: st.size, sha256: sha256File(abs) });
    }
    return out;
  }

  function verifyStage(caseId, stage, expectedVerdict) {
    const dir = path.join(evidenceRoot, 'cases', caseId, stage);
    for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) {
      if (!fs.existsSync(path.join(dir, name))) fail(caseId + '/' + stage + ' missing ' + name);
    }
    const meta = readJson(path.join(dir, 'meta.json'));
    assertMetaShape(meta, evidenceRoot, { runId: runId, caseId: caseId, stage: stage });
    const summary = lastJsonLine(fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8'), 'phase-summary');
    if (!summary || summary.verdict !== expectedVerdict || summary.runId !== runId || summary.caseId !== caseId || summary.stage !== stage) {
      fail(caseId + '/' + stage + ' phase-summary contract mismatch');
    }
    if (expectedVerdict === 'PASS') {
      if (meta.verdict !== 'PASS' || meta.exitCode !== 0) fail(caseId + '/' + stage + ' PASS contract mismatch');
    } else {
      if (meta.verdict !== 'REJECTED' || meta.exitCode !== 2) fail(caseId + '/' + stage + ' REJECTED contract mismatch');
    }
    return meta;
  }

  function verifySelfTriplet(toolName) {
    const dir = path.join(evidenceRoot, 'self', toolName);
    for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) {
      if (!fs.existsSync(path.join(dir, name))) fail(toolName + ' self missing ' + name);
    }
    const meta = readJson(path.join(dir, 'meta.json'));
    assertMetaShape(meta, evidenceRoot, { runId: runId, caseId: '__self__', stage: toolName });
    if (meta.verdict !== 'PASS' || meta.exitCode !== 0) fail(toolName + ' self did not PASS');
    return meta;
  }

  function gitStatusSubset(claimStatus, markers) {
    const lines = String(claimStatus || '').split(/\r?\n/).filter((line) => line.trim());
    return lines.filter((line) => markers.some((m) => line.includes(m))).sort();
  }

  async function currentGitStatus() {
    const { execSync } = require('child_process');
    try {
      return execSync('git status --short', { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      return String((error && error.stdout) || '');
    }
  }

  async function main() {
    const storePath = path.join(PROJECT_ROOT, 'app/js/store.js');
    if (sha256File(storePath).toLowerCase() !== EXPECTED_STORE_SHA.toLowerCase()) fail('production Store SHA drifted');
    if (sha256File(storePath).toLowerCase() !== String(manifest.productionStoreSha256 || '').toLowerCase()) fail('production Store SHA drifted from manifest');
    if (manifest.taskId !== TASK_ID || manifest.contractId !== CONTRACT_ID || manifest.runId !== runId || manifest.evidenceRoot !== evidenceRoot || manifest.fixedOrigin !== FIXED_ORIGIN || manifest.baseCommit !== BASE_COMMIT) fail('run manifest identity mismatch');
    if (String(manifest.taskCardSha256 || '').toUpperCase() !== TASK_CARD_SHA256) fail('task card hash mismatch');

    const ledger = readJson(path.join(evidenceRoot, 'expected-red-ledger.json'));
    if (ledger.taskId !== TASK_ID || ledger.runId !== runId || !Array.isArray(ledger.cases) || ledger.cases.length !== 8 || ledger.killed !== 8 || ledger.verdict !== 'PASS') fail('expected-red ledger invalid');

    let stageCount = 0;
    for (const entry of ledger.cases) {
      for (const stage of ['baseline', 'mutated', 'restore']) {
        verifyStage(entry.caseId, stage, stage === 'mutated' ? 'REJECTED' : 'PASS');
        stageCount++;
      }
    }
    if (stageCount !== 24) fail('expected 24 stages, got ' + stageCount);

    for (const tool of ['runner', 'expected-red', 'verifier', 'audit']) verifySelfTriplet(tool);
    const auditSummary = lastJsonLine(fs.readFileSync(path.join(evidenceRoot, 'self/audit/stdout.txt'), 'utf8'), 'audit-summary');
    if (!auditSummary || auditSummary.verdict !== 'PASS' || auditSummary.killed !== 10 || auditSummary.probesOk !== 8) fail('audit summary did not PASS');
    const verifierSummary = lastJsonLine(fs.readFileSync(path.join(evidenceRoot, 'self/verifier/stdout.txt'), 'utf8'), 'verifier-summary');
    if (!verifierSummary || verifierSummary.verdict !== 'PASS' || verifierSummary.checkedStages !== 24) fail('verifier summary did not PASS');

    const claim = readJson(path.join(SCRATCH_ROOT, 'EXECUTOR_CLAIM.json'));
    const legacyMarkers = ['billing-store-cross-restart-hydration-exit-binding-codex-subagent-escalation-029', 'no-context-independent-review-031', 'canonical-evidence-rebuild-032', 'canonical-evidence-032'];
    const claimSubset = gitStatusSubset(claim.checkpoint_a && claim.checkpoint_a.git_status_short, legacyMarkers.concat(['store.js']));
    const currentStatus = await currentGitStatus();
    const currentSubset = gitStatusSubset(currentStatus, legacyMarkers.concat(['store.js']));
    const historicalDrift = JSON.stringify(claimSubset) !== JSON.stringify(currentSubset);
    if (historicalDrift) fail('historical/production path drift detected between claim snapshot and freeze time: ' + JSON.stringify({ claimSubset: claimSubset, currentSubset: currentSubset }));

    const files = walkFiles(evidenceRoot, [], '');
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const hashInput = JSON.stringify(files.map((f) => ({ rel: f.rel, sha256: f.sha256, bytes: f.bytes })));
    const aggregateSha256 = sha256Bytes(hashInput);

    const candidateFiles = {
      taskId: TASK_ID,
      runId: runId,
      evidenceRoot: evidenceRoot,
      generatedAt: nowUtc(),
      fileCount: files.length,
      aggregateSha256: aggregateSha256,
      files: files
    };
    const candidateManifest = {
      taskId: TASK_ID,
      contractId: CONTRACT_ID,
      baseCommit: BASE_COMMIT,
      runId: runId,
      evidenceRoot: evidenceRoot,
      candidateFiles: path.join(candidateDir, 'candidate-files-033.json'),
      candidateManifest: path.join(candidateDir, 'candidate-manifest-033.json'),
      aggregateSha256: aggregateSha256,
      storeSha256: EXPECTED_STORE_SHA,
      cardSha256: TASK_CARD_SHA256,
      flags: {
        createdLocal: true,
        releaseReady: false,
        publishAuthorized: false,
        released: false
      },
      verification: {
        stagesVerified: stageCount,
        selfTriplets: ['runner', 'expected-red', 'verifier', 'audit', 'freeze-verifier'],
        auditKilled: 10,
        auditProbes: 8,
        historicalZeroWrite: true,
        productionStoreReadOnly: true
      },
      generatedAt: nowUtc()
    };
    writeJson(path.join(candidateDir, 'candidate-files-033.json'), candidateFiles);
    writeJson(path.join(candidateDir, 'candidate-manifest-033.json'), candidateManifest);
    process.stdout.write(JSON.stringify({
      type: 'freeze-summary',
      taskId: TASK_ID,
      runId: runId,
      evidenceRoot: evidenceRoot,
      candidateDir: candidateDir,
      fileCount: files.length,
      aggregateSha256: aggregateSha256,
      flags: candidateManifest.flags,
      verdict: 'PASS'
    }) + String.fromCharCode(10));
    return 0;
  }

  main().then((code) => {
    finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ type: 'freeze-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
    finalizeSelf(1, 'FAIL');
    process.exitCode = 1;
  });
}
