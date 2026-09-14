'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK_ID = process.env.XJ_TASK_ID || 'XJ-5.1.2-calendar-billing-evidence-process-cleanup-rework-005';
const BASE_ROOT = path.join(ROOT, 'qa', 'task-scratch', TASK_ID);
const MANIFEST = path.resolve(process.env.XJ_EVIDENCE_MANIFEST || path.join(BASE_ROOT, 'latest-manifest.json'));
const VERIFIER = path.join(__dirname, 'verify-005.js');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const OUT_ROOT = path.join(BASE_ROOT, 'adversarial-005', RUN_ID);

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value), 'utf8'); }
function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }

function cloneJson(source, target) {
  const value = readJson(source);
  writeJson(target, value);
  return value;
}

function runVerifier(label, manifestFile, attackRoot, evidenceRoot) {
  const startedAt = new Date().toISOString();
  const child = cp.spawnSync(process.execPath, [VERIFIER], {
    cwd: ROOT,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 96 * 1024 * 1024,
    env: Object.assign({}, process.env, { XJ_TASK_ID: TASK_ID, XJ_EVIDENCE_ROOT: evidenceRoot, XJ_EVIDENCE_MANIFEST: manifestFile }),
  });
  const stdout = Buffer.from(String(child.stdout || ''), 'utf8');
  const stderr = Buffer.from(String(child.stderr || ''), 'utf8');
  const stdoutPath = path.join(attackRoot, 'verifier.stdout.json');
  const stderrPath = path.join(attackRoot, 'verifier.stderr.txt');
  writeText(stdoutPath, stdout);
  writeText(stderrPath, stderr);
  const meta = {
    taskId: TASK_ID,
    attack: label,
    command: [process.execPath, VERIFIER],
    cwd: ROOT,
    manifest: manifestFile,
    evidenceRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: child.status == null ? null : child.status,
    signal: child.signal || null,
    timedOut: !!(child.error && child.error.code === 'ETIMEDOUT'),
    stdoutPath,
    stderrPath,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
  writeJson(path.join(attackRoot, 'verifier.meta.json'), meta);
  return meta;
}

function main() {
  ensureDir(OUT_ROOT);
  const baseManifest = readJson(MANIFEST);
  const evidenceRoot = path.resolve(baseManifest.evidenceRoot);
  const attacks = [
    {
      id: 'A1-raw-sha-forged',
      mutate(runtime) {
        runtime.results[0].raw.stdout.sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
        return 'stdout SHA forged';
      },
      target: 'runtime',
    },
    {
      id: 'A2-cross-task-raw',
      mutate(runtime) {
        runtime.results[1].raw.stderr.file = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.2-calendar-billing-dialogue-fix-002', 'expected-red-002', 'cross-task.stderr.txt');
        return 'raw path moved outside fresh evidence';
      },
      target: 'runtime',
    },
    {
      id: 'A3-cleanup-binding-mismatch',
      mutate(runtime) {
        runtime.results[2].raw.cleanup.rootPid += 1;
        return 'cleanup root PID detached from raw PID';
      },
      target: 'runtime',
    },
    {
      id: 'A4-source-hash-forged',
      mutate(runtime) {
        runtime.productionHashes['app/session-calendar.html'].sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
        return 'production source hash forged';
      },
      target: 'runtime',
    },
  ];
  const results = [];
  for (const attack of attacks) {
    const attackRoot = path.join(OUT_ROOT, attack.id);
    ensureDir(attackRoot);
    const runtimeFile = path.join(attackRoot, 'runtime-summary.json');
    const mutationFile = path.join(attackRoot, 'mutation-summary.json');
    const runtime = cloneJson(baseManifest.runtimeSummary, runtimeFile);
    const mutation = cloneJson(baseManifest.mutationSummary, mutationFile);
    const description = attack.mutate(runtime, mutation);
    writeJson(runtimeFile, runtime);
    writeJson(mutationFile, mutation);
    const manifestFile = path.join(attackRoot, 'manifest.json');
    writeJson(manifestFile, {
      taskId: TASK_ID,
      harnessTaskId: baseManifest.harnessTaskId,
      cardSha256: baseManifest.cardSha256,
      evidenceRoot,
      runtimeSummary: runtimeFile,
      mutationSummary: mutationFile,
      generatedAt: new Date().toISOString(),
    });
    const meta = runVerifier(attack.id, manifestFile, attackRoot, evidenceRoot);
    const killed = meta.exitCode !== 0 && meta.timedOut === false;
    const result = { id: attack.id, target: attack.target, description, manifest: manifestFile, verifierExit: meta.exitCode, verifierTimedOut: meta.timedOut, killed };
    writeJson(path.join(attackRoot, 'case.json'), result);
    results.push(result);
  }
  const summary = {
    taskId: TASK_ID,
    version: 'adversarial-005-v1',
    evidenceRoot,
    manifest: MANIFEST,
    attackCount: results.length,
    killedCount: results.filter((item) => item.killed).length,
    status: results.length === attacks.length && results.every((item) => item.killed) ? 'PASS' : 'FAIL',
    results,
  };
  writeJson(path.join(OUT_ROOT, 'adversarial-results.json'), summary);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exitCode = summary.status === 'PASS' ? 0 : 2;
}

main();
