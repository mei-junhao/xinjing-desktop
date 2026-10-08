'use strict';
// 072 expected-red >=14（源码变异带护栏）
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const shell = fs.readFileSync(ROOT + '/app/billing-shell.html', 'utf8');
const js = fs.readFileSync(ROOT + '/app/js/billing-calendar.js', 'utf8');
const K=[],INV=[];
function run(id, srcArg, mfn, label) { const base = srcArg === 'js' ? js : shell; const m = mfn(base); const a = sha(m); if (a === sha(base)) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a + ' | ' + label); }
run('E1-expense-noop-guard', 'shell', b => b.split('if (!body) { App.showToast && App.showToast').join('if (true) { /* silent */ }'), '支出 no-op(静默早退)被检出');
run('E2-expense-no-form', 'shell', b => b.split('exp-form-card').join('exp-form-cardRemoved'), '支出无表单被检出');
run('E3-settle-empty-modal', 'js', b => b.split('bc-inv-settle').join('bc-inv-settleRemoved'), '月结空 modal 被检出');
run('E4-settle-no-durable', 'shell', b => b.split('saveSessionsDurable').join('saveSessionsDurableX'), '月结不写 durable 被检出');
run('E5-swallow-ok-false', 'shell', b => b.split('!saved || !saved.ok').join('false'), '吞 ok-false 被检出');
run('E6-month-prev-removed', 'js', b => b.split('prevMonth').join('prevMonthRemoved'), '删上月被检出');
run('E7-month-next-removed', 'js', b => b.split('nextMonth').join('nextMonthRemoved'), '删下月被检出');
run('E8-date-detail-removed', 'js', b => b.split('showDayDetail').join('showDayDetailRemoved'), '删日期详情被检出');
run('E9-deeplink-wrong', 'shell', b => b.split("get('date')").join("get('nodate')"), '深链错误被检出');
run('E10-session-calendar-route', 'js', b => b.split('billing-shell.html').join('session-calendar.html'), '跳 session-calendar 被检出');
run('E11-empty-no-recovery', 'shell', b => b.split('am-client').join('am-clientRemoved'), '空态无恢复被检出');
run('E12-skip-durable', 'shell', b => b.split('createExpenseDurable').join('createExpenseDurableRemoved'), '支出跳过 durable 被检出');
run('E13-no-readback', 'shell', b => b.split('getSessionsByClient').join('getSessionsByClientX'), '无回读被检出');
run('E14-remove-await', 'shell', b => b.split('await Store.').join('Store.'), '删 await 被检出');
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(INV.length === 0 && K.length >= 14 ? 0 : 2);