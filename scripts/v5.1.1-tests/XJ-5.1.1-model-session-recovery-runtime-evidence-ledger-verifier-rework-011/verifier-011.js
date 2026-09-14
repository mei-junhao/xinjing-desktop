'use strict';
// 011 独立 verifier：真实读取 ledger + raw，fail-closed 校验
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const LEDGER = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-ledger-verifier-rework-011/ledger/ledger.json');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errors = [];
if (!fs.existsSync(LEDGER)) { console.log('VERIFY: FAIL ledger missing'); process.exit(2); }
const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const REQUIRED_TOP = ['task_id', 'card_sha256', 'candidate_source_sha256', 'caseCount', 'uniqueIds', 'cases'];
for (const k of REQUIRED_TOP) { if (!(k in ledger)) errors.push('missing top field: ' + k); }
if (ledger.caseCount !== ledger.cases.length) errors.push('caseCount mismatch');
const uniq = new Set(ledger.uniqueIds);
if (uniq.size !== ledger.uniqueIds.length) errors.push('duplicate ids');
const chatSrc = fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8');
if (ledger.candidate_source_sha256 !== sha(chatSrc)) errors.push('candidate source SHA mismatch (disk=' + sha(chatSrc).slice(0,8) + ')');
for (const cid of ledger.cases) {
  const dir = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-ledger-verifier-rework-011/ledger', cid);
  const runPath = path.join(dir, 'run.json');
  if (!fs.existsSync(runPath)) { errors.push('missing run.json for ' + cid); continue; }
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const R17 = ['caseId','mode','command','argv','cwd','startUtc','endUtc','exitCode','sourcePath','sourceBeforeSha256','sourceBeforeBytes','sourceAfterSha256','sourceAfterBytes','rawStdoutSha256','rawStdoutBytes','rawStderrSha256','rawStderrBytes','expectedDifference','verdict'];
  for (const k of R17) { if (!(k in run)) errors.push(cid + ' missing field: ' + k); }
  var cwdNorm = String(run.cwd).split('\\').join('/'); if (cwdNorm.indexOf('D:/xinjing-electron') !== 0) errors.push(cid + ' cwd not absolute-contained: ' + cwdNorm);
  const stdout = fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8');
  const stderr = fs.readFileSync(path.join(dir, 'stderr.txt'), 'utf8');
  if (run.rawStdoutSha256 !== sha(stdout)) errors.push(cid + ' raw stdout SHA mismatch');
  if (run.rawStderrSha256 !== sha(stderr)) errors.push(cid + ' raw stderr SHA mismatch');
  if (run.rawStdoutBytes !== Buffer.byteLength(stdout)) errors.push(cid + ' raw stdout bytes mismatch');
  if (run.caseId !== cid) errors.push(cid + ' caseId mismatch');
  if (!['PASS','KILLED','INVALID','SURVIVED','FAIL'].includes(run.verdict)) errors.push(cid + ' bad verdict');
}
const vout = errors.length === 0 ? 'VERIFY: PASS' : 'VERIFY: FAIL ' + errors.join(' | ');
console.log(vout);
fs.writeFileSync(path.join(path.dirname(LEDGER), 'verifier-out.txt'), vout + '\n');
process.exit(errors.length === 0 ? 0 : 2);