'use strict';
// 046 audit — independently recomputes verifier-046 self triplet + baseline/restore/variants chain
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-recovery-no-context-independent-review-046';
const INPUT_TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044';
const OUT = process.argv[2];
const MIRROR = process.argv[3];
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
const errs = [];

// verifier self triplet
const vMeta = JSON.parse(fs.readFileSync(path.join(OUT, 'verifier-046.meta.json'), 'utf8'));
const vSo = path.join(OUT, 'verifier-046.stdout.raw');
const vSe = path.join(OUT, 'verifier-046.stderr.raw');
if (vMeta.taskId !== TASK_ID) errs.push('verifier meta taskId');
if (vMeta.inputTaskId !== INPUT_TASK_ID) errs.push('verifier meta inputTaskId');
if (vMeta.verdict !== 'PASS' || vMeta.exitCode !== 0) errs.push('verifier meta verdict/exit');
if (vMeta.stdoutSha256.toUpperCase() !== sha256(vSo)) errs.push('verifier self stdout sha');
if (vMeta.stderrSha256.toUpperCase() !== sha256(vSe)) errs.push('verifier self stderr sha');
if (!/V046/.test(fs.readFileSync(vSo, 'utf8'))) errs.push('verifier stdout lacks V046');

// expected-red ledger: 8/8 fail_closed
const er = JSON.parse(fs.readFileSync(path.join(OUT, 'expected-red-046.json'), 'utf8'));
if (er.length < 8) errs.push('expected-red variants < 8');
for (const v of er) if (!v.fail_closed) errs.push('variant not fail-closed: ' + v.name);
// baseline/restore raw show PASS
if (!/PASS/.test(fs.readFileSync(path.join(OUT, 'baseline-046.stdout.raw'), 'utf8'))) errs.push('baseline stdout lacks PASS');
if (!/PASS/.test(fs.readFileSync(path.join(OUT, 'restore-046.stdout.raw'), 'utf8'))) errs.push('restore stdout lacks PASS');

// audit self
const aSo = path.join(OUT, 'audit-046.stdout.raw');
if (!fs.existsSync(aSo)) fs.writeFileSync(aSo, '');
const aSe = path.join(OUT, 'audit-046.stderr.raw');
if (!fs.existsSync(aSe)) fs.writeFileSync(aSe, '');
const verdict = errs.length === 0 ? 'PASS' : 'FAIL';
const aMeta = {
  taskId: TASK_ID, inputTaskId: INPUT_TASK_ID, tool: 'audit-046',
  command: process.argv[0], argv: process.argv.slice(1), cwd: process.cwd(),
  startUtc: process.env.XJ_046_ASTART || '', endUtc: new Date().toISOString(),
  exitCode: errs.length === 0 ? 0 : 1,
  stdoutPath: aSo, stderrPath: aSe,
  stdoutSha256: sha256(aSo), stderrSha256: sha256(aSe),
  stdoutBytes: fs.statSync(aSo).size, stderrBytes: fs.statSync(aSe).size,
  variantsChecked: er.length, verdict,
};
fs.writeFileSync(path.join(OUT, 'audit-046.meta.json'), JSON.stringify(aMeta, null, 1));
process.stdout.write('A046 ' + JSON.stringify({ verdict, errorCount: errs.length, errors: errs.slice(0, 16), variantsChecked: er.length }) + '\n');
process.exit(errs.length === 0 ? 0 : 1);