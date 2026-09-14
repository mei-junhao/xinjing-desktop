'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P032 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rebuild-029';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
const ledger = JSON.parse(fs.readFileSync(path.join(P032, 'ledger-029.json'), 'utf8'));
const byMid = {};
for (const e of ledger.entries) { byMid[e.mutationId] = byMid[e.mutationId] || {}; byMid[e.mutationId][e.stage] = e.verdict + '/' + e.exitCode; }
let ok = 0;
for (const mid of Object.keys(byMid)) { const b = byMid[mid].baseline === 'PASS/0'; const m = byMid[mid].mutated === 'FAIL/2'; const r = byMid[mid].restore === 'PASS/0'; const o = b && m && r; if (o) ok++; else errs.push(mid); }
// 自身 raw 落盘
const out = 'AUDIT_029: ' + ok + '/8 cases closed\n';
const soP = path.join(P032, 'audit-029.stdout.txt'); const seP = path.join(P032, 'audit-029.stderr.txt');
fs.writeFileSync(soP, out); fs.writeFileSync(seP, errs.join('|') + '\n');
fs.writeFileSync(path.join(P032, 'audit-029.meta.json'), JSON.stringify({ command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: ok === 8 ? 0 : 2, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(out), stdoutBytes: Buffer.byteLength(out), stderrSha256: sha(errs.join('|') + '\n'), stderrBytes: Buffer.byteLength(errs.join('|') + '\n') }, null, 2) + '\n');
console.log(out.trim());
process.exit(ok === 8 ? 0 : 2);