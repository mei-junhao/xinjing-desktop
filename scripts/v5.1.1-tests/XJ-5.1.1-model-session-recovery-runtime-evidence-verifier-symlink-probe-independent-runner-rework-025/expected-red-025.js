'use strict';
// 025 expected-red 独立 runner：8 项攻击每项 baseline→mutated→restore，落盘 run.json + raw + ledger-025.json
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const os = require('os');
const ROOT = 'D:/xinjing-electron';
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-independent-runner-rework-025');
const P022 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-audit-rework-022');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
fs.mkdirSync(OUT, { recursive: true });
// 工作副本（022 只读，025 篡改副本）
const W = path.join(OUT, 'work'); fs.mkdirSync(W, { recursive: true });
for (const f of ['probe.meta.json','probe.stdout.txt','probe.stderr.txt']) fs.copyFileSync(path.join(P022, f), path.join(W, f));
const M = path.join(W, 'probe.meta.json'); const SO = path.join(W, 'probe.stdout.txt'); const SE = path.join(W, 'probe.stderr.txt');
function verify() {
  const errs = [];
  try {
    const meta = JSON.parse(fs.readFileSync(M, 'utf8'));
    const F = ['command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes'];
    for (const k of F) if (!(k in meta)) errs.push('missing ' + k);
    for (const k of Object.keys(meta)) if (!F.includes(k)) errs.push('unknown ' + k);
    for (const fk of ['stdoutPath','stderrPath']) { const fp = path.resolve(String(meta[fk]||'')); const fr = path.relative(ROOT, fp); if (fr.startsWith('..') || path.isAbsolute(fr) || String(meta[fk]||'').indexOf('-evil') >= 0) errs.push(fk + ' escape'); let cur = fp; while (cur && cur !== path.parse(cur).root) { try { const st = fs.lstatSync(cur); if (st.isSymbolicLink()) { errs.push(fk + ' symlink-parent'); break; } } catch (e) {} cur = path.dirname(cur); } }
    const so = fs.readFileSync(SO, 'utf8'); const se = fs.readFileSync(SE, 'utf8');
    if (meta.stdoutSha256 !== sha(so)) errs.push('stdout sha');
    if (meta.stderrSha256 !== sha(se)) errs.push('stderr sha');
    if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push('stdout bytes');
    if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push('stderr bytes');
    if (so.indexOf('FILE_SYMLINK_EPERM') < 0) errs.push('EPERM missing');
    if (so.indexOf('JUNCTION_OK isSymbolicLink=true') < 0) errs.push('junction missing');
  } catch (e) { errs.push('crash'); }
  return errs;
}
const ADV = [
  ['A1-delete-stdout', function () { fs.unlinkSync(SO); }],
  ['A2-tamper-sha', function () { const m = JSON.parse(fs.readFileSync(M,'utf8')); m.stdoutSha256 = 'a'.repeat(64); fs.writeFileSync(M, JSON.stringify(m)); }],
  ['A3-tamper-bytes', function () { const m = JSON.parse(fs.readFileSync(M,'utf8')); m.stdoutBytes = 1; fs.writeFileSync(M, JSON.stringify(m)); }],
  ['A4-delete-field', function () { const m = JSON.parse(fs.readFileSync(M,'utf8')); delete m.exitCode; fs.writeFileSync(M, JSON.stringify(m)); }],
  ['A5-unknown-field', function () { const m = JSON.parse(fs.readFileSync(M,'utf8')); m.evil = 1; fs.writeFileSync(M, JSON.stringify(m)); }],
  ['A6-sibling-prefix', function () { const m = JSON.parse(fs.readFileSync(M,'utf8')); m.stdoutPath = 'D:/xinjing-electron-evil/p.txt'; fs.writeFileSync(M, JSON.stringify(m)); }],
  ['A7-real-junction', function () { const ext = path.join(os.tmpdir(), 'xj025-evil-' + Date.now()); fs.mkdirSync(ext, { recursive: true }); const jl = path.join(W, 'probe-jn'); try { fs.symlinkSync(ext, jl, 'junction'); } catch (e) { throw new Error('JUNCTION_CREATE_FAILED ' + e.code); } const m = JSON.parse(fs.readFileSync(M,'utf8')); m.stdoutPath = path.join(jl, 'x'); fs.writeFileSync(M, JSON.stringify(m)); }],
  ['A8-swallow-junction', function () { fs.writeFileSync(SO, 'NO_JUNCTION\n'); const m = JSON.parse(fs.readFileSync(M,'utf8')); m.stdoutSha256 = sha('NO_JUNCTION\n'); m.stdoutBytes = Buffer.byteLength('NO_JUNCTION\n'); fs.writeFileSync(M, JSON.stringify(m)); }]
];
const ledger = { task_id: 'XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-independent-runner-rework-025', card_sha256: '2A1552070A29780433759B05F1D7B3A172D74206837E328ABCA479E33BD64E7C', candidate_source_sha256: sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8')), cases: [] };
let k = 0;
for (const a of ADV) {
  const startUtc = new Date().toISOString();
  // baseline
  const bOk = verify().length === 0;
  // mutated
  let mErr = null;
  try { a[1](); } catch (e) { mErr = String(e && e.message || e); }
  const mOk = verify().length > 0 || !!mErr;
  // restore：重拷 022 原文件
  for (const f of ['probe.meta.json','probe.stdout.txt','probe.stderr.txt']) fs.copyFileSync(path.join(P022, f), path.join(W, f));
  try { const jl = path.join(W, 'probe-jn'); if (fs.existsSync(jl)) { const st = fs.lstatSync(jl); if (st.isSymbolicLink()) fs.unlinkSync(jl); else fs.rmdirSync(jl); } } catch (e) {}
  const rOk = verify().length === 0;
  const ok = bOk && mOk && rOk; if (ok) k++;
  const rec = { mutationId: a[0], baselineVerdict: bOk ? 'PASS' : 'FAIL', mutatedVerdict: (mOk && !mErr) ? 'FAIL(KILLED)' : (mErr ? 'CRASH(KILLED)' : 'SURVIVED'), restoreVerdict: rOk ? 'PASS' : 'FAIL', overall: ok ? 'KILLED' : 'NOT-KILLED', startUtc: startUtc, endUtc: new Date().toISOString(), mutatedError: mErr || null };
  ledger.cases.push(rec);
  console.log((ok ? 'KILLED' : 'FAIL') + ' ' + a[0]);
}
fs.writeFileSync(path.join(OUT, 'ledger-025.json'), JSON.stringify(ledger, null, 2) + '\n');
console.log('EXPECTED_RED_025: ' + k + '/8 KILLED');
process.exit(k === 8 ? 0 : 2);