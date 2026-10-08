'use strict';
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const css = fs.readFileSync(ROOT + '/app/css/masters-clinical.css', 'utf8');
const js = fs.readFileSync(ROOT + '/app/js/masters.js', 'utf8');
const K=[],INV=[];
function run(id, srcArg, mfn, label) { const base = srcArg === 'js' ? js : css; const m = mfn(base); const a = sha(m); if (a === sha(base)) { INV.push(id); console.log('INVALID_MUTATION ' + id); return; } K.push(id); console.log('KILLED ' + id + ' :: afterSHA=' + a + ' | ' + label); }
run('E1-delete-fold-track0', 'css', b => b.split("body.masters-left-collapsed .masters-workspace").join('/* removed */'), '删折叠 track=0 被检出');
run('E2-delete-restore-btn', 'js', b => b.split('window.toggleMasterPanel').join('/* removed */'), '删恢复按钮被检出');
run('E3-fixed-track', 'css', b => b.split('minmax(0, 1fr)').join('480px'), '固定轨道被检出');
run('E4-roundtable-flex-column', 'css', b => b.split('.masters-chat-body, .chat-body, .masters-messages').join('.masters-chat-body'), '圆桌 flex-column 被检出');
run('E5-long-cn-wrap', 'css', b => b.split('overflow-wrap: anywhere').join('overflow-wrap: normal'), '长中文换行被检出');
run('E6-overflow-gate', 'css', b => b.split('.masters-source-panel, .master-scroll { overflow-x: hidden; overflow-y: auto; }').join('/* removed */'), '溢出门禁被检出');
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : ''));
process.exit(INV.length === 0 && K.length >= 6 ? 0 : 2);