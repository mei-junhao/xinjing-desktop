'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, CONTRACT_ID, TASK33, RUN33, AGGREGATE33, CARD33_SHA256, TASK_CARD_SHA256, STORE_SHA256, PROTECTED_MANIFEST_SHA256,
  PROJECT_ROOT, SCRATCH_ROOT, SCRIPTS33, EVIDENCE33, CANDIDATE33, ORIGINAL_FREEZE_PATH, HOOK_PATH,
  FREEZE33_SHA256, COMMON33_SHA256,
  ALLOWED_KINDS, EXPECTED_FLAGS,
  sha256Bytes, sha256File, bytesOf, nowUtc, ensureDir, readJson, writeJson, assertSafeLabel, assertContained,
  canonicalAggregate, installSelfCapture, argValue
} = require('./common-036');

const HARNESS_NAMES = ['common.js', 'fixture-electron.js', 'store-fixture.html', 'phase-worker.js', 'runner.js', 'expected-red.js', 'verifier.js', 'audit.js', 'freeze-verifier.js', 'expected-red.json'];
const SELF_035 = path.resolve(SCRATCH_ROOT, 'self');

function argBindingDir() {
  const v = argValue('--binding-dir', '');
  if (!v) throw new Error('--binding-dir is required');
  return path.resolve(v);
}
const bindingDir = argBindingDir();
const inputsRoot = argValue('--inputs-root', '') ? path.resolve(argValue('--inputs-root', '')) : null;
const runIdArg = argValue('--run-id', '');
const selfRoot = inputsRoot ? inputsRoot : SCRATCH_ROOT;
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: selfRoot, runId: runIdArg || 'run-035-unknown', toolName: 'final-binding-verifier' });

function fail(message) { throw new Error(message); }

function resolveEntryFile(entry) {
  if (entry.kind === 'protected-sha') return null;
  if (inputsRoot) {
    const staged = path.join(inputsRoot, entry.label);
    if (!fs.existsSync(staged) || !fs.statSync(staged).isFile()) fail('staged input missing: ' + entry.label);
    return staged;
  }
  return entry.sourcePath;
}

function allowlistRootFor(kind) {
  switch (kind) {
    case 'evidence-file': return EVIDENCE33;
    case 'harness-source': return SCRIPTS33;
    case 'freeze-self': return SELF_035;
    case 'candidate-file': return CANDIDATE33;
    case 'card': return path.resolve(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks');
    case 'store': return path.resolve(PROJECT_ROOT, 'app');
    default: return null;
  }
}

function verifyEntries(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (!ALLOWED_KINDS.has(entry.kind)) fail('unknown kind: ' + entry.kind);
    assertSafeLabel(entry.label);
    const key = entry.kind + '|' + entry.label;
    if (seen.has(key)) fail('duplicate entry: ' + key);
    seen.add(key);
    if (!entry.sourcePath || typeof entry.sourcePath !== 'string') fail('entry sourcePath missing: ' + key);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) fail('entry sha256 invalid: ' + key);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) fail('entry bytes invalid: ' + key);
    if (entry.kind === 'protected-sha') {
      if (entry.sha256.toLowerCase() !== PROTECTED_MANIFEST_SHA256.toLowerCase()) fail('protected manifest sha mismatch');
      continue;
    }
    if (!path.isAbsolute(entry.sourcePath)) fail('entry sourcePath must be absolute: ' + key);
    assertContained(allowlistRootFor(entry.kind), entry.sourcePath);
    const file = resolveEntryFile(entry);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail('entry file missing: ' + key);
    if (sha256File(file).toLowerCase() !== entry.sha256.toLowerCase()) fail('entry sha mismatch: ' + key);
    if (bytesOf(file) !== entry.bytes) fail('entry bytes mismatch: ' + key);
  }
  return entries;
}

