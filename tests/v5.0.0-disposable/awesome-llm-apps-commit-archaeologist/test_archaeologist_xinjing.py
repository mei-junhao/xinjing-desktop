#!/usr/bin/env python3
"""XinJing-specific acceptance for the vendored commit archaeologist."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


SCRIPT = os.path.abspath(os.path.join(
    os.path.dirname(__file__),
    "..", "..", "..",
    "tools", "awesome-llm-apps", "commit-archaeologist", "archaeologist.py",
))
checks = []


def check(name, condition, detail=""):
    checks.append(bool(condition))
    suffix = " - %s" % detail if detail and not condition else ""
    print("  %s %s%s" % ("PASS" if condition else "FAIL", name, suffix))


def git(repo, *args, env=None):
    result = subprocess.run(
        ["git", *args], cwd=repo, env=env,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result.stdout.strip()


def write(repo, relative, content):
    target = os.path.join(repo, relative)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(content)


def commit(repo, message):
    git(repo, "add", "-A")
    git(repo, "commit", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def init_repo(root):
    repo = os.path.join(root, "source")
    os.makedirs(repo)
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Synthetic Reviewer")
    git(repo, "config", "user.email", "synthetic@example.invalid")
    write(repo, "src/会谈记录.py", "def summarize(items):\n    return len(items)\n")
    first = commit(repo, "feat: 新增合成会谈摘要 #10")
    write(repo, "src/会谈记录.py", "def summarize(items):\n    # 临时兼容空列表\n    return len(items or [])\n")
    second = commit(repo, "fix: 临时兼容空列表 #11")
    return repo, first, second


def run(repo, file_path="src/会谈记录.py", *args):
    return subprocess.run(
        [sys.executable, SCRIPT, repo, file_path, "--json", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def main():
    root = tempfile.mkdtemp(prefix="xinjing-archaeologist-")
    try:
        repo, first, second = init_repo(root)
        before_head = git(repo, "rev-parse", "HEAD")
        before_status = git(repo, "status", "--porcelain=v1")

        print("unicode and deterministic report:")
        result = run(repo)
        check("clean report exits 0", result.returncode == 0, result.stderr)
        report = json.loads(result.stdout) if result.returncode == 0 else {}
        subjects = [entry.get("subject") for entry in report.get("timeline", [])]
        check("Chinese commit subjects survive UTF-8", subjects == [
            "feat: 新增合成会谈摘要 #10", "fix: 临时兼容空列表 #11",
        ], str(subjects))
        check("history remains oldest to newest", [
            entry.get("hash") for entry in report.get("timeline", [])
        ] == [first, second])
        state = report.get("repository_state", {})
        check("clean full history has no warnings", state == {
            "dirty_repository": False,
            "dirty_target": False,
            "shallow": False,
            "warnings": [],
        }, str(state))
        repeat = run(repo)
        check("JSON remains deterministic", repeat.stdout == result.stdout)

        if os.name == "nt":
            windows = run(repo, "src\\会谈记录.py")
            check("Windows separators resolve tracked path", windows.returncode == 0, windows.stderr)

        print("dirty and read-only boundaries:")
        write(repo, "src/会谈记录.py", "def summarize(items):\n    return 99\n")
        dirty_before = git(repo, "status", "--porcelain=v1")
        dirty = run(repo)
        dirty_report = json.loads(dirty.stdout) if dirty.returncode == 0 else {}
        dirty_state = dirty_report.get("repository_state", {})
        check("dirty target is labeled", dirty.returncode == 0 and dirty_state.get("dirty_target") is True)
        check("dirty repository is labeled", dirty_state.get("dirty_repository") is True)
        check("warning says report describes HEAD", any(
            "describes HEAD history" in warning for warning in dirty_state.get("warnings", [])
        ), str(dirty_state))
        check("HEAD is unchanged", git(repo, "rev-parse", "HEAD") == before_head)
        check("working tree is unchanged", git(repo, "status", "--porcelain=v1") == dirty_before)
        git(repo, "restore", "--", "src/会谈记录.py")
        check("fixture returns clean", git(repo, "status", "--porcelain=v1") == before_status)

        print("fail-closed paths:")
        outside = run(repo, "../outside.py")
        check("parent traversal fails with exit 2", outside.returncode == 2)
        check("parent traversal has no traceback", "traceback" not in outside.stderr.lower())
        write(repo, "src/untracked.py", "value = 1\n")
        untracked = run(repo, "src/untracked.py")
        check("untracked target fails with exit 2", untracked.returncode == 2)
        os.remove(os.path.join(repo, "src", "untracked.py"))

        print("external driver non-execution:")
        marker = os.path.join(root, "external-driver-ran")
        driver = os.path.join(root, "driver.py")
        with open(driver, "w", encoding="utf-8") as handle:
            handle.write("from pathlib import Path\nPath(%r).write_text('ran')\n" % marker)
        write(repo, ".gitattributes", "*.py diff=xinjing-test\n")
        commit(repo, "test: add synthetic diff attributes")
        git(repo, "config", "diff.xinjing-test.command", "%s %s" % (sys.executable, driver))
        git(repo, "config", "diff.xinjing-test.textconv", "%s %s" % (sys.executable, driver))
        driver_result = run(repo)
        check("report with configured drivers exits 0", driver_result.returncode == 0, driver_result.stderr)
        check("external diff/textconv is not executed", not os.path.exists(marker))

        print("shallow-history warning:")
        clone = os.path.join(root, "shallow")
        clone_result = subprocess.run(
            ["git", "clone", "-q", "--depth", "1", Path(repo).as_uri(), clone],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        check("shallow fixture clones", clone_result.returncode == 0, clone_result.stderr)
        shallow = run(clone) if clone_result.returncode == 0 else clone_result
        shallow_report = json.loads(shallow.stdout) if shallow.returncode == 0 else {}
        shallow_state = shallow_report.get("repository_state", {})
        check("shallow repository is labeled", shallow.returncode == 0 and shallow_state.get("shallow") is True)
        check("shallow warning explains missing history", any(
            "older commits may be unavailable" in warning
            for warning in shallow_state.get("warnings", [])
        ), str(shallow_state))

        print()
        if all(checks):
            print("PASS: %d/%d checks" % (len(checks), len(checks)))
            return 0
        print("FAIL: %d/%d checks passed" % (sum(checks), len(checks)))
        return 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
