'use strict';
const fs = require('fs'); const path = require('path');
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026';
const ledger = JSON.parse(fs.readFileSync(path.join(OUT, 'ledger-026.json'), 'utf8'));
const byMid = {};
for (const e of ledger.entries) { byMid[e.mutationId] = byMid[e.mutationId] || {}; byMid[e.mutationId][e.stage] = e.verdict; }
let ok = 0;
for (const mid of Object.keys(byMid)) { const b = byMid[mid].baseline === 'PASS'; const m = byMid[mid].mutated === 'FAIL'; const r = byMid[mid].restore === 'PASS'; const o = b && m && r; if (o) ok++; console.log((o ? 'OK' : 'FAIL') + ' ' + mid + ' baseline=' + byMid[mid].baseline + ' mutated=' + byMid[mid].mutated + ' restore=' + byMid[mid].restore); }
console.log('AUDIT_026: ' + ok + '/8 cases baseline->mutated->restore closed');
process.exit(ok === 8 ? 0 : 2);