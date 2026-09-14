"use strict";
// 010 行为 harness + mutation runner（isolated copy 跑同一 VM harness）
const fs = require("fs"); const vm = require("vm"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const chatSrc = fs.readFileSync(ROOT + "/app/js/xinjing-chat.js", "utf8");
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
function makeEl(tag) { return { tagName: tag || "div", children: [], style: {}, dataset: {}, className: "", textContent: "", innerHTML: "", _listeners: {}, _err: null, appendChild(c) { this.children.push(c); c.parentNode = this; if (String(c.className||"").indexOf("xj-recovery-err") >= 0) this._err = c; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, removeChild(c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c.parentNode === this) c.parentNode = null; return c; }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === ".xj-recovery-err") return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
function buildSandbox(durableImpl) {
  var body = makeEl("body");
  var sb = {
    window: { confirm: function () { return true; }, XinJingChat: {} },
    document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl("html") },
    App: { showToast: function (m) { sb._toasts.push(String(m)); }, openSettings: function () {} },
    Store: { saveSettingsDurable: durableImpl },
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    _body: body, _sent: [], _toasts: []
  };
  return sb;
}
function renderCard(sb) {
  sb.window.XinJingChat.quickQuery = function (x) { sb._sent.push(String(x)); };
  var d = makeEl("div"); sb._body.appendChild(d);
  return sb.window.showAccountSessionRecovery(d, "草稿-010");
}
function makeBtn(act, card) { return { textContent: "", disabled: false, _attrs: { "data-xj-act": act }, getAttribute: function (k) { return this._attrs[k] || null; }, closest: function (sel) { if (sel === "[data-xj-act]") return this; return null; }, addEventListener: function () {}, parentNode: card }; }
// ===== baseline 行为 ===== 
const R = []; function t(n, ok, d) { R.push(ok); console.log(ok ? "PASS" : "FAIL", n, d || ""); }
const sb0 = buildSandbox(function () { return Promise.resolve({ ok: true }); });
vm.createContext(sb0); vm.runInContext(chatSrc, sb0, { timeout: 5000 });
const c0 = renderCard(sb0);
const rb = makeBtn("retry", c0);
c0._listeners.click({ target: rb });
t("B1 retry sends exact draft once", sb0._sent.length === 1 && sb0._sent[0] === "草稿-010", JSON.stringify(sb0._sent));
t("B2 busy state", rb.disabled === true, "disabled");
c0._listeners.click({ target: rb }); // 二次直接调用（disabled 中）
t("B3 duplicate click no-op", sb0._sent.length === 1, "sent=" + sb0._sent.length);
// switch 四态
const sbF = buildSandbox(function () { return Promise.resolve({ ok: false }); });
vm.createContext(sbF); vm.runInContext(chatSrc, sbF, { timeout: 5000 });
const cF = renderCard(sbF); const swF = makeBtn("switch-qwen", cF);
cF._listeners.click({ target: swF });
setTimeout(function () {
  const errF = cF.querySelector(".xj-recovery-err");
  t("B4 ok:false keeps card+error+re-enable", errF !== null && swF.disabled === false, errF ? errF.textContent.slice(0,20) : "no err");
  const sbT = buildSandbox(function () { return Promise.reject(new Error("disk")); });
  vm.createContext(sbT); vm.runInContext(chatSrc, sbT, { timeout: 5000 });
  const cT = renderCard(sbT); const swT = makeBtn("switch-qwen", cT);
  cT._listeners.click({ target: swT });
  setTimeout(function () {
    const errT = cT.querySelector(".xj-recovery-err");
    t("B5 throw keeps card+error", errT !== null, errT ? errT.textContent.slice(0,20) : "no err");
    const sbO = buildSandbox(function () { return Promise.resolve({ ok: true }); });
    vm.createContext(sbO); vm.runInContext(chatSrc, sbO, { timeout: 5000 });
    const cO = renderCard(sbO); const swO = makeBtn("switch-qwen", cO);
    cO._listeners.click({ target: swO });
    setTimeout(function () {
      t("B6 ok:true removes card + toast", !cO.parentNode && sbO._toasts.some(function (m) { return m.indexOf("已切换到") >= 0; }), JSON.stringify(sbO._toasts));
      const all = JSON.stringify([sb0._sent, sbF._toasts, sbT._toasts, sbO._toasts]);
      t("B7 no credential leak", all.indexOf("token") < 0 && all.indexOf("session") < 0 && all.indexOf("secret") < 0, "clean");
      const bPass = R.filter(Boolean).length;
      console.log("BASELINE " + bPass + "/" + R.length + " PASS");
      // ===== mutation runner ===== 
      const mutations = [
        { id: "E1-remove-duplicate-guard", fn: b => b.split("if (btn.disabled) return;").join("/* removed */") },
        { id: "E2-free-var-retry", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("quickQuery(draft)") },
        { id: "E3-textarea-only", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("/* textarea */") },
        { id: "E4-missing-send", fn: b => b.split("if (window.XinJingChat && window.XinJingChat.quickQuery)").join("if (false)") },
        { id: "E5-dropped-draft", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("window.XinJingChat.quickQuery(EMPTY)") },
        { id: "E6-auto-switch", fn: b => b.split("window.confirm(").join("/* auto */ window.confirm(") },
        { id: "E7-swallow-ok-false", fn: b => b.split("res.ok === true").join("true") },
        { id: "E8-success-before-resolve", fn: b => b.split(".then(function (res) {").join(".then(function () {") },
        { id: "E9-remove-card-on-failure", fn: b => b.split("showInlineRecoveryError(card,").join("showInlineRecoveryError(undefined,") },
        { id: "E10-missing-re-enable", fn: b => b.split("btn.disabled = false").join("/* no re-enable */") },
        { id: "E11-credential-leak", fn: b => b.split("card.dataset.draft").join("card.dataset.token") }
      ];
      const BASE = sha(chatSrc);
      const K = [], INV = [];
      for (const c of mutations) {
        const mutated = c.fn(chatSrc);
        const a = sha(mutated);
        if (a === BASE) { INV.push(c.id); console.log("INVALID_MUTATION " + c.id); continue; }
        // 跑同 harness：retry 维度 + switch 维度（ok:false 场景）
        const sbM = buildSandbox(function () { return Promise.resolve({ ok: false }); });
        try { vm.createContext(sbM); vm.runInContext(mutated, sbM, { timeout: 5000 }); } catch (e) { INV.push(c.id); console.log("LOAD_FAIL " + c.id + " :: " + e.message); continue; }
        const cM = renderCard(sbM);
        if (!cM) { INV.push(c.id); console.log("NO_CARD " + c.id); continue; }
        const rM = makeBtn("retry", cM);
        let clickErr = null;
        try { cM._listeners.click({ target: rM }); } catch (e) { clickErr = String(e && e.message || e); }
        const swM = makeBtn("switch-qwen", cM);
        try { cM._listeners.click({ target: swM }); } catch (e) { clickErr = (clickErr || "") + " sw:" + String(e && e.message || e); }
        const swClickErr = (function () { try { cM._listeners.click({ target: swM }); return null; } catch (e) { return String(e && e.message || e); } })();
        const errEl = cM.querySelector(".xj-recovery-err");
        const switchBroken = swClickErr || (errEl === null);
        const retryBroken = sbM._sent.length !== 1 || clickErr;
        if (retryBroken || switchBroken) { K.push(c.id); console.log("KILLED " + c.id + " :: afterSHA=" + a + " | " + (clickErr || swClickErr || "retry/switch behavior broken")); }
        else { INV.push(c.id); console.log("SURVIVED " + c.id + " :: sent=" + JSON.stringify(sbM._sent)); }
      }
      console.log("ADVERSARIAL " + K.length + "/" + (K.length + INV.length) + " KILLED" + (INV.length ? " + " + INV.length + " INVALID/SURVIVED" : ""));
      process.exit(R.every(Boolean) && INV.length === 0 && K.length >= 10 ? 0 : 2);
    }, 400);
  }, 400);
}, 400);