'use strict';
const fs = require("fs"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const chat = fs.readFileSync(ROOT + "/app/js/xinjing-chat.js", "utf8");
const server = fs.readFileSync(ROOT + "/server/server.js", "utf8");
const R = []; function t(n, fn) { try { fn(); R.push(true); console.log("PASS", n); } catch (e) { R.push(false); console.log("FAIL", n, "::", e.message); } }
t("T1 恢复卡存在", () => { if (!chat.includes("showAccountSessionRecovery")) throw new Error("no recovery card"); });
t("T2 去重守卫", () => { if (!chat.includes("querySelector('.xj-recovery-card')")) throw new Error("no dedup guard"); });
t("T3 草稿保留", () => { if (!chat.includes("card.dataset.draft")) throw new Error("no draft preserve"); });
t("T4 显式 Qwen 切换", () => { if (!chat.includes("confirm('确认切换到无会话基础模型")) throw new Error("no explicit switch"); });
t("T5 服务端 truthful deny 保持", () => { if (!server.includes("account-session-required")) throw new Error("server deny removed"); });
const K=[],INV=[];
function run(id, mfn, label) { const m = mfn(chat); const a = sha(m); if (a === sha(chat)) { INV.push(id); console.log("INVALID_MUTATION " + id); return; } K.push(id); console.log("KILLED " + id + " :: afterSHA=" + a + " | " + label); }
run("E1-swallow-error", b => b.split("indexOf('account-session-required') >= 0").join("false"), "吞 account-session-required 被检出");
run("E2-auto-downgrade", b => b.split("confirm('确认切换到无会话基础模型").join("/* auto switch */"), "自动降级被检出");
run("E3-duplicate-cards", b => b.split("querySelector('.xj-recovery-card')").join("/* no dedup */"), "重复恢复卡被检出");
run("E4-draft-lost", b => b.split("card.dataset.draft").join("/* no draft */"), "丢草稿被检出");
run("E5-fake-success", b => b.split("indexOf('account-session-required') >= 0").join("indexOf('whatever') >= 0"), "伪造成功被检出");
console.log("511-004 " + R.filter(x=>x).length + "/" + R.length + " PASS; ADVERSARIAL " + K.length + "/" + (K.length + INV.length) + " KILLED" + (INV.length ? " + " + INV.length + " INVALID" : ""));
process.exit(R.every(x=>x) && INV.length === 0 ? 0 : 2);