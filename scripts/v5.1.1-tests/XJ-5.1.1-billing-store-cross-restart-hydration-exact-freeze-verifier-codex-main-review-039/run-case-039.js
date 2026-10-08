'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-codex-main-review-039';
const SCRIPT = path.join(__dirname, 'verifier-039.js');

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parseArgs() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) { const k = a[i].slice(2); out[k] = a[i + 1]; i += 1; }
  return out;
}
function run() {
  const o = parseArgs();
  if (!o.binding || !o.manifest || !o.out || !o.case || !o.stage) throw new Error('binding, manifest, out, case, stage required');
  const outDir = path.resolve(o.out);
  fs.mkdirSync(outDir, { recursive: true });
  const stdoutPath = path.join(outDir, 'stdout.txt');
  const stderrPath = path.join(outDir, 'stderr.txt');
  const argv = [SCRIPT, '--binding', path.resolve(o.binding), '--manifest', path.resolve(o.manifest)];
  if (o.comparator) argv.push('--comparator', o.comparator);
  const start = new Date().toISOString();
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const child = spawnSync(process.execPath, argv, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  fs.writeFileSync(stdoutPath, stdout, 'utf8');
  fs.writeFileSync(stderrPath, stderr, 'utf8');
  const end = new Date().toISOString();
  const meta = {
    schema: 'xj.v511.codex-main-review-run.v1',
    taskId: TASK_ID,
    caseId: String(o.case),
    stage: String(o.stage),
    command: process.execPath,
    argv,
    cwd: projectRoot,
    startUtc: start,
    endUtc: end,
    exitCode: child.status,
    stdoutPath,
    stderrPath,
    stdoutSha256: sha(Buffer.from(stdout, 'utf8')),
    stderrSha256: sha(Buffer.from(stderr, 'utf8')),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    verdict: child.status === 0 ? 'PASS' : 'FAIL'
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(meta));
  process.exitCode = child.status === 0 ? 0 : 1;
}
try { run(); } catch (error) { process.stderr.write(String(error.message || error)); process.exitCode = 1; }
