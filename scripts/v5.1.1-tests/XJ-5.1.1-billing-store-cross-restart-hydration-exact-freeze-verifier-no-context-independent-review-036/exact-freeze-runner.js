'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, TASK33, RUN33, AGGREGATE33,
  PROJECT_ROOT, SCRIPT_ROOT, SCRATCH_ROOT, SCRATCH33, EVIDENCE33, CANDIDATE33, CLAIM33_PATH, LEASE33_PATH,
  ORIGINAL_FREEZE_PATH, ORIGINAL_COMMON_PATH, HOOK_PATH,
  FREEZE33_SHA256, COMMON33_SHA256, STORE_SHA256,
  sha256Bytes, sha256File, bytesOf, nowUtc, randomNonce, makeRunId, ensureDir, writeJson, readJson,
  walkFiles, runChild, installSelfCapture, argValue
} = require('./common-036');

const runId = argValue('--run-id') || makeRunId();
const isolationRoot = path.resolve(argValue('--isolation-root', path.join(SCRATCH_ROOT, 'candidate-isolation', RUN33)));
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: SCRATCH_ROOT, runId: runId, toolName: 'exact-freeze-runner' });

function fail(message) { throw new Error(message); }

function evidenceAggregate() {
  const files = walkFiles(EVIDENCE33, '', []).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { aggregate: sha256Bytes(JSON.stringify(files.map((f) => ({ rel: f.rel, sha256: f.sha256, bytes: f.bytes })))), count: files.length };
}

function snapshot033() {
  return {
    evidence: evidenceAggregate(),
    candidateFilesSha: sha256File(path.join(CANDIDATE33, 'candidate-files-033.json')),
    candidateManifestSha: sha256File(path.join(CANDIDATE33, 'candidate-manifest-033.json')),
    claim33Sha: sha256File(CLAIM33_PATH),
    lease33Sha: sha256File(LEASE33_PATH),
    storeSha: sha256File(path.join(PROJECT_ROOT, 'app/js/store.js')),
    freezeSourceSha: sha256File(ORIGINAL_FREEZE_PATH),
    freezeSourceBytes: bytesOf(ORIGINAL_FREEZE_PATH),
    common33Sha: sha256File(ORIGINAL_COMMON_PATH)
  };
}

function assertSnapshotUnchanged(before, after, label) {
  for (const key of Object.keys(before)) {
    let equal;
    if (key === 'evidence') equal = before.evidence.aggregate === after.evidence.aggregate && before.evidence.count === after.evidence.count;
    else equal = before[key] === after[key];
    if (!equal) fail(label + ' drift on ' + key + ': ' + before[key] + ' -> ' + after[key]);
  }
}

