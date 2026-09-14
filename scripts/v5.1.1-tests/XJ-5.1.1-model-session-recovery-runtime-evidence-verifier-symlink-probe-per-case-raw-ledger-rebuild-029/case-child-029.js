'use strict';
// 030 case child：每次独立进程本轮真实生成 probe（FILE_SYMLINK_EPERM + JUNCTION_OK 探针），禁 copyFileSync 旧 raw
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const os = require('os');
const ROOT = 'D:/xinjing-electron';
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rebuild-029');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const mutationId = process.argv[2]; const stage = process.argv[3];
const dir = path.join(OUT, 'runs', mutationId + '.' + stage); fs.mkdirSync(dir, { recursive: true });
// 本轮生成 probe：file symlink + junction 探针
const DIR = path.join(os.tmpdir(), 'xj030-' + mutationId + '-' + stage + '-' + Date.now()); fs.mkdirSync(DIR, { recursive: true });
const probeOut = []; const probeErr = [];
const ft = path.join(DIR, 'ft.txt'); const fl = path.join(DIR, 'fl.txt'); fs.writeFileSync(ft, 'x');
try { fs.symlinkSync(ft, fl); probeOut.push('FILE_SYMLINK_OK isSymbolicLink=' + fs.lstatSync(fl).isSymbolicLink()); fs.unlinkSync(fl); }
catch (e) { probeOut.push('FILE_SYMLINK_EPERM code=' + e.code); probeErr.push('FILE_SYMLINK_EPERM ' + e.code); }
const dt = path.join(DIR, 'dt'); fs.mkdirSync(dt, { recursive: true }); const dl = path.join(DIR, 'dl');
try { fs.symlinkSync(dt, dl, 'junction'); probeOut.push('JUNCTION_OK isSymbolicLink=' + fs.lstatSync(dl).isSymbolicLink()); fs.rmdirSync(dl); }
catch (e) { probeOut.push('JUNCTION_EPERM code=' + e.code); probeErr.push('JUNCTION_EPERM ' + e.code); }
let probeStdout = probeOut.join('\n') + '\n'; const probeStderr = probeErr.join('\n') + '\n';
// mutated stage: 篡改 probe（构造错误）
if (stage === 'mutated') {
  if (mutationId === 'A1-delete-stdout') probeStdout = '\u0000';
  else if (mutationId === 'A2-tamper-sha') { probeStdout = probeStdout.replace('FILE_SYMLINK_EPERM', 'FAKE_OK'); }
  else if (mutationId === 'A3-tamper-bytes') { probeStdout = probeStdout.slice(0, -1); }
  else if (mutationId === 'A4-delete-field') { /* meta 缺字段由 metaOut 控制 */ }
  else if (mutationId === 'A5-unknown-field') { /* meta 未知字段 */ }
  else if (mutationId === 'A6-sibling-prefix') { /* meta path sibling */ }
  else if (mutationId === 'A7-real-junction') { /* meta path 指向 junction */ }
  else if (mutationId === 'A8-swallow-junction') { probeStdout = probeStdout.replace('JUNCTION_OK', 'JUNCTION_HIDDEN'); }
}
// 构造本轮 meta（正常）
const metaOut = { mutationId: mutationId, stage: stage, command: process.execPath + ' ' + process.argv[1] + ' ' + mutationId + ' ' + stage, argv: process.argv.slice(2), cwd: ROOT, startUtc: new Date(Date.now() - 50).toISOString(), endUtc: new Date().toISOString(), exitCode: 0, stdoutPath: path.join(dir, 'stdout.txt'), stderrPath: path.join(dir, 'stderr.txt'), stdoutSha256: sha(probeStdout), stdoutBytes: Buffer.byteLength(probeStdout), stderrSha256: sha(probeStderr), stderrBytes: Buffer.byteLength(probeStderr), verdict: 'PASS' };
// mutated: 应用 meta 篡改（触发 fail-closed）
if (stage === 'mutated') {
  if (mutationId === 'A1-delete-stdout') metaOut.stdoutBytes = 999999;
  else if (mutationId === 'A2-tamper-sha') metaOut.stdoutSha256 = 'a'.repeat(64);
  else if (mutationId === 'A3-tamper-bytes') metaOut.stdoutBytes = 1;
  else if (mutationId === 'A4-delete-field') delete metaOut.exitCode;
  else if (mutationId === 'A5-unknown-field') metaOut.evil = 1;
  else if (mutationId === 'A6-sibling-prefix') metaOut.stdoutPath = 'D:/xinjing-electron-evil/p.txt';
  else if (mutationId === 'A7-real-junction') { const ext = path.join(os.tmpdir(), 'xj030j-' + Date.now()); fs.mkdirSync(ext, { recursive: true }); const jl = path.join(dir, 'jn'); fs.symlinkSync(ext, jl, 'junction'); metaOut.stdoutPath = path.join(jl, 'x'); }
  else if (mutationId === 'A8-swallow-junction') metaOut.verdict = 'PASS';
}
// 先写文件（verify 检查已写 raw）
const soP = path.join(dir, 'stdout.txt'); const seP = path.join(dir, 'stderr.txt');
fs.writeFileSync(soP, probeStdout); fs.writeFileSync(seP, probeStderr);
// verify（fail-closed）
const errs = [];
const F = ['mutationId','stage','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict'];
for (const k of F) if (!(k in metaOut)) errs.push('missing ' + k);
for (const k of Object.keys(metaOut)) if (!F.includes(k)) errs.push('unknown ' + k);
if (metaOut.stdoutSha256 !== sha(probeStdout)) errs.push('stdout sha');
if (metaOut.stderrSha256 !== sha(probeStderr)) errs.push('stderr sha');
if (metaOut.stdoutBytes !== Buffer.byteLength(probeStdout)) errs.push('stdout bytes');
if (metaOut.stderrBytes !== Buffer.byteLength(probeStderr)) errs.push('stderr bytes');
if (probeStdout.indexOf('FILE_SYMLINK_EPERM') < 0) errs.push('EPERM missing');
if (probeStdout.indexOf('JUNCTION_OK isSymbolicLink=true') < 0) errs.push('junction missing');
for (const fk of ['stdoutPath','stderrPath']) { const fp = path.resolve(String(metaOut[fk]||'')); if (!fs.existsSync(fp)) { errs.push(fk + ' missing'); continue; } const fr = path.relative(ROOT, fp); if (fr.startsWith('..') || path.isAbsolute(fr)) errs.push(fk + ' escape'); let cur = fp; while (cur && cur !== path.parse(cur).root) { try { const st = fs.lstatSync(cur); if (st.isSymbolicLink()) { errs.push(fk + ' symlink-parent'); break; } } catch (e) {} cur = path.dirname(cur); } }
const verdict = errs.length ? 'FAIL' : 'PASS';
metaOut.verdict = verdict;
const exitCode = stage === 'mutated' ? (verdict === 'FAIL' ? 2 : 0) : (verdict === 'PASS' ? 0 : 2);
metaOut.exitCode = exitCode;
// 落盘（probeStdout 为本轮生成）
metaOut.errors = errs; fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metaOut, null, 2) + '\n');
process.exit(exitCode);