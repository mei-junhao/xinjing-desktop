#!/usr/bin/env python3
"""
Independent XinJing tests for the adapted scope-creep-detector.

Covers: upstream behavior preservation, Windows separators, exact and **
allowlist patterns, rename/delete old and new paths, protected edits,
malformed/unknown policy fields, duplicate normalized entries, absolute/
traversal rejection, long Chinese intent, textconv non-execution, and
read-only behavior.

    python3 delivery/tests/test_scope_creep_xinjing.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


SCRIPT = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "..",
    "tools", "awesome-llm-apps", "scope-creep-detector", "scope_creep.py",
))

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    suffix = ": %s" % detail if detail and not ok else ""
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name, suffix))


def write(root, path, content):
    target = os.path.join(root, path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(content)


def run_script(*args, **kwargs):
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        capture_output=True,
        text=True,
        **kwargs,
    )


def make_diff_file(root, content):
    diff_path = os.path.join(root, "test.diff")
    write(root, "test.diff", content)
    return diff_path


# ---------------------------------------------------------------------------
# Test: Policy with exact allowlist patterns
# ---------------------------------------------------------------------------

def test_exact_allowlist(root):
    diff = (
        "diff --git a/src/parser.py b/src/parser.py\n"
        "index aaa..bbb 100644\n"
        "--- a/src/parser.py\n"
        "+++ b/src/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
        "diff --git a/other.py b/other.py\n"
        "index ccc..ddd 100644\n"
        "--- a/other.py\n"
        "+++ b/other.py\n"
        "@@ -1 +1,2 @@\n"
        " def other():\n"
        "+    return 1\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["src/parser.py"],
        "protected_paths": ["other.py"],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))

    result = run_script("--diff", diff_path, "--intent", "fix parser", "--policy", policy_path, "--json")
    check("exact allowlist: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    pol = report.get("policy", {})
    check("exact allowlist: parser is allowed", "src/parser.py" in pol.get("allowed_paths", []), pol.get("allowed_paths"))
    check("exact allowlist: other is outside", "other.py" in pol.get("outside_allowlist", []), pol.get("outside_allowlist"))
    check("exact allowlist: other is protected edit", "other.py" in pol.get("protected_path_edits", []), pol.get("protected_path_edits"))


# ---------------------------------------------------------------------------
# Test: Policy with ** glob patterns
# ---------------------------------------------------------------------------

def test_glob_allowlist(root):
    diff = (
        "diff --git a/src/parser.py b/src/parser.py\n"
        "index aaa..bbb 100644\n"
        "--- a/src/parser.py\n"
        "+++ b/src/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
        "diff --git a/tests/test_parser.py b/tests/test_parser.py\n"
        "index ccc..ddd 100644\n"
        "--- a/tests/test_parser.py\n"
        "+++ b/tests/test_parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def test_parse():\n"
        "+    assert True\n"
        "diff --git a/build.mk b/build.mk\n"
        "index eee..fff 100644\n"
        "--- a/build.mk\n"
        "+++ b/build.mk\n"
        "@@ -1 +1,2 @@\n"
        " all:\n"
        "+\ttrue\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["src/**", "tests/**"],
        "protected_paths": ["build.*"],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))

    result = run_script("--diff", diff_path, "--intent", "fix parser", "--policy", policy_path, "--json")
    check("glob allowlist: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    pol = report.get("policy", {})
    check("glob allowlist: src/parser matched by src/**", "src/parser.py" in pol.get("allowed_paths", []), pol.get("allowed_paths"))
    check("glob allowlist: tests/test_parser matched by tests/**", "tests/test_parser.py" in pol.get("allowed_paths", []), pol.get("allowed_paths"))
    check("glob allowlist: build.mk is outside", "build.mk" in pol.get("outside_allowlist", []), pol.get("outside_allowlist"))
    check("glob allowlist: build.mk is protected", "build.mk" in pol.get("protected_path_edits", []), pol.get("protected_path_edits"))


# ---------------------------------------------------------------------------
# Test: Windows backslash separators
# ---------------------------------------------------------------------------

def test_windows_separators(root):
    diff = (
        "diff --git a/src\\parser.py b/src\\parser.py\n"
        "index aaa..bbb 100644\n"
        "--- a/src\\parser.py\n"
        "+++ b/src\\parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["src/parser.py"],
        "protected_paths": [],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))

    result = run_script("--diff", diff_path, "--intent", "fix parser", "--policy", policy_path, "--json")
    check("windows separators: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    pol = report.get("policy", {})
    # Backslashes should be normalized to forward slashes and matched.
    check("windows separators: backslash path matched to forward-slash allowlist",
          "src/parser.py" in pol.get("allowed_paths", []),
          pol.get("allowed_paths"))

    # Also test that a Windows-style path in the policy allowlist works.
    policy2 = {
        "task_id": "test-108",
        "write_allowlist": ["src\\parser.py"],
        "protected_paths": [],
    }
    write(root, "policy.json", json.dumps(policy2))
    diff2 = (
        "diff --git a/src/parser.py b/src/parser.py\n"
        "index aaa..bbb 100644\n"
        "--- a/src/parser.py\n"
        "+++ b/src/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
    )
    diff_path2 = make_diff_file(root, diff2)
    result2 = run_script("--diff", diff_path2, "--intent", "fix parser", "--policy", policy_path, "--json")
    check("windows separators: backslash in policy matched to forward-slash diff",
          result2.returncode == 0 and "src/parser.py" in json.loads(result2.stdout).get("policy", {}).get("allowed_paths", []),
          result2.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Rename old and new path evaluation
# ---------------------------------------------------------------------------

def test_rename_paths(root):
    diff = (
        "diff --git a/old_name.py b/new_name.py\n"
        "similarity index 90%\n"
        "rename from old_name.py\n"
        "rename to new_name.py\n"
        "index aaa..bbb 100644\n"
        "--- a/old_name.py\n"
        "+++ b/new_name.py\n"
        "@@ -1 +1,2 @@\n"
        " def old_func():\n"
        "+    return None\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["new_name.py"],
        "protected_paths": ["old_name.py"],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))

    result = run_script("--diff", diff_path, "--intent", "rename refactor", "--policy", policy_path, "--json")
    check("rename paths: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    pol = report.get("policy", {})
    # New path should be allowed (in allowlist).
    check("rename paths: new_path allowed", "new_name.py" in pol.get("allowed_paths", []),
          pol.get("allowed_paths"))
    # Old path should be outside allowlist.
    check("rename paths: old_path outside allowlist", "old_name.py" in pol.get("outside_allowlist", []),
          pol.get("outside_allowlist"))
    # Old path should be flagged as protected.
    check("rename paths: old_path protected", "old_name.py" in pol.get("protected_path_edits", []),
          pol.get("protected_path_edits"))


# ---------------------------------------------------------------------------
# Test: Delete path evaluation (both old and new)
# ---------------------------------------------------------------------------

def test_delete_paths(root):
    diff = (
        "diff --git a/deleted_file.py b/deleted_file.py\n"
        "deleted file mode 100644\n"
        "index aaa..0000000\n"
        "--- a/deleted_file.py\n"
        "+++ /dev/null\n"
        "@@ -1 +0,0 @@\n"
        "-def deleted_func():\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["allowed/**"],
        "protected_paths": ["deleted_file.py"],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))

    result = run_script("--diff", diff_path, "--intent", "cleanup", "--policy", policy_path, "--json")
    check("delete paths: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    pol = report.get("policy", {})
    check("delete paths: deleted file is outside allowlist",
          "deleted_file.py" in pol.get("outside_allowlist", []),
          pol.get("outside_allowlist"))
    check("delete paths: deleted file is protected",
          "deleted_file.py" in pol.get("protected_path_edits", []),
          pol.get("protected_path_edits"))


# ---------------------------------------------------------------------------
# Test: Malformed policy (missing field)
# ---------------------------------------------------------------------------

def test_malformed_missing(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\nindex aaa..bbb\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": "test", "write_allowlist": ["a.py"]}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("malformed missing field: exit 2", result.returncode == 2, result.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Unknown field in policy
# ---------------------------------------------------------------------------

def test_unknown_field(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\nindex aaa..bbb\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": "test", "write_allowlist": ["a.py"], "protected_paths": [], "extra_field": 1}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("unknown field: exit 2", result.returncode == 2, result.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Duplicate normalized entries in write_allowlist
# ---------------------------------------------------------------------------

def test_duplicate_allowlist(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\nindex aaa..bbb\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": "test", "write_allowlist": ["a.py", "a.py"], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("duplicate allowlist: exit 2", result.returncode == 2, result.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Duplicate normalized entries after backslash normalization
# ---------------------------------------------------------------------------

def test_duplicate_normalized(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\nindex aaa..bbb\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    # "src\\a.py" normalizes to "src/a.py", which duplicates the first entry
    policy = {"task_id": "test", "write_allowlist": ["src/a.py", "src\\a.py"], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("duplicate normalized: exit 2", result.returncode == 2, result.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Absolute path rejection
# ---------------------------------------------------------------------------

def test_absolute_path(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\nindex aaa..bbb\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": "test", "write_allowlist": ["/etc/passwd"], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("absolute path: exit 2", result.returncode == 2, result.stderr.strip())

    # Windows-style absolute path
    policy2 = {"task_id": "test", "write_allowlist": ["C:\\Users\\test"], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy2))
    result2 = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("windows absolute path: exit 2", result2.returncode == 2, result2.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Parent traversal rejection
# ---------------------------------------------------------------------------

def test_parent_traversal(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\nindex aaa..bbb\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": "test", "write_allowlist": ["../escape.py"], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("parent traversal: exit 2", result.returncode == 2, result.stderr.strip())

    policy2 = {"task_id": "test", "write_allowlist": ["src/../escape.py"], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy2))
    result2 = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("parent traversal embedded: exit 2", result2.returncode == 2, result2.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Long Chinese intent tokenization
# ---------------------------------------------------------------------------

def test_chinese_intent(root):
    diff = (
        "diff --git a/\u89e3\u6790\u5668/parser.py b/\u89e3\u6790\u5668/parser.py\n"
        "index aaa..bbb 100644\n"
        "--- a/\u89e3\u6790\u5668/parser.py\n"
        "+++ b/\u89e3\u6790\u5668/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
        "diff --git a/other.py b/other.py\n"
        "index ccc..ddd 100644\n"
        "--- a/other.py\n"
        "+++ b/other.py\n"
        "@@ -1 +1,2 @@\n"
        " def other():\n"
        "+    return 1\n"
    )
    diff_path = make_diff_file(root, diff)
    # Intent: "修复解析器中的空指针崩溃" (fix null pointer crash in parser)
    # Path: "解析器/parser.py" (parser/parser.py)
    # "解析器" (3 chars) should overlap with the intent
    result = run_script("--diff", diff_path, "--intent", "\u4fee\u590d\u89e3\u6790\u5668\u4e2d\u7684\u7a7a\u6307\u9488\u5d29\u6e83", "--json")
    check("chinese intent: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    in_scope = {item["path"] for item in report.get("in_scope", [])}
    # The Chinese path "解析器/parser.py" should be in scope because "解析器"
    # appears in both the intent and the path.
    check("chinese intent: Chinese path is in scope via Han bigram overlap",
          "\u89e3\u6790\u5668/parser.py" in in_scope,
          sorted(in_scope))
    # English path "other.py" should be in likely_creep.
    creep = {item["path"] for item in report.get("likely_creep", [])}
    check("chinese intent: English path is likely creep",
          "other.py" in creep,
          sorted(creep))


# ---------------------------------------------------------------------------
# Test: textconv non-execution
# ---------------------------------------------------------------------------

def test_textconv_nonexec(root):
    """Verify that --no-textconv is passed and textconv is never invoked."""
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "eval@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "eval"], cwd=root, check=True)
    write(root, "data.bin", "before\x00data\n")
    write(root, ".gitattributes", "*.bin diff=scope-eval-textconv\n")
    marker = os.path.join(root, "textconv-ran")
    helper = os.path.join(root, "textconv.py")
    write(
        root,
        "textconv.py",
        "import pathlib\nimport sys\n"
        "pathlib.Path(sys.argv[1]).write_text('ran', encoding='utf-8')\n"
        "print(pathlib.Path(sys.argv[2]).read_bytes().hex())\n",
    )
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "diff.scope-eval-textconv.textconv",
         "%s %s %s" % (sys.executable, helper, marker)],
        cwd=root, check=True,
    )
    write(root, "data.bin", "after\x00data\n")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)

    result = run_script("--repo", root, "--staged", "--intent", "update binary", "--json")
    check("textconv non-exec: exit 0", result.returncode == 0, result.stderr.strip())
    check("textconv non-exec: marker file not created", not os.path.exists(marker), marker)


# ---------------------------------------------------------------------------
# Test: Read-only behavior (no repo mutation)
# ---------------------------------------------------------------------------

def test_readonly(root):
    """Verify that running the script does not modify the repository state."""
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "eval@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "eval"], cwd=root, check=True)
    write(root, "a.py", "x = 1\n")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=root, check=True)

    # Capture git state before
    head_before = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()
    status_before = subprocess.run(
        ["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()
    staged_before = subprocess.run(
        ["git", "diff", "--cached", "--name-only"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()

    # Run the script on staged (there are no staged changes, but that's fine)
    result = run_script("--repo", root, "--intent", "test", "--json")
    check("read-only: exit 0", result.returncode == 0, result.stderr.strip())

    # Capture git state after
    head_after = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()
    status_after = subprocess.run(
        ["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()
    staged_after = subprocess.run(
        ["git", "diff", "--cached", "--name-only"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()

    check("read-only: HEAD unchanged", head_before == head_after, "HEAD changed")
    check("read-only: working tree status unchanged", status_before == status_after, "status changed")
    check("read-only: staged files unchanged", staged_before == staged_after, "staged changed")

    # Also verify with --diff mode that no file system writes happen outside temp
    diff_content = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n x = 1\n+y = 2\n"
    diff_path = os.path.join(root, "input.diff")
    write(root, "input.diff", diff_content)
    files_before = set()
    for dirpath, dirnames, filenames in os.walk(root):
        for fname in filenames:
            files_before.add(os.path.join(dirpath, fname))

    result2 = run_script("--diff", diff_path, "--intent", "test", "--json")
    check("read-only: diff mode exit 0", result2.returncode == 0, result2.stderr.strip())

    files_after = set()
    for dirpath, dirnames, filenames in os.walk(root):
        for fname in filenames:
            files_after.add(os.path.join(dirpath, fname))

    check("read-only: no new files created in diff mode", files_before == files_after,
          "files added: %s" % (files_after - files_before))


# ---------------------------------------------------------------------------
# Test: Protected edits are reported
# ---------------------------------------------------------------------------

def test_protected_edits(root):
    diff = (
        "diff --git a/src/parser.py b/src/parser.py\n"
        "index aaa..bbb 100644\n"
        "--- a/src/parser.py\n"
        "+++ b/src/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
        "diff --git a/config/secrets.yaml b/config/secrets.yaml\n"
        "index ccc..ddd 100644\n"
        "--- a/config/secrets.yaml\n"
        "+++ b/config/secrets.yaml\n"
        "@@ -1 +1,2 @@\n"
        " key: value\n"
        "+key2: value2\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["src/**"],
        "protected_paths": ["config/**"],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))

    result = run_script("--diff", diff_path, "--intent", "fix parser", "--policy", policy_path, "--json")
    check("protected edits: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    pol = report.get("policy", {})
    check("protected edits: secrets.yaml is protected",
          "config/secrets.yaml" in pol.get("protected_path_edits", []),
          pol.get("protected_path_edits"))
    check("protected edits: secrets.yaml is outside allowlist",
          "config/secrets.yaml" in pol.get("outside_allowlist", []),
          pol.get("outside_allowlist"))
    check("protected edits: parser.py is allowed",
          "src/parser.py" in pol.get("allowed_paths", []),
          pol.get("allowed_paths"))


# ---------------------------------------------------------------------------
# Test: Empty write_allowlist rejected
# ---------------------------------------------------------------------------

def test_empty_allowlist(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": "test", "write_allowlist": [], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("empty allowlist: exit 2", result.returncode == 2, result.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Non-string task_id rejected
# ---------------------------------------------------------------------------

def test_nonstring_task_id(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": 123, "write_allowlist": ["a.py"], "protected_paths": []}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("non-string task_id: exit 2", result.returncode == 2, result.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Policy not an object
# ---------------------------------------------------------------------------

def test_policy_not_object(root):
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    write(root, "policy.json", "[1, 2, 3]")
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("policy not object: exit 2", result.returncode == 2, result.stderr.strip())


# ---------------------------------------------------------------------------
# Test: No-policy mode still works (backward compatibility)
# ---------------------------------------------------------------------------

def test_no_policy_mode(root):
    diff = (
        "diff --git a/src/parser.py b/src/parser.py\n"
        "--- a/src/parser.py\n"
        "+++ b/src/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
    )
    diff_path = make_diff_file(root, diff)
    result = run_script("--diff", diff_path, "--intent", "fix parser", "--json")
    check("no-policy mode: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    check("no-policy mode: no policy key in report", "policy" not in report, "policy key present")
    in_scope = {item["path"] for item in report.get("in_scope", [])}
    check("no-policy mode: parser in scope", "src/parser.py" in in_scope, sorted(in_scope))


# ---------------------------------------------------------------------------
# Test: Leading ./ stripped
# ---------------------------------------------------------------------------

def test_leading_dot_slash(root):
    diff = (
        "diff --git a/./src/parser.py b/./src/parser.py\n"
        "--- a/./src/parser.py\n"
        "+++ b/./src/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["src/parser.py"],
        "protected_paths": [],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "fix parser", "--policy", policy_path, "--json")
    # The diff path won't have ./ after clean_path (which strips a/ prefix),
    # but let's test policy-side normalization of ./
    policy2 = {
        "task_id": "test-108",
        "write_allowlist": ["./src/parser.py"],
        "protected_paths": [],
    }
    write(root, "policy.json", json.dumps(policy2))
    diff2 = (
        "diff --git a/src/parser.py b/src/parser.py\n"
        "--- a/src/parser.py\n"
        "+++ b/src/parser.py\n"
        "@@ -1 +1,2 @@\n"
        " def parse():\n"
        "+    return None\n"
    )
    diff_path2 = make_diff_file(root, diff2)
    result2 = run_script("--diff", diff_path2, "--intent", "fix parser", "--policy", policy_path, "--json")
    check("leading ./: policy with ./ matches diff without ./",
          result2.returncode == 0 and "src/parser.py" in json.loads(result2.stdout).get("policy", {}).get("allowed_paths", []),
          result2.stderr.strip())


# ---------------------------------------------------------------------------
# Test: Non-sensitive error messages
# ---------------------------------------------------------------------------

def test_nonsensitive_errors(root):
    """Verify that error messages don't expose sensitive path contents."""
    diff_path = make_diff_file(root, "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+x\n")
    policy = {"task_id": "test", "write_allowlist": ["a.py"], "protected_paths": [], "extra": "secret_api_key_12345"}
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "test", "--policy", os.path.join(root, "policy.json"), "--json")
    check("non-sensitive errors: exit 2", result.returncode == 2, result.stderr.strip())
    check("non-sensitive errors: secret not in stderr",
          "secret_api_key_12345" not in result.stderr,
          result.stderr.strip())


