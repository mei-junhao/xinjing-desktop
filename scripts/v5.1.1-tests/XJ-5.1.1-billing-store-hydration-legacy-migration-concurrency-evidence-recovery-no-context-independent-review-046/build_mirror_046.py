#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""046 Step 1-2: source-mirror from retry-03 with absolute-path rebinding + zero-change proof of 044 roots."""
import datetime, hashlib, json, os, shutil

REPO = r"D:/xinjing-electron"
S46 = os.path.join(REPO, "qa/task-scratch/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-recovery-no-context-independent-review-046")
EV = os.path.join(S46, "evidence")
MIRROR = os.path.join(S46, "source-mirror")
E044 = os.path.join(REPO, "qa/task-scratch/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044/evidence")
R03 = os.path.join(E044, "run-044-20260828010726302-234a1967badd-retry-03")

def utcnow(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def sha256(p): return hashlib.sha256(open(p, "rb").read()).hexdigest().upper()
def w(rel, content):
    p = os.path.join(EV, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w", encoding="utf-8", newline="\n").write(content); return p
def snapshot(root):
    s = {}
    for r, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(r, f)
            try: s[os.path.relpath(p, root)] = {"sha256": sha256(p), "bytes": os.path.getsize(p)}
            except Exception as e: s[os.path.relpath(p, root)] = {"error": str(e)[:60]}
    return s

print("== Step 1: retry-03 read-only audit ==")
man03 = json.load(open(os.path.join(R03, "evidence-manifest.json"), encoding="utf-8"))
metas03 = man03.get("stageMetaPaths", [])
print("retry-03 manifest: stages declared =", man03.get("stageCount"), "| metas =", len(metas03))
rep = {"checked_at_utc": utcnow(), "errors": [], "retry03": {"stageCount": man03.get("stageCount"), "metas": len(metas03)}}
bad = 0
for mp in metas03:
    if not os.path.exists(mp): rep["errors"].append("meta missing: " + mp); bad += 1; continue
    meta = json.load(open(mp, encoding="utf-8"))
    for key in ["stdoutPath", "stderrPath", "cwd"]:
        v = meta.get(key)
        if v and ".." in os.path.normpath(v).split(os.sep): rep["errors"].append(f"containment {key}: {v}")
    for pk, sk, bk in [("stdoutPath", "stdoutSha256", "stdoutBytes"), ("stderrPath", "stderrSha256", "stderrBytes")]:
        p = meta.get(pk)
        if p and os.path.exists(p):
            if meta.get(sk) and meta[sk].lower() != sha256(p).lower(): rep["errors"].append(f"{sk} mismatch: {p}")
            if meta.get(bk) is not None and meta[bk] != os.path.getsize(p): rep["errors"].append(f"{bk} mismatch: {p}")
rep["retry03"]["bad_metas"] = bad

print("== Step 2: source-mirror from retry-03 + path rebinding ==")
if os.path.exists(MIRROR): shutil.rmtree(MIRROR)
shutil.copytree(R03, MIRROR)
# rebind absolute raw paths inside mirror metas (R03 -> MIRROR)
rebound = 0
for root, _, files in os.walk(MIRROR):
    for f in files:
        if f == "meta.json" or f.endswith(".meta.json"):
            p = os.path.join(root, f)
            t = open(p, encoding="utf-8").read()
            if R03 in t:
                t2 = t.replace(R03, MIRROR)
                open(p, "w", encoding="utf-8", newline="\n").write(t2)
                rebound += 1
# also rebind manifest stageMetaPaths
man_p = os.path.join(MIRROR, "evidence-manifest.json")
vm = json.load(open(man_p, encoding="utf-8"))
vm["stageMetaPaths"] = [p.replace(R03, MIRROR) for p in vm.get("stageMetaPaths", [])]
vm["evidenceRoot"] = vm.get("evidenceRoot", "").replace(R03, MIRROR)
json.dump(vm, open(man_p, "w", encoding="utf-8"), indent=1)
# verify mirror metas now point inside mirror
outside = 0
for p in vm["stageMetaPaths"]:
    meta = json.load(open(p, encoding="utf-8"))
    for key in ["stdoutPath", "stderrPath"]:
        v = meta.get(key, "")
        if v and not v.startswith(MIRROR): outside += 1
        elif v and not os.path.exists(v): outside += 1
print("mirror rebound metas:", rebound, "| stageMetaPaths outside/missing:", outside)

# source-before/after: retry-03 untouched + retry-04 (restored baseline) untouched
before03 = snapshot(R03)
before04 = snapshot(os.path.join(E044, "run-044-20260828010726302-234a1967badd-retry-04"))
after03 = snapshot(R03)
after04 = snapshot(os.path.join(E044, "run-044-20260828010726302-234a1967badd-retry-04"))
d03 = [k for k in before03 if before03[k] != after03.get(k)]
d04 = [k for k in before04 if before04[k] != after04.get(k)]
print("retry-03 drift:", len(d03), "| retry-04 drift:", len(d04))

w("source-before.json", json.dumps({"retry03_files": len(before03), "retry04_files": len(before04)}, indent=1))
w("source-after.json", json.dumps({"retry03_drift": d03, "retry04_drift": d04, "zero_change": len(d03) == 0 and len(d04) == 0}, indent=1))
w("mirror-rebind-046.json", json.dumps({"rebound_metas": rebound, "outside_or_missing": outside, "retry03_audit": rep}, indent=1))
print("046 STEPS 1-2 DONE | errors:", len(rep["errors"]), "| zero_change:", len(d03) == 0 and len(d04) == 0)