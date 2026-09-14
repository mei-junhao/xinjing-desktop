'use strict';
// verifier-032：校验 runner/source-audit/verifier 三套 self 三件套（9 文件）+ 24 阶段 raw 绑定
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
// 1) 三套 self 三件套（9 文件）
for (const n of ['runner-self', 'source-audit-self', 'verifier-self']) {
  const soP = path.join(P, n + '.stdout'); const seP = path.join(P, n + '.stderr'); const mp = path.join(P, n + '.meta.json');
  if (!fs.existsSync(soP) || !fs.existsSync(seP) || !fs.existsSync(mp)) { if (n === 'verifier-self') { continue; } errs.push(n + ' triplet missing'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const so = fs.readFileSync(soP, 'utf8'); const se = fs.readFileSync(seP, 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push(n + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(n + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(n + ' so bytes');
  if (!meta.runId || !meta.command || !meta.cwd || !meta.startUtc || !meta.endUtc) errs.push(n + ' meta fields');
}
// 2) 24 阶段 raw 绑定（json/stdout/stderr/rawJson + SHA/bytes 三方一致）
const rs = JSON.parse(fs.readFileSync(path.join(P, 'runner-self.json'), 'utf8'));
if (rs.phaseCount !== 24 || rs.phases.length !== 24) errs.push('phaseCount');
for (const e of rs.phases) {
  const dir = path.join(P, 'phases', e.er + '.' + e.stage);
  const soP = path.join(dir, 'stdout.txt'); const seP = path.join(dir, 'stderr.txt'); const rjP = path.join(dir, 'raw.json');
  if (!fs.existsSync(soP) || !fs.existsSync(seP) || !fs.existsSync(rjP)) { errs.push(e.er + '.' + e.stage + ' raw missing'); continue; }
  const so = fs.readFileSync(soP, 'utf8'); const rj = fs.readFileSync(rjP, 'utf8');
  if (e.stdoutSha256 !== sha(so)) errs.push(e.er + '.' + e.stage + ' so sha');
  if (e.rawSha256 !== sha(rj)) errs.push(e.er + '.' + e.stage + ' raw sha');
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'phase.json'), 'utf8'));
  if (pj.runId !== rs.runId) errs.push(e.er + '.' + e.stage + ' nonce');
  if (pj.er !== e.er || pj.stage !== e.stage) errs.push(e.er + '.' + e.stage + ' phase cross-id');
  if (pj.verdict !== e.verdict) errs.push(e.er + '.' + e.stage + ' phase cross-verdict');
  if (pj.stdoutSha256 !== e.stdoutSha256) errs.push(e.er + '.' + e.stage + ' phase cross-sha');
  if (pj.stdoutBytes !== Buffer.byteLength(fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8'))) errs.push(e.er + '.' + e.stage + ' phase cross-bytes');
  if (pj.rawSha256 !== e.rawSha256) errs.push(e.er + '.' + e.stage + ' phase cross-raw');
  if (pj.exitCode !== (e.verdict === 'FAIL' ? 2 : 0)) errs.push(e.er + '.' + e.stage + ' phase exit');
  const sp = path.resolve(pj.stdoutPath); const spr = path.relative(ROOT, sp); if (spr.startsWith('..') || path.isAbsolute(spr)) errs.push(e.er + '.' + e.stage + ' path escape');
  let cur = sp; while (cur && cur !== path.parse(cur).root) { try { const st = fs.lstatSync(cur); if (st.isSymbolicLink()) { errs.push(e.er + '.' + e.stage + ' junction'); break; } } catch (e2) {} cur = path.dirname(cur); }
  if (e.verdict === 'FAIL' && pj.exitCode !== 2) errs.push(e.er + '.' + e.stage + ' exit');
  const expect = e.stage === 'mutated' ? 'FAIL' : 'PASS';
  if (e.verdict !== expect) errs.push(e.er + '.' + e.stage + ' verdict');
}
console.log('VERIFY_032:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join('|'));
process.exit(errs.length ? 2 : 0);