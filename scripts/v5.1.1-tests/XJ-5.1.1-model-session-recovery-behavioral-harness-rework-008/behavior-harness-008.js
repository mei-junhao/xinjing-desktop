'use strict';
// 008 行为 harness：vm 沙箱加载 xinjing-chat.js（真实 IIFE），合成 DOM 驱动 recovery-card click
const fs = require('fs'); const vm = require('vm'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const chatSrc = fs.readFileSync(ROOT + '/app/js/xinjing-chat.js', 'utf8');
// 合成 DOM 最小桩
function makeEl(tag) { return { tagName: tag || 'div', children: [], style: {}, dataset: {}, className: '', textContent: '', innerHTML: '', _listeners: {}, appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === '.xj-recovery-err') return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
var body = makeEl('body');
var sandbox = {
  window: { confirm: function () { return true; }, XinJingChat: { quickQuery: function (t) { sandbox.__sent.push(t); } } },
  document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, addEventListener: function () {}, documentElement: makeEl('html') },
  App: { showToast: function () {}, openSettings: function () {} },
  Store: { saveSettingsDurable: function () { return Promise.resolve({ ok: true }); } },
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  __sent: []
};
sandbox.window.__sent = sandbox.__sent;
// 触发点击的辅助：从源码提取恢复卡 renderer 太重；直接调用导出的 window.showAccountSessionRecovery
try {
  vm.createContext(sandbox);
  vm.runInContext(chatSrc, sandbox, { timeout: 5000 });
  // 渲染恢复卡（用导出的 showAccountSessionRecovery）
  var typingDiv = makeEl('div'); body.appendChild(typingDiv);
  var card = sandbox.window.showAccountSessionRecovery(typingDiv, '草稿内容-008');
  console.log('CARD_CREATED:', !!card);
  // 触发 retry click
  var retryBtn = { textContent: '重试', dataset: { xjAct: 'retry' }, _attrs: { 'data-xj-act': 'retry' }, getAttribute: function (k) { return this._attrs[k] || null; }, closest: function (sel) { if (sel === '[data-xj-act]') return this; return null; }, addEventListener: function () {}, parentNode: card };
  // 直接调用卡内 click listener：需从 card._listeners 取
  var clickFn = card && card._listeners && card._listeners.click;
  if (clickFn) { card.dataset.draft = '草稿内容-008'; clickFn({ target: retryBtn }); }
  console.log('RETRY_SENT:', JSON.stringify(sandbox.__sent));
  process.exit(0);
} catch (e) { console.log('HARNESS_ERR:', e.message); process.exit(2); }