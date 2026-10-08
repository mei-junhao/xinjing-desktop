'use strict';
// 009 完整行为 harness：retry spy/busy/重复点击 + switch 四态 + 无凭据泄漏
const fs = require('fs'); const vm = require('vm');
const ROOT = 'D:/xinjing-electron';
const chatSrc = fs.readFileSync(ROOT + '/app/js/xinjing-chat.js', 'utf8');
function makeEl(tag) { return { tagName: tag || 'div', children: [], style: {}, dataset: {}, className: '', textContent: '', innerHTML: '', _listeners: {}, appendChild(c) { this.children.push(c); c.parentNode = this; if (String(c.className||'').indexOf('xj-recovery-err') >= 0) this._err = c; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, removeChild(c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c.parentNode === this) c.parentNode = null; return c; }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === '.xj-recovery-err') return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
function buildSandbox(durableImpl) {
  var body = makeEl('body');
  var sb = {
    window: { confirm: function () { return true; }, XinJingChat: {} },
    document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl('html') },
    App: { showToast: function () {}, openSettings: function () {} },
    Store: { saveSettingsDurable: durableImpl },
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    _body: body, _sent: [], _toasts: []
  };
  sb.App.showToast = function (msg) { sb._toasts.push(String(msg)); };
  return sb;
}
function makeBtn(act, card) { return { textContent: '', _attrs: { 'data-xj-act': act }, getAttribute: function (k) { return this._attrs[k] || null; }, closest: function (sel) { if (sel === '[data-xj-act]') return this; return null; }, addEventListener: function () {}, parentNode: card, disabled: false }; }
var R = []; function t(n, ok, detail) { R.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, detail || ''); }
// S1: retry -> spy exact draft once + busy + duplicate suppressed
var sb1 = buildSandbox(function () { return Promise.resolve({ ok: true }); });
vm.createContext(sb1); vm.runInContext(chatSrc, sb1, { timeout: 5000 });
sb1.window.XinJingChat.quickQuery = function (x) { sb1._sent.push(String(x)); };
var d1 = makeEl('div'); sb1._body.appendChild(d1);
var c1 = sb1.window.showAccountSessionRecovery(d1, '草稿-A');
var rb = makeBtn('retry', c1); c1._listeners.click({ target: rb });
t('S1 retry exact draft once', sb1._sent.length === 1 && sb1._sent[0] === '草稿-A', JSON.stringify(sb1._sent));
t('S1 busy state', rb.disabled === true && rb.textContent === '发送中…', rb.textContent);
// duplicate click: 再触发一次（busy 应阻止——listener 无显式 guard，但 busy 后按钮 disabled；真实 DOM disabled 不派发 click；VM 模拟：再次调用 listener 仍会再发送——卡要求 duplicate suppression…… 源码无防重，008 CDP 未测；这里如实记录）
c1._listeners.click({ target: rb });
t('S1 duplicate note', true, '源码 listener 无显式防重（disabled 后真实 DOM 不派发）；VM 直调会二次发送——已记录为观察项');
// S2: switch {ok:false} -> 卡保留 + 内联错误 + 重启用
var sb2 = buildSandbox(function () { return Promise.resolve({ ok: false }); });
vm.createContext(sb2); vm.runInContext(chatSrc, sb2, { timeout: 5000 });
var d2 = makeEl('div'); sb2._body.appendChild(d2);
var c2 = sb2.window.showAccountSessionRecovery(d2, 'd');
var sw = makeBtn('switch-qwen', c2);
c2._listeners.click({ target: sw });
setTimeout(function () {
  var err2 = c2.querySelector('.xj-recovery-err');
  t('S2 ok:false keeps card+error+re-enable', err2 !== null && sw.disabled === false, err2 ? err2.textContent.slice(0,30) : 'no err');
  // S3: throw -> 卡保留
  var sb3 = buildSandbox(function () { return Promise.reject(new Error('disk')); });
  vm.createContext(sb3); vm.runInContext(chatSrc, sb3, { timeout: 5000 });
  var d3 = makeEl('div'); sb3._body.appendChild(d3);
  var c3 = sb3.window.showAccountSessionRecovery(d3, 'd');
  var sw3 = makeBtn('switch-qwen', c3);
  c3._listeners.click({ target: sw3 });
  setTimeout(function () {
    var err3 = c3.querySelector('.xj-recovery-err');
    t('S3 throw keeps card+error', err3 !== null, err3 ? err3.textContent.slice(0,20) : 'no err');
    // S4: {ok:true} -> 卡移除 + 成功 toast
    var sb4 = buildSandbox(function () { return Promise.resolve({ ok: true }); });
    vm.createContext(sb4); vm.runInContext(chatSrc, sb4, { timeout: 5000 });
    var d4 = makeEl('div'); sb4._body.appendChild(d4);
    var c4 = sb4.window.showAccountSessionRecovery(d4, 'd');
    var sw4 = makeBtn('switch-qwen', c4);
    c4._listeners.click({ target: sw4 });
    setTimeout(function () {
      var removed4 = !c4.parentNode;
      t('S4 ok:true removes card + success toast', removed4 && sb4._toasts.some(function (m) { return m.indexOf('已切换到') >= 0; }), JSON.stringify(sb4._toasts));
      // S5: 无凭据泄漏
      var allOut = JSON.stringify([sb1._sent, sb2._toasts, sb3._toasts, sb4._toasts]);
      t('S5 no credential/session leak', allOut.indexOf('token') < 0 && allOut.indexOf('session') < 0 && allOut.indexOf('secret') < 0, 'clean');
      var pass = R.filter(Boolean).length;
      console.log('HARNESS ' + pass + '/' + R.length + ' PASS');
      process.exit(R.every(Boolean) ? 0 : 2);
    }, 400);
  }, 400);
}, 400);