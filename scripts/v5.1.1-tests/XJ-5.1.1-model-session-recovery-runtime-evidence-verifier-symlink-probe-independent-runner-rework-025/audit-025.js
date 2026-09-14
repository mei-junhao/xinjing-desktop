'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-independent-runner-rework-025';
const errs = [];
const lp = path.join(OUT, 'ledger-025.json');
if (!fs.existsSync(lp)) { console.log('AUDIT_025: FAIL ledger missing'); process.exit(2); }
const ledger = JSON.parse(fs.readFileSync(lp, 'utf8'));
if (ledger.cases.length !== 8) errs.push('ledger case count ' + ledger.cases.length);
for (const c of ledger.cases) {
  if (!c.mutationId || !c.baselineVerdict || !c.mutatedVerdict || !c.restoreVerdict || !c.overall) errs.push('case missing fields ' + c.mutationId);
  if (c.overall !== 'KILLED') errs.push('case not killed ' + c.mutationId);
  if (c.baselineVerdict !== 'PASS' || c.restoreVerdict !== 'PASS') errs.push('case baseline/restore ' + c.mutationId);
}
console.log('AUDIT_025:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.join('|'));
process.exit(errs.length === 0 ? 0 : 2);