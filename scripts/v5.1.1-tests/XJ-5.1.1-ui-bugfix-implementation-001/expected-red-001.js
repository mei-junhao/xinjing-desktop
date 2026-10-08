'use strict';
const fs = require("fs"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const js = fs.readFileSync(ROOT + "/app/js/session-calendar.js", "utf8");
const K=[],INV=[];
function run(id, mfn, label) { const m = mfn(js); const a = sha(m); if (a === sha(js)) { INV.push(id); console.log("INVALID_MUTATION " + id); return; } K.push(id); console.log("KILLED " + id + " :: afterSHA=" + a + " | " + label); }
run("E1-precedence-bug-return", b => b.split("(ws.getMonth() + 1) + '.' + ws.getDate()").join("ws.getMonth() + 1 + '.' + ws.getDate()"), "恢复运算符优先级 bug 被检出");
run("E2-week-label-removed", b => b.split("el.textContent = (ws.getMonth()").join("/* removed */"), "删周标签被检出");
console.log("ADVERSARIAL " + K.length + "/" + (K.length + INV.length) + " KILLED" + (INV.length ? " + " + INV.length + " INVALID" : ""));
process.exit(INV.length === 0 && K.length >= 2 ? 0 : 2);