# --------------------------------------------------------------------------- 
# Test: Protected path with both rename and edit
# ---------------------------------------------------------------------------

def test_rename_protected_both(root):
    diff = (
        "diff --git a/old_protected.py b/new_protected.py\n"
        "similarity index 90%\n"
        "rename from old_protected.py\n"
        "rename to new_protected.py\n"
        "index aaa..bbb 100644\n"
        "--- a/old_protected.py\n"
        "+++ b/new_protected.py\n"
        "@@ -1 +1,2 @@\n"
        " def func():\n"
        "+    return None\n"
    )
    diff_path = make_diff_file(root, diff)
    policy = {
        "task_id": "test-108",
        "write_allowlist": ["new_protected.py"],
        "protected_paths": ["old_protected.py", "new_protected.py"],
    }
    policy_path = os.path.join(root, "policy.json")
    write(root, "policy.json", json.dumps(policy))
    result = run_script("--diff", diff_path, "--intent", "rename", "--policy", policy_path, "--json")
    check("rename protected both: exit 0", result.returncode == 0, result.stderr.strip())
    report = {}
    if result.returncode == 0:
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    pol = report.get("policy", {})
    check("rename protected both: old path protected",
          "old_protected.py" in pol.get("protected_path_edits", []),
          pol.get("protected_path_edits"))
    check("rename protected both: new path protected",
          "new_protected.py" in pol.get("protected_path_edits", []),
          pol.get("protected_path_edits"))
    check("rename protected both: new path allowed",
          "new_protected.py" in pol.get("allowed_paths", []),
          pol.get("allowed_paths"))
    check("rename protected both: old path outside",
          "old_protected.py" in pol.get("outside_allowlist", []),
          pol.get("outside_allowlist"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    tests = [
        ("exact allowlist", test_exact_allowlist),
        ("glob allowlist", test_glob_allowlist),
        ("windows separators", test_windows_separators),
        ("rename paths", test_rename_paths),
        ("delete paths", test_delete_paths),
        ("malformed missing field", test_malformed_missing),
        ("unknown field", test_unknown_field),
        ("duplicate allowlist", test_duplicate_allowlist),
        ("duplicate normalized", test_duplicate_normalized),
        ("absolute path", test_absolute_path),
        ("parent traversal", test_parent_traversal),
        ("chinese intent", test_chinese_intent),
        ("textconv non-execution", test_textconv_nonexec),
        ("read-only behavior", test_readonly),
        ("protected edits", test_protected_edits),
        ("empty allowlist", test_empty_allowlist),
        ("non-string task_id", test_nonstring_task_id),
        ("policy not object", test_policy_not_object),
        ("no-policy mode", test_no_policy_mode),
        ("leading ./", test_leading_dot_slash),
        ("non-sensitive errors", test_nonsensitive_errors),
        ("rename protected both", test_rename_protected_both),
    ]

    for name, test_fn in tests:
        root = tempfile.mkdtemp(prefix="scope-creep-xinjing-")
        try:
            print(name + ":")
            test_fn(root)
            print()
        finally:
            shutil.rmtree(root, ignore_errors=True)

    passed = sum(checks)
    total = len(checks)
    if passed == total:
        print("PASS: %d/%d checks" % (passed, total))
        return 0
    print("FAIL: %d/%d checks passed" % (passed, total))
    return 1


if __name__ == "__main__":
    sys.exit(main())
