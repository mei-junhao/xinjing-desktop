"use strict";
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const ROOT = "D:/xinjing-electron";
const BASE = path.resolve(ROOT, "qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-final-provenance-verifier-raw-rework-020/ledger");
const sha = b => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const ledgerPath = path.join(BASE, "ledger.json");
const CASES = ["B-baseline","E1-remove-duplicate-guard","E2-free-var-retry","E3-textarea-only","E4-missing-send","E5-dropped-draft","E6-auto-switch","E7-swallow-ok-false","E8-success-before-resolve","E9-remove-card-on-failure","E10-missing-re-enable","E11-credential-leak"];
// 完整快照：ledger + 每 case run.json + stderr.txt
function fullSnapshot() { const s = {}; s.ledger = fs.readFileSync(ledgerPath, "utf8"); s.files = {}; for (const c of CASES) { for (const f of ["run.json","stdout.txt","stderr.txt"]) { const p = path.join(BASE, c, f); if (fs.existsSync(p)) s.files[c + "/" + f] = fs.readFileSync(p, "utf8"); } } return s; }
function fullRestore(s) { fs.writeFileSync(ledgerPath, s.ledger); for (const k of Object.keys(s.files)) { const p = path.join(BASE, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s.files[k]); } }
// verify（结构 fail-closed）
function verifyNow() {
  const errors = [];
  try {
    const l = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    if (!l || typeof l !== "object" || !Array.isArray(l.cases)) { errors.push("cases not array"); return errors; }
    const TOP = ["task_id","card_sha256","candidate_source_sha256","caseCount","uniqueIds","cases"];
    for (const k of Object.keys(l)) if (!TOP.includes(k)) errors.push("unknown top " + k);
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
      let run; try { run = JSON.parse(fs.readFileSync(rp, "utf8")); } catch (e) { errors.push(cid + " run bad json"); continue; }
      const F = ["caseId","mode","command","argv","cwd","startUtc","endUtc","exitCode","sourcePath","sourceBeforeSha256","sourceBeforeBytes","sourceAfterSha256","sourceAfterBytes","rawStdoutSha256","rawStdoutBytes","rawStderrSha256","rawStderrBytes","expectedDifference","verdict"];
      for (const k of Object.keys(run)) if (!F.includes(k)) errors.push(cid + " unknown " + k);
      if (run.caseId !== cid) errors.push(cid + " caseId");
      if (!["PASS","KILLED"].includes(run.verdict)) errors.push(cid + " verdict");
      const cwdN = String(run.cwd || "").split("\\").join("/");
      if (!path.isAbsolute(run.cwd || "") || cwdN.indexOf("D:/xinjing-electron") !== 0) errors.push(cid + " cwd");
      const so = fs.readFileSync(path.join(dir, "stdout.txt"), "utf8");
      if (run.rawStdoutSha256 !== sha(so)) errors.push(cid + " stdout sha");
      const sep = path.join(dir, "stderr.txt");
      if (!fs.existsSync(sep)) { errors.push(cid + " no stderr"); continue; }
      const se = fs.readFileSync(sep, "utf8");
      if (run.rawStderrSha256 !== sha(se)) errors.push(cid + " stderr sha");
    }
  } catch (e) { errors.push("crash: " + e.message); }
  return errors;
}
function capture(stage, name, snap) {
  const startUtc = new Date().toISOString();
  const errors = verifyNow();
  const ok = errors.length === 0;
  const stdout = JSON.stringify({ stage: stage, mutationId: name, ok: ok, errors: errors }) + "\n";
  const stderr = ok ? "" : errors.join(" | ") + "\n";
  const dir = path.join(BASE, "adv-raw", name); fs.mkdirSync(dir, { recursive: true });
  const outP = path.join(dir, stage + ".stdout.txt"); const errP = path.join(dir, stage + ".stderr.txt");
  fs.writeFileSync(outP, stdout); fs.writeFileSync(errP, stderr);
  const meta = { mutationId: name, stage: stage, command: "node " + process.argv[1], argv: process.argv.slice(1), cwd: process.cwd(), startUtc: startUtc, endUtc: new Date().toISOString(), exitCode: ok ? 0 : 2, stdoutPath: outP, stderrPath: errP, stdoutSha256: sha(stdout), stdoutBytes: Buffer.byteLength(stdout), stderrSha256: sha(stderr), stderrBytes: Buffer.byteLength(stderr), verdict: ok ? "PASS" : "FAIL", failed: !ok, recovered: null, restoreBaselineVerdict: null };
  fs.writeFileSync(path.join(dir, stage + ".meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return { ok: ok };
}
const ADV = [
  ["A1-delete-entry", function (s) { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.cases.pop(); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ["A2-dup-id", function (s) { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.uniqueIds.push(l.uniqueIds[0]); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ["A3-unknown-field", function (s) { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.evil = 1; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ["A4-delete-stderr", function (s) { const p = path.join(BASE, "B-baseline", "stderr.txt"); if (fs.existsSync(p)) fs.unlinkSync(p); }],
  ["A5-tamper-sha", function (s) { const p = path.join(BASE, "B-baseline", "run.json"); const r = JSON.parse(fs.readFileSync(p,"utf8")); r.rawStdoutSha256 = "x".repeat(64); fs.writeFileSync(p, JSON.stringify(r)); }],
  ["A6-relative-cwd", function (s) { const p = path.join(BASE, "B-baseline", "run.json"); const r = JSON.parse(fs.readFileSync(p,"utf8")); r.cwd = "./rel"; fs.writeFileSync(p, JSON.stringify(r)); }],
  ["A7-sibling-prefix", function (s) { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.cases.push("B-baselineX"); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ["A8-old-evidence", function (s) { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.cases.push("../final-provenance-verifier-raw-rework-020/ledger/B-baseline"); l.caseCount = l.cases.length; fs.writeFileSync(ledgerPath, JSON.stringify(l)); }],
  ["A9-total-only", function (s) { fs.writeFileSync(ledgerPath, JSON.stringify({ total: 12 })); }],
  ["A10-invalid-as-killed", function (s) { const p = path.join(BASE, "E2-free-var-retry", "run.json"); const r = JSON.parse(fs.readFileSync(p,"utf8")); r.verdict = "SURVIVED"; fs.writeFileSync(p, JSON.stringify(r)); }],
  ["A11-candidate-sha-tamper", function (s) { const l = JSON.parse(fs.readFileSync(ledgerPath,"utf8")); l.candidate_source_sha256 = "y".repeat(64); fs.writeFileSync(ledgerPath, JSON.stringify(l)); }]
];
let killed = 0;
for (const a of ADV) {
  const name = a[0];
  const snap = fullSnapshot();
  const b = capture("baseline", name, snap);
  a[1](snap); const m = capture("mutated", name, snap);
  fullRestore(snap); const rr = capture("restore", name, snap);
  const ok = b.ok && !m.ok && rr.ok;
  if (ok) killed++;
  // 更新 restore meta 的恢复后 baseline verdict
  const rm = path.join(BASE, "adv-raw", name, "restore.meta.json");
  const rmj = JSON.parse(fs.readFileSync(rm, "utf8")); rmj.restoreBaselineVerdict = rr.ok ? "PASS" : "FAIL"; rmj.recovered = rr.ok; fs.writeFileSync(rm, JSON.stringify(rmj, null, 2) + "\n");
  console.log((ok ? "KILLED" : "FAIL") + " " + name + " baseline=" + (b.ok ? "PASS" : "FAIL") + " mutated=" + (!m.ok ? "FAIL" : "PASS") + " restore=" + (rr.ok ? "PASS" : "FAIL"));
}
console.log("ADV_RAW: " + killed + "/11 KILLED");
process.exit(killed === 11 ? 0 : 2);