async function main() {
  const pre = snapshot033();
  if (pre.evidence.aggregate !== AGGREGATE33) fail('033 evidence aggregate mismatch before run');
  if (pre.freezeSourceSha.toLowerCase() !== FREEZE33_SHA256.toLowerCase()) fail('033 freeze-verifier source sha mismatch before run');
  if (pre.common33Sha.toLowerCase() !== COMMON33_SHA256.toLowerCase()) fail('033 common.js source sha mismatch before run');
  if (!fs.existsSync(ORIGINAL_FREEZE_PATH) || !fs.existsSync(ORIGINAL_COMMON_PATH) || !fs.existsSync(HOOK_PATH)) fail('child source files missing');

  const nodeOptions = '--require=' + HOOK_PATH;
  const argv = [ORIGINAL_FREEZE_PATH, '--evidence-root', EVIDENCE33, '--run-id', RUN33];
  const startUtc = nowUtc();
  const child = await runChild(process.execPath, argv, {
    cwd: PROJECT_ROOT,
    env: {
      NODE_OPTIONS: nodeOptions,
      XJ035_CANDIDATE_PREFIX: path.join(SCRATCH33, 'candidate', RUN33),
      XJ035_ISOLATION_ROOT: isolationRoot,
      XJ035_SCRATCH_ROOT: SCRATCH_ROOT
    }
  });
  const endUtc = nowUtc();
  const after = snapshot033();
  assertSnapshotUnchanged(pre, after, 'post-run');

  // isolation outputs the ORIGINAL child must have produced
  const expectedIsolationFiles = [
    'candidate-files-033.json',
    'candidate-manifest-033.json',
    'self/freeze-verifier/stdout.txt',
    'self/freeze-verifier/stderr.txt',
    'self/freeze-verifier/meta.json'
  ];
  for (const rel of expectedIsolationFiles) {
    if (!fs.existsSync(path.join(isolationRoot, rel))) fail('isolation output missing: ' + rel);
  }
  const isoFilesDoc = readJson(path.join(isolationRoot, 'candidate-files-033.json'));
  if (String(isoFilesDoc.aggregateSha256).toLowerCase() !== AGGREGATE33.toLowerCase()) fail('isolated candidate aggregate mismatch: ' + isoFilesDoc.aggregateSha256);
  const isoManifest = readJson(path.join(isolationRoot, 'candidate-manifest-033.json'));
  const isoSelfMeta = readJson(path.join(isolationRoot, 'self/freeze-verifier/meta.json'));
  if (String(isoFilesDoc.fileCount) !== '1608' && isoFilesDoc.fileCount !== 1608) fail('isolated candidate file count mismatch');

  const summaryLine = String(child.stdout).split(/\r?\n/).filter((l) => l.trim() && l.indexOf('freeze-summary') >= 0).pop();
  const summary = (() => { try { return JSON.parse(summaryLine); } catch (error) { return {}; } })();
  if (child.exitCode !== 0 || summary.verdict !== 'PASS') fail('original freeze-verifier child did not PASS (exit ' + child.exitCode + ')');

  const selfDir = ensureDir(path.join(SCRATCH_ROOT, 'self', 'freeze-verifier'));
  const stdoutPath = path.join(selfDir, 'stdout.txt');
  const stderrPath = path.join(selfDir, 'stderr.txt');
  const metaPath = path.join(selfDir, 'meta.json');
  fs.writeFileSync(stdoutPath, child.stdout);
  fs.writeFileSync(stderrPath, child.stderr);
  const meta = {
    taskId: TASK_ID,
    runId: runId,
    tool: 'freeze-verifier',
    capturedFrom: ORIGINAL_FREEZE_PATH,
    command: process.execPath,
    argv: argv.map(String),
    nodeOptions: nodeOptions,
    cwd: PROJECT_ROOT,
    startUtc: startUtc,
    endUtc: endUtc,
    exitCode: child.exitCode,
    verdict: child.exitCode === 0 ? 'PASS' : 'FAIL',
    executedSourceSha256: pre.freezeSourceSha,
    executedSourceBytes: pre.freezeSourceBytes,
    sourceByteIdentical: pre.freezeSourceSha === after.freezeSourceSha && pre.freezeSourceSha.toLowerCase() === FREEZE33_SHA256.toLowerCase(),
    executedCommonSha256: pre.common33Sha,
    hookPath: HOOK_PATH,
    hookSha256: sha256File(HOOK_PATH),
    hookBytes: bytesOf(HOOK_PATH),
    redirectRoot: isolationRoot,
    mapping: {
      prefixBefore: path.join(SCRATCH33, 'candidate', RUN33),
      prefixAfter: isolationRoot,
      scope: '033 SCRATCH_ROOT/candidate/<run-033> write operations only; all other writes fail-closed'
    },
    isolationOutputs: expectedIsolationFiles.map((rel) => ({ rel: rel, sha256: sha256File(path.join(isolationRoot, rel)), bytes: bytesOf(path.join(isolationRoot, rel)) })),
    childSelfTriplet: {
      metaPath: path.join(isolationRoot, 'self/freeze-verifier/meta.json'),
      verdict: isoSelfMeta.verdict,
      exitCode: isoSelfMeta.exitCode
    },
    prePostEqual: true,
    summary: summary,
    stdoutPath: path.resolve(stdoutPath),
    stderrPath: path.resolve(stderrPath),
    metaPath: path.resolve(metaPath),
    stdoutSha256: sha256File(stdoutPath),
    stderrSha256: sha256File(stderrPath),
    stdoutBytes: bytesOf(stdoutPath),
    stderrBytes: bytesOf(stderrPath)
  };
  writeJson(metaPath, meta);
  process.stdout.write(JSON.stringify({
    type: 'exact-freeze-runner-summary',
    taskId: TASK_ID,
    runId: runId,
    childScript: ORIGINAL_FREEZE_PATH,
    executedSourceSha256: pre.freezeSourceSha,
    sourceByteIdentical: meta.sourceByteIdentical,
    exitCode: child.exitCode,
    verdict: 'PASS',
    aggregate33: summary.aggregateSha256,
    isolationRoot: isolationRoot
  }) + String.fromCharCode(10));
  return 0;
}

main().then((code) => {
  finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'exact-freeze-runner-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
