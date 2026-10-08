'use strict';
// 015 容错 verifier + A1-A11 对抗（坏 ledger 结构化 fail-closed 不崩溃）
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const BASE = path.resolve(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-adversarial-rework-015/ledger');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
function verify() {
  const errors = [];
  const ledgerPath = path.join(BASE, 'ledger.json');
  if (!fs.existsSync(ledgerPath)) return ['missing ledger'];
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (e) { return ['ledger not JSON']; }
  if (!ledger || typeof ledger !== 'object') return ['ledger not object'];
  if (!Array.isArray(ledger.cases)) return ['cases not array'];
  const TOP = ['task_id','card_sha256','candidate_source_sha256','caseCount','uniqueIds','cases'];
  for (const k of TOP) if (!(k in ledger)) errors.push('missing top ' + k);
  for (const k of Object.keys(ledger)) if (!TOP.includes(k)) errors.push('unknown top ' + k);
  if (typeof ledger.caseCount !== 'number' || ledger.caseCount !== ledger.cases.length) errors.push('caseCount mismatch');
  if (!Array.isArray(ledger.uniqueIds) || new Set(ledger.uniqueIds).size !== ledger.uniqueIds.length) errors.push('dup/invalid ids');
  // A1: ledger.cases 与磁盘 case 目录数一致性
  let dirCount = 0; try { dirCount = fs.readdirSync(BASE).filter(function (n) { return /^[BE]/.test(n); }).length; } catch (e) {}
  if (dirCount !== ledger.cases.length) errors.push('cases-vs-dirs mismatch (' + ledger.cases.length + ' vs ' + dirCount + ')');
  const chatSrc = fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8');
  if (ledger.candidate_source_sha256 !== sha(chatSrc)) errors.push('candidate source SHA');
  for (const cid of ledger.cases) {
    const dir = path.resolve(BASE, cid);
    const rel = path.relative(BASE, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') { errors.push(cid + ' containment'); continue; }
    try { const st = fs.lstatSync(dir); if (st.isSymbolicLink()) errors.push(cid + ' symlink'); } catch (e) { errors.push(cid + ' lstat'); continue; }
    const runPath = path.join(dir, 'run.json');
    if (!fs.existsSync(runPath)) { errors.push(cid + ' no run'); continue; }
    let run = null; try { run = JSON.parse(fs.readFileSync(runPath, 'utf8')); } catch (e) { errors.push(cid + ' run not JSON'); continue; }
    const F = ['caseId','mode','command','argv','cwd','startUtc','endUtc','exitCode','sourcePath','sourceBeforeSha256','sourceBeforeBytes','sourceAfterSha256','sourceAfterBytes','rawStdoutSha256','rawStdoutBytes','rawStderrSha256','rawStderrBytes','expectedDifference','verdict'];
    for (const k of F) if (!(k in run)) errors.push(cid + ' missing ' + k);
    for (const k of Object.keys(run)) if (!F.includes(k)) errors.push(cid + ' unknown ' + k);
    if (run.caseId !== cid) errors.push(cid + ' caseId');
    if (!['PASS','KILLED'].includes(run.verdict)) errors.push(cid + ' verdict');
    if (run.mode === 'baseline' && run.verdict !== 'PASS') errors.push(cid + ' baseline not PASS');
    if (run.mode === 'mutation' && run.verdict !== 'KILLED') errors.push(cid + ' mutation not KILLED');
    const cwdN = String(run.cwd || '').split('\\').join('/');
    if (!path.isAbsolute(run.cwd || '') || cwdN.indexOf('D:/xinjing-electron') !== 0) errors.push(cid + ' cwd not absolute-contained');
    const stdout = fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8');
    const stderrP = path.join(dir, 'stderr.txt');
    if (!fs.existsSync(stderrP)) { errors.push(cid + ' no stderr file'); continue; }
    const stderr = fs.readFileSync(stderrP, 'utf8');
    if (run.rawStdoutSha256 !== sha(stdout)) errors.push(cid + ' stdout SHA');
    if (run.rawStderrSha256 !== sha(stderr)) errors.push(cid + ' stderr SHA');
    if (run.rawStdoutBytes !== Buffer.byteLength(stdout)) errors.push(cid + ' stdout bytes');
    if (run.rawStderrBytes !== Buffer.byteLength(stderr)) errors.push(cid + ' stderr bytes');
  }
  return errors;
}
const errs = verify();
const PASS = errs.length === 0;
console.log('VERIFY_MAIN:', PASS ? 'PASS' : 'FAIL ' + errs.join('|'));
const ledgerPath = path.join(BASE, 'ledger.json');
const original = fs.readFileSync(ledgerPath, 'utf8');
const firstRun = JSON.parse(original).cases[0];
const adv = [];
function runAdv(name, mutate, restore) {
  try { mutate(); const e2 = verify(); const failed = e2.length > 0; restore(); const e3 = verify(); const rec = e3.length === 0; const ok = failed && rec; adv.push(ok); console.log((ok ? 'KILLED' : 'SURVIVED') + ' ADV ' + name + ' failed=' + failed + ' recovered=' + rec); return ok; }
  catch (e) { console.log('ERR ADV ' + name + ': ' + e.message); return false; }
}
const snapshots = {};
function snap(name) { const p2 = path.join(BASE, name, 'run.json'); if (fs.existsSync(p2)) snapshots[name] = fs.readFileSync(p2, 'utf8'); }
['B-baseline','E1-remove-duplicate-guard','E2-free-var-retry','E3-textarea-only','E4-missing-send','E5-dropped-draft','E6-auto-switch','E7-swallow-ok-false','E8-success-before-resolve','E9-remove-card-on-failure','E10-missing-re-enable','E11-credential-leak'].forEach(snap);
const restoreRun = function (name) { if (snapshots[name]) fs.writeFileSync(path.join(BASE, name, 'run.json'), snapshots[name]); };
const A = [
  ['A1-delete-entry', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.pop(); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A2-dup-id', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.uniqueIds.push(l.uniqueIds[0]); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A3-unknown-field', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.evil = 1; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A4-delete-stderr', function () { const p2 = path.join(BASE, firstRun, 'stderr.txt'); if (fs.existsSync(p2)) fs.unlinkSync(p2); }, function () { fs.writeFileSync(path.join(BASE, firstRun, 'stderr.txt'), ''); }],
  ['A5-tamper-sha', function () { const p2 = path.join(BASE, firstRun, 'run.json'); const r = JSON.parse(fs.readFileSync(p2,'utf8')); r.rawStdoutSha256 = 'x'.repeat(64); fs.writeFileSync(p2, JSON.stringify(r)); }, function () { restoreRun(firstRun); }],
  ['A6-relative-cwd', function () { const p2 = path.join(BASE, firstRun, 'run.json'); const r = JSON.parse(fs.readFileSync(p2,'utf8')); r.cwd = './rel'; fs.writeFileSync(p2, JSON.stringify(r)); }, function () { restoreRun(firstRun); }],
  ['A7-sibling-prefix', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push(firstRun + 'X'); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A8-old-evidence', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.cases.push('../verifier-adversarial-rework-014/ledger/' + firstRun); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A9-total-only', function () { fs.writeFileSync(ledgerPath, JSON.stringify({ total: 12 })); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ['A10-invalid-as-killed', function () { const p2 = path.join(BASE, 'E2-free-var-retry', 'run.json'); const r = JSON.parse(fs.readFileSync(p2,'utf8')); r.verdict = 'SURVIVED'; fs.writeFileSync(p2, JSON.stringify(r)); }, function () { restoreRun('E2-free-var-retry'); }],
  ['A11-candidate-sha-tamper', function () { const l = JSON.parse(fs.readFileSync(ledgerPath,'utf8')); l.candidate_source_sha256 = 'y'.repeat(64); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }]
];
let advOk = 0;
for (const a of A) { if (runAdv(a[0], a[1], a[2])) advOk++; }
console.log('ADVERSARIAL: ' + advOk + '/' + A.length + ' KILLED');
const final = verify();
console.log('VERIFY_AFTER_ADV:', final.length === 0 ? 'PASS' : 'FAIL ' + final.join('|'));
fs.writeFileSync(path.join(BASE, 'verifier-out.txt'), 'VERIFY_MAIN:' + (PASS ? 'PASS' : 'FAIL') + ' ADV:' + advOk + '/' + A.length + '\n');
process.exit(PASS && advOk === 11 ? 0 : 2);