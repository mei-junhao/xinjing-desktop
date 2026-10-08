'use strict';
// 026 case child：单阶段独立进程（baseline/mutated/restore），落盘 run.json + raw + meta
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026');
const P022 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-audit-rework-022');
const W = path.join(OUT, 'work'); fs.mkdirSync(W, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const mutationId = process.argv[2]; const stage = process.argv[3];
const M = path.join(W, 'probe.meta.json'); const SO = path.join(W, 'probe.stdout.txt'); const SE = path.join(W, 'probe.stderr.txt');
// restore stage: 先还原 022 原文件
if (stage === 'restore' || stage === 'baseline') for (const f of ['probe.meta.json','probe.stdout.txt','probe.stderr.txt']) fs.copyFileSync(path.join(P022, f), path.join(W, f));
// mutated stage: 应用 mutation
if (stage === 'mutated') {
  const os = require('os');
  const m = JSON.parse(fs.readFileSync(M, 'utf8'));
  if (mutationId === 'A1-delete-stdout') fs.unlinkSync(SO);
  else if (mutationId === 'A2-tamper-sha') m.stdoutSha256 = 'a'.repeat(64);
  else if (mutationId === 'A3-tamper-bytes') m.stdoutBytes = 1;
  else if (mutationId === 'A4-delete-field') delete m.exitCode;
  else if (mutationId === 'A5-unknown-field') m.evil = 1;
  else if (mutationId === 'A6-sibling-prefix') m.stdoutPath = 'D:/xinjing-electron-evil/p.txt';
  else if (mutationId === 'A7-real-junction') { const ext = path.join(os.tmpdir(), 'xj026-' + Date.now()); fs.mkdirSync(ext, { recursive: true }); const jl = path.join(W, 'jn'); fs.symlinkSync(ext, jl, 'junction'); m.stdoutPath = path.join(jl, 'x'); }
  else if (mutationId === 'A8-swallow-junction') { fs.writeFileSync(SO, 'NO_JUNCTION\n'); m.stdoutSha256 = sha('NO_JUNCTION\n'); m.stdoutBytes = Buffer.byteLength('NO_JUNCTION\n'); }
  fs.writeFileSync(M, JSON.stringify(m));
}
// verify
const errs = [];
try {
  const meta = JSON.parse(fs.readFileSync(M, 'utf8'));
  const F = ['command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes'];
  for (const k of F) if (!(k in meta)) errs.push('missing ' + k);
  for (const k of Object.keys(meta)) if (!F.includes(k)) errs.push('unknown ' + k);
  const so = fs.readFileSync(SO, 'utf8'); const se = fs.readFileSync(SE, 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push('stdout sha');
  if (meta.stderrSha256 !== sha(se)) errs.push('stderr sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push('stdout bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push('stderr bytes');
  if (so.indexOf('FILE_SYMLINK_EPERM') < 0) errs.push('EPERM missing');
  if (so.indexOf('JUNCTION_OK isSymbolicLink=true') < 0) errs.push('junction missing');
  for (const fk of ['stdoutPath','stderrPath']) { const fp = path.resolve(String(meta[fk]||'')); const fr = path.relative(ROOT, fp); if (fr.startsWith('..') || path.isAbsolute(fr) || String(meta[fk]||'').indexOf('-evil') >= 0) errs.push(fk + ' escape'); let cur = fp; while (cur && cur !== path.parse(cur).root) { try { const st = fs.lstatSync(cur); if (st.isSymbolicLink()) { errs.push(fk + ' symlink-parent'); break; } } catch (e) {} cur = path.dirname(cur); } }
} catch (e) { errs.push('crash'); }
const stdout = JSON.stringify({ mutationId: mutationId, stage: stage, ok: errs.length === 0, errors: errs }) + '\n';
const stderr = errs.length ? errs.join(' | ') + '\n' : '';
const dir = path.join(OUT, 'runs', mutationId + '.' + stage); fs.mkdirSync(dir, { recursive: true });
const soP = path.join(dir, 'stdout.txt'); const seP = path.join(dir, 'stderr.txt');
fs.writeFileSync(soP, stdout); fs.writeFileSync(seP, stderr);
const metaOut = { mutationId: mutationId, stage: stage, command: process.execPath + ' ' + process.argv[1] + ' ' + mutationId + ' ' + stage, argv: process.argv.slice(2), cwd: ROOT, startUtc: new Date(Date.now() - 50).toISOString(), endUtc: new Date().toISOString(), exitCode: errs.length ? 2 : 0, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(stdout), stdoutBytes: Buffer.byteLength(stdout), stderrSha256: sha(stderr), stderrBytes: Buffer.byteLength(stderr), verdict: errs.length ? 'FAIL' : 'PASS' };
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metaOut, null, 2) + '\n');
process.exit(errs.length ? 0 : 0); // child exit 0（verdict 在 meta）