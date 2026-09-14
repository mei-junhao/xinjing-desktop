'use strict';
// 046 verifier — independent re-verification of a given 044-lineage evidence root (mirror or mutation copy)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-recovery-no-context-independent-review-046';
const INPUT_TASK_ID = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044';
const EXPECTED_CARD_044 = 'FCA7266ED2D8BB543A6AF1CBEEDAD7AE4F08483659C3FC0DACF9CDD9557AB087';
const EXPECTED_STORE = '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D';
const OUT = process.argv[2];   // 046 evidence dir (self capture)
const ROOT = process.argv[3];  // evidence root to verify (mirror or mutation copy)

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function containment(p) {
  if (!p) return false;
  return !path.resolve(p).split(path.sep).includes('..');
}
const errs = [];
const selfStdout = path.join(OUT, 'verifier-046.stdout.raw');
if (!fs.existsSync(selfStdout)) fs.writeFileSync(selfStdout, '');
const selfStderr = path.join(OUT, 'verifier-046.stderr.raw');
if (!fs.existsSync(selfStderr)) fs.writeFileSync(selfStderr, '');

// 1) manifest identity (cardSha/storeSha are the 044 constants; taskId must be 044-lineage)
const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence-manifest.json'), 'utf8'));
if (String(m.cardSha256).toUpperCase() !== EXPECTED_CARD_044) errs.push('manifest cardSha mismatch');
if (String(m.storeSha256AtEnd).toUpperCase() !== EXPECTED_STORE) errs.push('manifest storeShaAtEnd mismatch');
if (!String(m.fixedOrigin).includes('19421')) errs.push('fixedOrigin not 19421');
if (m.taskId && !String(m.taskId).includes('recovery-044')) errs.push('manifest taskId not 044-lineage: ' + m.taskId);

// 2) production store unchanged
if (sha256('D:/xinjing-electron/app/js/store.js') !== EXPECTED_STORE) errs.push('production store.js drifted');

// 3) all stage metas: fields/containment/sha/bytes/UTC
const metas = m.stageMetaPaths || [];
let ok = 0;
for (const mp of metas) {
  if (!containment(mp)) { errs.push('meta path escape: ' + mp); continue; }
  if (!fs.existsSync(mp)) { errs.push('meta missing: ' + mp); continue; }
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  for (const f of ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'stdoutPath', 'stderrPath']) {
    if (!(f in meta)) errs.push('meta missing ' + f + ': ' + mp);
  }
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
// count-vs-disk reconciliation: every stages/*/<phase>/meta.json on disk must be referenced by the manifest
const stagesDir = path.join(ROOT, 'stages');
if (fs.existsSync(stagesDir)) {
  const countMetas = (dir) => {
    let n = 0;
    for (const e of fs.readdirSync(dir)) {
      const ep = path.join(dir, e);
      if (fs.statSync(ep).isDirectory()) n += countMetas(ep);
      else if (e === 'meta.json' || e.endsWith('.meta.json')) n += 1;
    }
    return n;
  };
  const diskMetas = countMetas(stagesDir);
  if (diskMetas !== metas.length) errs.push('manifest/meta count vs disk mismatch: manifest=' + metas.length + ' disk=' + diskMetas);
}

// 4) results.json summaries (8/8 KILLED + restore 8/8 PASS must be present & true)
const rjPath = path.join(ROOT, 'results.json');
if (fs.existsSync(rjPath)) {
  const results = JSON.parse(fs.readFileSync(rjPath, 'utf8'));
  const eightKill = results.find((r) => /8\/8/.test(String(r.name || '')) && /KILLED/.test(String(r.name || '')));
  if (!eightKill || eightKill.pass !== true) errs.push('expected-red 8/8 KILLED entry missing/false');
  const restore = results.find((r) => /restore 8\/8/.test(String(r.name || '')));
  if (!restore || restore.pass !== true) errs.push('restore 8/8 PASS entry missing/false');
}

// 5) expected-red stage dirs (if present) each baseline/mutated/restore complete
const erDir = path.join(ROOT, 'stages', 'expected-red');
if (fs.existsSync(erDir)) {
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
}

const verdict = errs.length === 0 ? 'PASS' : 'FAIL';
process.stdout.write('V046 ' + JSON.stringify({ verdict, errorCount: errs.length, errors: errs.slice(0, 16), verifiedMetas: ok, declared: metas.length, root: path.basename(ROOT) }) + '\n');
const selfMeta = {
  taskId: TASK_ID, inputTaskId: INPUT_TASK_ID, tool: 'verifier-046',
  command: process.argv[0], argv: process.argv.slice(1), cwd: process.cwd(),
  startUtc: process.env.XJ_046_START || '', endUtc: new Date().toISOString(),
  exitCode: errs.length === 0 ? 0 : 1,
  stdoutPath: selfStdout, stderrPath: selfStderr,
  stdoutSha256: sha256(selfStdout), stderrSha256: sha256(selfStderr),
  stdoutBytes: fs.statSync(selfStdout).size, stderrBytes: fs.statSync(selfStderr).size,
  verifiedRoot: ROOT, verdict,
};
fs.writeFileSync(path.join(OUT, 'verifier-046.meta.json'), JSON.stringify(selfMeta, null, 1));
process.exit(errs.length === 0 ? 0 : 1);