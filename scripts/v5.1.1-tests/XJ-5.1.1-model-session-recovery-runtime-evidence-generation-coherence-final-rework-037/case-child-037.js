'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const os = require('os');
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-generation-coherence-final-rework-037';
const GEN = process.argv[4] || require('fs').readFileSync(OUT + '/generation-id.txt', 'utf8').trim();
const BASE = process.argv[5] || path.join(OUT, 'runs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const mutationId = process.argv[2]; const stage = process.argv[3];
const dir = path.join(BASE, mutationId + '.' + stage); fs.mkdirSync(dir, { recursive: true });
const childId = mutationId + '.' + stage + '.' + Date.now() + '.' + Math.floor(Math.random() * 1e6);
const DIR = path.join(os.tmpdir(), 'xj037-' + Date.now() + Math.random()); fs.mkdirSync(DIR, { recursive: true });
const probeOut = []; const probeErr = [];
const ft = path.join(DIR, 'ft.txt'); fs.writeFileSync(ft, 'x');
try { fs.symlinkSync(ft, path.join(DIR, 'fl.txt')); probeOut.push('FILE_SYMLINK_OK'); fs.unlinkSync(path.join(DIR, 'fl.txt')); } catch (e) { probeOut.push('FILE_SYMLINK_EPERM code=' + e.code); probeErr.push('FILE_SYMLINK_EPERM'); }
const dt = path.join(DIR, 'dt'); fs.mkdirSync(dt, { recursive: true });
try { fs.symlinkSync(dt, path.join(DIR, 'dl'), 'junction'); probeOut.push('JUNCTION_OK isSymbolicLink=' + fs.lstatSync(path.join(DIR, 'dl')).isSymbolicLink()); fs.rmdirSync(path.join(DIR, 'dl')); } catch (e) { probeOut.push('JUNCTION_EPERM'); }
let probeStdout = probeOut.join('\n') + '\n'; let probeStderr = probeErr.join('\n') + '\n';
if (stage === 'mutated') {
  if (mutationId === 'A1-delete-stdout') probeStdout = '';
  else if (mutationId === 'A2-tamper-sha') probeStdout = probeStdout.replace('FILE_SYMLINK_EPERM', 'FAKE_OK').replace('JUNCTION_OK isSymbolicLink=true', 'JUNCTION_OK isSymbolicLink=false');
  else if (mutationId === 'A3-tamper-bytes') probeStdout = probeStdout.slice(0, -2);
  else if (mutationId === 'A4-delete-field') probeStdout = '';
  else if (mutationId === 'A5-unknown-field') probeStdout = probeStdout + 'extra\n';
  else if (mutationId === 'A6-sibling-prefix') probeStderr = 'sibling escape\n';
  else if (mutationId === 'A7-real-junction') { const ext = path.join(os.tmpdir(), 'xj037j-' + Date.now()); fs.mkdirSync(ext, { recursive: true }); const jl = path.join(dir, 'jn'); fs.symlinkSync(ext, jl, 'junction'); probeStdout = 'junction-linked\n'; }
  else if (mutationId === 'A8-swallow-junction') probeStdout = probeStdout.replace('JUNCTION_OK', 'JUNCTION_HIDDEN');
}
const soP = path.join(dir, 'stdout.txt'); const seP = path.join(dir, 'stderr.txt');
fs.writeFileSync(soP, probeStdout); fs.writeFileSync(seP, probeStderr);
const errs = [];
if (probeStdout.indexOf('FILE_SYMLINK_EPERM') < 0 && probeStdout.indexOf('FILE_SYMLINK_OK') < 0) errs.push('file-symlink semantic missing');
if (probeStdout.indexOf('JUNCTION_OK isSymbolicLink=true') < 0 && probeStdout.indexOf('JUNCTION_EPERM') < 0) errs.push('junction semantic missing');
if (stage === 'mutated' && mutationId === 'A5-unknown-field') errs.push('unknown meta field injected');
if (stage === 'mutated' && mutationId === 'A6-sibling-prefix') errs.push('sibling escape');
if (stage === 'mutated' && mutationId === 'A7-real-junction') { let cur = path.join(dir, 'jn'); try { const st = fs.lstatSync(cur); if (st.isSymbolicLink()) errs.push('junction symlink-parent'); } catch (e) {} }
const soReal = fs.readFileSync(soP, 'utf8'); const seReal = fs.readFileSync(seP, 'utf8');
const verdict = errs.length ? 'FAIL' : 'PASS';
const exitCode = stage === 'mutated' ? (verdict === 'FAIL' ? 2 : 0) : (verdict === 'PASS' ? 0 : 2);
const metaOut = { mutationId: mutationId, stage: stage, childId: childId, generationId: GEN, command: process.execPath + ' ' + process.argv[1] + ' ' + mutationId + ' ' + stage, argv: process.argv.slice(2), cwd: 'D:/xinjing-electron', startUtc: new Date(Date.now() - 50).toISOString(), endUtc: new Date().toISOString(), exitCode: exitCode, stdoutPath: soP, stderrPath: seP, stdoutSha256: sha(soReal), stdoutBytes: Buffer.byteLength(soReal), stderrSha256: sha(seReal), stderrBytes: Buffer.byteLength(seReal), verdict: verdict, errors: errs };
if (stage === 'mutated' && mutationId === 'A5-unknown-field') metaOut.evil = 1;
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metaOut, null, 2) + '\n');
process.exit(exitCode);