'use strict';
const fs = require('fs'); const vm = require('vm');
const ROOT = 'D:/xinjing-electron';
const chatSrc = fs.readFileSync(ROOT + '/app/js/xinjing-chat.js', 'utf8');
function makeEl(tag) { return { tagName: tag || 'div', children: [], style: {}, dataset: {}, className: '', textContent: '', innerHTML: '', _listeners: {}, appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { return this._err || null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
var body = makeEl('body');
var log = [];
var sandbox = {
  window: { confirm: function () { return true; }, XinJingChat: { quickQuery: function (t) { log.push('QQ:' + t); } } },
  document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl('html') },
  App: { showToast: function () {}, openSettings: function () {} },
  Store: { saveSettingsDurable: function () { return Promise.resolve({ ok: true }); } },
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  log: log
};
sandbox.window.log = log;
vm.createContext(sandbox);
vm.runInContext(chatSrc, sandbox, { timeout: 5000 });
var typingDiv = makeEl('div'); body.appendChild(typingDiv);
var card = sandbox.window.showAccountSessionRecovery(typingDiv, '草稿内容-008');
var retryBtn = { textContent: '重试', dataset: { xjAct: 'retry' }, _attrs: { 'data-xj-act': 'retry' }, getAttribute: function (k) { log.push('getAttr:' + k + '=' + (this._attrs[k] || null)); return this._attrs[k] || null; }, closest: function (sel) { log.push('closest:' + sel); if (sel === '[data-xj-act]') return this; return null; }, addEventListener: function () {}, parentNode: card };
card._listeners.click({ target: retryBtn });
console.log('LOG:', JSON.stringify(log));
process.exit(0);