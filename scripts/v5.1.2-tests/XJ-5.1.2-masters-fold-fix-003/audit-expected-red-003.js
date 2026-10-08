'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE_ROOT = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.2-masters-fold-fix-003', 'expected-red-003');
const OUT_DIR = path.join(EVIDENCE_ROOT, 'verifier-self');
const VERIFIER = path.join(__dirname, 'verify-expected-red-003.js');
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function write(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, value); }

function main() {
  ensureDir(OUT_DIR);
  const command = [process.execPath, VERIFIER];
  const startedAt = new Date().toISOString();
  const child = cp.spawnSync(process.execPath, [VERIFIER], { cwd:ROOT, encoding:'utf8', windowsHide:true, maxBuffer:32 * 1024 * 1024 });
  const stdout = Buffer.from(String(child.stdout || ''), 'utf8');
  const stderr = Buffer.from(String(child.stderr || ''), 'utf8');
  const stdoutPath = path.join(OUT_DIR, 'verifier.stdout.txt');
  const stderrPath = path.join(OUT_DIR, 'verifier.stderr.txt');
  write(stdoutPath, stdout); write(stderrPath, stderr);
  const meta = {
    taskId:'XJ-5.1.2-masters-fold-fix-003', verifier:'verify-expected-red-003', command, cwd:ROOT,
    startedAt, finishedAt:new Date().toISOString(), exitCode:child.status == null ? null : child.status, signal:child.signal || null,
    stdoutPath, stderrPath, stdoutSha256:sha256(stdout), stdoutBytes:stdout.length, stderrSha256:sha256(stderr), stderrBytes:stderr.length,
  };
  write(path.join(OUT_DIR, 'verifier.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ taskId:meta.taskId, verifier:meta.verifier, exitCode:meta.exitCode, stdoutPath, stderrPath, stdoutSha256:meta.stdoutSha256, stderrSha256:meta.stderrSha256 }, null, 2) + '\n');
  process.exitCode = meta.exitCode === 0 ? 0 : 2;
}

main();
