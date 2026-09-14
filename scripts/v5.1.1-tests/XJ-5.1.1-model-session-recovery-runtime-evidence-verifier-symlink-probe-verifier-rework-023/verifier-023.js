'use strict';
// 023 verifier：逐字段复算 022 probe meta/raw（022 只读引用）+ 4 项 expected-red
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P022 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-audit-rework-022');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verifyProbe() {
  const errs = [];
  const mp = path.join(P022, 'probe.meta.json');
  if (!fs.existsSync(mp)) { errs.push('probe.meta missing'); return errs; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const F = ['command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes'];
  for (const k of F) if (!(k in meta)) errs.push('meta missing ' + k);
  for (const k of Object.keys(meta)) if (!F.includes(k)) errs.push('meta unknown ' + k);
  if (!fs.existsSync(meta.stdoutPath)) errs.push('stdoutPath missing');
  if (!fs.existsSync(meta.stderrPath)) errs.push('stderrPath missing');
  const so = fs.readFileSync(meta.stdoutPath, 'utf8');
  const se = fs.readFileSync(meta.stderrPath, 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push('stdout SHA mismatch');
  if (meta.stderrSha256 !== sha(se)) errs.push('stderr SHA mismatch');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push('stdout bytes mismatch');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push('stderr bytes mismatch');
  // probe 结果语义：EPERM 如实 + junction isSymbolicLink=true
  if (so.indexOf('FILE_SYMLINK_EPERM') < 0) errs.push('EPERM not recorded');
  if (so.indexOf('JUNCTION_OK isSymbolicLink=true') < 0) errs.push('junction not verified');
  return errs;
}
const base = verifyProbe();
console.log('VERIFY_023_MAIN:', base.length === 0 ? 'PASS' : 'FAIL ' + base.join('|'));
// 4 项 expected-red（篡改 022 probe 副本——复制到 023 tmp 后篡改，不写 022 原文件）
const TMP = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-verifier-rework-023/tmp');
fs.mkdirSync(TMP, { recursive: true });
// 复制 022 probe 文件到 023 tmp 作为可篡改副本
fs.copyFileSync(path.join(P022, 'probe.meta.json'), path.join(TMP, 'probe.meta.json'));
fs.copyFileSync(path.join(P022, 'probe.stdout.txt'), path.join(TMP, 'probe.stdout.txt'));
fs.copyFileSync(path.join(P022, 'probe.stderr.txt'), path.join(TMP, 'probe.stderr.txt'));
const META_T = path.join(TMP, 'probe.meta.json'); const SO_T = path.join(TMP, 'probe.stdout.txt'); const SE_T = path.join(TMP, 'probe.stderr.txt');
function verifyTmp() {
  const errs = [];
  if (!fs.existsSync(META_T) || !fs.existsSync(SO_T) || !fs.existsSync(SE_T)) { errs.push('probe file missing'); return errs; }
  const meta = JSON.parse(fs.readFileSync(META_T, 'utf8'));
  const so = fs.readFileSync(SO_T, 'utf8'); const se = fs.readFileSync(SE_T, 'utf8');
  const sp = path.resolve(String(meta.stdoutPath || ''));
  const sr = path.relative(ROOT, sp);
  if (sr.startsWith('..') || path.isAbsolute(sr) || String(meta.stdoutPath||'').indexOf('021/') >= 0) errs.push('stdoutPath cross-task');
  if (meta.stdoutSha256 !== sha(so)) errs.push('stdout SHA mismatch');
  if (meta.stderrSha256 !== sha(se)) errs.push('stderr SHA mismatch');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push('stdout bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push('stderr bytes');
  if (so.indexOf('FILE_SYMLINK_EPERM') < 0) errs.push('EPERM missing');
  if (so.indexOf('JUNCTION_OK isSymbolicLink=true') < 0) errs.push('junction missing');
  return errs;
}
const ADV = [
  ['A1-delete-probe-raw', function () { fs.unlinkSync(SO_T); }, function () { fs.writeFileSync(SO_T, fs.readFileSync(path.join(P022, 'probe.stdout.txt'), 'utf8')); }],
  ['A2-tamper-sha', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutSha256 = 'd'.repeat(64); fs.writeFileSync(META_T, JSON.stringify(m)); }, function () { fs.writeFileSync(META_T, fs.readFileSync(path.join(P022, 'probe.meta.json'), 'utf8')); }],
  ['A3-cross-task-path', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutPath = '../../021/ledger/verifier-raw.stdout.txt'; fs.writeFileSync(META_T, JSON.stringify(m)); }, function () { fs.writeFileSync(META_T, fs.readFileSync(path.join(P022, 'probe.meta.json'), 'utf8')); }],
  ['A4-swallow-failure', function () { const m = JSON.parse(fs.readFileSync(META_T,'utf8')); m.stdoutSha256 = sha(fs.readFileSync(SO_T, 'utf8')); fs.writeFileSync(SO_T, 'NO_EPERM_NO_JUNCTION\n'); fs.writeFileSync(META_T, JSON.stringify(m)); }, function () { fs.writeFileSync(SO_T, fs.readFileSync(path.join(P022, 'probe.stdout.txt'), 'utf8')); fs.writeFileSync(META_T, fs.readFileSync(path.join(P022, 'probe.meta.json'), 'utf8')); }]
];
let k = 0;
for (const a of ADV) {
  a[1](); const failed = verifyTmp().length > 0; a[2](); const rec = verifyTmp().length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('EXPECTED_RED: ' + k + '/4 KILLED');
fs.writeFileSync(path.join(TMP, '..', 'verifier-023.out.txt'), 'VERIFY:' + (base.length === 0 ? 'PASS' : 'FAIL') + ' ADV:' + k + '/4\n');
process.exit(base.length === 0 && k === 4 ? 0 : 2);