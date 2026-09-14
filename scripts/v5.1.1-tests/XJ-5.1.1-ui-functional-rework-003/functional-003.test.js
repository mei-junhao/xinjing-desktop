'use strict';
const fs = require("fs"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const bc = fs.readFileSync(ROOT + "/app/js/billing-calendar.js", "utf8");
const wb = fs.readFileSync(ROOT + "/app/css/workbench.css", "utf8");
const R = []; function t(n, fn) { try { fn(); R.push(true); console.log("PASS", n); } catch (e) { R.push(false); console.log("FAIL", n, "::", e.message); } }
t("T1 月历周期标签存在", () => { if (!bc.includes("bc-period-label")) throw new Error("no period label"); });
t("T2 aria-live 宣布", () => { if (!bc.includes("aria-live")) throw new Error("no aria-live"); });
t("T3 侧栏滚动容器", () => { if (!wb.includes("overflow-y: auto")) throw new Error("no scroll"); });
const K=[],INV=[];
function run(id, srcArg, mfn, label) { const base = srcArg === "css" ? wb : bc; const m = mfn(base); const a = sha(m); if (a === sha(base)) { INV.push(id); console.log("INVALID_MUTATION " + id); return; } K.push(id); console.log("KILLED " + id + " :: afterSHA=" + a + " | " + label); }
run("E1-remove-period-label", "js", b => b.split("bc-period-label").join("bc-period-removed"), "删周期标签被检出");
run("E2-remove-aria-live", "js", b => b.split("aria-live").join("aria-hidden"), "删 aria 宣布被检出");
run("E3-remove-sidebar-scroll", "css", b => b.split("overflow-y: auto").join("/* no scroll */"), "删侧栏滚动被检出");
console.log("511-003 " + R.filter(x=>x).length + "/" + R.length + " PASS; ADVERSARIAL " + K.length + "/" + (K.length + INV.length) + " KILLED" + (INV.length ? " + " + INV.length + " INVALID" : ""));
process.exit(R.every(x=>x) && INV.length === 0 ? 0 : 2);