'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-workbench-mainline-merge-and-candidate-rebind-049/evidence');
const verifier = path.join(EVIDENCE, 'evidence-verifier-049.js');
const matrixPath = path.join(EVIDENCE, 'electron-matrix.json');
const base = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const variants = [
  { name: 'R2-delete-visual-fields', mutate: (m) => { delete m.cells[0].keyboardFocus; delete m.cells[1].reducedMotion; } },
  { name: 'R8-totals-only', mutate: (m) => { m.cells = undefined; m.summary = { count: 18 }; } },
  { name: 'R8b-replace-cell-count', mutate: (m) => { m.cells = m.cells.slice(0, 17); } }
];
const results = [];
for (const v of variants) {
  const json = JSON.parse(JSON.stringify(base)); v.mutate(json);
  const input = path.join(EVIDENCE, v.name + '.json');
  fs.writeFileSync(input, JSON.stringify(json, null, 2) + '\n', 'utf8');
  const start = new Date().toISOString();
  const run = spawnSync(process.execPath, [verifier, EVIDENCE, path.basename(input)], { cwd: EVIDENCE, encoding: 'utf8', shell: false, windowsHide: true });
  const end = new Date().toISOString();
  const stdoutPath = path.join(EVIDENCE, v.name + '.stdout.raw');
  const stderrPath = path.join(EVIDENCE, v.name + '.stderr.raw');
  fs.writeFileSync(stdoutPath, String(run.stdout || ''), 'utf8');
  fs.writeFileSync(stderrPath, String(run.stderr || ''), 'utf8');
  const outBuf = fs.readFileSync(stdoutPath); const errBuf = fs.readFileSync(stderrPath);
  results.push({
    name: v.name,
    exit: run.status,
    fail_closed: run.status !== 0,
    command: `${process.execPath} ${verifier} ${EVIDENCE} ${path.basename(input)}`,
    cwd: EVIDENCE,
    start,
    end,
    stdout: stdoutPath,
    stderr: stderrPath,
    stdout_sha256: sha(outBuf),
    stderr_sha256: sha(errBuf),
    stdout_bytes: outBuf.length,
    stderr_bytes: errBuf.length
  });
  console.log(`${v.name}: exit=${run.status} fail_closed=${run.status !== 0}`);
}
const out = { task_id: 'XJ-5.1.0-pi-workbench-mainline-merge-and-candidate-rebind-049', count: results.length, killed: results.filter((x) => x.fail_closed).length, results };
fs.writeFileSync(path.join(EVIDENCE, 'expected-red-049.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
process.exitCode = out.killed === out.count ? 0 : 2;
