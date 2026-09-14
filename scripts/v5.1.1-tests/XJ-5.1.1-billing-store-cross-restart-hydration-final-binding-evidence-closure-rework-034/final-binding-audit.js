'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, CONTRACT_ID, TASK33, RUN33, AGGREGATE33, CARD33_SHA256, TASK_CARD_SHA256, STORE_SHA256, PROTECTED_MANIFEST_SHA256,
  PROJECT_ROOT, SCRATCH_ROOT, SCRIPTS33, EVIDENCE33, CANDIDATE33,
  ALLOWED_KINDS, EXPECTED_FLAGS,
  sha256Bytes, sha256File, bytesOf, nowUtc, ensureDir, readJson, assertSafeLabel, assertContained,
  canonicalAggregate, walkFiles, installSelfCapture, argValue
} = require('./common-034');

if (!argValue('--binding-dir', '')) {
  process.stderr.write(JSON.stringify({ type: 'audit-error', message: '--binding-dir is required' }) + String.fromCharCode(10));
  process.exitCode = 2;
} else {
  const bindingDir = path.resolve(argValue('--binding-dir', ''));
  const manifestDoc = readJson(path.join(bindingDir, 'final-binding-manifest-034.json'));
  const runId = argValue('--run-id', '') || manifestDoc.runId;
  process.env.XJ_SELF_START_UTC = nowUtc();
  const finalizeSelf = installSelfCapture({ root: SCRATCH_ROOT, runId: runId, toolName: 'final-binding-audit' });
  const selfDir = path.resolve(SCRATCH_ROOT, 'self');

  function fail(message) { throw new Error(message); }

  function allowlistRootFor(kind) {
    switch (kind) {
      case 'evidence-file': return EVIDENCE33;
      case 'harness-source': return SCRIPTS33;
      case 'freeze-self': return selfDir;
      case 'candidate-file': return CANDIDATE33;
      case 'card': return path.resolve(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks');
      case 'store': return path.resolve(PROJECT_ROOT, 'app');
      default: return null;
    }
  }

  function verifySelfTriplet(toolName, expectedRunId) {
    const dir = path.join(selfDir, toolName);
    const metaPath = path.join(dir, 'meta.json');
    for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) {
      if (!fs.existsSync(path.join(dir, name))) fail(toolName + ' self triplet missing ' + name);
    }
    const meta = readJson(metaPath);
    if (meta.taskId !== TASK_ID || meta.runId !== (expectedRunId || runId)) fail(toolName + ' self identity mismatch');
    if (meta.verdict !== 'PASS' || meta.exitCode !== 0) fail(toolName + ' self did not PASS');
    if (String(meta.stdoutSha256).toLowerCase() !== sha256File(path.join(dir, 'stdout.txt')).toLowerCase()) fail(toolName + ' self stdout sha mismatch');
    if (String(meta.stderrSha256).toLowerCase() !== sha256File(path.join(dir, 'stderr.txt')).toLowerCase()) fail(toolName + ' self stderr sha mismatch');
    return meta;
  }

  function verify033Baseline(claim) {
    if (!claim || !claim.checkpoint_a) fail('EXECUTOR_CLAIM missing in 034 scratch');
    const cp = claim.checkpoint_a;
    const files = walkFiles(EVIDENCE33, '', []).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const aggregate = sha256Bytes(JSON.stringify(files.map((f) => ({ rel: f.rel, sha256: f.sha256, bytes: f.bytes }))));
    if (aggregate !== AGGREGATE33) fail('033 evidence aggregate drifted since claim');
    if (files.length !== cp['033_evidence_file_count']) fail('033 evidence file count drifted');
    if (sha256File(path.join(PROJECT_ROOT, 'app/js/store.js')).toLowerCase() !== STORE_SHA256.toLowerCase()) fail('store sha drifted');
    if (sha256File(path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks', TASK_ID + '.md')).toLowerCase() !== TASK_CARD_SHA256.toLowerCase()) fail('034 card sha drifted');
    if (sha256File(path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks', TASK33 + '.md')).toLowerCase() !== CARD33_SHA256.toLowerCase()) fail('033 card sha drifted');
    return { files: files.length, aggregate: aggregate };
  }

  function verifyExpectedRed() {
    const erRoot = path.join(SCRATCH_ROOT, 'expected-red', 'attacks');
    const ids = ['01-delete-033-stage', '02-tamper-033-raw', '03-replace-harness', '04-delete-freeze-stdout', '05-tamper-freeze-stderr', '06-forge-freeze-meta', '07-remove-source-binding', '08-tamper-store', '09-tamper-033-card', '10-forge-flags'];
    const records = [];
    for (const id of ids) {
      const metaPath = path.join(erRoot, id, 'meta.json');
      if (!fs.existsSync(metaPath)) fail('expected-red record missing: ' + id);
      const meta = readJson(metaPath);
      if (meta.taskId !== TASK_ID || meta.attackId !== id) fail('expected-red record identity mismatch: ' + id);
      if (meta.mutatedExit === 0) fail('expected-red mutation survived: ' + id);
      if (meta.restoreExit !== 0) fail('expected-red restore did not PASS: ' + id);
      if (meta.overall !== 'KILLED') fail('expected-red overall not KILLED: ' + id);
      for (const name of ['stdout.txt', 'stderr.txt']) {
        if (!fs.existsSync(path.join(erRoot, id, 'mutated.' + name)) || !fs.existsSync(path.join(erRoot, id, 'restore.' + name))) fail('expected-red raw missing: ' + id + ' ' + name);
      }
      records.push({ attackId: id, mutatedExit: meta.mutatedExit, restoreExit: meta.restoreExit, overall: meta.overall });
    }
    return records;
  }

  async function main() {
    const filesDoc = readJson(path.join(bindingDir, 'final-binding-files-034.json'));
    if (filesDoc.schemaVersion !== 'final-binding-files-034-v1' || manifestDoc.schemaVersion !== 'final-binding-manifest-034-v1') fail('binding schema mismatch');
    if (filesDoc.taskId !== TASK_ID || manifestDoc.taskId !== TASK_ID || manifestDoc.contractId !== CONTRACT_ID || filesDoc.runId !== runId || manifestDoc.runId !== runId) fail('binding identity mismatch');
    if (filesDoc.selfReferenceExcluded !== true || manifestDoc.selfReferenceExcluded !== true) fail('selfReferenceExcluded invalid');
    if (JSON.stringify(manifestDoc.flags) !== JSON.stringify(EXPECTED_FLAGS)) fail('flags misclaim');
    const entries = filesDoc.entries;
    if (!Array.isArray(entries) || entries.length === 0) fail('binding entries missing');
    const seen = new Set();
    for (const entry of entries) {
      if (!ALLOWED_KINDS.has(entry.kind)) fail('unknown kind: ' + entry.kind);
      assertSafeLabel(entry.label);
      const key = entry.kind + '|' + entry.label;
      if (seen.has(key)) fail('duplicate entry: ' + key);
      seen.add(key);
      if (!/^[a-f0-9]{64}$/i.test(entry.sha256) || !Number.isInteger(entry.bytes)) fail('entry field invalid: ' + key);
      if (entry.kind === 'protected-sha') {
        if (entry.sha256.toLowerCase() !== PROTECTED_MANIFEST_SHA256.toLowerCase()) fail('protected sha mismatch');
        continue;
      }
      if (!path.isAbsolute(entry.sourcePath)) fail('entry sourcePath not absolute: ' + key);
      assertContained(allowlistRootFor(entry.kind), entry.sourcePath);
      if (!fs.existsSync(entry.sourcePath) || !fs.statSync(entry.sourcePath).isFile()) fail('entry file missing: ' + key);
      if (sha256File(entry.sourcePath).toLowerCase() !== entry.sha256.toLowerCase()) fail('entry sha mismatch on raw read: ' + key);
      if (bytesOf(entry.sourcePath) !== entry.bytes) fail('entry bytes mismatch on raw read: ' + key);
    }
    const countByKind = {};
    for (const entry of entries) countByKind[entry.kind] = (countByKind[entry.kind] || 0) + 1;
    if (countByKind['evidence-file'] !== 1608 || countByKind['harness-source'] !== 10 || countByKind['freeze-self'] !== 3 || countByKind['candidate-file'] !== 2 || countByKind['card'] !== 2 || countByKind['store'] !== 1 || countByKind['protected-sha'] !== 1) fail('entry counts mismatch');
    const { aggregate } = canonicalAggregate(entries);
    if (aggregate !== filesDoc.aggregateSha256 || aggregate !== manifestDoc.aggregateSha256) fail('aggregate mismatch');

    const claim = readJson(path.join(SCRATCH_ROOT, 'EXECUTOR_CLAIM.json'));
    const baseline = verify033Baseline(claim);
    const records = verifyExpectedRed();
    const selfChecks = {};
    for (const tool of ['final-binding-builder', 'final-binding-verifier', 'expected-red-034']) {
      try { verifySelfTriplet(tool, runId); selfChecks[tool] = 'PASS'; } catch (error) { selfChecks[tool] = 'FAIL:' + error.message; }
    }
    try { verifySelfTriplet('freeze-replica-check', RUN33); selfChecks['freeze-replica-check'] = 'PASS'; } catch (error) { selfChecks['freeze-replica-check'] = 'FAIL:' + error.message; }
    if (Object.values(selfChecks).some((v) => v !== 'PASS')) fail('self triplet verification failed: ' + JSON.stringify(selfChecks));

    process.stdout.write(JSON.stringify({
      type: 'audit-summary',
      taskId: TASK_ID,
      contractId: CONTRACT_ID,
      runId: runId,
      bindingDir: bindingDir,
      entryCount: entries.length,
      aggregateSha256: aggregate,
      '033-input': { evidenceFileCount: baseline.files, aggregate: baseline.aggregate, unchangedSinceClaim: true },
      expectedRed: { total: records.length, killed: records.length, records: records },
      self: selfChecks,
      flags: manifestDoc.flags,
      verdict: 'PASS',
      auditedAt: nowUtc()
    }) + String.fromCharCode(10));
    return 0;
  }

  main().then((code) => {
    finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ type: 'audit-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
    finalizeSelf(1, 'FAIL');
    process.exitCode = 1;
  });
}
