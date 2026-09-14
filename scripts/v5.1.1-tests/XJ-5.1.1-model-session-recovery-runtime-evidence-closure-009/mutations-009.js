"use strict";
// 009 mutation runner: isolated copy + same behavior harness (mutated must FAIL)
const fs = require("fs"); const vm = require("vm"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const chatSrc = fs.readFileSync(ROOT + "/app/js/xinjing-chat.js", "utf8");
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
function makeEl(tag) { return { tagName: tag || "div", children: [], style: {}, dataset: {}, className: "", textContent: "", innerHTML: "", _listeners: {}, _err: null, appendChild(c) { this.children.push(c); c.parentNode = this; if (String(c.className||"").indexOf("xj-recovery-err") >= 0) this._err = c; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, removeChild(c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c.parentNode === this) c.parentNode = null; return c; }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === ".xj-recovery-err") return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
function runBehavior(src, switchCase) {
  var body = makeEl("body");
  var sb = {
    window: { confirm: function () { return true; }, XinJingChat: {} },
    document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl("html") },
    App: { showToast: function (m) { sb._toasts.push(String(m)); }, openSettings: function () {} },
    Store: { saveSettingsDurable: switchCase === "ok-false" ? function () { return Promise.resolve({ ok: false }); } : switchCase === "throw" ? function () { return Promise.reject(new Error("disk")); } : function () { return Promise.resolve({ ok: true }); } },
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    _body: body, _sent: [], _toasts: []
  };
  vm.createContext(sb);
  try { vm.runInContext(src, sb, { timeout: 5000 }); } catch (e) { return { load: false, err: e.message }; }
  sb.window.XinJingChat.quickQuery = function (x) { sb._sent.push(String(x)); };
  var d = makeEl("div"); body.appendChild(d);
  var card = sb.window.showAccountSessionRecovery(d, "草稿-M");
  if (!card) return { load: true, card: false };
  var rb = makeEl("button"); rb._attrs = { "data-xj-act": "retry" }; rb.getAttribute = function (k) { return this._attrs[k] || null; }; rb.closest = function (sel) { if (sel === "[data-xj-act]") return this; return null; }; rb.parentNode = card;
  var clickErr = null;
  try { card._listeners.click({ target: rb }); } catch (e) { clickErr = String(e && e.message || e); }
  return { load: true, card: true, sent: JSON.stringify(sb._sent), clickErr: clickErr };
}
const mutations = [
  { id: "E1-free-var", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("quickQuery(draft)") },
  { id: "E2-textarea-only", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("/* textarea */") },
  { id: "E3-missing-send", fn: b => b.split("if (window.XinJingChat && window.XinJingChat.quickQuery)").join("if (false)") },
  { id: "E4-dropped-draft", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("window.XinJingChat.quickQuery(EMPTY)") },
  { id: "E6-auto-switch", fn: b => b.split("window.confirm(").join("/* auto */ window.confirm(") },
  { id: "E7-swallow-ok-false", fn: b => b.split("res.ok === true").join("true") },
  { id: "E9-remove-card-on-failure", fn: b => b.split("showInlineRecoveryError(card,").join("card.remove(); showInlineRecoveryError(null,") },
  { id: "E10-credential-leak", fn: b => b.split("card.dataset.draft").join("card.dataset.token") }
];
const BASE = sha(chatSrc);
const K = [], INV = [];
for (const c of mutations) {
  const mutated = c.fn(chatSrc);
  const a = sha(mutated);
  if (a === BASE) { INV.push(c.id); console.log("INVALID_MUTATION " + c.id); continue; }
  const r = runBehavior(mutated, "ok-false");
  if (r.load && r.card && (r.sent === "[]" || r.clickErr)) { K.push(c.id); console.log("KILLED " + c.id + " :: afterSHA=" + a + " | " + (r.clickErr || "retry no longer sends")); }
  else { INV.push(c.id); console.log("SURVIVED " + c.id + " :: " + JSON.stringify(r)); }
}
console.log("ADVERSARIAL " + K.length + "/" + (K.length + INV.length) + " KILLED" + (INV.length ? " + " + INV.length + " INVALID/SURVIVED" : ""));
process.exit(INV.length === 0 && K.length >= 8 ? 0 : 2);