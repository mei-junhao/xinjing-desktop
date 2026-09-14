'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P030 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-fresh-child-raw-verifier-self-audit-rework-030');
const OUT = path.join(P030, 'adv'); fs.mkdirSync(OUT, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verifyLedger(lp) {
  const errs = [];
  try {
    const ledger = JSON.parse(fs.readFileSync(lp, 'utf8'));
    if (ledger.task_id !== 'XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-fresh-child-raw-verifier-self-audit-rework-030') errs.push('task_id');
    if (ledger.card_sha256 !== '03B92A415CE49C98AC97FB76A28785CD0EA6D6984AE99C07386DCAB081E327A6') errs.push('card');
    if (ledger.candidate_source_sha256 !== sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8'))) errs.push('candidate');
    if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('count');
    const TOP = ['task_id','card_sha256','candidate_source_sha256','runCount','entries']; for (const k of Object.keys(ledger)) if (!TOP.includes(k)) errs.push('top ' + k);
    const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
    for (const mid of MUT) { const es = ledger.entries.filter(e => e.mutationId === mid); if (es.length !== 3) errs.push(mid + ' count'); }
    for (const e of ledger.entries) {
      const mp = path.resolve(e.metaPath); const rel = path.relative(ROOT, mp);
      if (rel.startsWith('..') || path.isAbsolute(rel)) { errs.push(e.mutationId + '.' + e.stage + ' contain'); continue; }
      if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
      const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
      const F = ['mutationId','stage','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict'];
      for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' miss ' + k);
      const expectExit = e.stage === 'mutated' ? 2 : 0; const expectVerdict = e.stage === 'mutated' ? 'FAIL' : 'PASS';
      if (meta.exitCode !== expectExit || e.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exit');
      if (meta.verdict !== expectVerdict || e.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' verdict');
      if (e.stage !== 'mutated') {
        const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
        if (!fs.existsSync(soP) || !fs.existsSync(seP)) errs.push(e.mutationId + '.' + e.stage + ' raw missing');
        else { let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' raw read fail'); } if (so && meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha'); if (se && meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha'); if (so && meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes'); if (se && meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes'); }
      }
    }
  } catch (e) { errs.push('crash'); }
  return errs;
}
const ORIG = JSON.parse(fs.readFileSync(path.join(P030, 'ledger-030.json'), 'utf8'));
const L = path.join(OUT, 'ledger.json');
const ADV = [
  ['E1-delete-entry', l => { l.entries.pop(); l.runCount = l.entries.length; }],
  ['E2-duplicate-stage', l => { l.entries.push(Object.assign({}, l.entries[0], { stage: 'extra' })); l.runCount = l.entries.length; }],
  ['E3-unknown-top', l => { l.evil = 1; }],
  ['E4-task-id', l => { l.task_id = 'X'; }],
  ['E5-card-sha', l => { l.card_sha256 = 'x'.repeat(64); }],
  ['E6-candidate-sha', l => { l.candidate_source_sha256 = 'y'.repeat(64); }],
  ['E7-exit-tamper', l => { l.entries[0].exitCode = 0; l.entries[0].stage = 'mutated'; }],
  ['E8-verdict-tamper', l => { l.entries[0].verdict = 'PASS'; l.entries[0].stage = 'mutated'; }],
  ['E9-meta-external', l => { l.entries[0].metaPath = '../rebuild-029/ledger-029.json'; }],
  ['E10-sibling-prefix', l => { l.entries[0].metaPath = '..\..\..\..\..\XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rebuild-029/ledger-029.json'; }],
  ['E11-delete-stderr', l => { const mp = path.resolve(l.entries[0].metaPath); const m2 = JSON.parse(fs.readFileSync(mp,'utf8')); fs.unlinkSync(path.resolve(m2.stderrPath)); }],
  ['E12-sha-tamper', l => { const mp = path.resolve(l.entries[0].metaPath); const m2 = JSON.parse(fs.readFileSync(mp,'utf8')); m2.stdoutSha256 = 'a'.repeat(64); fs.writeFileSync(mp, JSON.stringify(m2)); }],
  ['E13-bytes-tamper', l => { const mp = path.resolve(l.entries[0].metaPath); const m2 = JSON.parse(fs.readFileSync(mp,'utf8')); m2.stdoutBytes = 1; fs.writeFileSync(mp, JSON.stringify(m2)); }],
  ['E14-reuse-old-raw', l => { l.entries[0].metaPath = '..\..\..\..\..\XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rebuild-029/runs/A1-delete-stdout.baseline/meta.json'; }]
];
let k = 0;
for (const a of ADV) {
  const l = JSON.parse(JSON.stringify(ORIG));
  a[1](l);
  fs.writeFileSync(L, JSON.stringify(l));
  const failed = verifyLedger(L).length > 0;
  // restore：重跑 runner 恢复（E11/E12/E13 改了 meta/raw）——用 runner 重建最可靠
  fs.writeFileSync(L, JSON.stringify(ORIG));
  if (['E11-delete-stderr','E12-sha-tamper','E13-bytes-tamper'].includes(a[0])) { const cp = require('child_process'); cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-fresh-child-raw-verifier-self-audit-rework-030/runner-030.js')], { cwd: ROOT, encoding: 'utf8' }); }
  const rec = verifyLedger(L).length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('EXPECTED_RED_030: ' + k + '/14 KILLED');
process.exit(k === 14 ? 0 : 2);