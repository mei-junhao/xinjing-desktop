'use strict';
// 027 expected-red：12 项对抗（隔离 026 ledger 副本篡改，verifier 逻辑必须 FAIL）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P026 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026');
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-verifier-hardening-rework-027');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
fs.mkdirSync(path.join(OUT, 'adv'), { recursive: true });
// verifier 逻辑（读给定 ledger 副本）
function verifyLedger(lp) {
  const errs = [];
  try {
    const ledger = JSON.parse(fs.readFileSync(lp, 'utf8'));
    if (ledger.task_id !== 'XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026') errs.push('task_id');
    if (ledger.card_sha256 !== '10CC2F7D8FB1ACDDF254E7492ACFBBC130E5E3F4C40E9E466B3202BEC0372FBC') errs.push('card');
    if (ledger.candidate_source_sha256 !== sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8'))) errs.push('candidate');
    if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('count');
    const TOP = ['task_id','card_sha256','candidate_source_sha256','runCount','entries'];
    for (const k of Object.keys(ledger)) if (!TOP.includes(k)) errs.push('unknown top ' + k);
    const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
    for (const mid of MUT) { const es = ledger.entries.filter(e => e.mutationId === mid); if (es.length !== 3) errs.push(mid + ' count'); for (const st of ['baseline','mutated','restore']) if (!es.some(e => e.stage === st)) errs.push(mid + ' stage'); }
    for (const e of ledger.entries) {
      const mp = path.resolve(P026, e.metaPath); if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
      const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (meta.cwd !== 'D:/xinjing-electron') errs.push(e.mutationId + '.' + e.stage + ' meta cwd');
      const F = ['mutationId','stage','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict'];
      for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' missing ' + k);
      for (const k of Object.keys(meta)) if (!F.includes(k)) errs.push(e.mutationId + '.' + e.stage + ' unknown ' + k);
      if (e.exitCode !== meta.exitCode) errs.push(e.mutationId + '.' + e.stage + ' entry-meta exitCode');
      if (e.verdict !== meta.verdict) errs.push(e.mutationId + '.' + e.stage + ' entry-meta verdict');
      const expectExit = e.stage === 'mutated' ? 2 : 0; const expectVerdict = e.stage === 'mutated' ? 'FAIL' : 'PASS';
      if (!['baseline','mutated','restore'].includes(e.stage)) errs.push(e.mutationId + ' bad stage');
      if (meta.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exit');
      if (meta.verdict !== expectVerdict || e.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' verdict');
      const soP = path.resolve(P026, meta.stdoutPath); const seP = path.resolve(P026, meta.stderrPath);
      if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw'); continue; }
      const so = fs.readFileSync(soP, 'utf8'); const se = fs.readFileSync(seP, 'utf8');
      if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
      if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
    }
  } catch (e) { errs.push('crash'); }
  return errs;
}
const ORIG = JSON.parse(fs.readFileSync(path.join(P026, 'ledger-026.json'), 'utf8'));
const L = path.join(OUT, 'adv', 'ledger.json');
const ADV = [
  ['E1-delete-entry', function (l) { l.entries.pop(); l.runCount = l.entries.length; }],
  ['E2-duplicate-case', function (l) { l.entries.push(Object.assign({}, l.entries[0], { stage: 'extra' })); l.runCount = l.entries.length; }],
  ['E3-unknown-field', function (l) { l.evil = 1; }],
  ['E4-tamper-task-id', function (l) { l.task_id = 'WRONG'; }],
  ['E5-tamper-card-sha', function (l) { l.card_sha256 = 'x'.repeat(64); }],
  ['E6-tamper-candidate-sha', function (l) { l.candidate_source_sha256 = 'y'.repeat(64); }],
  ['E7-change-cwd', function (l) { const srcMeta = path.resolve(P026, l.entries[0].metaPath); const m2 = JSON.parse(fs.readFileSync(srcMeta, 'utf8')); m2.cwd = '/tmp'; const advMeta = path.join(OUT, 'adv', 'meta-tmp.json'); fs.writeFileSync(advMeta, JSON.stringify(m2)); l.entries[0].metaPath = path.relative(P026, advMeta); l.entries[0].cwd = '/tmp'; }],
  ['E8-change-exitcode', function (l) { l.entries[0].exitCode = 0; l.entries[0].stage = 'mutated'; }],
  ['E9-meta-external', function (l) { l.entries[0].metaPath = '../verifier-hardening-rework-027/adv/ledger.json'; }],
  ['E10-sibling-prefix', function (l) { l.entries[0].metaPath = '../..XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026/ledger-026.json'; }],
  ['E11-forge-verdict', function (l) { l.entries[0].verdict = 'PASS'; }],
  ['E12-reuse-025-raw', function (l) { l.entries[0].metaPath = '..\..\..\..\..\XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-independent-runner-rework-025/ledger-025.json'; }]
];
let k = 0;
for (const a of ADV) {
  const l = JSON.parse(JSON.stringify(ORIG));
  const metaBackup = a[0] === 'E7-change-cwd' ? fs.readFileSync(path.resolve(P026, l.entries[0].metaPath), 'utf8') : null;
  a[1](l);
  fs.writeFileSync(L, JSON.stringify(l));
  const failed = verifyLedger(L).length > 0;
  fs.writeFileSync(L, JSON.stringify(ORIG));
  if (a[0] === 'E7-change-cwd' && metaBackup) { fs.writeFileSync(path.resolve(P026, ORIG.entries[0].metaPath), metaBackup); }
  const rec = verifyLedger(L).length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('EXPECTED_RED_027: ' + k + '/12 KILLED');
process.exit(k === 12 ? 0 : 2);