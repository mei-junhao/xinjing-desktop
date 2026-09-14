'use strict';
// 009 VM 行为 harness：加载实际 xinjing-chat.js IIFE，run 后注入 spy，驱动恢复卡真实事件
const fs = require('fs'); const vm = require('vm');
const ROOT = 'D:/xinjing-electron';
const chatSrc = fs.readFileSync(ROOT + '/app/js/xinjing-chat.js', 'utf8');
function makeEl(tag) { return { tagName: tag || 'div', children: [], style: {}, dataset: {}, className: '', textContent: '', innerHTML: '', _listeners: {}, appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === '.xj-recovery-err') return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
function buildSandbox() {
  var body = makeEl('body');
  var sb = {
    window: { confirm: function () { return true; }, XinJingChat: {} },
    document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl('html') },
    App: { showToast: function () {}, openSettings: function () {} },
    Store: { saveSettingsDurable: function () { return Promise.resolve({ ok: true }); } },
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    _body: body, _sent: []
  };
  return sb;
}
// 注入 spy（run 后覆盖 IIFE 导出的真实 quickQuery）+ 渲染卡 + click retry
var sb = buildSandbox();
vm.createContext(sb);
vm.runInContext(chatSrc, sb, { timeout: 5000 });
// run 后注入 spy（覆盖导出）
sb.window.XinJingChat.quickQuery = function (t) { sb._sent.push(String(t)); };
var typingDiv = makeEl('div'); sb._body.appendChild(typingDiv);
var card = sb.window.showAccountSessionRecovery(typingDiv, '草稿-009');
console.log('CARD:', !!card, '| draft:', card && card.dataset.draft);
var retryBtn = { textContent: '重试', _attrs: { 'data-xj-act': 'retry' }, getAttribute: function (k) { return this._attrs[k] || null; }, closest: function (sel) { if (sel === '[data-xj-act]') return this; return null; }, addEventListener: function () {}, parentNode: card };
try {
  card._listeners.click({ target: retryBtn });
  console.log('RETRY_SENT:', JSON.stringify(sb._sent));
  console.log('BTN_BUSY:', retryBtn.disabled === true, '| TEXT:', retryBtn.textContent);
} catch (e) { console.log('CLICK_ERR:', e.message); }
process.exit(sb._sent.length === 1 && sb._sent[0] === '草稿-009' ? 0 : 2);