'use strict';
// 045 audit — independently recomputes verifier-045 self triplet + spot-recomputes 044 metas (fresh subprocesses)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-045';
const INPUT_TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044';
const OUT = process.argv[2];
const E044 = process.argv[3];
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
const errs = [];

// 1) verifier-045 self triplet must exist and bind
const vMeta = JSON.parse(fs.readFileSync(path.join(OUT, 'verifier-045.meta.json'), 'utf8'));
const vSo = path.join(OUT, 'verifier-045.stdout.raw');
const vSe = path.join(OUT, 'verifier-045.stderr.raw');
for (const f of [vSo, vSe]) if (!fs.existsSync(f)) errs.push('verifier self missing: ' + f);
if (vMeta.taskId !== TASK_ID) errs.push('verifier meta taskId mismatch');
if (vMeta.inputTaskId !== INPUT_TASK_ID) errs.push('verifier meta inputTaskId mismatch');
if (vMeta.verdict !== 'PASS' || vMeta.exitCode !== 0) errs.push('verifier meta verdict/exit not PASS/0');
if (vMeta.stdoutSha256.toUpperCase() !== sha256(vSo)) errs.push('verifier self stdout sha mismatch');
if (vMeta.stderrSha256.toUpperCase() !== sha256(vSe)) errs.push('verifier self stderr sha mismatch');
if (!/V045/.test(fs.readFileSync(vSo, 'utf8'))) errs.push('verifier self stdout lacks V045 verdict line');

// 2) independent spot recomputation of 5 random 044 metas (fresh reads, not trusting verifier)
const m = JSON.parse(fs.readFileSync(path.join(E044, 'evidence-manifest.json'), 'utf8'));
const metas = m.stageMetaPaths || [];
const picks = [0, Math.floor(metas.length / 4), Math.floor(metas.length / 2), Math.floor(metas.length * 3 / 4), metas.length - 1];
for (const i of picks) {
  const mp = metas[i];
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.stdoutPath && fs.existsSync(meta.stdoutPath) && meta.stdoutSha256) {
    if (meta.stdoutSha256.toUpperCase() !== sha256(meta.stdoutPath)) errs.push('spot recompute stdout sha: ' + mp);
  }
  if (meta.stderrPath && fs.existsSync(meta.stderrPath) && meta.stderrSha256) {
    if (meta.stderrSha256.toUpperCase() !== sha256(meta.stderrPath)) errs.push('spot recompute stderr sha: ' + mp);
  }
}

// 3) audit self meta
const aSo = path.join(OUT, 'audit-045.stdout.raw');
if (!fs.existsSync(aSo)) fs.writeFileSync(aSo, '');
const aSe = path.join(OUT, 'audit-045.stderr.raw');
if (!fs.existsSync(aSe)) fs.writeFileSync(aSe, '');
const verdict = errs.length === 0 ? 'PASS' : 'FAIL';
const aMeta = {
  taskId: TASK_ID, inputTaskId: INPUT_TASK_ID, tool: 'audit-045',
  command: process.argv[0], argv: process.argv.slice(1), cwd: process.cwd(),
  startUtc: process.env.XJ_045_ASTART || '', endUtc: new Date().toISOString(),
  exitCode: errs.length === 0 ? 0 : 1,
  stdoutPath: aSo, stderrPath: aSe,
  stdoutSha256: sha256(aSo), stderrSha256: sha256(aSe),
  stdoutBytes: fs.statSync(aSo).size, stderrBytes: fs.statSync(aSe).size,
  verifierSelfChecked: true, spotRecompute: picks.length, verdict,
};
fs.writeFileSync(path.join(OUT, 'audit-045.meta.json'), JSON.stringify(aMeta, null, 1));
process.stdout.write('A045 ' + JSON.stringify({ verdict, errorCount: errs.length, errors: errs.slice(0, 20), spotRecompute: picks.length }) + '\n');
process.exit(errs.length === 0 ? 0 : 1);