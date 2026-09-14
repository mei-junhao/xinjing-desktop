'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P026 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const ledger = JSON.parse(fs.readFileSync(path.join(P026, 'ledger-026.json'), 'utf8'));
const errs = [];
for (const e of ledger.entries) {
  const mp = path.resolve(P026, e.metaPath);
  if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta missing'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.cwd !== 'D:/xinjing-electron') errs.push(e.mutationId + '.' + e.stage + ' meta.cwd=' + meta.cwd);
  const F = ['mutationId','stage','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict'];
  for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' missing ' + k);
  const soP = path.resolve(P026, meta.stdoutPath); if (!fs.existsSync(soP)) errs.push(e.mutationId + '.' + e.stage + ' stdout missing');
}
console.log('DEBUG_ORIG:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 8).join(' | '));