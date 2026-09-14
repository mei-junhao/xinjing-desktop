
'use strict';
// 045 verifier — independent re-verification of 044 retry-04 evidence (read-only inputs, fresh self capture)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-045';
const INPUT_TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044';
const EXPECTED_CARD_044 = 'FCA7266ED2D8BB543A6AF1CBEEDAD7AE4F08483659C3FC0DACF9CDD9557AB087';
const EXPECTED_STORE = '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D';
const OUT = process.argv[2];   // 045 evidence dir (self capture goes here)
const E044 = process.argv[3];  // 044 retry-04 evidence root (read-only)

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function containment(p) {
  if (!p) return false;
  const norm = path.resolve(p);
  if (norm.split(path.sep).includes('..')) return false;
  return true;
}
const errs = [];

// self capture (fresh subprocess wrote our stdout/stderr; we bind them here)
const selfStdout = path.join(OUT, 'verifier-045.stdout.raw');
if (!fs.existsSync(selfStdout)) fs.writeFileSync(selfStdout, '');
const selfStderr = path.join(OUT, 'verifier-045.stderr.raw');
if (!fs.existsSync(selfStderr)) fs.writeFileSync(selfStderr, '');
function ERRDIR() { return OUT; }

// 1) 044 manifest identity
const m = JSON.parse(fs.readFileSync(path.join(E044, 'evidence-manifest.json'), 'utf8'));
if (String(m.cardSha256).toUpperCase() !== EXPECTED_CARD_044) errs.push('manifest cardSha mismatch');
if (String(m.storeSha256AtEnd).toUpperCase() !== EXPECTED_STORE) errs.push('manifest storeShaAtEnd mismatch');
if (!String(m.fixedOrigin).includes('19421')) errs.push('fixedOrigin not 19421');
if (m.taskId && !String(m.taskId).includes('recovery-044')) errs.push('manifest taskId unexpected: ' + m.taskId);

// 2) production store unchanged
const storePath = 'D:/xinjing-electron/app/js/store.js';
if (sha256(storePath) !== EXPECTED_STORE) errs.push('production store.js drifted');

// 3) every stage meta: fields, containment, sha/bytes, UTC order, exit
const metas = m.stageMetaPaths || [];
let ok = 0;
for (const mp of metas) {
  if (!containment(mp)) { errs.push('meta path escape: ' + mp); continue; }
  if (!fs.existsSync(mp)) { errs.push('meta missing: ' + mp); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  for (const f of ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'stdoutPath', 'stderrPath']) {
    if (!(f in meta)) errs.push('meta missing ' + f + ': ' + mp);
  }
  if (meta.cwd && !containment(meta.cwd)) errs.push('cwd escape: ' + meta.cwd);
  if (meta.endUtc && meta.startUtc && meta.endUtc < meta.startUtc) errs.push('UTC order: ' + mp);
  for (const [pk, sk, bk] of [['stdoutPath', 'stdoutSha256', 'stdoutBytes'], ['stderrPath', 'stderrSha256', 'stderrBytes']]) {
    const p = meta[pk];
    if (!p) continue;
    if (!containment(p)) { errs.push(pk + ' escape: ' + p); continue; }
    if (!fs.existsSync(p)) { errs.push(pk + ' missing: ' + p); continue; }
    if (meta[sk] && meta[sk].toUpperCase() !== sha256(p)) errs.push(sk + ' mismatch: ' + p);
    if (meta[bk] != null && meta[bk] !== fs.statSync(p).size) errs.push(bk + ' mismatch: ' + p);
  }
  ok += 1;
}
if (ok !== metas.length) errs.push('verified metas ' + ok + ' != declared ' + metas.length);

// 4) results.json: 8/8 expected-red KILLED + restore PASS
const results = JSON.parse(fs.readFileSync(path.join(E044, 'results.json'), 'utf8'));
const erItems = results.filter((r) => /expected-red/.test(r.name || '') && /KILLED/.test(r.name || ''));
if (erItems.length < 2) errs.push('results.json lacks expected-red summary entries');
const restore = results.find((r) => /restore 8\/8/.test(r.name || ''));
if (!restore || restore.pass !== true) errs.push('restore 8/8 PASS entry missing/false');
const eightKill = results.find((r) => /8\/8 真 KILLED/.test(r.name || ''));
if (!eightKill || eightKill.pass !== true) errs.push('expected-red 8/8 KILLED entry missing/false');

// 5) expected-red stage dirs each have baseline/mutated/restore with meta
const erDir = path.join(E044, 'stages', 'expected-red');
const dirs = fs.readdirSync(erDir).filter((d) => fs.statSync(path.join(erDir, d)).isDirectory());
if (dirs.length < 8) errs.push('expected-red dirs ' + dirs.length + ' < 8');
for (const d of dirs) {
  for (const ph of ['baseline', 'mutated', 'restore']) {
    const php = path.join(erDir, d, ph);
    if (!fs.existsSync(php)) { errs.push('expected-red ' + d + '/' + ph + ' missing'); continue; }
    const files = fs.readdirSync(php);
    if (!files.some((f) => f === 'meta.json' || f.endsWith('.meta.json'))) errs.push('expected-red ' + d + '/' + ph + ' no meta');
    if (!files.some((f) => f.includes('stdout'))) errs.push('expected-red ' + d + '/' + ph + ' no stdout');
  }
}

// verdict + self meta write
const verdict = errs.length === 0 ? 'PASS' : 'FAIL';
process.stdout.write('V045 ' + JSON.stringify({ verdict, errorCount: errs.length, errors: errs.slice(0, 20), verifiedMetas: ok, declared: metas.length, expectedRedDirs: dirs.length }) + '\n');
const selfMeta = {
  taskId: TASK_ID, inputTaskId: INPUT_TASK_ID, tool: 'verifier-045',
  command: process.argv[0], argv: process.argv.slice(1), cwd: process.cwd(),
  startUtc: process.env.XJ_045_START || '', endUtc: new Date().toISOString(),
  exitCode: errs.length === 0 ? 0 : 1,
  stdoutPath: selfStdout, stderrPath: selfStderr,
  stdoutSha256: sha256(selfStdout), stderrSha256: sha256(selfStderr),
  stdoutBytes: fs.statSync(selfStdout).size, stderrBytes: fs.statSync(selfStderr).size,
  verdict,
};
fs.writeFileSync(path.join(OUT, 'verifier-045.meta.json'), JSON.stringify(selfMeta, null, 1));
process.exit(errs.length === 0 ? 0 : 1);
