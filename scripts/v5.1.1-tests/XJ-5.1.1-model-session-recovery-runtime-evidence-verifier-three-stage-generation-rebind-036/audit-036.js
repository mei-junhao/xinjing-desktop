'use strict';
// audit-036：generation manifest——先验证上一代 self raw/meta（input epoch），再生成当前代 audit self（output epoch）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P036 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const CARD_SHA = crypto.createHash('sha256').update(fs.readFileSync('D:/xinjing-electron/docs/agent-coordination/v5.1.1/tasks/XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036.md', 'utf8')).digest('hex').toUpperCase();
const errs = [];
const genEpoch1 = { epoch: 1, validatedAt: new Date().toISOString() };
// epoch1: 验证上一代 verifier/expected-red self raw/meta
for (const n of ['verifier-036','expected-red-036']) {
  const mp = path.join(P036, n + '.meta.json');
  if (!fs.existsSync(mp)) { errs.push(n + ' meta missing'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const so = fs.readFileSync(path.resolve(meta.stdoutPath), 'utf8'); const se = fs.readFileSync(path.resolve(meta.stderrPath), 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push(n + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(n + ' se sha');
  genEpoch1[n] = { stdoutSha256: meta.stdoutSha256, exitCode: meta.exitCode };
}
// epoch1: 验证 24 条 child（三阶段）+ er-ledger
const ledger = JSON.parse(fs.readFileSync(path.join(P036, 'ledger-036.json'), 'utf8'));
if (ledger.card_sha256 !== CARD_SHA) errs.push('ledger card');
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
}
const erl = JSON.parse(fs.readFileSync(path.join(P036, 'er-ledger-036.json'), 'utf8'));
if (erl.card_sha256 !== CARD_SHA) errs.push('er-ledger card');
for (const en of erl.entries) { if (!en.childId || !fs.existsSync(path.resolve(en.metaPath || ''))) errs.push('er entry incomplete'); }
// epoch2: 生成当前代 audit self（input=epoch1 验证结果）
const out = 'AUDIT_036: ' + (errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join('|')) + '\n';
const soP = path.join(P036, 'audit-036.stdout.txt'); const seP = path.join(P036, 'audit-036.stderr.txt');
fs.writeFileSync(soP, out); fs.writeFileSync(seP, errs.join('|') + '\n');
const genEpoch2 = { epoch: 2, generatedAt: new Date().toISOString(), auditStdoutSha256: sha(out), auditExitCode: errs.length ? 2 : 0, inputEpoch: genEpoch1, outputEpoch: genEpoch2_ref => genEpoch2_ref };
const manifest = { task_id: 'XJ-5.1.1-model-session-recovery-runtime-evidence-three-stage-verifier-generation-rebind-036', card_sha256: CARD_SHA, inputEpoch: genEpoch1, outputEpoch: { epoch: 2, generatedAt: new Date().toISOString(), auditStdoutSha256: sha(out), auditExitCode: errs.length ? 2 : 0 } };
fs.writeFileSync(path.join(P036, 'generation-manifest-036.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(P036, 'audit-036.meta.json'), JSON.stringify({ command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: errs.length ? 2 : 0, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(out), stdoutBytes: Buffer.byteLength(out), stderrSha256: sha(errs.join('|') + '\n'), stderrBytes: Buffer.byteLength(errs.join('|') + '\n') }, null, 2) + '\n');
console.log(out.trim());
console.log('GENERATION_MANIFEST: input=epoch1 output=epoch2 bound');
process.exit(errs.length ? 2 : 0);