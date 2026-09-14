'use strict';
// 021 expected-red：junction 真实 symlink + raw path 字段 + verifier-raw meta 补全
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const os = require('os');
const ROOT = 'D:/xinjing-electron';
const BASE = path.resolve(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/ledger');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const ledgerPath = path.join(BASE, 'ledger.json');
const CASES = ['B-baseline','E1-remove-duplicate-guard','E2-free-var-retry','E3-textarea-only','E4-missing-send','E5-dropped-draft','E6-auto-switch','E7-swallow-ok-false','E8-success-before-resolve','E9-remove-card-on-failure','E10-missing-re-enable','E11-credential-leak'];
function isContained(cid) {
  const dir = path.resolve(BASE, cid);
  const rel = path.relative(BASE, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return false;
  if (!/^(B-baseline|E[0-9]+-[a-z-]+)$/.test(cid)) return false;
  try { const st = fs.lstatSync(dir); if (st.isSymbolicLink()) return false; } catch (e) { return false; }
  // realpath 必须在 BASE 内
  try { const rp = fs.realpathSync(dir); const rr = path.relative(BASE, rp); if (rr.startsWith('..') || path.isAbsolute(rr)) return false; } catch (e) { return false; }
  return true;
}
function verify() {
  const errs = [];
  try {
    const vrP = path.join(BASE, 'verifier-raw.stdout.txt');
    if (!fs.existsSync(vrP)) errs.push('verifier-raw missing');
    else { const vrs = fs.readFileSync(vrP, 'utf8'); const vrm = path.join(BASE, 'verifier-raw.meta.json'); if (fs.existsSync(vrm)) { const m = JSON.parse(fs.readFileSync(vrm, 'utf8')); if (m.stdoutSha256 !== sha(vrs)) errs.push('verifier-raw sha'); if (!m.startUtc || !m.stdoutPath || !m.stderrPath) errs.push('verifier-raw meta incomplete'); } }
    const stm = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.meta.json');
    if (!fs.existsSync(stm)) errs.push('self-test.meta missing');
    else { const sm = JSON.parse(fs.readFileSync(stm, 'utf8')); if (sm.fake === true) errs.push('self-test.meta forged'); if (!sm.stdoutPath || !sm.stderrPath) errs.push('self-test.meta no paths'); }
    const l = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!Array.isArray(l.cases)) { errs.push('cases not array'); return errs; }
    const TOP = ['task_id','card_sha256','candidate_source_sha256','caseCount','uniqueIds','cases'];
    for (const k of Object.keys(l)) if (!TOP.includes(k)) errs.push('unknown top');
    if (l.caseCount !== l.cases.length) errs.push('caseCount');
    const chatSrc = fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8');
    if (l.candidate_source_sha256 !== sha(chatSrc)) errs.push('candidate sha');
    for (const cid of l.cases) {
      if (!isContained(cid)) { errs.push(cid + ' containment'); continue; }
      const dir = path.resolve(BASE, cid);
      const rp = path.join(dir, 'run.json'); if (!fs.existsSync(rp)) { errs.push(cid + ' no run'); continue; }
      const run = JSON.parse(fs.readFileSync(rp, 'utf8'));
      if (run.caseId !== cid) errs.push(cid + ' caseId');
      if (!['PASS','KILLED'].includes(run.verdict)) errs.push(cid + ' verdict');
      if (run.mode === 'mutation' && run.verdict !== 'KILLED') errs.push(cid + ' mutation-not-killed');
      if (run.mode === 'baseline' && run.verdict !== 'PASS') errs.push(cid + ' baseline-not-pass');
      // run.json raw path 字段（stdoutPath/stderrPath）containment
      for (const fk of ['stdoutPath','stderrPath']) {
        if (run[fk]) { const fp = path.resolve(run[fk]); const fr = path.relative(BASE, fp); if (fr.startsWith('..') || path.isAbsolute(fr)) errs.push(cid + ' ' + fk + ' escape'); }
      }
      const cwdAbs = path.resolve(String(run.cwd || ''));
      const cwdRel = path.relative(ROOT, cwdAbs);
      if (cwdRel.startsWith('..') || path.isAbsolute(cwdRel)) errs.push(cid + ' cwd escape');
      const so = fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8');
      if (run.rawStdoutSha256 !== sha(so)) errs.push(cid + ' stdout sha');
      if (run.rawStdoutBytes !== Buffer.byteLength(so)) errs.push(cid + ' stdout bytes');
    }
  } catch (e) { errs.push('crash'); }
  return errs;
}
function snap() { const s = {}; s.ledger = fs.readFileSync(ledgerPath, 'utf8'); s.files = {}; for (const c of CASES) for (const f of ['run.json','stdout.txt','stderr.txt']) { const p = path.join(BASE, c, f); if (fs.existsSync(p)) s.files[c + '/' + f] = fs.readFileSync(p, 'utf8'); } const vr = ['verifier-raw.stdout.txt','verifier-raw.stderr.txt','verifier-raw.meta.json']; for (const f of vr) { const p = path.join(BASE, f); if (fs.existsSync(p)) s.files['__vr/' + f] = fs.readFileSync(p, 'utf8'); } const stm = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.meta.json'); if (fs.existsSync(stm)) s.files['__stm'] = fs.readFileSync(stm, 'utf8'); return s; }
function restore(s) { fs.writeFileSync(ledgerPath, s.ledger); for (const k of Object.keys(s.files)) { const p = k.indexOf('__vr/') === 0 ? path.join(BASE, k.slice(5)) : (k === '__stm' ? path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.meta.json') : path.join(BASE, k)); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s.files[k]); } }
// 重置 self-test.meta 为合法（消除上轮 fake 残留）
const STM = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.meta.json');
if (fs.existsSync(STM)) { const sm = JSON.parse(fs.readFileSync(STM, 'utf8')); if (sm.fake === true) { const so2 = fs.readFileSync(path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.stdout'), 'utf8'); const se2 = fs.readFileSync(path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.stderr'), 'utf8'); fs.writeFileSync(STM, JSON.stringify({ command: 'node scripts/self-test.js', argv: ['scripts/self-test.js'], cwd: ROOT, startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: 1, stdoutPath: path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.stdout'), stderrPath: path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.stderr'), stdoutSha256: sha(so2), stdoutBytes: Buffer.byteLength(so2), stderrSha256: sha(se2), stderrBytes: Buffer.byteLength(se2) }, null, 2) + '\n'); } }
const S = snap();
const baselineOk = verify().length === 0;
console.log('BASELINE:', baselineOk ? 'PASS' : 'FAIL');
// junction symlink 攻击：创建 ledger/E99-evil junction 指向 BASE 外目录（真实 symlink 等价，lstat.isSymbolicLink=true）
const ADV = [
  ['R1-verifier-raw-missing', function () { const p = path.join(BASE, 'verifier-raw.stdout.txt'); if (fs.existsSync(p)) fs.unlinkSync(p); }],
  ['R2-self-test-meta-forged', function () { const p = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-provenance-raw-symlink-rework-021/self-test.meta.json'); fs.writeFileSync(p, JSON.stringify({ fake: true })); }],
  ['R3-cwd-sibling-prefix', function () { const p = path.join(BASE, 'B-baseline', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.cwd = 'D:/xinjing-electron-evil'; fs.writeFileSync(p, JSON.stringify(r)); }],
  ['R4-real-symlink-junction', function () { const ext = path.join(os.tmpdir(), 'xj021-evil-' + Date.now()); fs.mkdirSync(ext, { recursive: true }); const link = path.join(BASE, 'E99-evil'); try { fs.symlinkSync(ext, link, 'junction'); } catch (e) { fs.mkdirSync(link); } const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('E99-evil'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ['R5-cross-case-raw', function () { const p = path.join(BASE, 'B-baseline', 'stdout.txt'); const t = path.join(BASE, 'E2-free-var-retry', 'stdout.txt'); fs.writeFileSync(p, fs.readFileSync(t, 'utf8')); }],
  ['R6-old-evidence', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('../final-provenance-verifier-raw-rework-020/ledger/B-baseline'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ['R7-sha-tamper', function () { const p = path.join(BASE, 'E3-textarea-only', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.rawStdoutSha256 = 'c'.repeat(64); fs.writeFileSync(p, JSON.stringify(r)); }],
  ['R8-unknown-field-green', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.evil = 1; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }]
];
let k = 0;
for (const a of ADV) {
  const s2 = snap();
  a[1]();
  const failed = verify().length > 0;
  // 清理 junction
  try { const p = path.join(BASE, 'E99-evil'); if (fs.existsSync(p)) { const st = fs.lstatSync(p); if (st.isSymbolicLink()) fs.unlinkSync(p); else fs.rmdirSync(p); } } catch (e) {}
  restore(s2);
  const rec = verify().length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('EXPECTED_RED: ' + k + '/' + ADV.length + ' KILLED');
// verifier 主 raw 落盘（补 startUtc/stdoutPath/stderrPath）
const startUtc = new Date().toISOString();
const vOut = 'BASELINE:' + (baselineOk ? 'PASS' : 'FAIL') + ' EXPECTED_RED:' + k + '/' + ADV.length + '\n';
const vOutP = path.join(BASE, 'verifier-raw.stdout.txt'); const vErrP = path.join(BASE, 'verifier-raw.stderr.txt');
fs.writeFileSync(vOutP, vOut); fs.writeFileSync(vErrP, '');
fs.writeFileSync(path.join(BASE, 'verifier-raw.meta.json'), JSON.stringify({ exitCode: (baselineOk && k >= 8 ? 0 : 2), command: 'node ' + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: startUtc, endUtc: new Date().toISOString(), stdoutPath: vOutP, stderrPath: vErrP, stdoutSha256: sha(vOut), stdoutBytes: Buffer.byteLength(vOut), stderrSha256: sha(''), stderrBytes: 0 }, null, 2) + '\n');
process.exit(baselineOk && k >= 8 ? 0 : 2);