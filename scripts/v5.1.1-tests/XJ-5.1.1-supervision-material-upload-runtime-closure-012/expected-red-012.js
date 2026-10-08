'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-supervision-material-upload-runtime-closure-012', 'expected-red');
const HARNESS = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-supervision-material-upload-runtime-closure-012/electron-upload-harness-012.js');
const CASES = [
  { id: 'E1-delete-failure', scenario: 'retry', mutation: 'delete-failure' },
  { id: 'E2-delete-retry', scenario: 'retry', mutation: 'delete-retry' },
  { id: 'E3-delete-cancel', scenario: 'cancel', mutation: 'delete-cancel' },
  { id: 'E4-cancel-writes', scenario: 'cancel', mutation: 'cancel-writes' },
];

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex').toUpperCase(); }
function write(file, value) { fs.writeFileSync(file, value, 'utf8'); }
function writeJson(file, value) { write(file, JSON.stringify(value, null, 2) + '\n'); }
function now() { return new Date().toISOString(); }

function runStage(caseInfo, stage, mutation) {
  const caseDir = path.join(OUT, caseInfo.id);
  fs.mkdirSync(caseDir, { recursive: true });
  const args = [HARNESS, '--scenario=' + caseInfo.scenario, '--mutation=' + mutation];
  const command = process.execPath + ' ' + args.map((arg) => JSON.stringify(arg)).join(' ');
  const startedAt = now();
  const child = cp.spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const endedAt = now();
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  const stdoutPath = path.join(caseDir, stage + '.stdout.txt');
  const stderrPath = path.join(caseDir, stage + '.stderr.txt');
  write(stdoutPath, stdout);
  write(stderrPath, stderr);
  let payload = null;
  try {
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    payload = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch (_) {}
  const exitCode = typeof child.status === 'number' ? child.status : -1;
  const expectedExit = stage === 'mutated' ? 1 : 0;
  const verdict = exitCode === expectedExit && (stage === 'mutated' ? !(payload && payload.ok === true) : !!(payload && payload.ok === true)) ? 'PASS' : 'FAIL';
  return {
    caseId: caseInfo.id,
    scenario: caseInfo.scenario,
    mutation,
    stage,
    verdict,
    expectedExit,
    exitCode,
    signal: child.signal || null,
    command,
    argv: [process.execPath].concat(args),
    cwd: ROOT,
    startedAt,
    endedAt,
    stdoutPath,
    stderrPath,
    stdoutSha256: sha256(stdout),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrSha256: sha256(stderr),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    payload,
  };
}

function assertRaw(entry) {
  if (!fs.existsSync(entry.stdoutPath) || !fs.existsSync(entry.stderrPath)) throw new Error(entry.caseId + '.' + entry.stage + ' raw missing');
  const stdout = fs.readFileSync(entry.stdoutPath, 'utf8');
  const stderr = fs.readFileSync(entry.stderrPath, 'utf8');
  if (sha256(stdout) !== entry.stdoutSha256 || Buffer.byteLength(stdout, 'utf8') !== entry.stdoutBytes) throw new Error(entry.caseId + '.' + entry.stage + ' stdout binding mismatch');
  if (sha256(stderr) !== entry.stderrSha256 || Buffer.byteLength(stderr, 'utf8') !== entry.stderrBytes) throw new Error(entry.caseId + '.' + entry.stage + ' stderr binding mismatch');
  if (!path.isAbsolute(entry.stdoutPath) || !path.isAbsolute(entry.stderrPath)) throw new Error(entry.caseId + '.' + entry.stage + ' paths not absolute');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const entries = [];
  for (const caseInfo of CASES) {
    entries.push(runStage(caseInfo, 'baseline', 'none'));
    entries.push(runStage(caseInfo, 'mutated', caseInfo.mutation));
    entries.push(runStage(caseInfo, 'restored', 'none'));
  }
  entries.forEach(assertRaw);
  const byCase = new Map();
  entries.forEach((entry) => { if (!byCase.has(entry.caseId)) byCase.set(entry.caseId, []); byCase.get(entry.caseId).push(entry); });
  for (const caseInfo of CASES) {
    const stages = byCase.get(caseInfo.id) || [];
    if (stages.length !== 3 || stages.some((entry) => entry.verdict !== 'PASS')) throw new Error(caseInfo.id + ' expected-red closure failed');
    const baseline = stages.find((entry) => entry.stage === 'baseline');
    const mutated = stages.find((entry) => entry.stage === 'mutated');
    const restored = stages.find((entry) => entry.stage === 'restored');
    if (!baseline.payload || !baseline.payload.ok || !restored.payload || !restored.payload.ok) throw new Error(caseInfo.id + ' baseline/restored payload not PASS');
    if (mutated.payload && mutated.payload.ok === true) throw new Error(caseInfo.id + ' mutation unexpectedly reported PASS');
  }
  const ledger = { schemaVersion: 1, taskId: 'XJ-5.1.1-supervision-material-upload-runtime-closure-012', generatedAt: now(), cwd: ROOT, command: process.execPath + ' ' + process.argv.slice(1).map((arg) => JSON.stringify(arg)).join(' '), cases: CASES, entries, verdict: 'PASS' };
  writeJson(path.join(OUT, 'ledger-012.json'), ledger);
  process.stdout.write(JSON.stringify({ ok: true, verdict: 'PASS', cases: CASES.map((item) => item.id), ledger: path.join(OUT, 'ledger-012.json') }) + '\n');
}

try { main(); } catch (error) { process.stderr.write((error && error.stack) || String(error)); process.stderr.write('\n'); process.exit(1); }
