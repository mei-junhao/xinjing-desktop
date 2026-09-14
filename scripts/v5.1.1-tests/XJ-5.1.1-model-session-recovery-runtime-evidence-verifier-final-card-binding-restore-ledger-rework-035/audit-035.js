'use strict';
// audit-035：fresh invocation——先验证上轮 self raw/meta，再生成本轮 audit self raw/meta（不自证）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P035 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-final-card-binding-restore-ledger-rework-035';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
// 1) 复算上轮 self raw/meta（verifier/expected-red）
for (const n of ['verifier-035','expected-red-035']) {
  const mp = path.join(P035, n + '.meta.json');
  if (!fs.existsSync(mp)) { errs.push(n + ' meta missing'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const so = fs.readFileSync(path.resolve(meta.stdoutPath), 'utf8'); const se = fs.readFileSync(path.resolve(meta.stderrPath), 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push(n + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(n + ' se sha');
}
// 2) 复算 24 条 child（三阶段 SHA/bytes）
const ledger = JSON.parse(fs.readFileSync(path.join(P035, 'ledger-035.json'), 'utf8'));
if (ledger.card_sha256 !== '65F5E84EDE1A71A25C8A2AD74CAEFF8DC6B9D05D9D3EDBBBB0F6D000CFC802C9') errs.push('ledger card sha');
if (ledger.runCount !== 24) errs.push('runCount');
for (const e of ledger.entries) {
  const mp = path.resolve(e.metaPath); if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.verdict !== e.verdict || meta.exitCode !== e.exitCode) errs.push(e.mutationId + '.' + e.stage + ' mismatch');
  const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw'); continue; }
  let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' read'); continue; }
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
  // A5 mutated 必须含 evil（unknown field fail-closed）
  if (e.mutationId === 'A5-unknown-field' && e.stage === 'mutated' && !('evil' in meta)) errs.push('A5 mutated evil missing');
}
// 3) 复算 er-ledger（E11-E13 restore entry）
const erl = JSON.parse(fs.readFileSync(path.join(P035, 'er-ledger-035.json'), 'utf8'));
if (erl.card_sha256 !== '65F5E84EDE1A71A25C8A2AD74CAEFF8DC6B9D05D9D3EDBBBB0F6D000CFC802C9') errs.push('er-ledger card sha');
for (const en of erl.entries) { if (!en.childId || !en.metaPath || !fs.existsSync(path.resolve(en.metaPath))) errs.push('er entry incomplete ' + en.mutationId); }
// 4) 生成 audit self raw/meta
const out = 'AUDIT_035: ' + (errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join('|')) + '\n';
const soP = path.join(P035, 'audit-035.stdout.txt'); const seP = path.join(P035, 'audit-035.stderr.txt');
fs.writeFileSync(soP, out); fs.writeFileSync(seP, errs.join('|') + '\n');
fs.writeFileSync(path.join(P035, 'audit-035.meta.json'), JSON.stringify({ command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: errs.length ? 2 : 0, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(out), stdoutBytes: Buffer.byteLength(out), stderrSha256: sha(errs.join('|') + '\n'), stderrBytes: Buffer.byteLength(errs.join('|') + '\n') }, null, 2) + '\n');
console.log(out.trim());
process.exit(errs.length ? 2 : 0);