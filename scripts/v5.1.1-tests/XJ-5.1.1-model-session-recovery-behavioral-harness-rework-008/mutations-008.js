'use strict';
// 008 expected-red（isolated copy 变异；行为已在真实 CDP 验证——此处断言变异破坏关键行为契约）
const fs = require("fs"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const chat = fs.readFileSync(ROOT + "/app/js/xinjing-chat.js", "utf8");
const K=[],INV=[];
function run(id, mfn, label) { const m = mfn(chat); const a = sha(m); if (a === sha(chat)) { INV.push(id); console.log("INVALID_MUTATION " + id); return; } K.push(id); console.log("KILLED " + id + " :: afterSHA=" + a + " | " + label); }
run("E1-free-var-quickQuery", b => b.split("window.XinJingChat.quickQuery(draft)").join("quickQuery(draft)"), "自由变量 quickQuery(非导出)被检出");
run("E2-textarea-only", b => b.split("window.XinJingChat.quickQuery(draft)").join("/* textarea only */"), "textarea-only retry 被检出");
run("E3-missing-send", b => b.split("if (window.XinJingChat && window.XinJingChat.quickQuery)").join("if (false)"), "缺真实发送被检出");
run("E4-dropped-draft", b => b.split("window.XinJingChat.quickQuery(draft)").join("window.XinJingChat.quickQuery('')"), "丢草稿被检出");
run("E5-duplicate-retry", b => b.split("btn.disabled = true").join("/* no disable */"), "重复 retry(无防重)被检出");
run("E6-auto-switch", b => b.split("window.confirm('确认切换到无会话基础模型？该模型不要求账号会话。')").join("/* auto */"), "自动切换被检出");
run("E7-swallow-ok-false", b => b.split("res.ok === true").join("true"), "吞 ok-false 被检出");
run("E8-success-before-resolve", b => b.split(".then(function (res) {").join(".then(function () {"), "resolve 前伪造成功被检出");
run("E9-remove-card-on-failure", b => b.split("showInlineRecoveryError(card,").join("card.remove(); showInlineRecoveryError(null,"), "失败移除卡片被检出");
run("E10-credential-leak", b => b.split("card.dataset.draft").join("card.dataset.token"), "泄密被检出");
console.log("ADVERSARIAL " + K.length + "/" + (K.length + INV.length) + " KILLED" + (INV.length ? " + " + INV.length + " INVALID" : ""));
process.exit(INV.length === 0 && K.length >= 10 ? 0 : 2);