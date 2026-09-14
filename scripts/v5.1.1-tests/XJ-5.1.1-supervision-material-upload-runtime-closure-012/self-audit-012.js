'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_ROOT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-supervision-material-upload-runtime-closure-012');
const AUDIT_ROOT = path.join(OUT_ROOT, 'self-audit-2026-08-26');
const HARNESS = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-supervision-material-upload-runtime-closure-012/electron-upload-harness-012.js');
const RUNTIME_VERIFY = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-supervision-material-upload-runtime-closure-012/runtime-verify-012.js');
fs.mkdirSync(AUDIT_ROOT, { recursive: true });

function write(file, value) {
  fs.writeFileSync(file, value, 'utf8');
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function runNode(args, stdoutPath, stderrPath) {
  const child = cp.spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  write(stdoutPath, child.stdout || '');
  write(stderrPath, child.stderr || '');
  return { exitCode: typeof child.status === 'number' ? child.status : 1, stdout: child.stdout || '', stderr: child.stderr || '' };
}

function harnessRun(id, scenario, mutation, expectedExit) {
  const dir = path.join(AUDIT_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const result = runNode([HARNESS, '--scenario=' + scenario, '--mutation=' + mutation], path.join(dir, 'harness.stdout.txt'), path.join(dir, 'harness.stderr.txt'));
  const detected = result.exitCode === expectedExit;
  const payload = parseJson(result.stdout.trim());
  let runPath = '';
  if (payload && payload.runtime && payload.runtime.viewportEvidence && payload.runtime.viewportEvidence[0] && payload.runtime.viewportEvidence[0].screenshot) {
    runPath = path.join(path.dirname(payload.runtime.viewportEvidence[0].screenshot.path), 'run.json');
  }
  return { id, scenario, mutation, harnessExit: result.exitCode, expectedExit, detected, runPath, stdoutPath: path.join(dir, 'harness.stdout.txt'), stderrPath: path.join(dir, 'harness.stderr.txt') };
}

function runtimeVerify(id, scenario, runPath, expectedExit) {
  const dir = path.join(AUDIT_ROOT, id);
  const result = runNode([RUNTIME_VERIFY, '--scenario=' + scenario, '--run=' + runPath], path.join(dir, 'verify.stdout.txt'), path.join(dir, 'verify.stderr.txt'));
  return Object.assign({}, { verifyExit: result.exitCode, verifyExpectedExit: expectedExit, detected: result.exitCode === expectedExit, verifyStdoutPath: path.join(dir, 'verify.stdout.txt'), verifyStderrPath: path.join(dir, 'verify.stderr.txt') });
}

const entries = [];
entries.push(harnessRun('A1-swallow-reader-error', 'success', 'swallow-reader-error', 1));
entries.push(harnessRun('A2-drop-promise-await', 'retry', 'drop-promise-await', 1));
entries.push(harnessRun('A3-retry-loses-file', 'retry', 'retry-loses-file', 1));
entries.push(harnessRun('A4-cancel-writes', 'cancel', 'cancel-writes', 1));

const fakeStateBaseline = harnessRun('A5-fake-state-baseline', 'cancel', 'none', 0);
if (!fakeStateBaseline.runPath || !fs.existsSync(fakeStateBaseline.runPath)) throw new Error('fake-state baseline run missing');
const fakeStateDir = path.join(AUDIT_ROOT, 'A5-fake-state');
fs.cpSync(path.dirname(fakeStateBaseline.runPath), fakeStateDir, { recursive: true });
const fakeStateRunPath = path.join(fakeStateDir, 'run.json');
const fakeStateRun = JSON.parse(fs.readFileSync(fakeStateRunPath, 'utf8'));
for (const evidence of fakeStateRun.runtime.viewportEvidence || []) {
  evidence.screenshot.path = path.join(fakeStateDir, path.basename(evidence.screenshot.path));
}
fakeStateRun.after.state = 'success';
write(fakeStateRunPath, JSON.stringify(fakeStateRun, null, 2) + '\n');
entries.push(Object.assign({}, fakeStateBaseline, { id: 'A5-fake-state', tamperedRunPath: fakeStateRunPath }, runtimeVerify('A5-fake-state', 'cancel', fakeStateRunPath, 1)));

const fakeShaHarness = harnessRun('A6-fake-screenshot-sha', 'success', 'fake-screenshot-sha', 0);
if (!fakeShaHarness.runPath || !fs.existsSync(fakeShaHarness.runPath)) throw new Error('fake-sha run missing');
entries.push(Object.assign({}, fakeShaHarness, runtimeVerify('A6-fake-screenshot-sha', 'success', fakeShaHarness.runPath, 1)));

entries.push(harnessRun('A7-skip-real-click', 'success', 'skip-real-click', 1));

const failures = entries.filter((entry) => !entry.detected);
const ledger = {
  schemaVersion: 1,
  taskId: 'XJ-5.1.1-supervision-material-upload-runtime-closure-012',
  generatedAt: new Date().toISOString(),
  cases: entries,
  verdict: failures.length ? 'FAIL' : 'PASS'
};
write(path.join(AUDIT_ROOT, 'ledger-012.json'), JSON.stringify(ledger, null, 2) + '\n');
if (failures.length) {
  process.stderr.write(JSON.stringify({ ok: false, verdict: 'FAIL', failures }) + '\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, verdict: 'PASS', cases: entries.map((entry) => entry.id), ledger: path.join(AUDIT_ROOT, 'ledger-012.json') }) + '\n');
