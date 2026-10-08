'use strict';
const fs = require('fs'); const vm = require('vm');
const ROOT = 'D:/xinjing-electron';
const chatSrc = fs.readFileSync(ROOT + '/app/js/xinjing-chat.js', 'utf8');
function makeEl(tag) { return { tagName: tag || 'div', children: [], style: {}, dataset: {}, className: '', textContent: '', innerHTML: '', _listeners: {}, appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === '.xj-recovery-err') return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
var body = makeEl('body');
var sb = {
  window: { confirm: function () { log.push('confirm called'); return true; }, XinJingChat: {} },
  document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl('html') },
  App: { showToast: function (m) { log.push('toast:' + m); }, openSettings: function () {} },
  Store: { saveSettingsDurable: function () { log.push('ssd called'); return Promise.resolve({ ok: false }); } },
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  _body: body, _sent: []
};
var log = []; sb.window.__log = log;
vm.createContext(sb);
vm.runInContext(chatSrc, sb, { timeout: 5000 });
console.log('HAS_SWB:', !!sb.window.__xjSwitchBasic);
var d = makeEl('div'); body.appendChild(d);
var card = sb.window.showAccountSessionRecovery(d, 'd');
var sw = { textContent: '', _attrs: { 'data-xj-act': 'switch-qwen' }, getAttribute: function (k) { return this._attrs[k] || null; }, closest: function (sel) { if (sel === '[data-xj-act]') return this; return null; }, addEventListener: function () {}, parentNode: card, disabled: false };
try {
  card._listeners.click({ target: sw });
  console.log('LOG:', JSON.stringify(log));
} catch (e) { console.log('CLICK_ERR:', e.message, '| LOG:', JSON.stringify(log)); }
setTimeout(function () { console.log('AFTER 400ms:', JSON.stringify(log)); process.exit(0); }, 500);