'use strict';
// 027 verifier：只读 026 ledger + 24 runs raw/meta 严格校验（fail-closed）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P026 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
const lp = path.join(P026, 'ledger-026.json');
if (!fs.existsSync(lp)) { console.log('VERIFY_027: FAIL ledger missing'); process.exit(2); }
const ledger = JSON.parse(fs.readFileSync(lp, 'utf8'));
// 顶层校验
if (ledger.task_id !== 'XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026') errs.push('task_id');
if (ledger.card_sha256 !== '10CC2F7D8FB1ACDDF254E7492ACFBBC130E5E3F4C40E9E466B3202BEC0372FBC') errs.push('card_sha256');
if (ledger.candidate_source_sha256 !== sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8'))) errs.push('candidate sha');
if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('runCount');
// A1-A8 唯一 + 三阶段各一条
const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
for (const mid of MUT) {
  const es = ledger.entries.filter(e => e.mutationId === mid);
  if (es.length !== 3) errs.push(mid + ' count ' + es.length);
  for (const st of ['baseline','mutated','restore']) if (!es.some(e => e.stage === st)) errs.push(mid + ' missing ' + st);
}
for (const e of ledger.entries) {
  // 每条 meta 严格校验
  const mp = path.resolve(P026, e.metaPath);
  const rel = path.relative(P026, mp);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { errs.push(e.mutationId + '.' + e.stage + ' meta containment'); continue; }
  if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta missing'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const F = ['mutationId','stage','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict'];
  for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' missing ' + k);
  for (const k of Object.keys(meta)) if (!F.includes(k)) errs.push(e.mutationId + '.' + e.stage + ' unknown ' + k);
  if (meta.mutationId !== e.mutationId || meta.stage !== e.stage) errs.push(e.mutationId + '.' + e.stage + ' identity');
  if (meta.cwd !== 'D:/xinjing-electron') errs.push(e.mutationId + '.' + e.stage + ' cwd');
  const t0 = Date.parse(meta.startUtc); const t1 = Date.parse(meta.endUtc);
  if (isNaN(t0) || isNaN(t1) || t1 < t0) errs.push(e.mutationId + '.' + e.stage + ' utc');
  // exitCode 规则：baseline/restore exit 0 + verdict PASS；mutated exit 2 + verdict FAIL
  const expectExit = e.stage === 'mutated' ? 2 : 0;
  const expectVerdict = e.stage === 'mutated' ? 'FAIL' : 'PASS';
  if (meta.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exitCode ' + meta.exitCode);
  if (meta.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' verdict');
  if (e.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' ledger verdict');
  // raw 文件复算
  const soP = path.resolve(P026, meta.stdoutPath); const seP = path.resolve(P026, meta.stderrPath);
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw missing'); continue; }
  const so = fs.readFileSync(soP, 'utf8'); const se = fs.readFileSync(seP, 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' stdout sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' stderr sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' stdout bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' stderr bytes');
  // 路径链接门禁（realpath + lstat 父链）
  for (const fk of ['stdoutPath','stderrPath']) { let cur = path.resolve(meta[fk]); while (cur && cur !== path.parse(cur).root) { try { const st = fs.lstatSync(cur); if (st.isSymbolicLink()) { errs.push(e.mutationId + '.' + e.stage + ' ' + fk + ' symlink'); break; } } catch (e) {} cur = path.dirname(cur); } }
}
console.log('VERIFY_027:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 6).join('|'));
process.exit(errs.length === 0 ? 0 : 2);