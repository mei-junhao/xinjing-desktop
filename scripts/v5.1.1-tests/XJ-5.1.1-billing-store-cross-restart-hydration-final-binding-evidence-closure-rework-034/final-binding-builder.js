'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, CONTRACT_ID, TASK33, RUN33, AGGREGATE33, CARD33_SHA256, TASK_CARD_SHA256, STORE_SHA256, PROTECTED_MANIFEST_SHA256,
  PROJECT_ROOT, SCRIPT_ROOT, SCRATCH_ROOT, SCRIPTS33, EVIDENCE33, CANDIDATE33, CARD33_PATH, CARD34_PATH, STORE_PATH,
  sha256Bytes, sha256File, bytesOf, nowUtc, randomNonce, makeRunId, ensureDir, writeJson, readJson,
  canonicalAggregate, runChild, installSelfCapture, argValue
} = require('./common-034');

const HARNESS_NAMES = ['common.js', 'fixture-electron.js', 'store-fixture.html', 'phase-worker.js', 'runner.js', 'expected-red.js', 'verifier.js', 'audit.js', 'freeze-verifier.js', 'expected-red.json'];
const FREEZE_REPLICA = path.join(SCRIPT_ROOT, 'freeze-replica-check.js');

const runId = argValue('--run-id') || makeRunId();
const bindingDir = ensureDir(path.join(SCRATCH_ROOT, 'binding', runId));
const selfDir = ensureDir(path.join(SCRATCH_ROOT, 'self'));
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: SCRATCH_ROOT, runId: runId, toolName: 'final-binding-builder' });

function fail(message) { throw new Error(message); }

async function captureFreezeTriplet() {
  const selfRoot = SCRATCH_ROOT;
  const argv = [FREEZE_REPLICA, '--run-id', RUN33, '--self-root', selfRoot];
  const startUtc = nowUtc();
  const child = await runChild(process.execPath, argv, { cwd: PROJECT_ROOT });
  const endUtc = nowUtc();
  const dir = ensureDir(path.join(selfDir, 'freeze-verifier'));
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const metaPath = path.join(dir, 'meta.json');
  fs.writeFileSync(stdoutPath, child.stdout);
  fs.writeFileSync(stderrPath, child.stderr);
  const meta = {
    taskId: TASK_ID,
    runId: runId,
    tool: 'freeze-verifier',
    capturedFrom: FREEZE_REPLICA,
    command: process.execPath,
    argv: argv.map(String),
    cwd: PROJECT_ROOT,
    startUtc: startUtc,
    endUtc: endUtc,
    exitCode: child.exitCode,
    verdict: child.exitCode === 0 ? 'PASS' : 'FAIL',
    stdoutPath: path.resolve(stdoutPath),
    stderrPath: path.resolve(stderrPath),
    metaPath: path.resolve(metaPath),
    stdoutSha256: sha256File(stdoutPath),
    stderrSha256: sha256File(stderrPath),
    stdoutBytes: bytesOf(stdoutPath),
    stderrBytes: bytesOf(stderrPath),
    summary: JSON.parse(fs.readFileSync(stdoutPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() && l.indexOf('freeze-summary') >= 0).pop() || '{}')
  };
  writeJson(metaPath, meta);
  return meta;
}

function archiveIsolates() {
  const isoDir = ensureDir(path.join(SCRIPT_ROOT, 'isolated'));
  const copies = [];
  const sources = [
    { name: '033-freeze-verifier.js', src: path.join(SCRIPTS33, 'freeze-verifier.js') },
    { name: '033-common.js', src: path.join(SCRIPTS33, 'common.js') }
  ];
  for (const item of sources) {
    const dst = path.join(isoDir, item.name);
    fs.copyFileSync(item.src, dst);
    copies.push({
      file: item.name,
      sourcePath: item.src,
      sourceSha256: sha256File(item.src),
      sourceBytes: bytesOf(item.src),
      copySha256: sha256File(dst),
      copyBytes: bytesOf(dst),
      copiedForIsolation: true,
      executed: false,
      note: 'byte-identical archive; NOT executed because 033 freeze-verifier has no safe read-only mode and its SCRATCH_ROOT is 033-bound'
    });
  }
  return copies;
}

