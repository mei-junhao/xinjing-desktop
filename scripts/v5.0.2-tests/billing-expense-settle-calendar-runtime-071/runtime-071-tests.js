'use strict';
// 071 expected-red >=12（源码变异带护栏）
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const shell = fs.readFileSync(ROOT + '/app/billing-shell.html', 'utf8');
const js = fs.readFileSync(ROOT + '/app/js/billing-calendar.js', 'utf8');
const K=[],INV=[];
function run(id, srcArg, mfn, label) { const base = srcArg === 'js' ? js : shell; const m = mfn(base); const a = sha(m); if (a === sha(base)) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a + ' | ' + label); }
run('E1-expense-hidden-gate', 'shell', b => b.split('state-income .exp-col .col-head button{display:inline-flex}').join('display:none'), 'hidden 入口(收入态隐藏支出)被检出');
run('E2-expense-no-form', 'shell', b => b.split('openExpenseForm(null, event)').join('/* removed */'), '记支出无表单被检出');
run('E3-settle-fake-success', 'js', b => b.split('if (!saved || !saved.ok)').join('if (false)'), '月结假成功被检出');
run('E4-settle-no-durable', 'shell', b => b.split('saveSessionsDurable').join('saveSessionsDurableRemoved'), '月结不写 durable 被检出');
run('E5-month-switch-removed', 'js', b => b.split('nextMonth').join('nextMonthRemoved'), '删月份切换被检出');
run('E6-date-detail-removed', 'js', b => b.split('showDayDetail').join('showDayDetailRemoved'), '删日期详情被检出');
run('E7-deeplink-no-prefill', 'shell', b => b.split("get('date')").join("get('nodate')"), '深链不预填被检出');
run('E8-deeplink-session-calendar', 'shell', b => b.split('billing-calendar.html').join('session-calendar.html'), '深链跳 session-calendar 被检出');
run('E9-empty-no-recovery', 'shell', b => b.split('am-client').join('am-clientRemoved'), '空态无恢复被检出');
run('E10-income-no-durable', 'shell', b => b.split('saveSessionsDurable').join('saveSessionsDurableX'), '收入不写 durable 被检出');
run('E11-forge-ok-true', 'js', b => b.split('!saved.ok').join('false'), '伪造 ok-true 被检出');
run('E12-no-readback', 'shell', b => b.split('getSessionsByClient').join('getSessionsByClientRemoved'), '删 durable 回读被检出');
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(INV.length === 0 && K.length >= 12 ? 0 : 2);