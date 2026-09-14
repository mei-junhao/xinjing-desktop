'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const P032 = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rebuild-029';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const errs = [];
const ledger = JSON.parse(fs.readFileSync(path.join(P032, 'ledger-029.json'), 'utf8'));
if (ledger.task_id !== 'XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rebuild-029') errs.push('task_id');
if (ledger.card_sha256 !== '200904DEE947504E41FE51BA41AD11D69BE01C5DEEE3193DD091B4185EA8AC04') errs.push('card');
if (ledger.candidate_source_sha256 !== sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8'))) errs.push('candidate');
if (ledger.runCount !== 24 || ledger.entries.length !== 24) errs.push('count');
const TOP = ['task_id','card_sha256','candidate_source_sha256','runCount','entries']; for (const k of Object.keys(ledger)) if (!TOP.includes(k)) errs.push('top ' + k);
const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
for (const mid of MUT) { const es = ledger.entries.filter(e => e.mutationId === mid); if (es.length !== 3) errs.push(mid + ' count'); for (const st of ['baseline','mutated','restore']) if (!es.some(e => e.stage === st)) errs.push(mid + ' stage'); }
for (const e of ledger.entries) {
  const mp = path.resolve(e.metaPath); const rel = path.relative(ROOT, mp);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { errs.push(e.mutationId + '.' + e.stage + ' contain'); continue; }
  if (!fs.existsSync(mp)) { errs.push(e.mutationId + '.' + e.stage + ' meta'); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const F = ['mutationId','stage','command','argv','cwd','startUtc','endUtc','exitCode','stdoutPath','stderrPath','stdoutSha256','stdoutBytes','stderrSha256','stderrBytes','verdict'];
  for (const k of F) if (!(k in meta)) errs.push(e.mutationId + '.' + e.stage + ' miss ' + k);
  if (e.stage !== 'mutated') for (const k of Object.keys(meta)) if (!F.includes(k) && k !== 'errors') errs.push(e.mutationId + '.' + e.stage + ' unknown ' + k);
  const expectExit = e.stage === 'mutated' ? 2 : 0; const expectVerdict = e.stage === 'mutated' ? 'FAIL' : 'PASS';
  if (meta.exitCode !== expectExit || e.exitCode !== expectExit) errs.push(e.mutationId + '.' + e.stage + ' exit');
  if (meta.verdict !== expectVerdict || e.verdict !== expectVerdict) errs.push(e.mutationId + '.' + e.stage + ' verdict');
  const t0 = Date.parse(meta.startUtc); const t1 = Date.parse(meta.endUtc); if (isNaN(t0) || isNaN(t1) || t1 < t0) errs.push(e.mutationId + '.' + e.stage + ' utc');
  if (meta.cwd !== 'D:/xinjing-electron') errs.push(e.mutationId + '.' + e.stage + ' cwd');
  if (e.stage !== 'mutated') {
    const soP = path.resolve(meta.stdoutPath); const seP = path.resolve(meta.stderrPath);
    if (!fs.existsSync(soP) || !fs.existsSync(seP)) { errs.push(e.mutationId + '.' + e.stage + ' raw'); continue; }
    const so = fs.readFileSync(soP, 'utf8'); const se = fs.readFileSync(seP, 'utf8');
    if (meta.stdoutSha256 !== sha(so)) errs.push(e.mutationId + '.' + e.stage + ' so sha');
    if (meta.stderrSha256 !== sha(se)) errs.push(e.mutationId + '.' + e.stage + ' se sha');
    if (meta.stdoutBytes !== Buffer.byteLength(so)) errs.push(e.mutationId + '.' + e.stage + ' so bytes');
    if (meta.stderrBytes !== Buffer.byteLength(se)) errs.push(e.mutationId + '.' + e.stage + ' se bytes');
    if (so.indexOf('FILE_SYMLINK_EPERM') < 0 && so.indexOf('FILE_SYMLINK_OK') < 0) errs.push(e.mutationId + '.' + e.stage + ' no file-probe');
    if (so.indexOf('JUNCTION_OK isSymbolicLink=') < 0 && so.indexOf('JUNCTION_EPERM') < 0) errs.push(e.mutationId + '.' + e.stage + ' no junction-probe');
  }
}
console.log('VERIFY_029:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.slice(0, 5).join('|'));
process.exit(errs.length === 0 ? 0 : 2);