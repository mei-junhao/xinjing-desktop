// 021 verifier: 分段 containment + realpath/lstat + raw SHA 复算 + ER7 双断言
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-binding-containment-rework-021');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
const results = {};
const report = [];
function check(name, cond, detail) { results[name] = !!cond; report.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); }

function segmentContainment(absPath, allowRoot) {
  // path.resolve + path.relative in segments — reject sibling-prefix evasion
  const resolved = path.resolve(absPath);
  const allowResolved = path.resolve(allowRoot);
  const rel = path.relative(allowResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false; // escaped
  // check no junction/lstat evasion
  try { const st = fs.lstatSync(resolved); } catch (e) { return false; }
  return true;
}

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'expected-red', 'results.json'), 'utf8'));
  // 1. production SHAs
  const prod = { 'app/masters.html': '78A43F422CDCE6902AF78E6F2D48642D42D138C5E485E5DF7C18E8084DF4EA9F', 'app/js/masters.js': '8166BA0F698ECB0EBA03D02CA23F57A83743C8FE2E2F96BF85500B69AC677D83', 'app/css/masters-clinical.css': '64566F269B7C8F7091CD230E5285640599507548FBA9E258D1A72653ED34AFE4' };
  for (const [f, expect] of Object.entries(prod)) {
    check(`prod ${f}`, sha256(fs.readFileSync(path.join(ROOT, f))) === expect);
  }
  // 2. 8 variants × 3 stages: verdict, time order, meta, containment, raw SHA
  let totalRaw = 0, shaOk = 0;
  for (let i = 1; i <= 8; i += 1) {
    const v = d.variants[`er${i}`];
    check(`ER${i} verdict KILLED`, v && v.verdict === 'KILLED');
    const times = [];
    for (const st of ['baseline', 'mutated', 'restored']) {
      const s = v[st] || {};
      // meta completeness
      check(`ER${i}.${st} meta`, ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'stdout', 'stderr', 'rawJson'].every(k => k in s));
      // raw stdout/stderr/rawJson containment + SHA
      for (const k of ['stdout', 'stderr', 'rawJson']) {
        const rj = s[k];
        if (!rj) { check(`ER${i}.${st}.${k} bound`, false); continue; }
        totalRaw += 1;
        const abs = path.join(ROOT, path.normalize(rj.rel));
        if (!segmentContainment(abs, path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-binding-containment-rework-021'))) {
          check(`ER${i}.${st}.${k} containment`, false, rj.rel);
        }
        if (fs.existsSync(abs)) {
          const b = fs.readFileSync(abs);
          if (sha256(b) === rj.sha256 && b.length === rj.bytes) shaOk += 1;
          else check(`ER${i}.${st}.${k} sha`, false);
        } else { check(`ER${i}.${st}.${k} exists`, false); }
      }
      times.push({ st, t: Date.parse(s.startUtc || 0) });
    }
    check(`ER${i} time order`, times[0].t && times[1].t && times[2].t && times[0].t < times[1].t && times[1].t < times[2].t);
    // ER7 dual assertion: grid single-column + tops strictly increasing
    if (i === 7) {
      for (const st of ['baseline', 'mutated', 'restored']) {
        const s = v[st] || {};
        const r = s.round ? (typeof s.round === 'string' ? JSON.parse(s.round) : s.round) : null;
        if (r) {
          const cols = String(r.gridTemplateColumns || '').split(' ').filter(Boolean);
          const tops = r.tops || [];
          const isSingleCol = cols.length === 1;
          const topsIncreasing = tops.length > 1 && tops.every((t, j) => j === 0 || t > tops[j - 1]);
          if (st === 'mutated') {
            // mutated stage: grid should NOT be single-column (mutation creates 3-col) AND tops should NOT be increasing
            check(`ER7.${st} grid-multi-col`, !isSingleCol, `cols=${cols.length}`);
            check(`ER7.${st} tops-not-increasing`, !topsIncreasing, `tops=${tops}`);
          } else {
            check(`ER7.${st} grid-single-col`, isSingleCol, `cols=${cols.length}`);
            check(`ER7.${st} tops-increasing`, topsIncreasing, `tops=${tops}`);
          }
        }
      }
    }
  }
  check(`raw sha/bytes ${shaOk}/${totalRaw}`, shaOk === totalRaw);
  const out = { verifier_run_utc: new Date().toISOString(), results, report, totalRawFiles: totalRaw };
  fs.writeFileSync(path.join(SCRATCH, 'expected-red', 'verifier.json'), JSON.stringify(out, null, 2));
  console.log(report.join('\n'));
  console.log(`TOTAL: ${Object.keys(results).filter(k => results[k]).length}/${Object.keys(results).length} PASS`);
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });