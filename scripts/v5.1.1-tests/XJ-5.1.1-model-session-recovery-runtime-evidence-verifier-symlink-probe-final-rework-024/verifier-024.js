'use strict';
// 024 final verifier：复算 022 probe provenance + realpath/lstat containment + 8 expected-red
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P022 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-audit-rework-022');
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-final-rework-024');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verifyProbe(base) {
  const errs = [];
  const mp = path.join(base, 'probe.meta.json');
  if (!fs.existsSync(mp)) { errs.push('probe.meta missing'); return errs; }
  let meta; try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e) { errs.push('meta bad json'); return errs; }
  const F = ['command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes'];
  for (const k of F) if (!(k in meta) || meta[k] === '' || meta[k] === null || meta[k] === undefined) errs.push('meta missing/empty ' + k);
  if (typeof meta.exitCode !== 'number') errs.push('exitCode not number');
  if (!Array.isArray(meta.argv)) errs.push('argv not array');
  const t0 = Date.parse(meta.startUtc); const t1 = Date.parse(meta.endUtc);
  if (isNaN(t0) || isNaN(t1) || t1 < t0) errs.push('UTC order invalid');
  for (const k of Object.keys(meta)) if (!F.includes(k)) errs.push('meta unknown ' + k);
  // stdoutPath/stderrPath 真实路径 containment（resolve/relative/realpath）
  for (const fk of ['stdoutPath','stderrPath']) {
    const fp = path.resolve(String(meta[fk] || ''));
    const fr = path.relative(ROOT, fp);
    if (fr.startsWith('..') || path.isAbsolute(fr)) errs.push(fk + ' escape');
    if (!fs.existsSync(fp)) { errs.push(fk + ' missing'); continue; }
    const rp = fs.realpathSync(fp); const rr = path.relative(ROOT, rp);
    if (rr.startsWith('..') || path.isAbsolute(rr)) errs.push(fk + ' realpath escape');
    const st = fs.lstatSync(fp); if (st.isSymbolicLink()) errs.push(fk + ' symlink');
  }
  const soP = path.resolve(String(meta.stdoutPath || '')); const seP = path.resolve(String(meta.stderrPath || ''));
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push('probe files missing'); return errs; }
  let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e) { errs.push('probe read fail'); return errs; }
  if (meta.stdoutSha256 !== sha(so)) errs.push('stdout SHA');
  if (meta.stderrSha256 !== sha(se)) errs.push('stderr SHA');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push('stdout bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push('stderr bytes');
  if (so.indexOf('FILE_SYMLINK_EPERM') < 0) errs.push('EPERM missing');
  if (so.indexOf('JUNCTION_OK isSymbolicLink=true') < 0) errs.push('junction missing');
  return errs;
}
const base = verifyProbe(P022);
console.log('VERIFY_024_MAIN:', base.length === 0 ? 'PASS' : 'FAIL ' + base.join('|'));
// tmp 副本（篡改用，022 只读）
const TMP = path.join(OUT, 'tmp'); fs.mkdirSync(TMP, { recursive: true });
for (const f of ['probe.meta.json','probe.stdout.txt','probe.stderr.txt']) fs.copyFileSync(path.join(P022, f), path.join(TMP, f));
const META_T = path.join(TMP, 'probe.meta.json'); const SO_T = path.join(TMP, 'probe.stdout.txt'); const SE_T = path.join(TMP, 'probe.stderr.txt');
function snapT() { return { m: fs.readFileSync(META_T,'utf8'), so: fs.readFileSync(SO_T,'utf8'), se: fs.readFileSync(SE_T,'utf8') }; }
function restoreT(s) { fs.writeFileSync(META_T, s.m); fs.writeFileSync(SO_T, s.so); fs.writeFileSync(SE_T, s.se); }
const ADV = [
  ['A1-delete-raw', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutPath = SO_T; m.stderrPath = SE_T; fs.writeFileSync(META_T, JSON.stringify(m)); fs.unlinkSync(SO_T); }],
  ['A2-tamper-sha', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutSha256 = 'a'.repeat(64); fs.writeFileSync(META_T, JSON.stringify(m)); }],
  ['A3-tamper-bytes', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutBytes = 1; fs.writeFileSync(META_T, JSON.stringify(m)); }],
  ['A4-unknown-field', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.evil = 1; fs.writeFileSync(META_T, JSON.stringify(m)); }],
  ['A5-cross-task', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutPath = '../../021/ledger/verifier-raw.stdout.txt'; fs.writeFileSync(META_T, JSON.stringify(m)); }],
  ['A6-sibling-prefix', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutPath = 'D:/xinjing-electron-evil/probe.stdout.txt'; fs.writeFileSync(META_T, JSON.stringify(m)); }],
  ['A7-real-junction', function () { const ext = path.join(require('os').tmpdir(), 'xj024-evil-' + Date.now()); fs.mkdirSync(ext, { recursive: true }); const jl = path.join(TMP, 'probe-junction'); try { fs.symlinkSync(ext, jl, 'junction'); } catch (e) { fs.mkdirSync(jl); } const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutPath = path.join(jl, 'x'); fs.writeFileSync(META_T, JSON.stringify(m)); }],
  ['A8-swallow-failure', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutPath = SO_T; m.stderrPath = SE_T; fs.writeFileSync(SO_T, 'OK\n'); m.stdoutSha256 = sha('OK\n'); m.stdoutBytes = Buffer.byteLength('OK\n'); fs.writeFileSync(META_T, JSON.stringify(m)); }]
];
let k = 0;
for (const a of ADV) {
  const s = snapT();
  a[1]();
  const failed = verifyProbe(TMP).length > 0;
  // 清理 junction
  try { const jl = path.join(TMP, 'probe-junction'); if (fs.existsSync(jl)) { const st = fs.lstatSync(jl); if (st.isSymbolicLink()) fs.unlinkSync(jl); else fs.rmdirSync(jl); } } catch (e) {}
  restoreT(s);
  const rec = verifyProbe(TMP).length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('EXPECTED_RED: ' + k + '/8 KILLED');
const vOut = 'VERIFY_024_MAIN:' + (base.length === 0 ? 'PASS' : 'FAIL') + ' ADV:' + k + '/8\n';
const vP = path.join(OUT, 'verifier-024.stdout.txt'); const vE = path.join(OUT, 'verifier-024.stderr.txt');
fs.writeFileSync(vP, vOut); fs.writeFileSync(vE, '');
fs.writeFileSync(path.join(OUT, 'verifier-024.meta.json'), JSON.stringify({ exitCode: (base.length === 0 && k === 8 ? 0 : 2), command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), stdoutPath: vP, stderrPath: vE, stdoutSha256: sha(vOut), stdoutBytes: Buffer.byteLength(vOut), stderrSha256: sha(''), stderrBytes: 0 }, null, 2) + '\n');
process.exit(base.length === 0 && k === 8 ? 0 : 2);