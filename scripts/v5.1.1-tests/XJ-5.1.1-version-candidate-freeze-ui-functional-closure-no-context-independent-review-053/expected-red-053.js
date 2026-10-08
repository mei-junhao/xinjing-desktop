'use strict';
// 053 expected-red runner: for each variant, copy candidate -> mutate -> rebind+recompute internal bindings -> run verifier.
// NOTE: rebind+recompute only affects the ISOLATED copy; canonical candidate is never touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve('.');
const CAND = path.join(REPO, 'docs/agent-coordination/v5.1.1/candidate-freeze/5.1.1-rt-5.1.1-0001-001-ui-functional-closure-candidate');
const S52 = path.join(REPO, 'qa/task-scratch/XJ-5.1.1-version-candidate-freeze-ui-functional-closure-052');
const ISO = path.join(REPO, 'qa/task-scratch/XJ-5.1.1-version-candidate-freeze-ui-functional-closure-no-context-independent-review-053/isolated');
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(); }
function writeJson(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n', 'utf8'); }

function rebindFull(d) {
  // freeze.json: candidate_root -> d (freeze sha changes; final-manifest.freeze_sha256 must rebind)
  const fzPath = path.join(d, 'freeze.json');
  const fz = JSON.parse(fs.readFileSync(fzPath, 'utf8'));
  fz.candidate_root = d;
  writeJson(fzPath, fz);
  // recompute candidate-files.txt sha + manifest sha + aggregate + freeze sha; rebind final-manifest
  const manPath = path.join(d, 'manifest.json');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  const entries = man.entries.slice().sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const lines = entries.map(e => [e.relative_path, e.candidate_sha256, e.byte_count, e.source_task].join('|'));
  const candidateSha = sha(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  const filesBuf = fs.readFileSync(path.join(d, 'candidate-files.txt'));
  const filesSha = sha(filesBuf);
  const manifestSha = sha(Buffer.from(JSON.stringify(man) + '\n', 'utf8'));
  const freezeSha = sha(fs.readFileSync(fzPath));
  const fmPath = path.join(d, 'final-manifest.json');
  const fm = JSON.parse(fs.readFileSync(fmPath, 'utf8'));
  fm.candidate_sha256 = candidateSha;
  fm.manifest_sha256 = manifestSha;
  fm.candidate_files_sha256 = filesSha;
  fm.freeze_sha256 = freezeSha;
  if ('candidate_root' in fm) fm.candidate_root = d;
  writeJson(fmPath, fm);
  return { candidateSha, filesSha, manifestSha, freezeSha };
}

function runVerifier(d) {
  // shadow module with rebound CANDIDATE
  let src = fs.readFileSync(path.join(S52, 'freeze-052.js'), 'utf8');
  src = src.replace(/const CANDIDATE = [^;]+;/, 'const CANDIDATE = ' + JSON.stringify(d) + ';');
  const shadowDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj053er-'));
  fs.writeFileSync(path.join(shadowDir, 'freeze-052.js'), src);
  fs.writeFileSync(path.join(shadowDir, 'verifier-052.js'), fs.readFileSync(path.join(S52, 'verifier-052.js')));
  const r = spawnSync(process.execPath, [path.join(shadowDir, 'verifier-052.js')], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  try { fs.rmSync(shadowDir, { recursive: true, force: true }); } catch (e) {}
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function flipLast(p) { const b = fs.readFileSync(p); b[b.length - 1] ^= 0xFF; fs.writeFileSync(p, b); }

const VARIANTS = [
  ['01-delete-member', d => fs.rmSync(path.join(d, 'files', 'app', 'css', 'masters-clinical.css'))],
  ['02-duplicate-member', d => fs.copyFileSync(path.join(d, 'files', 'app', 'index.html'), path.join(d, 'files', 'app', 'dup-index.html'))],
  ['03-reorder-tsv', d => { const p = path.join(d, 'candidate-files.txt'); const L = fs.readFileSync(p, 'utf8').split('\n').filter(x => x.trim()); const t = L[0]; L[0] = L[1]; L[1] = t; fs.writeFileSync(p, L.join('\n') + '\n'); }],
  ['04-tamper-entry-sha', d => flipLast(path.join(d, 'files', 'app', 'index.html'))],
  ['05-source-task-swap', d => { const p = path.join(d, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.entries[0].source_task = '999'; writeJson(p, m); }],
  ['06-candidate-sha-forge', d => { const p = path.join(d, 'final-manifest.json'); const x = JSON.parse(fs.readFileSync(p, 'utf8')); x.candidate_sha256 = 'E' + '1'.repeat(63); writeJson(p, x); }],
  ['07-release-ready-forge', d => { const p = path.join(d, 'freeze.json'); const x = JSON.parse(fs.readFileSync(p, 'utf8')); x.release_ready = true; writeJson(p, x); }],
  ['08-path-escape', d => { const p = path.join(d, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.entries[0].candidate_path_rel = '../../outside/file.txt'; writeJson(p, m); }],
  ['09-sibling-prefix', d => { const p = path.join(d, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.entries[0].candidate_path_rel = 'files/app-v2/index.html'; writeJson(p, m); }],
];

const results = [];
for (const [name, fn] of VARIANTS) {
  const d = path.join(ISO, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.cpSync(CAND, d, { recursive: true });
  rebindFull(d);
  fn(d);
  const r = runVerifier(d);
  const killed = r.status !== 0;
  results.push({ name, exit: r.status, fail_closed: killed, stdout_tail: (r.stdout || '').trim().slice(0, 220), stderr_tail: (r.stderr || '').trim().slice(0, 120) });
  console.log((killed ? 'KILLED  ' : 'SURVIVED') + ' ' + name + ' | ' + (r.stdout || r.stderr || '').trim().slice(0, 110));
}
fs.writeFileSync(path.join(ISO, 'expected-red-053.json'), JSON.stringify(results, null, 1));
console.log('EXPECTED-RED:', results.filter(r => r.fail_closed).length, '/', results.length, 'KILLED');
// restore: pristine copy, rebind, verify => PASS
const rd = path.join(ISO, 'restore-check');
fs.rmSync(rd, { recursive: true, force: true });
fs.cpSync(CAND, rd, { recursive: true });
rebindFull(rd);
const rr = runVerifier(rd);
console.log('RESTORE: exit', rr.status, '|', (rr.stdout || '').trim().slice(0, 100));
// canonical zero-drift vs manifest
const man = JSON.parse(fs.readFileSync(path.join(CAND, 'manifest.json'), 'utf8'));
let drift = 0;
for (const e of man.entries) {
  const p = path.join(CAND, e.candidate_path_rel.replace(/\//g, path.sep));
  if (sha(fs.readFileSync(p)) !== e.candidate_sha256) drift += 1;
}
console.log('canonical drift:', drift);