function verifyEvidenceAgainstCandidate(entries) {
  const candidateFiles = readJson(path.join(CANDIDATE33, 'candidate-files-033.json'));
  if (!Array.isArray(candidateFiles.files) || candidateFiles.files.length !== 1608) fail('033 candidate file list invalid');
  if (String(candidateFiles.aggregateSha256).toLowerCase() !== AGGREGATE33.toLowerCase()) fail('033 candidate aggregate mismatch');
  const byLabel = {};
  for (const entry of entries) byLabel[entry.label] = entry;
  for (const file of candidateFiles.files) {
    const label = 'evidence/' + file.rel;
    const entry = byLabel[label];
    if (!entry) fail('missing evidence binding: ' + label);
    if (String(entry.sha256).toLowerCase() !== String(file.sha256).toLowerCase() || entry.bytes !== file.bytes) fail('evidence binding mismatch: ' + label);
  }
}

function verifyCounts(entries) {
  const countByKind = {};
  for (const entry of entries) countByKind[entry.kind] = (countByKind[entry.kind] || 0) + 1;
  if (countByKind['evidence-file'] !== 1608) fail('evidence count');
  if (countByKind['harness-source'] !== 10) fail('harness count');
  if (countByKind['freeze-self'] !== 3) fail('freeze-self count');
  if (countByKind['candidate-file'] !== 2) fail('candidate count');
  if (countByKind['card'] !== 2) fail('card count');
  if (countByKind['store'] !== 1) fail('store count');
  if (countByKind['protected-sha'] !== 1) fail('protected count');
  return countByKind;
}

function verifyFreezeIdentity(entries) {
  const metaEntry = entries.find((e) => e.label === 'self/freeze-verifier/meta.json');
  const stdoutEntry = entries.find((e) => e.label === 'self/freeze-verifier/stdout.txt');
  const stderrEntry = entries.find((e) => e.label === 'self/freeze-verifier/stderr.txt');
  if (!metaEntry || !stdoutEntry || !stderrEntry) fail('freeze triplet binding incomplete');
  const meta = readJson(resolveEntryFile(metaEntry));
  const raw = JSON.stringify(meta).toLowerCase();
  for (const marker of ['replica', 'equivalent-reimplementation', 'executed:false', 'freeze-replica-check']) {
    if (raw.includes(marker)) fail('freeze meta contains forbidden identity marker: ' + marker);
  }
  if (meta.tool !== 'freeze-verifier') fail('freeze meta tool must be freeze-verifier');
  if (path.resolve(meta.capturedFrom || '') !== path.resolve(ORIGINAL_FREEZE_PATH)) fail('freeze meta capturedFrom is not the original 033 freeze-verifier path');
  const argv = Array.isArray(meta.argv) ? meta.argv.map(String) : [];
  if (!argv.some((a) => path.resolve(a) === path.resolve(ORIGINAL_FREEZE_PATH))) fail('freeze meta argv does not contain the original 033 freeze-verifier script');
  if (String(meta.executedSourceSha256 || '').toLowerCase() !== FREEZE33_SHA256.toLowerCase()) fail('freeze meta executedSourceSha256 mismatch');
  if (meta.executedSourceBytes !== bytesOf(ORIGINAL_FREEZE_PATH)) fail('freeze meta executedSourceBytes mismatch');
  if (meta.sourceByteIdentical !== true) fail('freeze meta sourceByteIdentical must be true');
  if (meta.exitCode !== 0 || meta.verdict !== 'PASS') fail('freeze triplet did not PASS');
  if (String(meta.stdoutSha256).toLowerCase() !== String(stdoutEntry.sha256).toLowerCase()) fail('freeze meta stdout sha mismatch');
  if (String(meta.stderrSha256).toLowerCase() !== String(stderrEntry.sha256).toLowerCase()) fail('freeze meta stderr sha mismatch');
  const hookSha = meta.hookSha256;
  if (typeof hookSha !== 'string' || !/^[a-f0-9]{64}$/i.test(hookSha)) fail('freeze meta hookSha256 missing or invalid');
  const hookOnDisk = sha256File(HOOK_PATH).toLowerCase();
  if (hookSha.toLowerCase() !== hookOnDisk) fail('freeze meta hookSha256 does not match the on-disk 035 hook');
  if (!meta.redirectRoot || !meta.mapping || !meta.mapping.scope) fail('freeze meta redirectRoot/mapping missing');
  const redirectAbs = path.resolve(meta.redirectRoot);
  const rel = path.relative(path.resolve(SCRATCH_ROOT), redirectAbs);
  if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) fail('freeze redirectRoot must live under the 035 scratch root');
  if (String(meta.mapping.scope).indexOf('candidate') < 0) fail('freeze mapping scope must be candidate-writes-only');
  // the executed source on disk must still be byte-original
  if (sha256File(ORIGINAL_FREEZE_PATH).toLowerCase() !== FREEZE33_SHA256.toLowerCase()) fail('033 freeze-verifier source drifted on disk');
  if (sha256File(path.join(SCRIPTS33, 'common.js')).toLowerCase() !== COMMON33_SHA256.toLowerCase()) fail('033 common.js drifted on disk');
  if (!meta.summary || meta.summary.aggregateSha256 !== AGGREGATE33) fail('freeze summary aggregate mismatch');
  return meta;
}

