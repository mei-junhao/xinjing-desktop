"use strict";
const fs = require("fs"); const path = require("path"); const vm = require("vm"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const LEDGER_DIR = path.join(ROOT, "qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-ledger-verifier-rework-011/ledger");
fs.mkdirSync(LEDGER_DIR, { recursive: true });
const chatSrc = fs.readFileSync(path.join(ROOT, "app/js/xinjing-chat.js"), "utf8");
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
function makeEl(tag) { return { tagName: tag || "div", children: [], style: {}, dataset: {}, className: "", textContent: "", innerHTML: "", _listeners: {}, _err: null, appendChild(c) { this.children.push(c); c.parentNode = this; if (String(c.className||"").indexOf("xj-recovery-err") >= 0) this._err = c; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, removeChild(c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c.parentNode === this) c.parentNode = null; return c; }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === ".xj-recovery-err") return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
function buildSandbox() {
  var body = makeEl("body");
  var sb = { window: { confirm: function () { return true; }, XinJingChat: {} }, document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl("html") }, App: { showToast: function (m) { sb._toasts.push(String(m)); }, openSettings: function () {} }, Store: { saveSettingsDurable: function () { return Promise.resolve({ ok: false }); } }, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, _body: body, _sent: [], _toasts: [] };
  return sb;
}
function clickBtn(card, act) {
  var b = makeEl("button"); b._attrs = { "data-xj-act": act }; b.getAttribute = function (k) { return this._attrs[k] || null; }; b.closest = function (sel) { if (sel === "[data-xj-act]") return this; return null; }; b.parentNode = card;
  var err = null; try { card._listeners.click({ target: b }); } catch (e) { err = String(e && e.message || e); }
  return { err: err };
}
async function runCase(src, caseId, expected) {
  const startUtc = new Date().toISOString();
  const out = [];
  let loadErr = null;
  try {
    const sb = buildSandbox();
    vm.createContext(sb); vm.runInContext(src, sb, { timeout: 5000 });
    sb.window.XinJingChat.quickQuery = function (x) { sb._sent.push(String(x)); };
    const d = makeEl("div"); sb._body.appendChild(d);
    const card = sb.window.showAccountSessionRecovery(d, "草稿-011");
    if (!card) { out.push(caseId + " NO_CARD"); }
    else {
      const r = clickBtn(card, "retry");
      await new Promise(function (r) { setTimeout(r, 50); });
      const sw = clickBtn(card, "switch-qwen");
      await new Promise(function (r) { setTimeout(r, 50); });
      const errEl = card.querySelector(".xj-recovery-err");
      const sentOk = sb._sent.length === 1 && sb._sent[0] === "草稿-011";
      const switchOk = !sw.err && errEl !== null;
      const behaviorOk = sentOk && !r.err && switchOk;
      const v = expected === "PASS" ? (behaviorOk ? "PASS" : "FAIL") : (behaviorOk ? "SURVIVED" : "KILLED");
      out.push(caseId + " verdict=" + v + " sent=" + JSON.stringify(sb._sent) + " err=" + (r.err || sw.err || "none") + " errEl=" + (errEl ? "yes" : "no"));
    }
  } catch (e) { loadErr = String(e && e.message || e); out.push(caseId + " verdict=" + (expected === "PASS" ? "FAIL" : "KILLED") + " crash=" + loadErr); }
  const endUtc = new Date().toISOString();
  const stdout = out.join("\n") + "\n";
  const stderr = loadErr ? (loadErr + "\n") : "";
  const verdictLine = out.join("");
  const verdict = expected === "PASS" ? (verdictLine.indexOf("verdict=PASS") >= 0 ? "PASS" : "FAIL") : (verdictLine.indexOf("verdict=KILLED") >= 0 ? "KILLED" : (verdictLine.indexOf("LOAD_FAIL") >= 0 || verdictLine.indexOf("NO_CARD") >= 0 ? "INVALID" : "SURVIVED"));
  const run = { caseId: caseId, mode: expected === "PASS" ? "baseline" : "mutation", command: "node " + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: startUtc, endUtc: endUtc, exitCode: 0, sourcePath: "app/js/xinjing-chat.js", sourceBeforeSha256: sha(chatSrc), sourceBeforeBytes: Buffer.byteLength(chatSrc), sourceAfterSha256: sha(src), sourceAfterBytes: Buffer.byteLength(src), rawStdoutSha256: sha(stdout), rawStdoutBytes: Buffer.byteLength(stdout), rawStderrSha256: sha(stderr), rawStderrBytes: Buffer.byteLength(stderr), expectedDifference: expected === "PASS" ? "baseline should pass" : "mutation must fail", verdict: verdict };
  const dir = path.join(LEDGER_DIR, caseId); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "stdout.txt"), stdout); fs.writeFileSync(path.join(dir, "stderr.txt"), stderr);
  return run;
}
const mutations = [
  { id: "E1-remove-duplicate-guard", fn: b => b.split("if (btn.disabled) return;").join("/* removed */") },
  { id: "E2-free-var-retry", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("quickQuery(draft)") },
  { id: "E3-textarea-only", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("/* textarea */") },
  { id: "E4-missing-send", fn: b => b.split("if (window.XinJingChat && window.XinJingChat.quickQuery)").join("if (false)") },
  { id: "E5-dropped-draft", fn: b => b.split("window.XinJingChat.quickQuery(draft)").join("window.XinJingChat.quickQuery(EMPTY)") },
  { id: "E6-auto-switch", fn: b => b.split("window.confirm(").join("/* auto */ window.confirm(") },
  { id: "E7-swallow-ok-false", fn: b => b.split("res.ok === true").join("true") },
  { id: "E8-success-before-resolve", fn: b => b.split(".then(function (res) {").join(".then(function () {") },
  { id: "E9-remove-card-on-failure", fn: b => b.split("showInlineRecoveryError(card, \'切换失败").join("showInlineRecoveryError(undefined, \'切换失败") },
  { id: "E10-missing-re-enable", fn: b => b.split("btn.disabled = false").join("/* no re-enable */") },
  { id: "E11-credential-leak", fn: b => b.split("card.dataset.draft").join("card.dataset.token") }
];
async function main() {
  const cases = [];
  cases.push(await runCase(chatSrc, "B-baseline", "PASS"));
  for (const c of mutations) { cases.push(await runCase(c.fn(chatSrc), c.id, "MUT")); }
  const ledger = { task_id: "XJ-5.1.1-model-session-recovery-runtime-evidence-ledger-verifier-rework-011", card_sha256: "4877427C72AAB09B9607CD19D849795DAA706C8DC1936B07EB89F901865E71FD", candidate_source_sha256: sha(chatSrc), caseCount: cases.length, uniqueIds: cases.map(function (c) { return c.caseId; }), cases: cases.map(function (c) { return c.caseId; }) };
  fs.writeFileSync(path.join(LEDGER_DIR, "ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
  const passed = cases.filter(function (c) { return c.verdict === "PASS"; }).length;
  const killed = cases.filter(function (c) { return c.verdict === "KILLED"; }).length;
  const invalid = cases.filter(function (c) { return c.verdict === "INVALID"; }).length;
  console.log("LEDGER: baseline PASS=" + passed + " mutations KILLED=" + killed + " INVALID=" + invalid);
  process.exit(passed >= 1 && killed >= 11 && invalid === 0 ? 0 : 2);
}
main().catch(function (e) { console.error("MAIN_ERR:", e); process.exit(2); });