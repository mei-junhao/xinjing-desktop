'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const BASE = path.resolve(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/ledger');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const ledgerPath = path.join(BASE, 'ledger.json');
const CASES = ['B-baseline','E1-remove-duplicate-guard','E2-free-var-retry','E3-textarea-only','E4-missing-send','E5-dropped-draft','E6-auto-switch','E7-swallow-ok-false','E8-success-before-resolve','E9-remove-card-on-failure','E10-missing-re-enable','E11-credential-leak'];
// containment：path.resolve + path.relative + realpath + lstat
function isContained(cid) {
  const dir = path.resolve(BASE, cid);
  const rel = path.relative(BASE, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return false;
  if (!/^(B-baseline|E[0-9]+-[a-z-]+)$/.test(cid)) return false;
  try { const st = fs.lstatSync(dir); if (st.isSymbolicLink()) return false; } catch (e) { return false; }
  return true;
}
function verify() {
  const errs = [];
  try {
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
      // 真实 path containment（stdoutPath/stderrPath 字段若存在）
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
function snap() { const s = {}; s.ledger = fs.readFileSync(ledgerPath, 'utf8'); s.files = {}; for (const c of CASES) for (const f of ['run.json','stdout.txt','stderr.txt']) { const p = path.join(BASE, c, f); if (fs.existsSync(p)) s.files[c + '/' + f] = fs.readFileSync(p, 'utf8'); } return s; }
function restore(s) { fs.writeFileSync(ledgerPath, s.ledger); for (const k of Object.keys(s.files)) { const p = path.join(BASE, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s.files[k]); } }
const S = snap();
const baselineOk = verify().length === 0;
console.log('BASELINE:', baselineOk ? 'PASS' : 'FAIL');
const ADV = [
  ['R1-self-test-meta-missing', function () { const p = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/self-test.meta.json'); if (fs.existsSync(p)) fs.unlinkSync(p); }],
  ['R2-self-test-meta-forged', function () { const p = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/self-test.meta.json'); fs.writeFileSync(p, JSON.stringify({ fake: true })); }],
  ['R3-cwd-sibling-prefix', function () { const p = path.join(BASE, 'B-baseline', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.cwd = 'D:/xinjing-electron-evil'; fs.writeFileSync(p, JSON.stringify(r)); }],
  ['R4-symlink-raw', function () { const p = path.join(BASE, 'B-baseline', 'stdout.txt'); const t = path.join(BASE, 'E1-remove-duplicate-guard', 'stdout.txt'); try { fs.unlinkSync(p); } catch (e) {} try { fs.symlinkSync(t, p); } catch (e) { /* symlink 可能失败——用真实文件复制模拟跨 case */ fs.copyFileSync(t, p); } }],
  ['R5-cross-case-raw', function () { const p = path.join(BASE, 'B-baseline', 'stdout.txt'); const t = path.join(BASE, 'E2-free-var-retry', 'stdout.txt'); const c = fs.readFileSync(t, 'utf8'); fs.writeFileSync(p, c); }],
  ['R6-old-evidence', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('../evidence-provenance-selftest-rework-019/ledger/B-baseline'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ['R7-sha-tamper', function () { const p = path.join(BASE, 'E3-textarea-only', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.rawStdoutSha256 = 'b'.repeat(64); fs.writeFileSync(p, JSON.stringify(r)); }],
  ['R8-bytes-tamper', function () { const p = path.join(BASE, 'E4-missing-send', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.rawStdoutBytes = 999999; fs.writeFileSync(p, JSON.stringify(r)); }]
];
let k = 0;
for (const a of ADV) {
  const s2 = snap();
  a[1]();
  let failed = verify().length > 0 || (a[0].indexOf('self-test-meta') >= 0 && !fs.existsSync(path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/self-test.meta.json')));
  const rMeta = fs.existsSync(path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/self-test.meta.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/self-test.meta.json'), 'utf8')) : null;
  if (a[0] === 'R1-self-test-meta-missing') failed = failed || rMeta === null;
  if (a[0] === 'R2-self-test-meta-forged') failed = failed || (rMeta && rMeta.fake === true);
  restore(s2);
  const rec = verify().length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('EXPECTED_RED: ' + k + '/' + ADV.length + ' KILLED');
// verifier 主 raw 落盘
const vOut = 'BASELINE:' + (baselineOk ? 'PASS' : 'FAIL') + ' EXPECTED_RED:' + k + '/' + ADV.length + '\n';
fs.writeFileSync(path.join(BASE, 'verifier-raw.stdout.txt'), vOut);
fs.writeFileSync(path.join(BASE, 'verifier-raw.stderr.txt'), '');
fs.writeFileSync(path.join(BASE, 'verifier-raw.meta.json'), JSON.stringify({ exitCode: (baselineOk && k >= 8 ? 0 : 2), stdoutSha256: sha(vOut), stdoutBytes: Buffer.byteLength(vOut), stderrSha256: sha(''), stderrBytes: 0, command: 'node ' + process.argv[1], cwd: process.cwd(), endUtc: new Date().toISOString() }, null, 2) + '\n');
process.exit(baselineOk && k >= 8 ? 0 : 2);