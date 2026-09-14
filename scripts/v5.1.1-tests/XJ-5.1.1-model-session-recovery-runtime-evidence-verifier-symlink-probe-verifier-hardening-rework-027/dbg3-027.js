'use strict';
const fs = require('fs'); const path = require('path');
const P026 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026';
const ledger = JSON.parse(fs.readFileSync(path.join(P026, 'ledger-026.json'), 'utf8'));
const errs = [];
for (const e of ledger.entries) {
  const meta = JSON.parse(fs.readFileSync(path.resolve(P026, e.metaPath), 'utf8'));
  if (e.exitCode !== meta.exitCode) errs.push(e.mutationId + '.' + e.stage + ' exit ' + e.exitCode + ' vs ' + meta.exitCode);
  if (e.verdict !== meta.verdict) errs.push(e.mutationId + '.' + e.stage + ' verdict ' + e.verdict + ' vs ' + meta.verdict);
  if (meta.mutationId !== e.mutationId || meta.stage !== e.stage) errs.push(e.mutationId + ' identity');
  if (e.stdoutPath !== meta.stdoutPath) errs.push(e.mutationId + '.' + e.stage + ' stdoutPath entry-vs-meta');
}
console.log('ENTRY_META_CONSISTENCY:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join(' | '));