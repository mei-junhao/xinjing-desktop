// 020 verifier：复算 raw 文件字节、路径 containment、时间顺序、三阶段闭环、生产 SHA
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-rebuild-020');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
const results = {};
const report = [];
function check(name, cond, detail) { results[name] = !!cond; report.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); }

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'expected-red', 'results.json'), 'utf8'));
  // 1. 生产三 SHA
  const prod = { 'app/masters.html': '78A43F422CDCE6902AF78E6F2D48642D42D138C5E485E5DF7C18E8084DF4EA9F', 'app/js/masters.js': '8166BA0F698ECB0EBA03D02CA23F57A83743C8FE2E2F96BF85500B69AC677D83', 'app/css/masters-clinical.css': '64566F269B7C8F7091CD230E5285640599507548FBA9E258D1A72653ED34AFE4' };
  for (const [f, expect] of Object.entries(prod)) {
    const b = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check(`prod ${f}`, sha256(Buffer.from(b)) === expect);
  }
  // 2. 8 变异三阶段闭环 + raw SHA 复算 + 时间顺序 + containment
  let totalRaw = 0, shaOk = 0;
  for (let i = 1; i <= 8; i += 1) {
    const v = d.variants[`er${i}`];
    check(`ER${i} verdict KILLED`, v && v.verdict === 'KILLED');
    const times = [];
    for (const st of ['baseline', 'mutated', 'restored']) {
      const s = v[st] || {};
      for (const k of ['rawJson', 'rawStdout', 'rawStderr']) {
        const rj = s[k];
        if (!rj) { check(`ER${i}.${st}.${k} bound`, false); continue; }
        totalRaw += 1;
        const abs = path.join(ROOT, path.normalize(rj.rel));
        const inAllow = abs.startsWith(path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-rebuild-020'));
        if (!inAllow) check(`ER${i}.${st} containment`, false, abs);
        if (fs.existsSync(abs)) {
          const b = fs.readFileSync(abs);
          if (sha256(b) === rj.sha256 && b.length === rj.bytes) shaOk += 1;
          else check(`ER${i}.${st} ${k} sha`, false, rj.rel);
        } else { check(`ER${i}.${st} ${k} exists`, false, rj.rel); }
      }
      times.push({ st, t: Date.parse(s.startUtc || 0) });
    }
    // 时间顺序 baseline < mutated < restored
    const t0 = times[0].t, t1 = times[1].t, t2 = times[2].t;
    check(`ER${i} time order`, t0 && t1 && t2 && t0 < t1 && t1 < t2, `${t0} < ${t1} < ${t2}`);
    // meta 完整
    for (const st of ['baseline', 'mutated', 'restored']) {
      const s = v[st] || {};
      check(`ER${i}.${st} meta`, ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode'].every(k => k in s));
    }
  }
  check(`raw sha/bytes ${shaOk}/${totalRaw}`, shaOk === totalRaw);
  const out = { verifier_run_utc: new Date().toISOString(), results, report, totalRawFiles: totalRaw };
  fs.writeFileSync(path.join(SCRATCH, 'expected-red', 'verifier.json'), JSON.stringify(out, null, 2));
  console.log(report.join('\n'));
  console.log(`\nTOTAL: ${Object.keys(results).filter(k => results[k]).length}/${Object.keys(results).length} PASS, raw=${totalRaw}`);
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });