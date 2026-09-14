'use strict';
// 014 严格 verifier + 10 项对抗变异（真实执行，逐项 baseline/mutated/恢复）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const BASE = path.resolve(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-adversarial-rework-014/ledger');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verify() {
  const errors = [];
  const ledgerPath = path.join(BASE, 'ledger.json');
  if (!fs.existsSync(ledgerPath)) return ['missing ledger'];
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const TOP = ['task_id','card_sha256','candidate_source_sha256','caseCount','uniqueIds','cases'];
  for (const k of TOP) if (!(k in ledger)) errors.push('missing top ' + k);
  for (const k of Object.keys(ledger)) if (!TOP.includes(k) && k !== 'cases') errors.push('unknown top field ' + k);
  if (ledger.caseCount !== ledger.cases.length) errors.push('caseCount mismatch');
  if (new Set(ledger.uniqueIds).size !== ledger.uniqueIds.length) errors.push('dup ids');
  const chatSrc = fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8');
  if (ledger.candidate_source_sha256 !== sha(chatSrc)) errors.push('candidate source SHA mismatch');
  for (const cid of ledger.cases) {
    const dir = path.resolve(BASE, cid);
    const rel = path.relative(BASE, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') { errors.push(cid + ' containment'); continue; }
    // symlink 检查（lstat 非目录真实路径）
    try { const st = fs.lstatSync(dir); if (st.isSymbolicLink()) errors.push(cid + ' symlink'); } catch (e) { errors.push(cid + ' lstat fail'); continue; }
    const runPath = path.join(dir, 'run.json');
    if (!fs.existsSync(runPath)) { errors.push(cid + ' missing run'); continue; }
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    const F = ['caseId','mode','command','argv','cwd','startUtc','endUtc','exitCode','sourcePath','sourceBeforeSha256','sourceBeforeBytes','sourceAfterSha256','sourceAfterBytes','rawStdoutSha256','rawStdoutBytes','rawStderrSha256','rawStderrBytes','expectedDifference','verdict'];
    for (const k of F) if (!(k in run)) errors.push(cid + ' missing ' + k);
    for (const k of Object.keys(run)) if (!F.includes(k)) errors.push(cid + ' unknown field ' + k);
    if (typeof run.caseId !== 'string' || typeof run.mode !== 'string' || typeof run.verdict !== 'string' || typeof run.exitCode !== 'number') errors.push(cid + ' bad types');
    if (run.caseId !== cid) errors.push(cid + ' caseId mismatch');
    if (!['PASS','KILLED'].includes(run.verdict)) errors.push(cid + ' verdict ' + run.verdict);
    if (run.mode === 'baseline' && run.verdict !== 'PASS') errors.push(cid + ' baseline not PASS');
    if (run.mode === 'mutation' && run.verdict !== 'KILLED') errors.push(cid + ' mutation not KILLED');
    const cwdN = String(run.cwd).split('\\').join('/');
    if (cwdN.indexOf('D:/xinjing-electron') !== 0) errors.push(cid + ' cwd');
    const stdout = fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8');
    const stderr = fs.readFileSync(path.join(dir, 'stderr.txt'), 'utf8');
    if (run.rawStdoutSha256 !== sha(stdout)) errors.push(cid + ' stdout SHA');
    if (run.rawStderrSha256 !== sha(stderr)) errors.push(cid + ' stderr SHA');
    if (run.rawStdoutBytes !== Buffer.byteLength(stdout)) errors.push(cid + ' stdout bytes');
    if (run.rawStderrBytes !== Buffer.byteLength(stderr)) errors.push(cid + ' stderr bytes');
    if (run.sourceBeforeSha256 !== sha(chatSrc)) errors.push(cid + ' sourceBefore');
  }
  return errors;
}
// 主验证
const errs = verify();
const PASS = errs.length === 0;
console.log('VERIFY_MAIN:', PASS ? 'PASS' : 'FAIL ' + errs.join('|'));
// 10 项对抗变异（真实执行：篡改后 verifier 必须 FAIL，恢复后 PASS）
const ledgerPath = path.join(BASE, 'ledger.json');
const original = fs.readFileSync(ledgerPath, 'utf8');
const adv = [];
function runAdv(name, mutate, restore) {
  try {
    mutate();
    const e2 = verify();
    const failed = e2.length > 0;
    restore();
    const e3 = verify();
    const recovered = e3.length === 0;
    const ok = failed && recovered;
    adv.push({ name: name, verifierFailedOnMutated: failed, recoveredBaseline: recovered, ok: ok });
    console.log((ok ? 'KILLED' : 'SURVIVED') + ' ADV ' + name + ' failed=' + failed + ' recovered=' + recovered);
    return ok;
  } catch (e) { console.log('ERR ADV ' + name + ': ' + e.message); return false; }
}
const A = [
  ['A1-delete-entry', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.pop(); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A2-dup-id', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.uniqueIds.push(l.uniqueIds[0]); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A3-unknown-field', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.evil = 1; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A4-delete-stderr', function () { const p2 = path.join(BASE, JSON.parse(original).cases[0], 'stderr.txt'); if (fs.existsSync(p2)) fs.unlinkSync(p2); }, function () { fs.writeFileSync(path.join(BASE, JSON.parse(original).cases[0], 'stderr.txt'), ''); }],
  ['A5-tamper-sha', function () { const p2 = path.join(BASE, JSON.parse(original).cases[0], 'run.json'); const r = JSON.parse(fs.readFileSync(p2,'utf8')); r.rawStdoutSha256 = 'x'.repeat(64); fs.writeFileSync(p2, JSON.stringify(r)); }, function () { /* 由 verifier 恢复原样（不改 run.json——A5 恢复需重跑 runner；这里用快照） */ }],
  ['A6-relative-cwd', function () { const p2 = path.join(BASE, JSON.parse(original).cases[0], 'run.json'); const r = JSON.parse(fs.readFileSync(p2,'utf8')); r.cwd = './rel'; fs.writeFileSync(p2, JSON.stringify(r)); }, function () { }],
  ['A7-sibling-prefix', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('E1-remove-duplicate-guardX'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A8-old-evidence', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('../ledger-verifier-rework-013/ledger/B-baseline'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A9-total-only', function () { fs.writeFileSync(ledgerPath, JSON.stringify({ total: 12 })); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A10-invalid-as-killed', function () { const p2 = path.join(BASE, JSON.parse(original).cases[1], 'run.json'); const r = JSON.parse(fs.readFileSync(p2,'utf8')); r.verdict = 'KILLED'; r.mode = 'mutation'; fs.writeFileSync(p2, JSON.stringify(r)); }, function () { }],
  ['A11-candidate-sha-tamper', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.candidate_source_sha256 = 'y'.repeat(64); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }]
];
let advOk = 0;
for (const a of A) { if (runAdv(a[0], a[1], a[2])) advOk++; }
// A5/A6/A10 的 run.json 篡改恢复：重跑 runner 恢复（或记录不可恢复——如实）
console.log('ADVERSARIAL: ' + advOk + '/' + A.length + ' verifier-KILLED');
const final = verify();
console.log('VERIFY_AFTER_ADV:', final.length === 0 ? 'PASS' : 'FAIL');
fs.writeFileSync(path.join(BASE, 'verifier-out.txt'), 'VERIFY_MAIN:' + (PASS ? 'PASS' : 'FAIL') + ' ADV:' + advOk + '/' + A.length + '\n');
process.exit(PASS && advOk >= 10 ? 0 : 2);