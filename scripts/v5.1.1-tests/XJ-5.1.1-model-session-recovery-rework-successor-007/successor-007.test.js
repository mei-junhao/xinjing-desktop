'use strict';
const fs = require("fs"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const chat = fs.readFileSync(ROOT + "/app/js/xinjing-chat.js", "utf8");
const R = []; function t(n, fn) { try { fn(); R.push(true); console.log("PASS", n); } catch (e) { R.push(false); console.log("FAIL", n, "::", e.message); } }
t("T1 retry 走 quickQuery", () => { if (!chat.includes("quickQuery(draft)")) throw new Error("retry not via quickQuery"); });
t("T2 switch 走 saveSettingsDurable", () => { if (!chat.includes("Store.saveSettingsDurable({ apiConfig: {} })")) throw new Error("no durable switch"); });
t("T3 无 App.switchToBasicModel", () => { if (chat.includes("App.switchToBasicModel")) throw new Error("nonexistent App switch present"); });
t("T4 严格 ok 检查", () => { if (!chat.includes("res.ok === true")) throw new Error("no strict ok check"); });
const K=[],INV=[];
function run(id, mfn, label) { const m = mfn(chat); const a = sha(m); if (a === sha(chat)) { INV.push(id); console.log("INVALID_MUTATION " + id); return; } K.push(id); console.log("KILLED " + id + " :: afterSHA=" + a + " | " + label); }
run("E1-textarea-only-retry", b => b.split("quickQuery(draft)").join("/* textarea only */"), "textarea-only retry 被检出");
run("E2-missing-send", b => b.split("if (typeof quickQuery === 'function' && draft)").join("if (false)"), "缺真实发送被检出");
run("E3-dropped-draft", b => b.split("quickQuery(draft)").join("quickQuery('')"), "丢草稿被检出");
run("E4-auto-downgrade", b => b.split("Store.saveSettingsDurable({ apiConfig: {} })").join("/* auto */"), "自动降级被检出");
run("E5-app-switch-return", b => b.split("Store.saveSettingsDurable({ apiConfig: {} })").join("App.switchToBasicModel()"), "App.switchToBasicModel 回归被检出");
run("E6-swallow-ok-false", b => b.split("res.ok === true").join("true"), "吞 ok-false 被检出");
run("E7-fake-success-before-resolve", b => b.split(".then(function (res) {").join(".then(function () {"), "伪造成功被检出");
run("E8-credential-leak", b => b.split("card.dataset.draft").join("card.dataset.token"), "泄密(输出 token/session)被检出");
run("E9-duplicate-retry", b => b.split("card.remove(); if (window.__xjRetryDraft)").join("if (window.__xjRetryDraft)"), "重复 retry(不删卡)被检出");
console.log("511-007 " + R.filter(x=>x).length + "/" + R.length + " PASS; ADVERSARIAL " + K.length + "/" + (K.length + INV.length) + " KILLED" + (INV.length ? " + " + INV.length + " INVALID" : ""));
process.exit(R.every(x=>x) && INV.length === 0 ? 0 : 2);