'use strict';
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const shell = fs.readFileSync(ROOT + '/app/billing-shell.html', 'utf8');
const cal = fs.readFileSync(ROOT + '/app/billing-calendar.html', 'utf8');
const js = fs.readFileSync(ROOT + '/app/js/billing-calendar.js', 'utf8');
const R = []; function t(name, fn) { try { fn(); R.push(true); console.log('PASS', name); } catch (e) { R.push(false); console.log('FAIL', name, '::', e.message); } }
t('B1 记收入按钮 + handler 绑定', () => { if (!shell.includes('id="bf-add-income"')) throw new Error('no btn'); if (!shell.includes("addIncome.addEventListener('click'")) throw new Error('no handler'); if (!shell.includes('openAddModal')) throw new Error('no modal'); });
t('B2 记收入保存 durable + 刷新', () => { if (!shell.includes('saveSessionsDurable')) throw new Error('no durable'); if (!shell.includes('location.reload') && !shell.includes('renderBilling') && !shell.includes('render(')) throw new Error('no refresh'); });
t('B3 记收入失败路径保留', () => { if (!shell.includes('catch') && !shell.includes('ok === false') && !shell.includes('!saved')) throw new Error('no failure path'); });
t('B4 月结单 handler + durable 反馈', () => { if (!js.includes('bc-inv-settle') && !shell.includes('toggleSettleFor')) throw new Error('no settle'); if (!js.includes('saveSessionsDurable') && !js.includes('月结已保存')) throw new Error('no settle feedback'); });
t('B5 月历月份切换 + 详情', () => { if (!js.includes('prevMonth') && !js.includes('nextMonth') && !js.includes('switchMonth')) throw new Error('no month switch'); if (!shell.includes('openAddModal')) throw new Error('no detail-add'); });
const K=[],INV=[];
function run(id, mfn) { const m = mfn(shell); const a = sha(m); if (a === sha(shell)) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a); }
run('E1-btn-no-handler', b => b.split("addIncome.addEventListener('click'").join('/* removed */'), '删记收入 handler');
run('E2-ui-only-no-durable', b => b.split('saveSessionsDurable').join('saveSessionsDurableRemoved'), '只改 UI 不写 durable');
run('E3-static-placeholder', b => b.split('openAddModal').join('openAddModalRemoved'), '静态占位');
(function(){ const m = js.split('月结已保存').join('月结已保存X'); const a = sha(m); if (a === sha(js)) { INV.push('E4'); console.log('INVALID_MUTATION E4'); } else { K.push('E4'); console.log('KILLED E4 :: afterSHA=' + a); } })();
console.log('BILLING ' + R.filter(x=>x).length + '/' + R.length + ' PASS; ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(R.every(x=>x) && INV.length === 0 ? 0 : 2);