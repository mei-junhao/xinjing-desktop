'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const LEDGER_PATH = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-supervision-material-upload-runtime-closure-012/expected-red/ledger-012.json');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex').toUpperCase();
const errors = [];
let ledger = null;
try { ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch (error) { errors.push('ledger unreadable: ' + error.message); }
if (!ledger || ledger.taskId !== 'XJ-5.1.1-supervision-material-upload-runtime-closure-012') errors.push('task binding');
if (!ledger || ledger.verdict !== 'PASS') errors.push('ledger verdict');
if (!ledger || !Array.isArray(ledger.entries) || ledger.entries.length !== 12) errors.push('entry count');
for (const entry of (ledger && ledger.entries || [])) {
  if (!['baseline', 'mutated', 'restored'].includes(entry.stage)) errors.push(entry.caseId + ' stage');
  if (entry.verdict !== 'PASS') errors.push(entry.caseId + '.' + entry.stage + ' verdict');
  if (entry.stage === 'mutated' && entry.exitCode === 0) errors.push(entry.caseId + ' mutation exit');
  if (entry.stage !== 'mutated' && entry.exitCode !== 0) errors.push(entry.caseId + '.' + entry.stage + ' exit');
  for (const key of ['stdoutPath', 'stderrPath']) {
    if (!path.isAbsolute(entry[key]) || !fs.existsSync(entry[key])) { errors.push(entry.caseId + '.' + entry.stage + ' ' + key); continue; }
    const raw = fs.readFileSync(entry[key], 'utf8');
    const hashKey = key === 'stdoutPath' ? 'stdoutSha256' : 'stderrSha256';
    const bytesKey = key === 'stdoutPath' ? 'stdoutBytes' : 'stderrBytes';
    if (sha256(raw) !== entry[hashKey]) errors.push(entry.caseId + '.' + entry.stage + ' ' + hashKey);
    if (Buffer.byteLength(raw, 'utf8') !== entry[bytesKey]) errors.push(entry.caseId + '.' + entry.stage + ' ' + bytesKey);
  }
}
if (errors.length) { process.stderr.write(JSON.stringify({ ok: false, errors }) + '\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ ok: true, verdict: 'PASS', ledger: LEDGER_PATH, entries: ledger.entries.length }) + '\n');
