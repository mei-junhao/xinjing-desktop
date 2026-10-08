'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005';
const BASE = path.join(ROOT, 'qa', 'task-scratch', TASK, 'evidence');
const OUT = path.join(BASE, 'expected-red');
const VERIFIER = path.join(ROOT, 'scripts', 'v5.1.1-tests', TASK, 'verifier-005.js');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function copyEvidence(dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(BASE, 'screenshots'), path.join(dest, 'screenshots'), { recursive: true });
  const matrix = JSON.parse(fs.readFileSync(path.join(BASE, 'matrix.json'), 'utf8'));
  for (const cell of matrix.cells || []) for (const route of cell.routes || []) {
    const name = path.basename(route.screenshot.path);
    route.screenshot.path = path.join(dest, 'screenshots', name);
    route.screenshot.relativePath = `screenshots/${name}`;
  }
  fs.writeFileSync(path.join(dest, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n', 'utf8');
}
function writeRaw(file, text) { const b = Buffer.from(String(text || ''), 'utf8'); fs.writeFileSync(file, b); return { path: file, sha256: sha256(b), bytes: b.length }; }
function runVerifier(dir, label) {
  const start = new Date().toISOString(); const args = [VERIFIER, `--evidence=${dir}`];
  const r = childProcess.spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const end = new Date().toISOString(); const rawDir = path.join(dir, 'raw'); fs.mkdirSync(rawDir, { recursive: true });
  const stdout = writeRaw(path.join(rawDir, `${label}.stdout.txt`), r.stdout || ''); const stderr = writeRaw(path.join(rawDir, `${label}.stderr.txt`), r.stderr || '');
  const meta = { task_id: TASK, label, command: process.execPath, argv: [process.execPath, ...args], cwd: ROOT, startUtc: start, endUtc: end, exitCode: r.status == null ? -1 : r.status, stdoutPath: stdout.path, stderrPath: stderr.path, stdoutSha256: stdout.sha256, stdoutBytes: stdout.bytes, stderrSha256: stderr.sha256, stderrBytes: stderr.bytes };
  const metaPath = path.join(rawDir, `${label}.meta.json`); fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { exitCode: meta.exitCode, stdout, stderr, meta: { path: metaPath, sha256: sha256(fs.readFileSync(metaPath)), bytes: fs.statSync(metaPath).size } };
}
function mutate(caseId, dir) {
  const file = path.join(dir, 'matrix.json'); const m = JSON.parse(fs.readFileSync(file, 'utf8')); const c = m.cells[0];
  if (caseId === 'delete-screenshot') fs.unlinkSync(c.routes[0].screenshot.path);
  if (caseId === 'replace-old-screenshot') c.routes[0].screenshot.path = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-ui-functional-closure-codex-subagent-successor-004', 'evidence', 'old.png');
  if (caseId === 'delete-keyboard-focus') delete c.keyboardFocus;
  if (caseId === 'fake-reduced-motion') c.reducedMotion.mqMatches = false;
  if (caseId === 'fake-overflow') c.overflow.horizontal.hasHorizontalOverflow = true;
  if (caseId === 'tamper-screenshot-sha') c.routes[0].screenshot.sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
  if (caseId === 'reuse-history-raw') c.routes[1].screenshot.path = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-ui-functional-closure-codex-subagent-successor-004', 'evidence', 'runtime-closure-011.json');
  if (caseId === 'summary-only') { m.matrix.count = 1; m.cells = []; }
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n', 'utf8');
}
const CASES = ['delete-screenshot','replace-old-screenshot','delete-keyboard-focus','fake-reduced-motion','fake-overflow','tamper-screenshot-sha','reuse-history-raw','summary-only'];
const rows = [];
for (const id of CASES) {
  const root = path.join(OUT, id); const baseline = path.join(root, 'baseline'); const mutated = path.join(root, 'mutated'); const restore = path.join(root, 'restore');
  copyEvidence(baseline); copyEvidence(mutated); copyEvidence(restore); mutate(id, mutated);
  const b = runVerifier(baseline, 'baseline'); const m = runVerifier(mutated, 'mutated'); const r = runVerifier(restore, 'restore');
  rows.push({ id, baseline: b, mutated: m, restore: r, verdict: b.exitCode === 0 && m.exitCode !== 0 && r.exitCode === 0 ? 'KILLED' : 'SURVIVED' });
  console.log(`${id}: ${rows[rows.length - 1].verdict}`);
}
const out = { task_id: TASK, generatedUtc: new Date().toISOString(), caseCount: rows.length, killed: rows.filter((x) => x.verdict === 'KILLED').length, cases: rows };
fs.writeFileSync(path.join(OUT, 'expected-red.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
process.exitCode = out.killed === out.caseCount ? 0 : 1;
