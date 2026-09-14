'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK_ID = 'XJ-5.1.2-calendar-billing-evidence-process-cleanup-rework-005';
const HARNESS_TASK_ID = 'XJ-5.1.2-calendar-billing-dialogue-fix-002';
const CARD_SHA = '2222C14D6BD5ECD7A84E10ECCCE706354E14E9289A0ED8FF227115B05873DD99';
const BASE_ROOT = path.join(ROOT, 'qa', 'task-scratch', TASK_ID);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const FRESH_ROOT = path.join(BASE_ROOT, 'fresh', RUN_ID);
const RUNTIME = path.join(ROOT, 'scripts', 'v5.1.2-tests', 'XJ-5.1.2-calendar-billing-dialogue-fix-002', 'runtime-002.js');
const MUTATIONS = path.join(ROOT, 'scripts', 'v5.1.2-tests', 'XJ-5.1.2-calendar-billing-dialogue-fix-002', 'mutation-probes.js');
const VERIFIER = path.join(ROOT, 'scripts', 'v5.1.2-tests', 'XJ-5.1.2-calendar-billing-dialogue-fix-002', 'verify-005.js');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value), 'utf8'); }
function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function now() { return new Date().toISOString(); }

function findLatestSummary(root, name) {
  const found = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === name) found.push(full);
    }
  }
  visit(root);
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] || null;
}

function runNode(label, script, env, timeoutMs) {
  const startedAt = now();
  const startedMs = Date.now();
  const child = cp.spawnSync(process.execPath, [script], {
    cwd: ROOT,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 96 * 1024 * 1024,
    env: Object.assign({}, process.env, env),
  });
  const stdout = Buffer.from(String(child.stdout || ''), 'utf8');
  const stderr = Buffer.from(String(child.stderr || ''), 'utf8');
  return {
    label,
    taskId: TASK_ID,
    command: [process.execPath, script],
    cwd: ROOT,
    startedAt,
    finishedAt: now(),
    elapsedMs: Date.now() - startedMs,
    exitCode: child.status == null ? null : child.status,
    signal: child.signal || null,
    timedOut: !!(child.error && child.error.code === 'ETIMEDOUT'),
    stdout: { text: stdout.toString('utf8'), bytes: stdout.length, sha256: sha256(stdout) },
    stderr: { text: stderr.toString('utf8'), bytes: stderr.length, sha256: sha256(stderr) },
    error: child.error ? { code: child.error.code || null, message: String(child.error.message || child.error) } : null,
  };
}

function persistRunnerResult(result) {
  const dir = path.join(FRESH_ROOT, 'runners');
  result.stdoutPath = path.join(dir, result.label + '.stdout.txt');
  result.stderrPath = path.join(dir, result.label + '.stderr.txt');
  writeText(result.stdoutPath, result.stdout.text);
  writeText(result.stderrPath, result.stderr.text);
  return result;
}

function makeManifest(runtimeSummary, mutationSummary) {
  return {
    taskId: TASK_ID,
    harnessTaskId: HARNESS_TASK_ID,
    cardSha256: CARD_SHA,
    evidenceRoot: FRESH_ROOT,
    runtimeSummary,
    mutationSummary,
    generatedAt: now(),
  };
}

function copyJson(source, target) {
  const value = readJson(source);
  writeJson(target, value);
  return value;
}

function runVerifier(label, manifestFile, outDir) {
  ensureDir(outDir);
  const result = runNode(label, VERIFIER, {
    XJ_TASK_ID: TASK_ID,
    XJ_EVIDENCE_ROOT: FRESH_ROOT,
    XJ_EVIDENCE_MANIFEST: manifestFile,
  }, 30000);
  const stdoutPath = path.join(outDir, 'verifier.stdout.txt');
  const stderrPath = path.join(outDir, 'verifier.stderr.txt');
  writeText(stdoutPath, result.stdout.text);
  writeText(stderrPath, result.stderr.text);
  const meta = Object.assign({}, result, {
    stdoutPath,
    stderrPath,
    stdoutSha256: result.stdout.sha256,
    stdoutBytes: result.stdout.bytes,
    stderrSha256: result.stderr.sha256,
    stderrBytes: result.stderr.bytes,
  });
  delete meta.stdout;
  delete meta.stderr;
  writeJson(path.join(outDir, 'verifier.meta.json'), meta);
  return Object.assign(result, { stdoutPath, stderrPath, metaPath: path.join(outDir, 'verifier.meta.json') });
}

