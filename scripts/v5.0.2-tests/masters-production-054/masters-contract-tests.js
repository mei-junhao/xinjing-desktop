'use strict';
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const js = fs.readFileSync(ROOT + '/app/js/masters.js', 'utf8');
const html = fs.readFileSync(ROOT + '/app/masters.html', 'utf8');
const css = fs.readFileSync(ROOT + '/app/css/masters-clinical.css', 'utf8');
const R = []; function t(name, fn) { try { fn(); R.push(true); console.log('PASS', name); } catch (e) { R.push(false); console.log('FAIL', name, '::', e.message); } }
t('M1 renderMsg AI 错误分支闭合', () => { if (!/if \(msg\.status === 'error'\)[\s\S]{0,1200}renderErrorCard\(msg\.error \|\| msg\.content, msg\.errorCode\)/.test(js)) throw new Error('error branch missing'); });
t('M2 折叠按钮存在', () => { if (!html.includes('masters-collapse-left') || !html.includes('masters-collapse-right')) throw new Error('no collapse btns'); });
t('M3 toggleMasterPanel 已接', () => { if (!js.includes('window.toggleMasterPanel') || !js.includes("classList.toggle('collapsed', collapsed)")) throw new Error('no toggle'); });
t('M4 renderErrorCard + retry', () => { if (!js.includes('renderErrorCard') || !js.includes('data-masters-action=\"retry\"')) throw new Error('no error card'); });
t('M5 CSS collapsed + reduced-motion', () => { if (!css.includes('.collapsed')) throw new Error('no collapsed css'); if (!css.includes('prefers-reduced-motion')) throw new Error('no reduced-motion'); });
const K=[],INV=[];
const BASE = sha(js);
function run(id, mfn) { const m = mfn(js); const a = sha(m); if (a === BASE) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a); }
run('E1-remove-closing-div', b => b.split('</div></div></div></div>').join(''), '删闭合被检出');
run('E2-remove-collapse-btn', b => b.split('window.toggleMasterPanel').join('/* removed */'), '删折叠被检出');
run('E3-remove-error-card', b => b.split('renderErrorCard').join('renderErrorCardRemoved'), '删错误卡被检出');
run('E4-remove-retry-delegation', b => b.split('data-masters-action=\"retry\"').join('data-masters-action=\"noretry\"'), '删重试被检出');
console.log('MASTERS ' + R.filter(x=>x).length + '/' + R.length + ' PASS; ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(R.every(x=>x) && INV.length === 0 ? 0 : 2);
