'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, CONTRACT_ID, TASK33, RUN33, AGGREGATE33, CARD33_SHA256, TASK_CARD_SHA256, STORE_SHA256, PROTECTED_MANIFEST_SHA256,
  PROJECT_ROOT, SCRIPT_ROOT, SCRATCH_ROOT, SCRIPTS33, EVIDENCE33, CANDIDATE33, CARD33_PATH, CARD35_PATH, STORE_PATH,
  ORIGINAL_FREEZE_PATH,
  FREEZE33_SHA256,
  sha256Bytes, sha256File, bytesOf, nowUtc, makeRunId, ensureDir, writeJson, readJson,
  canonicalAggregate, installSelfCapture, argValue
} = require('./common-035');

const HARNESS_NAMES = ['common.js', 'fixture-electron.js', 'store-fixture.html', 'phase-worker.js', 'runner.js', 'expected-red.js', 'verifier.js', 'audit.js', 'freeze-verifier.js', 'expected-red.json'];

const runId = argValue('--run-id') || makeRunId();
const bindingDir = ensureDir(path.join(SCRATCH_ROOT, 'binding', runId));
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: SCRATCH_ROOT, runId: runId, toolName: 'final-binding-builder' });

function fail(message) { throw new Error(message); }

function readFreezeMeta() {
  const metaPath = path.join(SCRATCH_ROOT, 'self/freeze-verifier/meta.json');
  if (!fs.existsSync(metaPath)) fail('freeze-verifier meta missing (run exact-freeze-runner first)');
  const meta = readJson(metaPath);
  if (meta.tool !== 'freeze-verifier') fail('freeze meta tool identity mismatch');
  const expected = path.resolve(ORIGINAL_FREEZE_PATH);
  if (path.resolve(meta.capturedFrom || '') !== expected) fail('freeze meta capturedFrom is not the original 033 freeze-verifier');
  if (meta.sourceByteIdentical !== true || meta.exitCode !== 0 || meta.verdict !== 'PASS') fail('freeze meta identity/exit invalid');
  const raw = JSON.stringify(meta).toLowerCase();
  for (const marker of ['replica', 'equivalent', 'executed:false']) {
    if (raw.includes(marker)) fail('freeze meta contains forbidden marker: ' + marker);
  }
  return meta;
}

function buildEntries(freezeMeta) {
  const entries = [];
  const candidateFiles = readJson(path.join(CANDIDATE33, 'candidate-files-033.json'));
  if (!Array.isArray(candidateFiles.files) || candidateFiles.files.length !== 1608) fail('033 candidate file list invalid');
  for (const file of candidateFiles.files) {
    const sourcePath = path.resolve(EVIDENCE33, file.rel);
    if (!fs.existsSync(sourcePath)) fail('evidence file missing: ' + file.rel);
    const actual = { sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) };
    if (actual.sha256.toLowerCase() !== String(file.sha256).toLowerCase() || actual.bytes !== file.bytes) fail('evidence drift: ' + file.rel);
    entries.push({ kind: 'evidence-file', label: 'evidence/' + file.rel, sourcePath: sourcePath, sha256: actual.sha256, bytes: actual.bytes });
  }
  for (const name of HARNESS_NAMES) {
    const sourcePath = path.join(SCRIPTS33, name);
    if (!fs.existsSync(sourcePath)) fail('harness missing: ' + name);
    entries.push({ kind: 'harness-source', label: 'harness/' + name, sourcePath: sourcePath, sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) });
  }
  for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) {
    const sourcePath = path.join(SCRATCH_ROOT, 'self/freeze-verifier', name);
    if (!fs.existsSync(sourcePath)) fail('freeze triplet missing: ' + name);
    entries.push({ kind: 'freeze-self', label: 'self/freeze-verifier/' + name, sourcePath: sourcePath, sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) });
  }
  for (const name of ['candidate-files-033.json', 'candidate-manifest-033.json']) {
    const sourcePath = path.join(CANDIDATE33, name);
    if (!fs.existsSync(sourcePath)) fail('candidate missing: ' + name);
    entries.push({ kind: 'candidate-file', label: 'candidate/' + name, sourcePath: sourcePath, sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) });
  }
  entries.push({ kind: 'card', label: 'card/033', sourcePath: CARD33_PATH, sha256: sha256File(CARD33_PATH), bytes: bytesOf(CARD33_PATH) });
  entries.push({ kind: 'card', label: 'card/035', sourcePath: CARD35_PATH, sha256: sha256File(CARD35_PATH), bytes: bytesOf(CARD35_PATH) });
  entries.push({ kind: 'store', label: 'store/store.js', sourcePath: STORE_PATH, sha256: sha256File(STORE_PATH), bytes: bytesOf(STORE_PATH) });
  entries.push({ kind: 'protected-sha', label: 'protected/manifest-sha256', sourcePath: 'constant:protected-files-manifest-sha256', sha256: PROTECTED_MANIFEST_SHA256.toLowerCase(), bytes: 64 });
  const seen = new Set();
  for (const entry of entries) {
    const key = entry.kind + '|' + entry.label;
    if (seen.has(key)) fail('duplicate entry: ' + key);
    seen.add(key);
  }
  return entries;
}

