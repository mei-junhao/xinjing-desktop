'use strict';
// audit-033：独立复算三套 self raw/meta + 24 条 child + expected-red case
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P033 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-fresh-restore-self-raw-closure-rework-033';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
for (const n of ['verifier-033','expected-red-033','audit-033']) {
  const mp = path.join(P033, n + '.meta.json');
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
const ledger = JSON.parse(fs.readFileSync(path.join(P033, 'ledger-033.json'), 'utf8'));
if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('runCount');
for (const e of ledger.entries) {
  const mp = path.resolve(e.metaPath); if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.verdict !== e.verdict || meta.exitCode !== e.exitCode) errs.push(e.mutationId + '.' + e.stage + ' mismatch');
  if (e.stage === 'mutated') continue;
  const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw'); continue; }
  const so = fs.readFileSync(soP, 'utf8'); const se = fs.readFileSync(seP, 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
}
const out = 'AUDIT_033: ' + (errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join('|')) + '\n';
const soP = path.join(P033, 'audit-033.stdout.txt'); const seP = path.join(P033, 'audit-033.stderr.txt');
fs.writeFileSync(soP, out); fs.writeFileSync(seP, errs.join('|') + '\n');
fs.writeFileSync(path.join(P033, 'audit-033.meta.json'), JSON.stringify({ command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: errs.length ? 2 : 0, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(out), stdoutBytes: Buffer.byteLength(out), stderrSha256: sha(errs.join('|') + '\n'), stderrBytes: Buffer.byteLength(errs.join('|') + '\n') }, null, 2) + '\n');
console.log(out.trim());
process.exit(errs.length ? 2 : 0);