function buildEntries(freezeMeta) {
  const entries = [];
  const candidateFiles = readJson(path.join(CANDIDATE33, 'candidate-files-033.json'));
  if (!Array.isArray(candidateFiles.files) || candidateFiles.files.length !== 1608) fail('033 candidate file list invalid');
  for (const file of candidateFiles.files) {
    const sourcePath = path.resolve(EVIDENCE33, file.rel);
    if (!fs.existsSync(sourcePath)) fail('evidence file missing on disk: ' + sourcePath);
    const actual = { sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) };
    if (actual.sha256.toLowerCase() !== String(file.sha256).toLowerCase() || actual.bytes !== file.bytes) fail('evidence file drift: ' + file.rel);
    entries.push({ kind: 'evidence-file', label: 'evidence/' + file.rel, sourcePath: sourcePath, sha256: actual.sha256, bytes: actual.bytes });
  }
  for (const name of HARNESS_NAMES) {
    const sourcePath = path.join(SCRIPTS33, name);
    if (!fs.existsSync(sourcePath)) fail('harness file missing: ' + name);
    entries.push({ kind: 'harness-source', label: 'harness/' + name, sourcePath: sourcePath, sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) });
  }
  for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) {
    const sourcePath = path.join(selfDir, 'freeze-verifier', name);
    if (!fs.existsSync(sourcePath)) fail('freeze triplet missing: ' + name);
    entries.push({ kind: 'freeze-self', label: 'self/freeze-verifier/' + name, sourcePath: sourcePath, sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) });
  }
  for (const name of ['candidate-files-033.json', 'candidate-manifest-033.json']) {
    const sourcePath = path.join(CANDIDATE33, name);
    if (!fs.existsSync(sourcePath)) fail('candidate file missing: ' + name);
    entries.push({ kind: 'candidate-file', label: 'candidate/' + name, sourcePath: sourcePath, sha256: sha256File(sourcePath), bytes: bytesOf(sourcePath) });
  }
  entries.push({ kind: 'card', label: 'card/033', sourcePath: CARD33_PATH, sha256: sha256File(CARD33_PATH), bytes: bytesOf(CARD33_PATH) });
  entries.push({ kind: 'card', label: 'card/034', sourcePath: CARD34_PATH, sha256: sha256File(CARD34_PATH), bytes: bytesOf(CARD34_PATH) });
  entries.push({ kind: 'store', label: 'store/store.js', sourcePath: STORE_PATH, sha256: sha256File(STORE_PATH), bytes: bytesOf(STORE_PATH) });
  entries.push({ kind: 'protected-sha', label: 'protected/manifest-sha256', sourcePath: 'constant:protected-files-manifest-sha256', sha256: PROTECTED_MANIFEST_SHA256.toLowerCase(), bytes: 64 });
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.kind + '|' + entry.label)) fail('duplicate entry: ' + entry.kind + ' ' + entry.label);
    seen.add(entry.kind + '|' + entry.label);
  }
  return entries;
}

function verifyConstants(entries) {
  const storeEntry = entries.find((e) => e.label === 'store/store.js');
  const card33 = entries.find((e) => e.label === 'card/033');
  const card34 = entries.find((e) => e.label === 'card/034');
  const prot = entries.find((e) => e.label === 'protected/manifest-sha256');
  if (storeEntry.sha256.toLowerCase() !== STORE_SHA256.toLowerCase()) fail('store sha mismatch in binding');
  if (card33.sha256.toLowerCase() !== CARD33_SHA256.toLowerCase()) fail('033 card sha mismatch in binding');
  if (card34.sha256.toLowerCase() !== TASK_CARD_SHA256.toLowerCase()) fail('034 card sha mismatch in binding');
  if (prot.sha256.toLowerCase() !== PROTECTED_MANIFEST_SHA256.toLowerCase()) fail('protected manifest sha mismatch in binding');
  const candidateFiles = readJson(path.join(CANDIDATE33, 'candidate-files-033.json'));
  if (candidateFiles.aggregateSha256.toLowerCase() !== AGGREGATE33.toLowerCase()) fail('033 candidate aggregate differs from expected');
}

