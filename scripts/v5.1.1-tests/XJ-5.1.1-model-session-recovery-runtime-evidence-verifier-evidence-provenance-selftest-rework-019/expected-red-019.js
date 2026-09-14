'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const BASE = path.resolve(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-evidence-provenance-selftest-rework-019/ledger');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const ledgerPath = path.join(BASE, 'ledger.json');
const CASES = ['B-baseline','E1-remove-duplicate-guard','E2-free-var-retry','E3-textarea-only','E4-missing-send','E5-dropped-draft','E6-auto-switch','E7-swallow-ok-false','E8-success-before-resolve','E9-remove-card-on-failure','E10-missing-re-enable','E11-credential-leak'];
function snap() { const s = {}; s.ledger = fs.readFileSync(ledgerPath, 'utf8'); s.files = {}; for (const c of CASES) for (const f of ['run.json','stdout.txt','stderr.txt']) { const p = path.join(BASE, c, f); if (fs.existsSync(p)) s.files[c + '/' + f] = fs.readFileSync(p, 'utf8'); } return s; }
function restore(s) { fs.writeFileSync(ledgerPath, s.ledger); for (const k of Object.keys(s.files)) { const p = path.join(BASE, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s.files[k]); } }
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
    let dc = 0; try { dc = fs.readdirSync(BASE).filter(n => /^[BE]/.test(n)).length; } catch (e) {}
    if (dc !== l.cases.length) errs.push('cases-vs-dirs');
    for (const cid of l.cases) {
      const dir = path.resolve(BASE, cid);
      const rel = path.relative(BASE, dir);
      // 严拒：相对/../sibling-prefix（cid 必须以 B-baseline 或 E 开头精确匹配，路径 resolve 后必须在 BASE 内且为真实子目录）
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') { errs.push(cid + ' containment'); continue; }
      if (!/^(B-baseline|E[0-9]+-[a-z-]+)$/.test(cid)) { errs.push(cid + ' sibling-prefix'); continue; }
      // symlink 检查
      try { const st = fs.lstatSync(dir); if (st.isSymbolicLink()) errs.push(cid + ' symlink'); } catch (e) { errs.push(cid + ' lstat'); continue; }
      const rp = path.join(dir, 'run.json'); if (!fs.existsSync(rp)) { errs.push(cid + ' no run'); continue; }
      const run = JSON.parse(fs.readFileSync(rp, 'utf8'));
      if (run.caseId !== cid) errs.push(cid + ' caseId');
      if (!['PASS','KILLED'].includes(run.verdict)) errs.push(cid + ' verdict');
      if (run.mode === 'mutation' && run.verdict !== 'KILLED') errs.push(cid + ' mutation-not-killed');
      if (run.mode === 'baseline' && run.verdict !== 'PASS') errs.push(cid + ' baseline-not-pass');
      // 跨 case raw：stdout/stderr 路径必须在本 case 目录（由 path.join(dir,...) 保证——无跨 case）
      const so = fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8');
      if (run.rawStdoutSha256 !== sha(so)) errs.push(cid + ' stdout sha');
    }
  } catch (e) { errs.push('crash'); }
  return errs;
}
const S = snap();
const baselineOk = verify().length === 0;
console.log('BASELINE:', baselineOk ? 'PASS' : 'FAIL');
const ADV = [
  ['R1-reset-order', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases = ['E1-remove-duplicate-guard']; l.caseCount = 1; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ['R2-baseline-green', function () { const p = path.join(BASE, 'E1-remove-duplicate-guard', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.verdict = 'PASS'; fs.writeFileSync(p, JSON.stringify(r)); }],
  ['R3-delete-raw', function () { const p = path.join(BASE, 'B-baseline', 'stdout.txt'); fs.unlinkSync(p); }],
  ['R4-sha-tamper', function () { const p = path.join(BASE, 'E2-free-var-retry', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.rawStdoutSha256 = 'a'.repeat(64); fs.writeFileSync(p, JSON.stringify(r)); }],
  ['R5-cross-case', function () { const p = path.join(BASE, 'E1-remove-duplicate-guard', 'run.json'); const r = JSON.parse(fs.readFileSync(p,'utf8')); r.caseId = 'B-baseline'; fs.writeFileSync(p, JSON.stringify(r)); }],
  ['R6-old-evidence', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('../reset-order-selftest-rework-018/ledger/B-baseline'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ['R7-sibling-prefix', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('B-baselineX'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ['R8-unknown-field', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.evil = 1; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }]
];
let k = 0;
for (const a of ADV) {
  const s2 = snap(); a[1](); const failed = verify().length > 0; restore(s2); const rec = verify().length === 0;
  const ok = failed && rec; if (ok) k++;
  console.log((ok ? 'KILLED' : 'SURVIVED') + ' ' + a[0] + ' failed=' + failed + ' recovered=' + rec);
}
console.log('EXPECTED_RED: ' + k + '/' + ADV.length + ' KILLED');
process.exit(k >= 6 ? 0 : 2);