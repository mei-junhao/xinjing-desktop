'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005';
const EVIDENCE = path.join(ROOT, 'qa', 'task-scratch', TASK, 'evidence');
const errors = [];
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function check(v, msg) { if (!v) errors.push(msg); }
function verifyRaw(metaFile) {
  let m; try { m = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) { errors.push(`raw meta unreadable: ${metaFile}`); return; }
  for (const k of ['task_id','label','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes']) check(Object.prototype.hasOwnProperty.call(m,k), `${metaFile} missing ${k}`);
  for (const [p, sha, bytes, name] of [[m.stdoutPath,m.stdoutSha256,m.stdoutBytes,'stdout'],[m.stderrPath,m.stderrSha256,m.stderrBytes,'stderr']]) {
    check(path.isAbsolute(String(p||'')), `${metaFile} ${name} path not absolute`); if (!p || !fs.existsSync(p)) { errors.push(`${metaFile} ${name} missing`); continue; }
    const b = fs.readFileSync(p); check(sha256(b) === sha, `${metaFile} ${name} SHA mismatch`); check(b.length === bytes, `${metaFile} ${name} bytes mismatch`);
  }
}
const matrixFile = path.join(EVIDENCE, 'verifier-result.json');
let verifier = null; try { verifier = JSON.parse(fs.readFileSync(matrixFile, 'utf8')); } catch (_) { errors.push('verifier-result missing'); }
check(verifier && verifier.verdict === 'PASS' && verifier.errorCount === 0, 'baseline verifier not PASS');
let red = null; try { red = JSON.parse(fs.readFileSync(path.join(EVIDENCE,'expected-red','expected-red.json'), 'utf8')); } catch (_) { errors.push('expected-red summary missing'); }
check(red && red.caseCount === 8 && red.killed === 8, 'expected-red must be 8/8 KILLED');
for (const row of (red?.cases || [])) {
  check(row.verdict === 'KILLED', `${row.id} not KILLED`); check(row.baseline.exitCode === 0 && row.mutated.exitCode !== 0 && row.restore.exitCode === 0, `${row.id} exit binding failed`);
  for (const stage of ['baseline','mutated','restore']) verifyRaw(row[stage].meta.path);
}
const out = { task_id: TASK, checkedUtc: new Date().toISOString(), baselineVerifier: verifier ? verifier.verdict : 'MISSING', expectedRed: red ? { caseCount:red.caseCount, killed:red.killed } : null, errorCount: errors.length, verdict: errors.length ? 'FAIL' : 'PASS', errors };
fs.writeFileSync(path.join(EVIDENCE, 'audit-result.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ verdict: out.verdict, errorCount: out.errorCount, cases: out.expectedRed }, null, 2));
process.exitCode = errors.length ? 1 : 0;
