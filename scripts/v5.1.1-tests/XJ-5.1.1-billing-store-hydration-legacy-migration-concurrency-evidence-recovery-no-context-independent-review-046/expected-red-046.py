#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""046 mutation-roots: 8 real destructive variants, each isolated; baseline/mutated/restore via verifier-046.
All mutations act on 046 ISOLATED COPIES ONLY (paths rebound to mirror inside each root)."""
import datetime, hashlib, json, os, shutil, subprocess

REPO = r"D:/xinjing-electron"
S46 = os.path.join(REPO, "qa/task-scratch/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-recovery-no-context-independent-review-046")
EV = os.path.join(S46, "evidence")
SCR = os.path.join(REPO, "scripts/v5.1.1-tests/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-recovery-no-context-independent-review-046")
MIRROR = os.path.join(S46, "source-mirror")
ROOTS = os.path.join(S46, "mutation-roots")
os.makedirs(ROOTS, exist_ok=True)
M_WIN = MIRROR.replace("/", "\\")

def utcnow(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def sha256(p): return hashlib.sha256(open(p, "rb").read()).hexdigest().upper()
def w(rel, content):
    p = os.path.join(EV, rel); open(p, "w", encoding="utf-8", newline="\n").write(content); return p

# baseline: verifier against the pristine mirror (must PASS)
t0 = utcnow()
pp = subprocess.run(["node", os.path.join(SCR, "verifier-046.js"), EV, MIRROR], capture_output=True, timeout=180)
t1 = utcnow()
w("baseline-046.stdout.raw", pp.stdout.decode("utf-8", errors="replace"))
w("baseline-046.stderr.raw", pp.stderr.decode("utf-8", errors="replace"))
baseline_pass = pp.returncode == 0
print("BASELINE (mirror): exit", pp.returncode, "|", pp.stdout.decode("utf-8", errors="replace").strip()[:140])

# 8 destructive variants — each copies the mirror then breaks ONE thing inside the copy
VARIANTS = [
    ("01-delete-stage-meta",     lambda d, vm: vm["stageMetaPaths"].__delitem__(5)),
    ("02-delete-stderr-file",    lambda d, vm: _del_stderr(d, vm)),

    ("03-tamper-stdout-byte",    lambda d, vm: _flip(d, vm, 7)),
    ("04-alter-meta-sha",        lambda d, vm: _altersha(d, vm, 9)),
    ("05-task-identity-drift",   lambda d, vm: vm.__setitem__("taskId", "XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-recovery-no-context-independent-review-046")),
    ("06-card-sha-drift",        lambda d, vm: vm.__setitem__("cardSha256", "1" * 64)),
    ("07-store-sha-drift",       lambda d, vm: vm.__setitem__("storeSha256AtEnd", "2" * 64)),
    ("08-remove-restore-summary",lambda d, vm: _strip_results(d, "restore 8/8")),
]
def _del_stderr(d, vm):
    for mp in vm["stageMetaPaths"]:
        meta = json.load(open(mp, encoding="utf-8"))
        sp = meta.get("stderrPath", "")
        if sp and os.path.exists(sp):
            os.remove(sp)
            return
    raise RuntimeError("no existing stderr found to delete")
def _in_copy(d, p):
    """Map an absolute path recorded in meta to the same relative location inside the mutation copy d."""
    marker = os.sep + "source-mirror" + os.sep
    i = p.find(marker)
    if i < 0:
        raise RuntimeError("path not under source-mirror: " + p)
    return os.path.join(d, p[i + len(marker):])

def _rebind_copy(d):
    """Rebind all absolute raw paths in the copy's metas + manifest to point INSIDE the copy (isolation gate).
    JSON-level rewrite (no text surgery): load, walk string fields, replace mirror prefix with copy path."""
    mirror_marker = os.sep + "source-mirror" + os.sep
    d_win = os.path.abspath(d)
    for root, _, files in os.walk(d):
        for f in files:
            if f == "meta.json" or f.endswith(".meta.json"):
                p = os.path.join(root, f)
                meta = json.load(open(p, encoding="utf-8"))
                changed = False
                for k, v in list(meta.items()):
                    if isinstance(v, str) and mirror_marker in v:
                        i = v.find(mirror_marker)
                        meta[k] = os.path.join(d_win, v[i + len(mirror_marker):])
                        changed = True
                if changed:
                    json.dump(meta, open(p, "w", encoding="utf-8"), indent=1)
    manp = os.path.join(d, "evidence-manifest.json")
    vm2 = json.load(open(manp, encoding="utf-8"))
    vm2["stageMetaPaths"] = [_in_copy(d, x) for x in vm2["stageMetaPaths"]]
    if "evidenceRoot" in vm2 and "source-mirror" in str(vm2["evidenceRoot"]):
        vm2["evidenceRoot"] = d_win
    json.dump(vm2, open(manp, "w", encoding="utf-8"), indent=1)

def _flip(d, vm, idx):
    p = json.load(open(vm["stageMetaPaths"][idx], encoding="utf-8"))["stdoutPath"]
    b = bytearray(open(p, "rb").read()); b[-1] ^= 0xFF
    open(p, "wb").write(bytes(b))
def _altersha(d, vm, idx):
    mp = vm["stageMetaPaths"][idx]
    meta = json.load(open(mp, encoding="utf-8"))
    meta["stdoutSha256"] = "0" * 64
    json.dump(meta, open(mp, "w", encoding="utf-8"), indent=1)
def _strip_results(d, needle):
    rj = os.path.join(d, "results.json")
    results = json.load(open(rj, encoding="utf-8"))
    results = [r for r in results if needle not in str(r.get("name", ""))]
    json.dump(results, open(rj, "w", encoding="utf-8"), indent=1)

V = []
for name, fn in VARIANTS:
    vdir = os.path.join(ROOTS, name)
    if os.path.exists(vdir): shutil.rmtree(vdir)
    shutil.copytree(MIRROR, vdir)
    _rebind_copy(vdir)
    vman = os.path.join(vdir, "evidence-manifest.json")
    vm = json.load(open(vman, encoding="utf-8"))
    fn(vdir, vm)
    json.dump(vm, open(vman, "w", encoding="utf-8"), indent=1)
    t0 = utcnow()
    pp = subprocess.run(["node", os.path.join(SCR, "verifier-046.js"), EV, vdir], capture_output=True, timeout=180)
    t1 = utcnow()
    so = w(name + ".stdout.raw", pp.stdout.decode("utf-8", errors="replace"))
    se = w(name + ".stderr.raw", pp.stderr.decode("utf-8", errors="replace"))
    killed = pp.returncode != 0
    meta = {"name": name, "command": "node verifier-046.js <mutation-root>", "cwd": REPO, "start": t0, "end": t1,
            "exit": pp.returncode, "fail_closed": killed,
            "stdout": so, "stderr": se, "stdout_sha256": sha256(so), "stderr_sha256": sha256(se),
            "stdout_bytes": os.path.getsize(so), "stderr_bytes": os.path.getsize(se),
            "stdout_tail": pp.stdout.decode("utf-8", errors="replace").strip()[:200]}
    print(("KILLED  " if killed else "SURVIVED") + " " + name + " | " + meta["stdout_tail"][:110])
    V.append(meta)

w("expected-red-046.json", json.dumps(V, indent=1))
kills = sum(1 for v in V if v["fail_closed"])
print("FRESH EXPECTED-RED:", kills, "/", len(V), "KILLED")

# restore: verifier against pristine mirror again (fresh PASS)
t0 = utcnow()
pp = subprocess.run(["node", os.path.join(SCR, "verifier-046.js"), EV, MIRROR], capture_output=True, timeout=180)
t1 = utcnow()
w("restore-046.stdout.raw", pp.stdout.decode("utf-8", errors="replace"))
w("restore-046.stderr.raw", pp.stderr.decode("utf-8", errors="replace"))
print("RESTORE (mirror pristine): exit", pp.returncode, "|", pp.stdout.decode("utf-8", errors="replace").strip()[:140])