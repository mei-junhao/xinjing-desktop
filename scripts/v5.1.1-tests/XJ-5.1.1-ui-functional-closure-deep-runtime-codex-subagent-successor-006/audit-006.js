'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.1-ui-functional-closure-deep-runtime-codex-subagent-successor-006';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK, 'audit');
const VERIFIER = path.join(__dirname, 'verifier-006.js');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
const now = () => new Date().toISOString();
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, 'utf8'); };
const writeJson = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
const parseLastJson = (stdout) => {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch (_) {} }
  return null;
};

function runVerifier(index) {
  const startedAt = now();
  const child = cp.spawnSync(process.execPath, [VERIFIER], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const endedAt = now();
  const stdout = String(child.stdout || '');
  const stderr = String(child.stderr || '');
  const stdoutPath = path.join(OUT, 'verifier-' + index + '.stdout.txt');
  const stderrPath = path.join(OUT, 'verifier-' + index + '.stderr.txt');
  write(stdoutPath, stdout); write(stderrPath, stderr);
  const exitCode = typeof child.status === 'number' ? child.status : -1;
  const meta = {
    taskId: TASK,
    stage: 'verifier-' + index,
    command: process.execPath + ' ' + JSON.stringify(VERIFIER),
    argv: [process.execPath, VERIFIER],
    cwd: ROOT.replace(/\\/g, '/'),
    startedAt,
    endedAt,
    exitCode,
    stdoutPath: stdoutPath.replace(/\\/g, '/'),
    stderrPath: stderrPath.replace(/\\/g, '/'),
    stdoutSha256: sha256(stdout),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrSha256: sha256(stderr),
    stderrBytes: Buffer.byteLength(stderr),
  };
  writeJson(path.join(OUT, 'verifier-' + index + '.meta.json'), meta);
  return { stdout, stderr, exitCode, meta, payload: parseLastJson(stdout) };
}

function rawBound(meta) {
  const result = { ok: true, errors: [] };
  for (const [pathKey, shaKey, bytesKey] of [['stdoutPath', 'stdoutSha256', 'stdoutBytes'], ['stderrPath', 'stderrSha256', 'stderrBytes']]) {
    const file = meta[pathKey];
    const absolute = typeof file === 'string' ? path.resolve(file) : '';
    const relative = absolute ? path.relative(path.resolve(OUT), absolute) : '..';
    let realRelative = '..';
    try { realRelative = path.relative(fs.realpathSync.native(OUT), fs.realpathSync.native(absolute)); } catch (_) {}
    if (!absolute || !path.isAbsolute(absolute) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative) || !fs.existsSync(absolute)) { result.ok = false; result.errors.push(pathKey + ' missing/outside'); continue; }
    const raw = fs.readFileSync(absolute, 'utf8');
    if (sha256(raw) !== meta[shaKey] || Buffer.byteLength(raw) !== meta[bytesKey]) { result.ok = false; result.errors.push(pathKey + ' hash/bytes mismatch'); }
  }
  return result;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const auditStartedAt = now();
  const first = runVerifier(1);
  const second = runVerifier(2);
  const errors = [];
  for (const [name, result] of [['verifier-1', first], ['verifier-2', second]]) {
    const bound = rawBound(result.meta);
    if (!bound.ok) errors.push(name + ': ' + bound.errors.join(', '));
    if (result.exitCode !== 0 || !result.payload || result.payload.ok !== true || result.payload.verdict !== 'PASS' || result.payload.errorCount !== 0 || result.payload.caseCount !== 15) errors.push(name + ': verifier verdict');
    if (!result.meta.startedAt || !result.meta.endedAt || Date.parse(result.meta.startedAt) >= Date.parse(result.meta.endedAt)) errors.push(name + ': UTC order');
  }
  if (first.stdout !== second.stdout) errors.push('verifier stdout differs across independent runs');
  const summary = { taskId: TASK, verifierRuns: 2, stdoutByteIdentical: first.stdout === second.stdout, verifierPass: errors.length === 0, errorCount: errors.length, errors };
  writeJson(path.join(OUT, 'audit-006.json'), summary);
  const auditStdout = JSON.stringify(summary) + '\n';
  const auditStdoutPath = path.join(OUT, 'audit.stdout.txt');
  const auditStderrPath = path.join(OUT, 'audit.stderr.txt');
  write(auditStdoutPath, auditStdout); write(auditStderrPath, '');
  const auditMeta = {
    taskId: TASK,
    stage: 'audit',
    command: process.execPath + ' ' + JSON.stringify(__filename),
    argv: [process.execPath, __filename],
    cwd: ROOT.replace(/\\/g, '/'),
    startedAt: auditStartedAt,
    endedAt: now(),
    exitCode: errors.length ? 1 : 0,
    stdoutPath: auditStdoutPath.replace(/\\/g, '/'),
    stderrPath: auditStderrPath.replace(/\\/g, '/'),
    stdoutSha256: sha256(auditStdout),
    stdoutBytes: Buffer.byteLength(auditStdout),
    stderrSha256: sha256(''),
    stderrBytes: 0,
  };
  writeJson(path.join(OUT, 'audit.meta.json'), auditMeta);
  const own = rawBound(auditMeta);
  if (!own.ok) { summary.verifierPass = false; summary.errorCount += own.errors.length; summary.errors.push.apply(summary.errors, own.errors); writeJson(path.join(OUT, 'audit-006.json'), summary); }
  process.stdout.write(auditStdout);
  process.exitCode = summary.verifierPass ? 0 : 1;
}

try { main(); } catch (error) { process.stderr.write((error && error.stack) || String(error)); process.stderr.write('\n'); process.exitCode = 1; }
