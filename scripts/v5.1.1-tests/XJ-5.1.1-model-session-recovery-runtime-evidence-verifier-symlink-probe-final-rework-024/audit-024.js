'use strict';
// 024 audit：复算 verifier-024 自身 stdout/stderr/meta
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-final-rework-024';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
const mp = path.join(OUT, 'verifier-024.meta.json');
if (!fs.existsSync(mp)) { console.log('AUDIT: FAIL verifier meta missing'); process.exit(2); }
const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
const F = ['exitCode','command','argv','cwd','startUtc','endUtc','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes'];
for (const k of F) if (!(k in meta)) errs.push('verifier meta missing ' + k);
const so = fs.readFileSync(path.resolve(meta.stdoutPath), 'utf8');
const se = fs.readFileSync(path.resolve(meta.stderrPath), 'utf8');
if (meta.stdoutSha256 !== sha(so)) errs.push('verifier stdout SHA');
if (meta.stderrSha256 !== sha(se)) errs.push('verifier stderr SHA');
if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push('verifier stdout bytes');
if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push('verifier stderr bytes');
console.log('AUDIT_024:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.join('|'));
process.exit(errs.length === 0 ? 0 : 2);