async function main() {
  if (!path.relative(SCRATCH_ROOT, bindingDir) || path.relative(SCRATCH_ROOT, bindingDir).startsWith('..' + path.sep)) fail('binding dir must live under the 035 scratch root');
  const filesPath = path.join(bindingDir, 'final-binding-files-036.json');
  const manifestPath = path.join(bindingDir, 'final-binding-manifest-036.json');
  if (!fs.existsSync(filesPath) || !fs.existsSync(manifestPath)) fail('binding files missing');
  const filesDoc = readJson(filesPath);
  const manifestDoc = readJson(manifestPath);
  if (filesDoc.schemaVersion !== 'final-binding-files-036-v1' || manifestDoc.schemaVersion !== 'final-binding-manifest-036-v1') fail('binding schema mismatch');
  if (filesDoc.taskId !== TASK_ID || manifestDoc.taskId !== TASK_ID || manifestDoc.contractId !== CONTRACT_ID) fail('binding identity mismatch');
  const runId = runIdArg || manifestDoc.runId;
  if (filesDoc.runId !== runId || manifestDoc.runId !== runId) fail('binding runId mismatch');
  if (filesDoc.selfReferenceExcluded !== true || manifestDoc.selfReferenceExcluded !== true) fail('selfReferenceExcluded must be true');
  const entries = verifyEntries(filesDoc.entries);
  verifyEvidenceAgainstCandidate(entries);
  verifyCounts(entries);
  const freezeMeta = verifyFreezeIdentity(entries);
  const { aggregate } = canonicalAggregate(entries);
  if (aggregate !== filesDoc.aggregateSha256 || aggregate !== manifestDoc.aggregateSha256) fail('binding aggregate mismatch');
  const storeEntry = entries.find((e) => e.label === 'store/store.js');
  const card33 = entries.find((e) => e.label === 'card/033');
  const card35 = entries.find((e) => e.label === 'card/035');
  if (storeEntry.sha256.toLowerCase() !== STORE_SHA256.toLowerCase()) fail('store sha drift');
  if (card33.sha256.toLowerCase() !== CARD33_SHA256.toLowerCase()) fail('033 card sha drift');
  if (card35.sha256.toLowerCase() !== TASK_CARD_SHA256.toLowerCase()) fail('035 card sha drift');
  if (JSON.stringify(manifestDoc.flags) !== JSON.stringify(EXPECTED_FLAGS)) fail('flags misclaim');
  if (!manifestDoc.freezeCapture || manifestDoc.freezeCapture.exactSourceIdentity !== true) fail('manifest freezeCapture identity missing');
  process.stdout.write(JSON.stringify({
    type: 'verifier-summary',
    taskId: TASK_ID,
    contractId: CONTRACT_ID,
    runId: runId,
    bindingDir: bindingDir,
    mode: inputsRoot ? 'staged' : 'authoritative',
    entryCount: entries.length,
    aggregateSha256: aggregate,
    freezeIdentity: { capturedFrom: freezeMeta.capturedFrom, executedSourceSha256: freezeMeta.executedSourceSha256, sourceByteIdentical: freezeMeta.sourceByteIdentical, hookSha256: freezeMeta.hookSha256.slice(0, 12) },
    verdict: 'PASS',
    verifiedAt: nowUtc()
  }) + String.fromCharCode(10));
  return 0;
}

main().then((code) => {
  finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'verifier-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