function mutateRemoveTreeReclaim(summary) {
  const raw = summary.results[0].raw;
  raw.cleanup.treeExited = false;
  raw.cleanup.childTreeExited = false;
  raw.cleanup.ok = false;
  raw.binding.cleanupTreeExited = false;
  return { target: 'runtime.results[0].raw.cleanup', mutation: 'correct tree reclaim removed' };
}

function mutateRootOnly(summary) {
  const raw = summary.results[1].raw;
  raw.cleanup.naturalExit = false;
  raw.cleanup.forcedKill = true;
  raw.cleanup.termination = {
    attempted: true,
    confirmed: true,
    kill: {
      command: ['taskkill.exe', '/PID', String(raw.rootPid), '/F'],
      exitCode: 0,
      stdout: '',
      stderr: '',
      error: null,
    },
    beforeTree: raw.cleanup.launchProcess.tree,
    afterTree: [],
  };
  return { target: 'runtime.results[1].raw.cleanup.termination.kill.command', mutation: 'root-only kill without /T' };
}

function mutateSwallowTimeout(summary) {
  const raw = summary.results[2].raw;
  raw.cleanup.naturalExit = false;
  raw.cleanup.naturalExitWindowExpired = true;
  raw.cleanup.timedOut = false;
  raw.cleanup.elapsedMs = 10001;
  raw.cleanup.events = ['window-close-requested'];
  return { target: 'runtime.results[2].raw.cleanup', mutation: 'cleanup timeout swallowed' };
}

function mutateFakeExitSuccess(runtimeSummary, mutationSummary) {
  const item = mutationSummary.cases[0];
  item.mutated.status = 'PASS';
  item.killed = false;
  mutationSummary.killedCount = mutationSummary.cases.filter((entry) => entry.killed).length;
  mutationSummary.status = 'PASS';
  return { target: 'mutation.cases[0].mutated.status', mutation: 'fake exit-zero/success UI' };
}

