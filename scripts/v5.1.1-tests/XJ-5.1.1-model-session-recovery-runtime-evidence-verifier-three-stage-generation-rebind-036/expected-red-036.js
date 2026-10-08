'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P036 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036';
const CHILD = 'D:/xinjing-electron/scripts/v5.1.1-tests/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-three-stage-generation-rebind-036/case-child-036.js';
const CARD_SHA = crypto.createHash('sha256').update(fs.readFileSync('D:/xinjing-electron/docs/agent-coordination/v5.1.1/tasks/XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036.md', 'utf8')).digest('hex').toUpperCase();
const OUT = path.join(P036, 'adv'); fs.mkdirSync(OUT, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verifyLedger(lp) {
  const errs = [];
  try {
    const ledger = JSON.parse(fs.readFileSync(lp, 'utf8'));
    if (ledger.task_id !== 'XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036') errs.push('task_id');
    if (ledger.card_sha256 !== CARD_SHA) errs.push('card');
    if (ledger.candidate_source_sha256 !== sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8'))) errs.push('candidate');
    if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('count');
    const TOP = ['task_id','card_sha256','candidate_source_sha256','runCount','entries']; for (const k of Object.keys(ledger)) if (!TOP.includes(k)) errs.push('top ' + k);
    for (const e of ledger.entries) {
      const mp = path.resolve(e.metaPath); const rel = path.relative(ROOT, mp);
      if (rel.startsWith('..') || path.isAbsolute(rel)) { errs.push(e.mutationId + '.' + e.stage + ' contain'); continue; }
      if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
      let meta; try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' json'); continue; }
      const F = ['mutationId','stage','childId','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict','errors'];
      for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' miss ' + k);
      for (const k of Object.keys(meta)) if (!F.includes(k) && e.stage !== 'mutated') errs.push(e.mutationId + '.' + e.stage + ' unknown ' + k);
      const expectExit = e.stage === 'mutated' ? 2 : 0; const expectVerdict = e.stage === 'mutated' ? 'FAIL' : 'PASS';
      if (meta.exitCode !== expectExit || e.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exit');
      if (meta.verdict !== expectVerdict || e.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' verdict');
      const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
      if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw'); continue; }
      let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' read'); continue; }
      if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
      if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
      if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
      if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
    }
  } catch (e) { errs.push('crash'); }
  return errs;
}
const erLedger = { task_id: 'XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036', card_sha256: CARD_SHA, entries: [] };
const ORIG = JSON.parse(fs.readFileSync(path.join(P036, 'ledger-036.json'), 'utf8'));
const L = path.join(OUT, 'ledger.json');
const e0 = ORIG.entries[0];
const ADV = [
  ['E1-delete-entry', l => { l.entries.pop(); l.runCount = l.entries.length; }],
  ['E2-duplicate-stage', l => { l.entries.push(Object.assign({}, l.entries[0], { stage: 'extra' })); l.runCount = l.entries.length; }],
  ['E3-unknown-top', l => { l.evil = 1; }],
  ['E4-task-id', l => { l.task_id = 'X'; }],
  ['E5-card-sha', l => { l.card_sha256 = 'x'.repeat(64); }],
  ['E6-candidate-sha', l => { l.candidate_source_sha256 = 'y'.repeat(64); }],
  ['E7-exit-tamper', l => { l.entries[0].exitCode = 0; l.entries[0].stage = 'mutated'; }],
  ['E8-verdict-tamper', l => { l.entries[0].verdict = 'PASS'; l.entries[0].stage = 'mutated'; }],
  ['E9-meta-external', l => { l.entries[0].metaPath = '../final-card-binding-restore-ledger-rework-035/ledger-035.json'; }],
  ['E10-sibling-prefix', l => { l.entries[0].metaPath = '..\..\..\..\..\XJ-5.1.1-model-session-recovery-runtime-evidence-final-card-binding-restore-ledger-rework-035/ledger-035.json'; }],
  ['E11-delete-stderr', l => { fs.unlinkSync(path.resolve(l.entries[0].stderrPath)); }],
  ['E12-sha-tamper', l => { const mp = path.resolve(l.entries[0].metaPath); const m2 = JSON.parse(fs.readFileSync(mp,'utf8')); m2.stdoutSha256 = 'a'.repeat(64); fs.writeFileSync(mp, JSON.stringify(m2)); }],
  ['E13-bytes-tamper', l => { const mp = path.resolve(l.entries[0].metaPath); const m2 = JSON.parse(fs.readFileSync(mp,'utf8')); m2.stdoutBytes = 1; fs.writeFileSync(mp, JSON.stringify(m2)); }],
  ['E14-reuse-old-raw', l => { l.entries[0].metaPath = '..\..\..\..\..\XJ-5.1.1-model-session-recovery-runtime-evidence-final-card-binding-restore-ledger-rework-035/runs/A1-delete-stdout.baseline/meta.json'; }]
];
let k = 0;
for (const a of ADV) {
  const l = JSON.parse(JSON.stringify(ORIG));
  a[1](l);
  fs.writeFileSync(L, JSON.stringify(l));
  const failed = verifyLedger(L).length > 0;
  // restore: E11-E13 双 spawn（restore-stage child 新 childId + baseline 修复）——写入 erLedger 三阶段
  if (['E11-delete-stderr','E12-sha-tamper','E13-bytes-tamper'].includes(a[0])) {
    const cp = require('child_process');
    const c1 = cp.spawnSync(process.execPath, [CHILD, 'A1-delete-stdout', 'restore'], { cwd: ROOT, encoding: 'utf8' });
    const c2 = cp.spawnSync(process.execPath, [CHILD, 'A1-delete-stdout', 'baseline'], { cwd: ROOT, encoding: 'utf8' });
    if (c1.status !== 0 || c2.status !== 0) { console.error('FRESH_RESTORE_FAIL', c1.status, c2.status); }
    const rm = JSON.parse(fs.readFileSync(path.join(P036, 'runs', 'A1-delete-stdout.restore', 'meta.json'), 'utf8'));
    erLedger.entries.push({ mutationId: a[0], stage: 'baseline', childId: e0.childId, metaPath: e0.metaPath });
    erLedger.entries.push({ mutationId: a[0], stage: 'mutated', childId: 'tampered', metaPath: e0.metaPath });
    erLedger.entries.push({ mutationId: a[0], stage: 'restore', childId: rm.childId, metaPath: path.join(P036, 'runs', 'A1-delete-stdout.restore', 'meta.json'), stdoutPath: path.join(P036, 'runs', 'A1-delete-stdout.restore', 'stdout.txt'), exitCode: rm.exitCode, verdict: rm.verdict });
  }
  fs.writeFileSync(L, JSON.stringify(ORIG));
  const rec = verifyLedger(L).length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
fs.writeFileSync(path.join(P036, 'er-ledger-036.json'), JSON.stringify(erLedger, null, 2) + '\n');
console.log('EXPECTED_RED_036: ' + k + '/14 KILLED');
process.exit(k === 14 ? 0 : 2);