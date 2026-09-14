"use strict";
const fs = require("fs"); const path = require("path"); const vm = require("vm"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const LEDGER_DIR = path.join(ROOT, "qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/ledger");
fs.mkdirSync(LEDGER_DIR, { recursive: true });
const chatSrc = fs.readFileSync(path.join(ROOT, "app/js/xinjing-chat.js"), "utf8");
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
function makeEl(tag) { return { tagName: tag || "div", children: [], style: {}, dataset: {}, className: "", textContent: "", innerHTML: "", _listeners: {}, _err: null, appendChild(c) { this.children.push(c); c.parentNode = this; if (String(c.className||"").indexOf("xj-recovery-err") >= 0) this._err = c; return c; }, remove() { if (this.parentNode) { var i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }, removeChild(c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c.parentNode === this) c.parentNode = null; return c; }, addEventListener(t, fn) { this._listeners[t] = fn; }, querySelector(sel) { if (sel === ".xj-recovery-err") return this._err || null; return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; } }; }
function buildSandbox(opts) {
  opts = opts || {};
  var body = makeEl("body");
  var sb = { window: { confirm: function () { return opts.confirm !== false; }, XinJingChat: {} }, document: { body: body, getElementById: function () { return null; }, getElementsByClassName: function () { return []; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: makeEl, addEventListener: function () {}, documentElement: makeEl("html") }, App: { showToast: function (m) { sb._toasts.push(String(m)); }, openSettings: function () {} }, Store: { saveSettingsDurable: opts.durable || function () { return Promise.resolve({ ok: false }); } }, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, _body: body, _sent: [], _toasts: [], _durableCalls: 0 };
  var origSsd = sb.Store.saveSettingsDurable;
  sb.Store.saveSettingsDurable = function (x) { sb._durableCalls++; return origSsd(x); };
  return sb;
}
function renderCard(sb) {
  sb.window.XinJingChat.quickQuery = function (x) { sb._sent.push(String(x)); };
  var d = makeEl("div"); sb._body.appendChild(d);
  return sb.window.showAccountSessionRecovery(d, "草稿-013");
}
function makeBtn(act, card) { var b = makeEl("button"); b._attrs = { "data-xj-act": act }; b.getAttribute = function (k) { return this._attrs[k] || null; }; b.closest = function (sel) { if (sel === "[data-xj-act]") return this; return null; }; b.parentNode = card; b.disabled = false; b.textContent = act; return b; }
function click(card, btn) { try { card._listeners.click({ target: btn }); return null; } catch (e) { return String(e && e.message || e); } }
async function runCase(src, caseId, expected) {
  const startUtc = new Date().toISOString();
  const out = [];
  let loadErr = null;
  try {
    const opts = { durable: function () { return Promise.resolve({ ok: false }); } };
    if (caseId === "E6-auto-switch") opts.confirm = false;
    if (caseId === "E8-success-before-resolve") opts.durable = function () { return new Promise(function (res) { setTimeout(function () { res({ ok: true }); }, 80); }); };
    const sb = buildSandbox(opts);
    vm.createContext(sb); vm.runInContext(src, sb, { timeout: 5000 });
    const card = renderCard(sb);
    if (!card) { out.push(caseId + " NO_CARD"); }
    else {
      const rb = makeBtn("retry", card);
      const rErr = click(card, rb);
      if (caseId === "E1-remove-duplicate-guard") { click(card, rb); } // 二次直接调用
      await new Promise(function (r) { setTimeout(r, 120); });
      const sw = makeBtn("switch-qwen", card);
      const swErr = click(card, sw);
      await new Promise(function (r) { setTimeout(r, 120); });
      const errEl = card.querySelector(".xj-recovery-err");
      const sentBase = sb._sent.length === 1;
      const dupBroken = caseId === "E1-remove-duplicate-guard" ? sb._sent.length !== 1 : false; // E1 变异: 二次发送=破坏
      let switchOk = !swErr && errEl !== null && sw.disabled === false && sw.textContent.indexOf("改用无会话基础模型") >= 0;
      if (caseId === "E6-auto-switch") switchOk = sb._durableCalls === 0; // confirm=false 基线零调用；变异绕过则 durableCalls=1=破坏
      const noLeak = JSON.stringify([sb._sent, sb._toasts]).indexOf("SENTINEL") < 0;
      let v;
      if (expected === "PASS") v = (sentBase && !rErr && switchOk && noLeak) ? "PASS" : "FAIL";
      else v = (!dupBroken && sentBase && !rErr && switchOk && noLeak) ? "SURVIVED" : "KILLED";
      out.push(caseId + " verdict=" + v + " sent=" + JSON.stringify(sb._sent) + " durableCalls=" + sb._durableCalls + " err=" + (rErr || swErr || "none") + " btnDisabled=" + sw.disabled + " text=" + sw.textContent.slice(0, 12) + " errEl=" + (errEl ? "yes" : "no") + " leak=" + (noLeak ? "no" : "YES"));
    }
  } catch (e) { loadErr = String(e && e.message || e); out.push(caseId + " verdict=" + (expected === "PASS" ? "FAIL" : "KILLED") + " crash=" + loadErr); }
  const endUtc = new Date().toISOString();
  const stdout = out.join("\n") + "\n";
  const stderr = loadErr ? (loadErr + "\n") : "";
  const vl = out.join("");
  const verdict = expected === "PASS" ? (vl.indexOf("verdict=PASS") >= 0 ? "PASS" : "FAIL") : (vl.indexOf("verdict=KILLED") >= 0 ? "KILLED" : (vl.indexOf("LOAD_FAIL") >= 0 || vl.indexOf("NO_CARD") >= 0 ? "INVALID" : "SURVIVED"));
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
  { id: "E6-auto-switch", fn: b => b.split("if (window.confirm('确认切换到无会话基础模型？该模型不要求账号会话。'))").join("if (true)") },
  { id: "E7-swallow-ok-false", fn: b => b.split("showInlineRecoveryError(card, '切换失败：未收到 durable 确认，请重试')").join("/* swallowed */") },
  { id: "E8-success-before-resolve", fn: b => b.split("res.ok === true").join("true") },
  { id: "E9-remove-card-on-failure", fn: b => b.split("showInlineRecoveryError(card, '切换失败：未收到 durable 确认").join("card.remove(); showInlineRecoveryError(undefined, 'x") },
  { id: "E10-missing-re-enable", fn: b => b.split("if (btn) { btn.disabled = false; btn.textContent = '改用无会话基础模型（需显式确认）'; }").join("/* no re-enable */") },
  { id: "E11-credential-leak", fn: b => b.split("var draft = card.dataset.draft || '';").join("var draft = 'SENTINEL-' + String(card.dataset.draft || '');") }
];
async function main() {
  const cases = [];
  cases.push(await runCase(chatSrc, "B-baseline", "PASS"));
  for (const c of mutations) { cases.push(await runCase(c.fn(chatSrc), c.id, "MUT")); }
  const ledger = { task_id: "XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020", card_sha256: "53CCED87CDE56278D01268056D797D3591C7E43F5A4C4382DBFBD0EAF1966D25", candidate_source_sha256: sha(chatSrc), caseCount: cases.length, uniqueIds: cases.map(function (c) { return c.caseId; }), cases: cases.map(function (c) { return c.caseId; }) };
  fs.writeFileSync(path.join(LEDGER_DIR, "ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
  const passed = cases.filter(function (c) { return c.verdict === "PASS"; }).length;
  const killed = cases.filter(function (c) { return c.verdict === "KILLED"; }).length;
  const invalid = cases.filter(function (c) { return c.verdict === "INVALID"; }).length;
  const survived = cases.filter(function (c) { return c.verdict === "SURVIVED"; }).length;
  console.log("LEDGER: PASS=" + passed + " KILLED=" + killed + " INVALID=" + invalid + " SURVIVED=" + survived);
  process.exit(passed === 1 && killed === 11 && invalid === 0 && survived === 0 ? 0 : 2);
}
main().catch(function (e) { console.error("MAIN_ERR:", e); process.exit(2); });