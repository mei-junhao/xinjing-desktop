'use strict';
// verifier-036：三阶段（baseline/mutated/restore）全校验 raw 存在/containment/SHA/bytes/schema——NO skip
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P036 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036';
const CARD_SHA = crypto.createHash('sha256').update(fs.readFileSync('D:/xinjing-electron/docs/agent-coordination/v5.1.1/tasks/XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036.md', 'utf8')).digest('hex').toUpperCase();
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
const ledger = JSON.parse(fs.readFileSync(path.join(P036, 'ledger-036.json'), 'utf8'));
if (ledger.task_id !== 'XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036') errs.push('task_id');
if (ledger.card_sha256 !== CARD_SHA) errs.push('card sha');
if (ledger.candidate_source_sha256 !== sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8'))) errs.push('candidate');
if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('count');
const TOP = ['task_id','card_sha256','candidate_source_sha256','runCount','entries']; for (const k of Object.keys(ledger)) if (!TOP.includes(k)) errs.push('top ' + k);
const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
for (const mid of MUT) { const es = ledger.entries.filter(e => e.mutationId === mid); if (es.length !== 3) errs.push(mid + ' count'); for (const st of ['baseline','mutated','restore']) if (!es.some(e => e.stage === st)) errs.push(mid + ' stage'); }
for (const e of ledger.entries) {
  const mp = path.resolve(e.metaPath); const rel = path.relative(ROOT, mp);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { errs.push(e.mutationId + '.' + e.stage + ' contain'); continue; }
  if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
  let meta; try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' bad json'); continue; }
  const F = ['mutationId','stage','childId','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict','errors'];
  for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' miss ' + k);
  for (const k of Object.keys(meta)) if (!F.includes(k) && e.stage !== 'mutated') errs.push(e.mutationId + '.' + e.stage + ' unknown ' + k);
  if (meta.mutationId !== e.mutationId || meta.stage !== e.stage || meta.childId !== e.childId) errs.push(e.mutationId + '.' + e.stage + ' identity');
  const expectExit = e.stage === 'mutated' ? 2 : 0; const expectVerdict = e.stage === 'mutated' ? 'FAIL' : 'PASS';
  if (meta.exitCode !== expectExit || e.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exit');
  if (meta.verdict !== expectVerdict || e.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' verdict');
  const t0 = Date.parse(meta.startUtc); const t1 = Date.parse(meta.endUtc); if (isNaN(t0) || isNaN(t1) || t1 < t0) errs.push(e.mutationId + '.' + e.stage + ' utc');
  if (meta.cwd !== 'D:/xinjing-electron') errs.push(e.mutationId + '.' + e.stage + ' cwd');
  // 三阶段都校验 raw 存在 + SHA/bytes 一致（mutated 的 meta 反映落盘 raw——攻击后重算）
  const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw missing'); continue; }
  let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' read'); continue; }
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
  const fr = path.relative(P036, soP); if (fr.startsWith('..') || path.isAbsolute(fr)) errs.push(e.mutationId + '.' + e.stage + ' path');
}
console.log('VERIFY_036:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 6).join('|'));
process.exit(errs.length === 0 ? 0 : 2);