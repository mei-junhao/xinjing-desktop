'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.0-pi-workbench-mainline-merge-and-candidate-rebind-049';
const EV = path.join(ROOT, 'qa/task-scratch', TASK, 'evidence');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const stat = (p) => { const b = fs.readFileSync(p); return { path: p, sha256: sha(b), bytes: b.length }; };
const run = (command, args, cwd, stdoutName, stderrName) => {
  const started = new Date().toISOString();
  const r = spawnSync(command, args, { cwd, encoding: null, shell: false, windowsHide: true });
  const ended = new Date().toISOString();
  const outPath = path.join(EV, stdoutName); const errPath = path.join(EV, stderrName);
  fs.writeFileSync(outPath, Buffer.from(r.stdout || Buffer.alloc(0)));
  fs.writeFileSync(errPath, Buffer.from(r.stderr || Buffer.alloc(0)));
  return {
    command: [command, ...args], cwd, started, ended, exit: Number.isInteger(r.status) ? r.status : 1,
    stdout: stat(outPath), stderr: stat(errPath),
  };
};

const matrixVerifier = run(process.execPath, [path.join(EV, 'evidence-verifier-049.js'), EV, 'electron-matrix.json'], EV, 'matrix-verifier-049.stdout.raw', 'matrix-verifier-049.stderr.raw');
const adversarial = run(process.execPath, [path.join(EV, 'adversarial-049.js')], EV, 'adversarial-run-049.stdout.raw', 'adversarial-run-049.stderr.raw');
const expected = run(process.execPath, [path.join(ROOT, 'scripts/v5.1.0-tests/pi-workbench-mainline-049/build-expected-red-049.js')], ROOT, 'expected-red-run-049.stdout.raw', 'expected-red-run-049.stderr.raw');
const ui = run(process.execPath, [path.join(ROOT, 'scripts/v5.1.0-tests/pi-workbench-mainline-049/run-ui-fixed-049.js')], ROOT, 'ui-fixed-run-049.stdout.raw', 'ui-fixed-run-049.stderr.raw');
const selfTest = run(process.execPath, [path.join(ROOT, 'scripts/self-test.js')], ROOT, 'self-test-run-049.stdout.raw', 'self-test-run-049.stderr.raw');

const matrix = JSON.parse(fs.readFileSync(path.join(EV, 'electron-matrix.json'), 'utf8'));
const screenshots = matrix.cells.map((cell) => {
  const p = path.isAbsolute(cell.screenshot.path) ? cell.screenshot.path : path.join(EV, cell.screenshot.path);
  const actual = stat(p);
  return { declared: cell.screenshot, actual, matches: actual.sha256 === cell.screenshot.sha256 && actual.bytes === cell.screenshot.bytes };
});
const screenshotShas = screenshots.map((x) => x.actual.sha256);
const summary = {
  task_id: TASK,
  matrix: { cells: matrix.cells.length, screenshot_count: screenshots.length, unique_screenshot_sha256: new Set(screenshotShas).size, all_bound: screenshots.every((x) => x.matches), verifier_exit: matrixVerifier.exit },
  runs: { matrixVerifier, adversarial, expected, ui, selfTest },
};
fs.writeFileSync(path.join(EV, 'runs-bindings-049.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 2));
const ok = summary.matrix.cells === 18 && summary.matrix.screenshot_count === 18 && summary.matrix.unique_screenshot_sha256 === 18 && summary.matrix.all_bound && matrixVerifier.exit === 0 && adversarial.exit === 0 && expected.exit === 0 && ui.exit === 0;
process.exitCode = ok ? 0 : 1;
