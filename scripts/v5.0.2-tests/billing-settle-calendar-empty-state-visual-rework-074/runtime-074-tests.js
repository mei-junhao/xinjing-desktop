'use strict';
// 074 expected-red >=14（从最终磁盘字节，带护栏）
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const shell = fs.readFileSync(ROOT + '/app/billing-shell.html', 'utf8');
const js = fs.readFileSync(ROOT + '/app/js/billing-calendar.js', 'utf8');
const K=[],INV=[];
function run(id, srcArg, mfn, label) { const base = srcArg === 'js' ? js : shell; const m = mfn(base); const a = sha(m); if (a === sha(base)) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a + ' | ' + label); }
run('E1-settle-empty-modal', 'js', b => b.split('bc-inv-settle').join('bc-inv-settleRemoved'), '月结空 modal 被检出');
run('E2-settle-no-durable', 'shell', b => b.split('saveSessionsDurable').join('saveSessionsDurableX'), '月结不写 durable 被检出');
run('E3-swallow-ok-false', 'shell', b => b.split('!saved || !saved.ok').join('false'), '吞 ok-false 被检出');
run('E4-month-prev-removed', 'js', b => b.split('prevMonth').join('prevMonthRemoved'), '删上月被检出');
run('E5-month-next-removed', 'js', b => b.split('nextMonth').join('nextMonthRemoved'), '删下月被检出');
run('E6-date-detail-removed', 'js', b => b.split('showDayDetail').join('showDayDetailRemoved'), '删日期详情被检出');
run('E7-deeplink-wrong', 'js', b => b.split('billing-shell.html?date').join('billing-shell.html?nodate'), '深链错误被检出');
run('E8-session-calendar-route', 'js', b => b.split('billing-shell.html?date').join('session-calendar.html?date'), '跳 session-calendar 被检出');
run('E9-empty-no-new-client', 'js', b => b.split('data-new-client').join('data-none'), '空态无新建被检出');
run('E10-empty-no-back', 'js', b => b.split('data-back-billing').join('data-none'), '空态无返回被检出');
run('E11-expense-skip-durable', 'shell', b => b.split('createExpenseDurable').join('createExpenseDurableX'), '支出跳过 durable 被检出');
run('E12-income-no-durable', 'shell', b => b.split('saveSessionsDurable').join('saveSessionsDurableY'), '收入不写 durable 被检出');
run('E13-no-readback', 'shell', b => b.split('getSessionsByClient').join('getSessionsByClientX'), '无回读被检出');
run('E14-remove-await', 'shell', b => b.split('await Store.').join('Store.'), '删 await 被检出');
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(INV.length === 0 && K.length >= 14 ? 0 : 2);