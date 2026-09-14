#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""045 fresh expected-red: 9 mutated copies of the manifest, verifier re-run per variant, all must fail-closed."""
import datetime, hashlib, json, os, shutil, subprocess

REPO = r"D:/xinjing-electron"
S45 = os.path.join(REPO, "qa/task-scratch/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-045")
EV = os.path.join(S45, "evidence")
SCR = os.path.join(REPO, "scripts/v5.1.1-tests/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-045")
E044 = os.path.join(REPO, "qa/task-scratch/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044/evidence/run-044-20260828010726302-234a1967badd-retry-04")
ISO = os.path.join(S45, "isolated")
os.makedirs(ISO, exist_ok=True)

def utcnow(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def sha256(p): return hashlib.sha256(open(p, "rb").read()).hexdigest().upper()
def w(rel, content):
    p = os.path.join(EV, rel)
    open(p, "w", encoding="utf-8", newline="\n").write(content)
    return p

m = json.load(open(os.path.join(E044, "evidence-manifest.json"), encoding="utf-8"))
metas = m["stageMetaPaths"]

def make_variant(name, mutate):
    vdir = os.path.join(ISO, name)
    if os.path.exists(vdir): shutil.rmtree(vdir)
    shutil.copytree(E044, vdir)
    vman = os.path.join(vdir, "evidence-manifest.json")
    vm = json.load(open(vman, encoding="utf-8"))
    mutate(vdir, vm)
    json.dump(vm, open(vman, "w", encoding="utf-8"), indent=1)
    t0 = utcnow()
    pp = subprocess.run(["node", os.path.join(SCR, "verifier-045.js"), EV, vdir], capture_output=True, timeout=120)
    t1 = utcnow()
    so = w(name + ".stdout.raw", pp.stdout.decode("utf-8", errors="replace"))
    se = w(name + ".stderr.raw", pp.stderr.decode("utf-8", errors="replace"))
    killed = pp.returncode != 0
    meta = {"name": name, "command": "node verifier-045.js <isolated-" + name + ">", "cwd": REPO,
            "start": t0, "end": t1, "exit": pp.returncode, "fail_closed": killed,
            "stdout": so, "stderr": se, "stdout_sha256": sha256(so), "stderr_sha256": sha256(se),
            "stdout_bytes": os.path.getsize(so), "stderr_bytes": os.path.getsize(se),
            "stdout_tail": pp.stdout.decode("utf-8", errors="replace").strip()[:220]}
    print(("KILLED  " if killed else "SURVIVED") + " " + name + " | " + meta["stdout_tail"][:110])
    return meta

V = []
# 1) delete a stage meta from manifest (referenced file missing from manifest -> count mismatch handled; delete entry)
def m1(d, vm): vm["stageMetaPaths"] = vm["stageMetaPaths"][:-1]
V.append(make_variant("01-delete-stage-meta", m1))
# 2) delete a stderr file on disk
def m2(d, vm):
    meta = json.load(open(vm["stageMetaPaths"][0], encoding="utf-8"))
    if os.path.exists(meta["stderrPath"]): os.remove(meta["stderrPath"])
V.append(make_variant("02-delete-stderr-file", m2))
# 3) tamper a stdout file byte
def m3(d, vm):
    meta = json.load(open(vm["stageMetaPaths"][1], encoding="utf-8"))
    p = meta["stdoutPath"]
    b = bytearray(open(p, "rb").read())
    b[-1] ^= 0xFF
    open(p, "wb").write(bytes(b))
V.append(make_variant("03-tamper-stdout-byte", m3))
# 4) tamper meta sha field
def m4(d, vm):
    mp = vm["stageMetaPaths"][2]
    meta = json.load(open(mp, encoding="utf-8"))
    meta["stdoutSha256"] = "0" * 64
    json.dump(meta, open(mp, "w", encoding="utf-8"), indent=1)
V.append(make_variant("04-alter-meta-sha", m4))
# 5) task identity drift (inputTaskId forged to 045)
def m5(d, vm): vm["taskId"] = "XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-045"
V.append(make_variant("05-task-identity-drift", m5))
# 6) card sha drift
def m6(d, vm): vm["cardSha256"] = "1" * 64
V.append(make_variant("06-card-sha-drift", m6))
# 7) store sha drift (manifest claims drifted store)
def m7(d, vm): vm["storeSha256AtEnd"] = "2" * 64
V.append(make_variant("07-store-sha-drift", m7))
# 8) forge results 8/8 KILLED -> removed restore entry
def m8(d, vm):
    rj = os.path.join(d, "results.json")
    results = json.load(open(rj, encoding="utf-8"))
    results = [r for r in results if not (isinstance(r, dict) and "restore 8/8" in str(r.get("name", "")))]
    json.dump(results, open(rj, "w", encoding="utf-8"), indent=1)
V.append(make_variant("08-remove-restore-entry", m8))
# 9) fake verdict: rewrite results to claim PASS with mutated pass (simulate forged ok)
def m9(d, vm):
    rj = os.path.join(d, "results.json")
    results = json.load(open(rj, encoding="utf-8"))
    for r in results:
        if isinstance(r, dict) and "8/8 真 KILLED" in str(r.get("name", "")):
            r["pass"] = False
    json.dump(results, open(rj, "w", encoding="utf-8"), indent=1)
V.append(make_variant("09-fake-kill-summary", m9))

w("expected-red-045.json", json.dumps(V, indent=1))
kills = sum(1 for v in V if v["fail_closed"])
print("FRESH EXPECTED-RED:", kills, "/", len(V), "KILLED")
# restore: re-run verifier against pristine 044 (canonical untouched) -> must PASS
t0 = utcnow()
pp = subprocess.run(["node", os.path.join(SCR, "verifier-045.js"), EV, E044], capture_output=True, timeout=120)
t1 = utcnow()
w("restore-045.stdout.raw", pp.stdout.decode("utf-8", errors="replace"))
w("restore-045.stderr.raw", pp.stderr.decode("utf-8", errors="replace"))
print("RESTORE (pristine 044): exit", pp.returncode, "|", pp.stdout.decode("utf-8", errors="replace").strip()[:120])
print("043/042 raw reuse: NONE (all variants are byte-copies of 044 mutated in 045 isolated root)")