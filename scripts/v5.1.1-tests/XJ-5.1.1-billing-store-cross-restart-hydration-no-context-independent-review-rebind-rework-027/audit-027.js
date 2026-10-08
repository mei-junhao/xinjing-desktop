// audit-027.js：027 隔离副本 8 攻击变体 KILLED 复核（动态根 + 路径安全）
'use strict';
const fs = require('fs');
const path = require('path');
const ARGV = process.argv.slice(2);
const IV = ARGV.indexOf('--root');
const RB = IV >= 0 ? path.resolve(ARGV[IV + 1]) : path.resolve(__dirname, '..', '..', '..', 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-no-context-independent-review-rebind-rework-027', 'rebound');
const attacksDir = path.join(RB, 'attacks-v2');
const results = [];
let failures = 0;
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); if (!cond) failures++; console.log((cond ? 'PASS' : 'FAIL'), name, detail || ''); }

check('attacks 目录存在（8 变体）', fs.existsSync(attacksDir), attacksDir);
const variants = fs.existsSync(attacksDir) ? fs.readdirSync(attacksDir).filter(d => d.match(/^\d{2}-/)) : [];
check('攻击变体数 ≥ 8', variants.length >= 8, String(variants.length));
for (const v of variants) {
  const lp = path.join(attacksDir, v, 'expected-red-ledger.json');
  if (!fs.existsSync(lp)) { check(`attack ${v} ledger 存在`, false); continue; }
  const led = JSON.parse(fs.readFileSync(lp, 'utf8'));
  const mutatedFails = led.cases.filter(c => { const v2 = (c.stages.mutated.verdict || c.stages.mutated.summaryVerdict); return v2 !== 'PASS' && v2 != null; }).length;
  const allKilled = led.cases.every(c => (c.overall || '').toUpperCase() === 'KILLED');
  check(`attack ${v}（killed=${led.killed} mutated-fail=${mutatedFails}/8）`, led.killed === 8 && mutatedFails === 8 && allKilled, `killed=${led.killed}`);
}
// 独立复算一个攻击变体的 SHA 绑定（抽查 clone-8）
const a8 = variants.find(v => v.includes('08')) || variants[variants.length - 1];
if (a8) {
  const led = JSON.parse(fs.readFileSync(path.join(attacksDir, a8, 'expected-red-ledger.json'), 'utf8'));
  const crypto = require('crypto');
  const sha = b => crypto.createHash('sha256').update(b).digest('hex').toLowerCase();
  let bound = true;
  for (const c of led.cases) {
    for (const stg of ['baseline', 'mutated', 'restore']) {
      const s = c.stages[stg];
      try {
        const meta = JSON.parse(fs.readFileSync(s.metaPath, 'utf8'));
        if (meta.stdoutSha256 && sha(fs.readFileSync(s.stdoutPath)) !== meta.stdoutSha256.toLowerCase()) bound = false;
      } catch (e) { bound = false; }
    }
  }
  check(`attack ${a8} SHA 绑定复算`, bound);
}
const summary = { type: 'audit-027-summary', taskId: 'XJ-5.1.1-billing-store-cross-restart-hydration-no-context-independent-review-rebind-rework-027', attacksChecked: variants.length, verdict: failures === 0 ? 'PASS' : 'FAIL', failures, checkedAt: new Date().toISOString() };
fs.writeFileSync(path.join(RB, '..', 'audit-027-summary.json'), JSON.stringify(summary, null, 2));
console.log('AUDIT VERDICT:', summary.verdict, 'failures:', failures);
process.exit(failures === 0 ? 0 : 1);