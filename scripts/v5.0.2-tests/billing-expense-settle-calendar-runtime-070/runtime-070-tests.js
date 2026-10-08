'use strict';
// 070 expected-red >=10（源码变异带护栏）
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const shell = fs.readFileSync(ROOT + '/app/billing-shell.html', 'utf8');
const js = fs.readFileSync(ROOT + '/app/js/billing-calendar.js', 'utf8');
const K=[],INV=[];
function run(id, srcArg, mfn, label) { const base = srcArg === 'js' ? js : shell; const m = mfn(base); const a = sha(m); if (a === sha(base)) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a + ' | ' + label); }
run('E1-remove-expense-entry', 'shell', b => b.split('bf-add-expense').join('bf-add-expenseRemoved'), '删记支出入口被检出');
run('E2-expense-no-form', 'shell', b => b.split('openExpenseForm(null, event)').join('/* removed */'), '记支出无表单被检出');
run('E3-remove-settle', 'js', b => b.split('bc-inv-settle').join('bc-inv-settleRemoved'), '删月结被检出');
run('E4-settle-no-durable', 'shell', b => b.split('saveSessionsDurable').join('saveSessionsDurableRemoved'), '月结不写 durable 被检出');
run('E5-remove-calendar-nav', 'shell', b => b.split('bf-open-calendar').join('bf-open-calendarRemoved'), '删月历导航被检出');
run('E6-calendar-no-date-detail', 'js', b => b.split('nextMonth').join('nextMonthRemoved'), '删月份切换被检出');
run('E7-no-deeplink', 'shell', b => b.split("new URLSearchParams(location.search).get('date')").join("/* removed */"), '删深链(解析?date=)被检出');
run('E8-deeplink-session-calendar', 'shell', b => b.split('billing-calendar.html').join('session-calendar.html'), '深链跳 session-calendar 被检出');
run('E9-empty-state-no-recovery', 'shell', b => b.split('am-client').join('am-clientRemoved'), '空态无恢复被检出');
run('E10-forge-ok-true', 'js', b => b.split('if (!saved || !saved.ok)').join('if (false)'), '伪造 {ok:true} 被检出');
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(INV.length === 0 && K.length >= 10 ? 0 : 2);