'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const P037 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-generation-coherence-final-rework-037';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const CARD_SHA = crypto.createHash('sha256').update(fs.readFileSync('D:/xinjing-electron/docs/agent-coordination/v5.1.1/tasks/XJ-5.1.1-model-session-recovery-runtime-evidence-generation-coherence-final-rework-037.md', 'utf8')).digest('hex').toUpperCase();
const GEN = fs.readFileSync(path.join(P037, 'generation-id.txt'), 'utf8').trim();
const errs = [];
// input: wrapper 捕获的 verifier/expected-red self raw/meta
for (const n of ['verifier-037','expected-red-037']) {
  const mp = path.join(P037, n + '.meta.json');
  if (!fs.existsSync(mp)) { errs.push(n + ' meta missing'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.generationId !== GEN) errs.push(n + ' gen');
  const so = fs.readFileSync(path.resolve(meta.stdoutPath), 'utf8'); const se = fs.readFileSync(path.resolve(meta.stderrPath), 'utf8');
  if (meta.stdoutSha256 !== sha(so)) errs.push(n + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(n + ' se sha');

}
// input: 24 child（三阶段）+ er-ledger
const ledger = JSON.parse(fs.readFileSync(path.join(P037, 'ledger-037.json'), 'utf8'));
if (ledger.card_sha256 !== CARD_SHA || ledger.generationId !== GEN) errs.push('ledger binding');
if (ledger.runCount !== 24) errs.push('runCount');
for (const e of ledger.entries) {
  const mp = path.resolve(e.metaPath); if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.generationId !== GEN) errs.push(e.mutationId + '.' + e.stage + ' gen');
  const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
  if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw'); continue; }
  let so, se; try { so = fs.readFileSync(soP, 'utf8'); se = fs.readFileSync(seP, 'utf8'); } catch (e2) { errs.push(e.mutationId + '.' + e.stage + ' read'); continue; }
  if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
  if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
  if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
  if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
}
const erl = JSON.parse(fs.readFileSync(path.join(P037, 'er-ledger-037.json'), 'utf8'));
if (erl.generationId !== GEN) errs.push('er gen');
// output: 生成 audit self + manifest
const out = 'AUDIT_037: ' + (errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join('|')) + '\n';
const soP = path.join(P037, 'audit-037.stdout.txt'); const seP = path.join(P037, 'audit-037.stderr.txt');
fs.writeFileSync(soP, out); fs.writeFileSync(seP, errs.join('|') + '\n');
const manifest = { task_id: 'XJ-5.1.1-model-session-recovery-runtime-evidence-generation-coherence-final-rework-037', card_sha256: CARD_SHA, generationId: GEN, input: { verifierStdoutSha256: sha(fs.readFileSync(path.join(P037, 'verifier-037.stdout.txt'), 'utf8')), expectedRedStdoutSha256: sha(fs.readFileSync(path.join(P037, 'expected-red-037.stdout.txt'), 'utf8')) }, output: { auditStdoutSha256: sha(out), auditExitCode: errs.length ? 2 : 0, generatedAt: new Date().toISOString() } };
fs.writeFileSync(path.join(P037, 'generation-manifest-037.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(P037, 'audit-037.meta.json'), JSON.stringify({ name: 'audit-037', generationId: GEN, command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: errs.length ? 2 : 0, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(out), stdoutBytes: Buffer.byteLength(out), stderrSha256: sha(errs.join('|') + '\n'), stderrBytes: Buffer.byteLength(errs.join('|') + '\n') }, null, 2) + '\n');
console.log(out.trim());
console.log('MANIFEST: input gen ' + GEN + ' -> output gen ' + GEN + ' bound');
process.exit(errs.length ? 2 : 0);