async function main() {
  ensureDir(FRESH_ROOT);
  const runnerResults = [];
  runnerResults.push(persistRunnerResult(runNode('fresh-runtime', RUNTIME, {
    XJ_EVIDENCE_ROOT: FRESH_ROOT,
    XJ_EVIDENCE_TASK_ID: TASK_ID,
    XJ_CARD_SHA: CARD_SHA,
  }, 180000)));
  const runtimeSummary = findLatestSummary(path.join(FRESH_ROOT, 'runtime'), 'summary.json');
  runnerResults.push(persistRunnerResult(runNode('fresh-product-mutations', MUTATIONS, {
    XJ_EVIDENCE_ROOT: FRESH_ROOT,
    XJ_EVIDENCE_TASK_ID: TASK_ID,
    XJ_CARD_SHA: CARD_SHA,
  }, 180000)));
  const mutationSummary = path.join(FRESH_ROOT, 'expected-red-002', 'summary.json');
  const manifest = makeManifest(runtimeSummary, mutationSummary);
  const manifestFile = path.join(FRESH_ROOT, 'fresh-manifest.json');
  writeJson(manifestFile, manifest);
  writeJson(path.join(BASE_ROOT, 'latest-manifest.json'), manifest);

  const baselineVerifier = runVerifier('baseline-verifier', manifestFile, path.join(FRESH_ROOT, 'verifier-baseline'));
  const attacks = [
    { id: 'ER1-remove-tree-reclaim', mutate: (runtime, mutation) => mutateRemoveTreeReclaim(runtime), target: 'runtime' },
    { id: 'ER2-root-only-kill', mutate: (runtime, mutation) => mutateRootOnly(runtime), target: 'runtime' },
    { id: 'ER3-swallow-timeout', mutate: (runtime, mutation) => mutateSwallowTimeout(runtime), target: 'runtime' },
    { id: 'ER4-fake-exit-zero-success-ui', mutate: (runtime, mutation) => mutateFakeExitSuccess(runtime, mutation), target: 'mutation' },
  ];
  const cases = [];
  for (const attack of attacks) {
    const attackRoot = path.join(FRESH_ROOT, 'expected-red-005', attack.id);
    ensureDir(attackRoot);
    const attackRuntime = path.join(attackRoot, 'runtime-summary.json');
    const attackMutation = path.join(attackRoot, 'mutation-summary.json');
    const runtimeCopy = copyJson(runtimeSummary, attackRuntime);
    const mutationCopy = copyJson(mutationSummary, attackMutation);
    const mutationDetails = attack.mutate(runtimeCopy, mutationCopy);
    writeJson(attackRuntime, runtimeCopy);
    writeJson(attackMutation, mutationCopy);
    const attackManifest = path.join(attackRoot, 'manifest.json');
    writeJson(attackManifest, makeManifest(attackRuntime, attackMutation));
    const verifier = runVerifier(attack.id, attackManifest, attackRoot);
    const killed = verifier.exitCode !== 0 && verifier.timedOut === false;
    const item = {
      id: attack.id,
      description: mutationDetails.mutation,
      target: mutationDetails.target,
      manifest: attackManifest,
      verifier,
      killed,
    };
    writeJson(path.join(attackRoot, 'case.json'), item);
    cases.push(item);
  }
  const summary = {
    taskId: TASK_ID,
    version: 'expected-red-005-v1',
    startedAt: runnerResults[0].startedAt,
    finishedAt: now(),
    evidenceRoot: FRESH_ROOT,
    manifest: manifestFile,
    runnerResults: runnerResults.map((item) => ({ label: item.label, command: item.command, cwd: item.cwd, exitCode: item.exitCode, timedOut: item.timedOut, elapsedMs: item.elapsedMs, stdoutPath: item.stdoutPath, stderrPath: item.stderrPath, stdoutBytes: item.stdout.bytes, stderrBytes: item.stderr.bytes, stdoutSha256: item.stdout.sha256, stderrSha256: item.stderr.sha256 })),
    baselineVerifier: { exitCode: baselineVerifier.exitCode, timedOut: baselineVerifier.timedOut, metaPath: baselineVerifier.metaPath },
    caseCount: cases.length,
    killedCount: cases.filter((item) => item.killed).length,
    status: baselineVerifier.exitCode === 0 && baselineVerifier.timedOut === false && cases.length === attacks.length && cases.every((item) => item.killed) ? 'PASS' : 'FAIL',
    cases: cases.map((item) => ({ id: item.id, description: item.description, target: item.target, manifest: item.manifest, verifierExit: item.verifier.exitCode, verifierTimedOut: item.verifier.timedOut, killed: item.killed })),
  };
  writeJson(path.join(FRESH_ROOT, 'expected-red-summary.json'), summary);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exitCode = summary.status === 'PASS' ? 0 : 2;
}

if (require.main === module) {
  main().catch((error) => {
    ensureDir(FRESH_ROOT);
    writeJson(path.join(FRESH_ROOT, 'fatal.json'), { taskId: TASK_ID, status: 'FAIL', error: { message: error.message, stack: error.stack } });
    process.stderr.write((error.stack || error.message) + '\n');
    process.exitCode = 2;
  });
}

module.exports = { TASK_ID, FRESH_ROOT, runNode, runVerifier, main };