function verifyConstants(entries) {
  const storeEntry = entries.find((e) => e.label === 'store/store.js');
  const card33 = entries.find((e) => e.label === 'card/033');
  const card35 = entries.find((e) => e.label === 'card/035');
  const prot = entries.find((e) => e.label === 'protected/manifest-sha256');
  if (storeEntry.sha256.toLowerCase() !== STORE_SHA256.toLowerCase()) fail('store sha mismatch');
  if (card33.sha256.toLowerCase() !== CARD33_SHA256.toLowerCase()) fail('033 card sha mismatch');
  if (card35.sha256.toLowerCase() !== TASK_CARD_SHA256.toLowerCase()) fail('035 card sha mismatch');
  if (prot.sha256.toLowerCase() !== PROTECTED_MANIFEST_SHA256.toLowerCase()) fail('protected sha mismatch');
}

async function main() {
  const freezeMeta = readFreezeMeta();
  const entries = buildEntries(freezeMeta);
  verifyConstants(entries);
  const { aggregate, input, sorted } = canonicalAggregate(entries);
  const filesPath = path.join(bindingDir, 'final-binding-files-035.json');
  const manifestPath = path.join(bindingDir, 'final-binding-manifest-035.json');
  const filesDoc = {
    schemaVersion: 'final-binding-files-035-v1',
    selfReferenceExcluded: true,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    runId: runId,
    entryCount: entries.length,
    aggregateSha256: aggregate,
    aggregateInput: input,
    entries: sorted
  };
  writeJson(filesPath, filesDoc);
  const countByKind = {};
  for (const entry of entries) countByKind[entry.kind] = (countByKind[entry.kind] || 0) + 1;
  const harness = HARNESS_NAMES.map((name) => {
    const entry = entries.find((e) => e.label === 'harness/' + name);
    return { name: name, sha256: entry.sha256, bytes: entry.bytes };
  });
  const manifestDoc = {
    schemaVersion: 'final-binding-manifest-035-v1',
    selfReferenceExcluded: true,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    baseCommit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
    runId: runId,
    bindingDir: bindingDir,
    filesPath: filesPath,
    aggregateSha256: aggregate,
    entryCount: entries.length,
    objects: countByKind,
    metadata: {
      '033-run-id': RUN33,
      '033-aggregate': AGGREGATE33,
      '033-card-sha': CARD33_SHA256.toUpperCase(),
      '035-card-sha': TASK_CARD_SHA256.toUpperCase(),
      'store-sha': STORE_SHA256.toUpperCase(),
      'protected-manifest-sha': PROTECTED_MANIFEST_SHA256.toUpperCase(),
      '033-candidate-files-sha': sha256File(path.join(CANDIDATE33, 'candidate-files-033.json')),
      '033-candidate-manifest-sha': sha256File(path.join(CANDIDATE33, 'candidate-manifest-033.json'))
    },
    harness: harness,
    freezeCapture: {
      tool: freezeMeta.tool,
      capturedFrom: freezeMeta.capturedFrom,
      command: freezeMeta.command,
      argv: freezeMeta.argv,
      nodeOptions: freezeMeta.nodeOptions,
      cwd: freezeMeta.cwd,
      startUtc: freezeMeta.startUtc,
      endUtc: freezeMeta.endUtc,
      exitCode: freezeMeta.exitCode,
      verdict: freezeMeta.verdict,
      executedSourceSha256: freezeMeta.executedSourceSha256,
      executedSourceBytes: freezeMeta.executedSourceBytes,
      sourceByteIdentical: freezeMeta.sourceByteIdentical,
      executedCommonSha256: freezeMeta.executedCommonSha256,
      hookPath: freezeMeta.hookPath,
      hookSha256: freezeMeta.hookSha256,
      hookBytes: freezeMeta.hookBytes,
      redirectRoot: freezeMeta.redirectRoot,
      mapping: freezeMeta.mapping,
      isolationOutputs: freezeMeta.isolationOutputs,
      childSelfTriplet: freezeMeta.childSelfTriplet,
      prePostEqual: freezeMeta.prePostEqual,
      stdoutSha256: freezeMeta.stdoutSha256,
      stderrSha256: freezeMeta.stderrSha256,
      stdoutBytes: freezeMeta.stdoutBytes,
      stderrBytes: freezeMeta.stderrBytes,
      summary: freezeMeta.summary,
      exactSourceIdentity: true
    },
    flags: { createdLocal: true, releaseReady: false, publishAuthorized: false, released: false },
    generatedAt: nowUtc()
  };
  writeJson(manifestPath, manifestDoc);
  process.stdout.write(JSON.stringify({
    type: 'builder-summary',
    taskId: TASK_ID,
    runId: runId,
    bindingDir: bindingDir,
    entryCount: entries.length,
    aggregateSha256: aggregate,
    freezeSourceSha256: freezeMeta.executedSourceSha256,
    freezeIdentity: freezeMeta.sourceByteIdentical,
    verdict: 'PASS'
  }) + String.fromCharCode(10));
  return 0;
}

main().then((code) => {
  finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'builder-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
