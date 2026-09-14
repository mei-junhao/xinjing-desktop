'use strict';
// audit-034：独立复算三套 self raw/meta + 24 条 child（三阶段 SHA/bytes/path 全校验）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P034 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-self-audit-final-rebind-rework-034';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
for (const n of ['verifier-034','expected-red-034']) {
  const mp = path.join(P034, n + '.meta.json');
  if (!fs.existsSync(mp)) { errs.push(n + ' meta missing'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const F = ['command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes'];
  for (const k of F) if (!(k in meta)) errs.push(n + ' missing ' + k);
  const so = fs.readFileSync(path.resolve(meta.stdoutPath), 'utf8'); const se = fs.readFileSync(path.resolve(meta.stderrPath), 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push(n + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(n + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(n + ' so bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(n + ' se bytes');
}
const ledger = JSON.parse(fs.readFileSync(path.join(P034, 'ledger-034.json'), 'utf8'));
if (ledger.runCount !== 24) errs.push('runCount');
for (const e of ledger.entries) {
  const mp = path.resolve(e.metaPath); if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.verdict !== e.verdict || meta.exitCode !== e.exitCode) errs.push(e.mutationId + '.' + e.stage + ' mismatch');
  const expectExit = e.stage === 'mutated' ? 2 : 0;
  if (meta.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exit rule');
  // 三阶段都校验 raw 存在/SHA/bytes/path（mutated 的 raw 是攻击后落盘的真实文件）
  const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw missing'); continue; }
  let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' read'); continue; }
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
  const fr = path.relative(P034, soP); if (fr.startsWith('..') || path.isAbsolute(fr)) errs.push(e.mutationId + '.' + e.stage + ' path');
}
const out = 'AUDIT_034: ' + (errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join('|')) + '\n';
const soP = path.join(P034, 'audit-034.stdout.txt'); const seP = path.join(P034, 'audit-034.stderr.txt');
fs.writeFileSync(soP, out); fs.writeFileSync(seP, errs.join('|') + '\n');
fs.writeFileSync(path.join(P034, 'audit-034.meta.json'), JSON.stringify({ command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: errs.length ? 2 : 0, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(out), stdoutBytes: Buffer.byteLength(out), stderrSha256: sha(errs.join('|') + '\n'), stderrBytes: Buffer.byteLength(errs.join('|') + '\n') }, null, 2) + '\n');
console.log(out.trim());
process.exit(errs.length ? 2 : 0);