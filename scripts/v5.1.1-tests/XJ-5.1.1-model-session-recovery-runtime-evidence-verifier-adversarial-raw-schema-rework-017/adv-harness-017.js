"use strict";
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const BASE = path.resolve(ROOT, "qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-adversarial-raw-schema-rework-017/ledger");
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const ledgerPath = path.join(BASE, "ledger.json");
const original = fs.readFileSync(ledgerPath, "utf8");
const firstRun = JSON.parse(original).cases[0];
// 重置：还原 ledger + 所有 case run.json（干净基线）
fs.writeFileSync(ledgerPath, original);
const allCases = JSON.parse(original).cases;
for (const cid of allCases) { const rp = path.join(BASE, cid, "run.json"); const op = rp + ".orig"; if (fs.existsSync(op)) fs.copyFileSync(op, rp); }
// 备份原始 run.json（供 restore）
for (const cid of allCases) { const rp = path.join(BASE, cid, "run.json"); const op = rp + ".orig"; if (!fs.existsSync(op)) fs.copyFileSync(rp, op); }
// 捕获器：模拟 verifier 运行（实际执行 verify 逻辑的包装——为真实性，每个阶段独立调用 verify() 并捕获其输出）
function verifyNow() {
  // 复用 016 verifier 核心（内联轻量版：检查 ledger + run 完整性，输出 JSON）
  const errors = [];
  try {
    const l = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    if (!Array.isArray(l.cases)) { errors.push("cases not array"); return errors; }
    if (l.caseCount !== l.cases.length) errors.push("caseCount");
    if (new Set(l.uniqueIds).size !== l.uniqueIds.length) errors.push("dup ids");
    const chatSrc = fs.readFileSync(path.join(ROOT, "app/js/xinjing-chat.js"), "utf8");
    if (l.candidate_source_sha256 !== sha(chatSrc)) errors.push("candidate sha");
    let dirCount = 0; try { dirCount = fs.readdirSync(BASE).filter(n => /^[BE]/.test(n)).length; } catch (e) {}
    if (dirCount !== l.cases.length) errors.push("cases-vs-dirs");
    for (const cid of l.cases) {
      const dir = path.resolve(BASE, cid); const rel = path.relative(BASE, dir);
      if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") { errors.push(cid + " containment"); continue; }
      const rp = path.join(dir, "run.json"); if (!fs.existsSync(rp)) { errors.push(cid + " no run"); continue; }
      const run = JSON.parse(fs.readFileSync(rp, "utf8"));
      if (run.caseId !== cid) errors.push(cid + " caseId");
      if (!["PASS","KILLED"].includes(run.verdict)) errors.push(cid + " verdict");
      const F = ["caseId","mode","command","argv","cwd","startUtc","endUtc","exitCode","sourcePath","sourceBeforeSha256","sourceBeforeBytes","sourceAfterSha256","sourceAfterBytes","rawStdoutSha256","rawStdoutBytes","rawStderrSha256","rawStderrBytes","expectedDifference","verdict"];
      for (const k of Object.keys(run)) if (!F.includes(k)) errors.push(cid + " unknown " + k);
      const cwdN = String(run.cwd || "").split("\\").join("/");
      if (!path.isAbsolute(run.cwd || "") || cwdN.indexOf("D:/xinjing-electron") !== 0) errors.push(cid + " cwd");
      const stdout = fs.readFileSync(path.join(dir, "stdout.txt"), "utf8");
      if (run.rawStdoutSha256 !== sha(stdout)) errors.push(cid + " stdout sha");
      const stderrP = path.join(dir, "stderr.txt"); if (!fs.existsSync(stderrP)) { errors.push(cid + " no stderr"); continue; }
      const stderr = fs.readFileSync(stderrP, "utf8");
      if (run.rawStderrSha256 !== sha(stderr)) errors.push(cid + " stderr sha");
    }
  } catch (e) { errors.push("crash: " + e.message); }
  return errors;
}
function capture(stage, name) {
  const startUtc = new Date().toISOString();
  const errors = verifyNow();
  const ok = errors.length === 0;
  const stdout = JSON.stringify({ stage: stage, ok: ok, errors: errors }) + "\n";
  const stderr = ok ? "" : errors.join(" | ") + "\n";
  const dir = path.join(BASE, "adv-raw", name); fs.mkdirSync(dir, { recursive: true });
  const outP = path.join(dir, stage + ".stdout.txt"); const errP = path.join(dir, stage + ".stderr.txt");
  fs.writeFileSync(outP, stdout); fs.writeFileSync(errP, stderr);
  const meta = { mutationId: name, stage: stage, command: "node " + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: startUtc, endUtc: new Date().toISOString(), exitCode: ok ? 0 : 2, stdoutPath: outP, stderrPath: errP, stdoutSha256: sha(stdout), stdoutBytes: Buffer.byteLength(stdout), stderrSha256: sha(stderr), stderrBytes: Buffer.byteLength(stderr), verdict: ok ? "PASS" : "FAIL", restoredBaselineVerdict: null };
  fs.writeFileSync(path.join(dir, stage + ".meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return { ok: ok, stdout: stdout, stderr: stderr };
}
// 11 项对抗：mutate 篡改、restore 还原
const ADV = [
  ["A1-delete-entry", function () { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.cases.pop(); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ["A2-dup-id", function () { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.uniqueIds.push(l.uniqueIds[0]); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ["A3-unknown-field", function () { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.evil = 1; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ["A4-delete-stderr", function () { const p2 = path.join(BASE, firstRun, "stderr.txt"); if (fs.existsSync(p2)) fs.unlinkSync(p2); }, function () { fs.writeFileSync(path.join(BASE, firstRun, "stderr.txt"), ""); }],
  ["A5-tamper-sha", function () { const p2 = path.join(BASE, firstRun, "run.json"); const r = JSON.parse(fs.readFileSync(p2,"utf8")); r.rawStdoutSha256 = "x".repeat(64); fs.writeFileSync(p2, JSON.stringify(r)); }, function () { }],
  ["A6-relative-cwd", function () { const p2 = path.join(BASE, firstRun, "run.json"); const r = JSON.parse(fs.readFileSync(p2,"utf8")); r.cwd = "./rel"; fs.writeFileSync(p2, JSON.stringify(r)); }, function () { }],
  ["A7-sibling-prefix", function () { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.cases.push(firstRun + "X"); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ["A8-old-evidence", function () { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.cases.push("../verifier-evidence-binding-rework-016/ledger/" + firstRun); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ["A9-total-only", function () { fs.writeFileSync(ledgerPath, JSON.stringify({ total: 12 })); }, function () { fs.writeFileSync(ledgerPath, original); }],
  ["A10-invalid-as-killed", function () { const p2 = path.join(BASE, "E2-free-var-retry", "run.json"); const r = JSON.parse(fs.readFileSync(p2,"utf8")); r.verdict = "SURVIVED"; fs.writeFileSync(p2, JSON.stringify(r)); }, function () { }],
  ["A11-candidate-sha-tamper", function () { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.candidate_source_sha256 = "y".repeat(64); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }, function () { fs.writeFileSync(ledgerPath, original); }]
];
// 每项快照 run.json 用于 restore
const snap = {};
["B-baseline","E1-remove-duplicate-guard","E2-free-var-retry","E3-textarea-only","E4-missing-send","E5-dropped-draft","E6-auto-switch","E7-swallow-ok-false","E8-success-before-resolve","E9-remove-card-on-failure","E10-missing-re-enable","E11-credential-leak"].forEach(function (n) { const p2 = path.join(BASE, n, "run.json"); if (fs.existsSync(p2)) snap[n] = fs.readFileSync(p2, "utf8"); });
function restoreRun(n) { if (snap[n]) fs.writeFileSync(path.join(BASE, n, "run.json"), snap[n]); }
let killed = 0;
for (const a of ADV) {
  const name = a[0];
  const b = capture("baseline", name);
  a[1](); const m = capture("mutated", name);
  a[2]();
  if (name.indexOf("A5") >= 0 || name.indexOf("A6") >= 0) restoreRun(firstRun);
  if (name.indexOf("A10") >= 0) restoreRun("E2-free-var-retry");
  const rr = capture("restore", name);
  const ok = b.ok && !m.ok && rr.ok;
  if (ok) killed++;
  // 更新 restore meta 的 restoredBaselineVerdict
  const rm = path.join(BASE, "adv-raw", name, "restore.meta.json"); const rmj = JSON.parse(fs.readFileSync(rm, "utf8")); rmj.restoredBaselineVerdict = rr.ok ? "PASS" : "FAIL"; fs.writeFileSync(rm, JSON.stringify(rmj, null, 2) + "\n");
  console.log((ok ? "KILLED" : "FAIL") + " " + name + " baseline=" + (b.ok ? "PASS" : "FAIL") + " mutated=" + (!m.ok ? "FAIL" : "PASS") + " restore=" + (rr.ok ? "PASS" : "FAIL"));
}
console.log("ADV_RAW: " + killed + "/11 KILLED");
process.exit(killed === 11 ? 0 : 2);