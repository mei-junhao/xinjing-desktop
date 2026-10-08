'use strict';
// 026 verifier：只读 ledger-026.json + raw/meta 文件逐项复算
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
const lp = path.join(OUT, 'ledger-026.json');
if (!fs.existsSync(lp)) { console.log('VERIFY_026: FAIL ledger missing'); process.exit(2); }
const ledger = JSON.parse(fs.readFileSync(lp, 'utf8'));
if (ledger.runCount !== 24) errs.push('runCount ' + ledger.runCount);
for (const e of ledger.entries) {
  const dir = path.resolve(OUT, e.runDir);
  const rel = path.relative(OUT, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { errs.push(e.mutationId + '.' + e.stage + ' containment'); continue; }
  const soP = path.join(dir, 'stdout.txt'); const seP = path.join(dir, 'stderr.txt'); const mp = path.join(dir, 'meta.json');
  if (!fs.existsSync(soP) || !fs.existsSync(seP) || !fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' missing raw'); continue; }
  const so = fs.readFileSync(soP, 'utf8'); const se = fs.readFileSync(seP, 'utf8'); const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' stdout sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' stderr sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' stdout bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' stderr bytes');
  const t0 = Date.parse(meta.startUtc); const t1 = Date.parse(meta.endUtc);
  if (isNaN(t0) || isNaN(t1) || t1 < t0) errs.push(e.mutationId + '.' + e.stage + ' utc order');
  if (meta.cwd !== 'D:/xinjing-electron') errs.push(e.mutationId + '.' + e.stage + ' cwd');
  if (meta.verdict !== e.verdict) errs.push(e.mutationId + '.' + e.stage + ' verdict mismatch');
}
console.log('VERIFY_026:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.join('|'));
process.exit(errs.length === 0 ? 0 : 2);