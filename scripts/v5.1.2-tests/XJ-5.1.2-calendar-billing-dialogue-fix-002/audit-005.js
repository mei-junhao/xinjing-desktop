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
const OUT_ROOT = path.resolve(process.env.XJ_AUDIT_ROOT || path.join(BASE_ROOT, 'audit-005'));
const TIMEOUT_MS = 30000;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function write(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function isWithin(root, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function main() {
  ensureDir(OUT_ROOT);
  const startedAt = new Date().toISOString();
  const manifest = readJson(MANIFEST);
  const evidenceRoot = path.resolve(manifest.evidenceRoot);
  const command = [process.execPath, VERIFIER];
  const child = cp.spawnSync(process.execPath, [VERIFIER], {
    cwd: ROOT,
    windowsHide: true,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 96 * 1024 * 1024,
    env: Object.assign({}, process.env, {
      XJ_TASK_ID: TASK_ID,
      XJ_EVIDENCE_ROOT: evidenceRoot,
      XJ_EVIDENCE_MANIFEST: MANIFEST,
    }),
  });
  const stdout = Buffer.from(String(child.stdout || ''), 'utf8');
  const stderr = Buffer.from(String(child.stderr || ''), 'utf8');
  const stdoutPath = path.join(OUT_ROOT, 'verifier.stdout.json');
  const stderrPath = path.join(OUT_ROOT, 'verifier.stderr.txt');
  write(stdoutPath, stdout);
  write(stderrPath, stderr);
  const meta = {
    taskId: TASK_ID,
    audit: 'audit-005',
    verifier: VERIFIER,
    manifest: MANIFEST,
    evidenceRoot,
    command,
    cwd: ROOT,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: child.status == null ? null : child.status,
    signal: child.signal || null,
    timedOut: !!(child.error && child.error.code === 'ETIMEDOUT'),
    stdoutPath,
    stderrPath,
    stdoutSha256: sha256(stdout),
    stdoutBytes: stdout.length,
    stderrSha256: sha256(stderr),
    stderrBytes: stderr.length,
  };
  const checks = [];
  const check = (label, pass, details) => checks.push({ label, pass: !!pass, details: details === undefined ? null : details });
  check('manifest exists', fs.existsSync(MANIFEST), MANIFEST);
  check('verifier exit zero', meta.exitCode === 0 && meta.timedOut === false, { exitCode: meta.exitCode, timedOut: meta.timedOut });
  check('verifier stdout path in task scratch', isWithin(BASE_ROOT, stdoutPath), stdoutPath);
  check('verifier stderr path in task scratch', isWithin(BASE_ROOT, stderrPath), stderrPath);
  check('stdout bytes match', fs.readFileSync(stdoutPath).length === meta.stdoutBytes, { expected: meta.stdoutBytes, actual: fs.readFileSync(stdoutPath).length });
  check('stderr bytes match', fs.readFileSync(stderrPath).length === meta.stderrBytes, { expected: meta.stderrBytes, actual: fs.readFileSync(stderrPath).length });
  check('stdout SHA match', sha256(fs.readFileSync(stdoutPath)) === meta.stdoutSha256, meta.stdoutSha256);
  check('stderr SHA match', sha256(fs.readFileSync(stderrPath)) === meta.stderrSha256, meta.stderrSha256);
  let parsed = null;
  try { parsed = JSON.parse(stdout.toString('utf8')); } catch (error) { check('verifier stdout JSON', false, error.message); }
  check('verifier declares PASS', parsed && parsed.status === 'PASS' && parsed.errorCount === 0, parsed && { status: parsed.status, errorCount: parsed.errorCount, checkCount: parsed.checkCount });
  write(path.join(OUT_ROOT, 'audit-result.json'), JSON.stringify({ taskId: TASK_ID, audit: 'audit-005', meta, checkCount: checks.length, errorCount: checks.filter((item) => !item.pass).length, status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL', checks }, null, 2) + '\n');
  write(path.join(OUT_ROOT, 'audit.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  const result = { taskId: TASK_ID, audit: 'audit-005', evidenceRoot, verifierMeta: path.join(OUT_ROOT, 'audit.meta.json'), checkCount: checks.length, errorCount: checks.filter((item) => !item.pass).length, status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL', checks };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

main();
