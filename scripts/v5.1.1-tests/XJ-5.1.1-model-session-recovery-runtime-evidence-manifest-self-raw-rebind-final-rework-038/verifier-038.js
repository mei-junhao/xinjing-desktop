'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P038 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-manifest-self-raw-rebind-final-rework-038';
const CARD_SHA = crypto.createHash('sha256').update(fs.readFileSync('D:/xinjing-electron/docs/agent-coordination/v5.1.1/tasks/XJ-5.1.1-model-session-recovery-runtime-evidence-manifest-self-raw-rebind-final-rework-038.md', 'utf8')).digest('hex').toUpperCase();
const GEN = fs.readFileSync(path.join(P038, 'generation-id.txt'), 'utf8').trim();
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
const ledger = JSON.parse(fs.readFileSync(path.join(P038, 'ledger-038.json'), 'utf8'));
if (ledger.task_id !== 'XJ-5.1.1-model-session-recovery-runtime-evidence-manifest-self-raw-rebind-final-rework-038') errs.push('task_id');
if (ledger.card_sha256 !== CARD_SHA) errs.push('card');
if (ledger.generationId !== GEN) errs.push('generation');
if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('count');
const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
for (const mid of MUT) { const es = ledger.entries.filter(e => e.mutationId === mid); if (es.length !== 3) errs.push(mid + ' count'); }
for (const e of ledger.entries) {
  const mp = path.resolve(e.metaPath); if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
  let meta; try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' json'); continue; }
  const F = ['mutationId','stage','childId','generationId','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict','errors'];
  // unknown 检查：对 ALL 阶段执行（无 stage 跳过）——mutated 的 evil 检测 = 该条目 FAIL 证据
  const unknown = Object.keys(meta).filter(k => !F.includes(k));
  if (unknown.length) { if (e.stage !== 'mutated') errs.push(e.mutationId + '.' + e.stage + ' unknown ' + unknown.join(',')); else if (e.verdict !== 'FAIL') errs.push(e.mutationId + '.' + e.stage + ' mutated-unknown-not-fail'); }
  for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' miss ' + k);
  if (meta.generationId !== GEN || e.generationId !== GEN) errs.push(e.mutationId + '.' + e.stage + ' gen');
  const expectExit = e.stage === 'mutated' ? 2 : 0; const expectVerdict = e.stage === 'mutated' ? 'FAIL' : 'PASS';
  if (meta.exitCode !== expectExit || e.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exit');
  if (meta.verdict !== expectVerdict || e.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' verdict');
  const t0 = Date.parse(meta.startUtc); const t1 = Date.parse(meta.endUtc); if (isNaN(t0) || isNaN(t1) || t1 < t0) errs.push(e.mutationId + '.' + e.stage + ' utc');
  if (meta.cwd !== 'D:/xinjing-electron') errs.push(e.mutationId + '.' + e.stage + ' cwd');
  const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw'); continue; }
  let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' read'); continue; }
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
}
// manifest binding 校验（wrapper 后 rebind 的最终 manifest）
try {
  const man = JSON.parse(fs.readFileSync(path.join(P038, 'generation-manifest-038.json'), 'utf8'));
  if (man.generationId !== GEN) errs.push('manifest gen');
  const aSo = fs.readFileSync(path.join(P038, 'audit-038.stdout.txt'), 'utf8');
  if (man.output.audit.stdoutSha256 !== sha(aSo)) errs.push('manifest audit so sha');
  if (man.output.audit.stdoutBytes !== Buffer.byteLength(aSo)) errs.push('manifest audit so bytes');
} catch (e2) { errs.push('manifest missing'); }
console.log('VERIFY_038:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 6).join('|'));
process.exit(errs.length === 0 ? 0 : 2);