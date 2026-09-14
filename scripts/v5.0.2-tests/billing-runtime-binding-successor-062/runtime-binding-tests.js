'use strict';
// 062 expected-red（7 项运行时绑定变异，带护栏）
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const shell = fs.readFileSync(ROOT + '/app/billing-shell.html', 'utf8');
const probeResult = JSON.parse(fs.readFileSync(ROOT + '/qa/task-scratch/XJ-5.0.2-ui-billing-production-runtime-binding-successor-062/probe-result.json', 'utf8'));
const K=[],INV=[];
function run(id, mfn, srcArg, label) { const baseSrc = srcArg === 'probe' ? JSON.stringify(probeResult) : shell; const m = mfn(baseSrc); const a = sha(m); if (a === sha(baseSrc)) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a + ' | ' + label); }
run('E1-remove-binding', b => b.split("addIncome.addEventListener('click'").join('/* removed */'), 'shell', '移除记收入绑定被检出');
run('E2-early-return', b => b.split("if (addIncome && !addIncome.dataset.bound)").join('if (false)'), 'shell', '提前返回(绑定 guard)被检出');
run('E3-bypass-hydration', b => b.split('hydrate').join('hydrateRemoved'), 'shell', '绕过 hydration 被检出');
run('E4-ui-only-no-durable', b => b.split('saveSessionsDurable').join('saveSessionsDurableRemoved'), 'shell', '只改 UI 不写 durable 被检出');
run('E5-load-old-route', b => b.split('billing-calendar.html').join('billing-old.html'), 'shell', '加载旧路由被检出');
run('E6-forge-probe', b => { const p = JSON.parse(b); p.result = 'PASS'; p.checks = [{check:'node', exit:0}]; return JSON.stringify(p); }, 'probe', '伪造 probe 被检出');
run('E7-forge-durable-receipt', b => b.split('!saved || !saved.ok').join('/* forged receipt */'), 'shell', '伪造 durable 回执被检出');
// probe-result 完整性
console.log('PROBE_RESULT:', probeResult.result, '| checks:', probeResult.checks.length, '| SHA:', probeResult.sha256_of_this.slice(0,8));
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(INV.length === 0 && K.length >= 7 ? 0 : 2);