async function main() {
  const freezeMeta = await captureFreezeTriplet();
  if (freezeMeta.exitCode !== 0 || freezeMeta.verdict !== 'PASS') fail('freeze replica capture failed with exit ' + freezeMeta.exitCode);

  const entries = buildEntries(freezeMeta);
  verifyConstants(entries);
  const { aggregate, input, sorted } = canonicalAggregate(entries);
  const filesPath = path.join(bindingDir, 'final-binding-files-034.json');
  const manifestPath = path.join(bindingDir, 'final-binding-manifest-034.json');

  const filesDoc = {
    schemaVersion: 'final-binding-files-034-v1',
    selfReferenceExcluded: true,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    runId: runId,
    entryCount: entries.length,
    kinds: Object.keys(entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {})),
    aggregateSha256: aggregate,
    aggregateInput: input,
    entries: sorted
  };
  writeJson(filesPath, filesDoc);

  const isolatedCopies = archiveIsolates();
  const countByKind = {};
  for (const entry of entries) countByKind[entry.kind] = (countByKind[entry.kind] || 0) + 1;
  const harness = HARNESS_NAMES.map((name) => {
    const entry = entries.find((e) => e.label === 'harness/' + name);
    return { name: name, sha256: entry.sha256, bytes: entry.bytes };
  });
  const manifestDoc = {
    schemaVersion: 'final-binding-manifest-034-v1',
    selfReferenceExcluded: true,
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    baseCommit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
    runId: runId,
    bindingDir: bindingDir,
    filesPath: filesPath,
    aggregateSha256: aggregate,
    aggregateInputProjection: { kindLabelShaBytesOnly: true, sortedBy: 'kind+label stable sort', excludesSourcePath: true },
    entryCount: entries.length,
    objects: countByKind,
    metadata: {
      '033-run-id': RUN33,
      '033-aggregate': AGGREGATE33,
      'aggregate-includes-033-evidence': true,
      '033-card-sha': CARD33_SHA256.toUpperCase(),
      '034-card-sha': TASK_CARD_SHA256.toUpperCase(),
      'store-sha': STORE_SHA256.toUpperCase(),
      'protected-manifest-sha': PROTECTED_MANIFEST_SHA256.toUpperCase(),
      '033-candidate-files-sha': sha256File(path.join(CANDIDATE33, 'candidate-files-033.json')),
      '033-candidate-manifest-sha': sha256File(path.join(CANDIDATE33, 'candidate-manifest-033.json'))
    },
    harness: harness,
    freezeCapture: {
      tool: 'freeze-verifier',
      capturedBy: 'final-binding-builder (real parent process)',
      replica: FREEZE_REPLICA,
      command: freezeMeta.command,
      argv: freezeMeta.argv,
      cwd: freezeMeta.cwd,
      startUtc: freezeMeta.startUtc,
      endUtc: freezeMeta.endUtc,
      exitCode: freezeMeta.exitCode,
      verdict: freezeMeta.verdict,
      stdoutSha256: freezeMeta.stdoutSha256,
      stderrSha256: freezeMeta.stderrSha256,
      stdoutBytes: freezeMeta.stdoutBytes,
      stderrBytes: freezeMeta.stderrBytes,
      summary: freezeMeta.summary
    },
    isolatedCopies: isolatedCopies,
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
    freezeExit: freezeMeta.exitCode,
    freezeVerdict: freezeMeta.verdict,
    freezeAggregate: freezeMeta.summary && freezeMeta.summary.aggregateSha256,
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
