'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const {
  ROOT,
  TASK,
  SCRIPT_ROOT,
  SCRATCH_ROOT,
  shaBytes,
  ensureDir,
  loadIdentity,
} = require('./common-047');

const identity = loadIdentity();
const evidenceRoot = identity.evidenceRoot;
const verifierPath = path.join(SCRIPT_ROOT, 'verifier-047.js');
const rawRoot = path.join(SCRATCH_ROOT, 'expected-red-047', identity.runId);
const cases = [];

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function runVerifier(label) {
  const dir = path.join(rawRoot, label);
  ensureDir(dir);
  const command = process.execPath;
  const argv = [verifierPath];
  const startUtc = new Date().toISOString();
  const child = cp.spawnSync(command, argv, {
    cwd: ROOT,
    env: { ...process.env, XJ_047_EVIDENCE_SUFFIX: 'final' },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = String(child.stdout || '');
  const stderr = String(child.stderr || '');
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  fs.writeFileSync(stdoutPath, stdout, 'utf8');
  fs.writeFileSync(stderrPath, stderr, 'utf8');
  const endUtc = new Date().toISOString();
  const exitCode = typeof child.status === 'number' ? child.status : 3;
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch (_) {}
  const result = {
    label,
    command,
    argv,
    cwd: ROOT,
    startUtc,
    endUtc,
    exitCode,
    stdoutPath,
    stderrPath,
    stdoutSha256: shaBytes(Buffer.from(stdout, 'utf8')),
    stderrSha256: shaBytes(Buffer.from(stderr, 'utf8')),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    pass: !!(parsed && parsed.pass === true && exitCode === 0),
    verifier: parsed,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    schema: 'xj-047-expected-red-run-meta-v1',
    taskId: TASK,
    runId: identity.runId,
    runNonce: identity.runNonce,
    cardSha256: identity.cardSha256,
    storeSha256: identity.storeSha256,
    protectedFilesManifestSha256: identity.protectedFilesManifestSha256,
    ...result,
  }, null, 2) + '\n', 'utf8');
  return result;
}

function mutateJson(file, mutator) {
  const original = fs.readFileSync(file);
  const value = readJson(file);
  mutator(value);
  writeJson(file, value);
  return () => fs.writeFileSync(file, original);
}

function mutateDelete(file) {
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  return () => fs.writeFileSync(file, original);
}

function firstMeta() {
  const manifest = readJson(path.join(evidenceRoot, 'evidence-manifest.json'));
  return manifest.stageMetaPaths[0];
}

function caseRun(id, mutator) {
  const baseline = runVerifier(`${id}-baseline`);
  let restore = () => {};
  let mutated;
  try {
    restore = mutator();
    mutated = runVerifier(`${id}-mutated`);
  } finally {
    try { restore(); } catch (error) { process.stderr.write(`RESTORE_ERROR ${id} ${error.stack || error}\n`); }
  }
  const restored = runVerifier(`${id}-restore`);
  const killed = baseline.pass === true && mutated.pass === false && mutated.exitCode !== 0 && restored.pass === true && restored.exitCode === 0;
  const record = { id, killed, baseline, mutated, restored };
  cases.push(record);
  console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${id} baseline=${baseline.exitCode} mutated=${mutated.exitCode} restore=${restored.exitCode}`);
  return killed;
}

function main() {
  ensureDir(rawRoot);
  const metaPath = firstMeta();
  const stderrPath = path.join(path.dirname(metaPath), 'stderr.txt');
  caseRun('ER1-delete-stderr', () => mutateDelete(stderrPath));
  caseRun('ER2-sha-tamper', () => mutateJson(metaPath, value => { value.stdoutSha256 = '0'.repeat(64); }));
  caseRun('ER3-unknown-field', () => mutateJson(metaPath, value => { value.unexpected047 = true; }));
  caseRun('ER4-time-reversal', () => mutateJson(metaPath, value => { const temp = value.startUtc; value.startUtc = value.endUtc; value.endUtc = temp; }));
  caseRun('ER5-sibling-path', () => mutateJson(metaPath, value => { value.stdoutPath = path.join(path.dirname(evidenceRoot), `${path.basename(evidenceRoot)}-sibling`, 'stdout.txt'); }));
  caseRun('ER6-manifest-count', () => mutateJson(path.join(evidenceRoot, 'evidence-manifest.json'), value => { value.stageCount += 1; }));
  caseRun('ER7-summary-tamper', () => mutateJson(path.join(evidenceRoot, 'results.json'), value => { value[0].pass = false; }));
  caseRun('ER8-mutated-verdict', () => {
    const manifest = readJson(path.join(evidenceRoot, 'evidence-manifest.json'));
    const target = manifest.stageMetaPaths.find(file => /expected-red[\\/]01-delete-migration[\\/]mutated[\\/]meta\.json$/.test(file));
    if (!target) throw new Error('ER8 mutated target meta missing');
    return mutateJson(target, value => { value.verdict = 'PASS'; value.exitCode = 0; });
  });
  const summary = {
    schema: 'xj-047-expected-red-v1',
    taskId: TASK,
    runId: identity.runId,
    runNonce: identity.runNonce,
    cardSha256: identity.cardSha256,
    evidenceRoot,
    caseCount: cases.length,
    killedCount: cases.filter(item => item.killed).length,
    cases,
    pass: cases.length === 8 && cases.every(item => item.killed),
    generatedUtc: new Date().toISOString(),
  };
  writeJson(path.join(rawRoot, 'expected-red-results.json'), summary);
  console.log(JSON.stringify({ expectedRed: '047', pass: summary.pass, caseCount: summary.caseCount, killedCount: summary.killedCount }));
  if (!summary.pass) process.exitCode = 1;
}

main();
