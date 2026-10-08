'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK_ID = process.env.XJ_TASK_ID || 'XJ-5.1.2-masters-fold-evidence-process-cleanup-rework-004';
const EVIDENCE_ROOT = path.resolve(process.env.XJ_EXPECTED_RED_ROOT || path.join(ROOT, 'qa', 'task-scratch', TASK_ID, 'expected-red'));
const OUT_DIR = path.join(EVIDENCE_ROOT, 'verifier-self');
const VERIFIER = path.join(__dirname, 'verify-expected-red-004.js');
const TIMEOUT_MS = 30000;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive:true }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function write(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, value); }
function isWithin(root, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function main() {
  ensureDir(OUT_DIR);
  const command = [process.execPath, VERIFIER];
  const startedAt = new Date().toISOString();
  const child = cp.spawnSync(process.execPath, [VERIFIER], {
    cwd:ROOT, windowsHide:true, encoding:'utf8', timeout:TIMEOUT_MS, maxBuffer:64 * 1024 * 1024,
    env:Object.assign({}, process.env, { XJ_TASK_ID:TASK_ID, XJ_EXPECTED_RED_ROOT:EVIDENCE_ROOT }),
  });
  const stdout = Buffer.from(String(child.stdout || ''), 'utf8');
  const stderr = Buffer.from(String(child.stderr || ''), 'utf8');
  const stdoutPath = path.join(OUT_DIR, 'verifier.stdout.txt');
  const stderrPath = path.join(OUT_DIR, 'verifier.stderr.txt');
  const metaPath = path.join(OUT_DIR, 'verifier.meta.json');
  write(stdoutPath, stdout); write(stderrPath, stderr);
  const meta = {
    taskId:TASK_ID, verifier:'verify-expected-red-004', command, cwd:ROOT,
    startedAt, finishedAt:new Date().toISOString(), exitCode:child.status == null ? null : child.status,
    signal:child.signal || null, timedOut:!!(child.error && child.error.code === 'ETIMEDOUT'),
    stdoutPath, stderrPath, stdoutSha256:sha256(stdout), stdoutBytes:stdout.length,
    stderrSha256:sha256(stderr), stderrBytes:stderr.length,
  };
  write(metaPath, JSON.stringify(meta, null, 2) + '\n');
  const checks = [];
  const check = (label, pass, details) => checks.push({ label, pass:!!pass, details:details === undefined ? null : details });
  check('verifier exit 0', meta.exitCode === 0 && meta.timedOut === false, { exitCode:meta.exitCode, timedOut:meta.timedOut });
  check('stdout path contained', isWithin(EVIDENCE_ROOT, stdoutPath), stdoutPath);
  check('stderr path contained', isWithin(EVIDENCE_ROOT, stderrPath), stderrPath);
  check('meta path contained', isWithin(EVIDENCE_ROOT, metaPath), metaPath);
  check('stdout bytes match', fs.readFileSync(stdoutPath).length === meta.stdoutBytes, { expected:meta.stdoutBytes, actual:fs.readFileSync(stdoutPath).length });
  check('stderr bytes match', fs.readFileSync(stderrPath).length === meta.stderrBytes, { expected:meta.stderrBytes, actual:fs.readFileSync(stderrPath).length });
  check('stdout SHA match', sha256(fs.readFileSync(stdoutPath)) === meta.stdoutSha256, meta.stdoutSha256);
  check('stderr SHA match', sha256(fs.readFileSync(stderrPath)) === meta.stderrSha256, meta.stderrSha256);
  check('stdout declares PASS', stdout.toString('utf8').includes('"status": "PASS"'), stdout.toString('utf8').slice(-240));
  const result = { taskId:TASK_ID, audit:'audit-expected-red-004', verifierMeta:metaPath, checkCount:checks.length, errorCount:checks.filter((item) => !item.pass).length, status:checks.every((item) => item.pass) ? 'PASS' : 'FAIL', checks };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

main();
