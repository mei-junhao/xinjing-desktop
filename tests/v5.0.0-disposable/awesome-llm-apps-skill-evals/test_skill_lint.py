#!/usr/bin/env python3
"""Deterministic tests for the XinJing-adapted skill_lint.py (self-contained, tempdir fixtures, exit 0/1)."""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VENDOR = os.path.join(PROJECT_ROOT, "tools", "awesome-llm-apps", "skill-evals")
sys.path.insert(0, VENDOR)

import skill_lint  # noqa: E402

PASS_MARK = "XJ_LINT_PASS"
FAIL_MARK = "XJ_LINT_FAIL"


def write_skill(d, name, body, fm_extra=""):
    """Create a minimal valid skill directory under *d*."""
    skill_dir = os.path.join(d, name)
    os.makedirs(os.path.join(skill_dir, "references"))
    content = "---\nname: %s\ndescription: %s%s\n---\n%s" % (
        name,
        "Extracts structured data from PDF files. Use when the user needs to "
        "convert a document into rows or JSON.",
        fm_extra,
        body,
    )
    with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write(content)
    return skill_dir


def write_file(skill_dir, relpath, content):
    p = os.path.join(skill_dir, relpath)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(content)
    return p


class TestLint(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="xj_lint_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, skill_dir, strict=False, as_json=False):
        argv = [skill_dir]
        if strict:
            argv.append("--strict")
        if as_json:
            argv.append("--json")
        code = skill_lint.main(argv)
        return code

    # --- upstream behavior -------------------------------------------------
    def test_valid_skill_passes(self):
        sd = write_skill(self.tmp, "good-skill", "See [guide](references/guide.md) for details.")
        write_file(sd, "references/guide.md", "# Guide\n")
        code = self._run(sd)
        self.assertEqual(code, 0, "valid skill should pass lint")

    def test_missing_skill_md_is_error(self):
        sd = os.path.join(self.tmp, "empty-skill")
        os.makedirs(sd)
        code = self._run(sd)
        self.assertEqual(code, 1)

    def test_name_mismatch_is_error(self):
        sd = write_skill(self.tmp, "dir-name", "body")
        # name is set to "dir-name" by write_skill, so manually fix it
        with open(os.path.join(sd, "SKILL.md"), "r", encoding="utf-8") as fh:
            text = fh.read()
        text = text.replace("name: dir-name", "name: wrong-name")
        with open(os.path.join(sd, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(text)
        code = self._run(sd)
        self.assertEqual(code, 1)

    def test_strict_text_only_skill_is_error(self):
        sd = write_skill(self.tmp, "text-only-skill", "Just prose, no resources referenced.")
        # remove the references dir created by write_skill
        shutil.rmtree(os.path.join(sd, "references"), ignore_errors=True)
        code = self._run(sd, strict=True)
        self.assertEqual(code, 1)

    def test_non_strict_text_only_is_warning(self):
        sd = write_skill(self.tmp, "text-only-warn", "Just prose, no resources referenced.")
        shutil.rmtree(os.path.join(sd, "references"), ignore_errors=True)
        code = self._run(sd, strict=False)
        self.assertEqual(code, 0)

    # --- UTF-8 BOM ---------------------------------------------------------
    def test_bom_accepted(self):
        sd = write_skill(self.tmp, "bom-skill", "Body with [ref](references/x.md).")
        write_file(sd, "references/x.md", "x")
        p = os.path.join(sd, "SKILL.md")
        with open(p, "rb") as fh:
            raw = fh.read()
        with open(p, "wb") as fh:
            fh.write(b"\xef\xbb\xbf" + raw)
        errors, warnings = skill_lint.lint(sd)
        self.assertEqual(errors, [], "BOM should be accepted; got errors: %r" % errors)

    def test_invalid_utf8_fails_closed(self):
        sd = write_skill(self.tmp, "badutf-skill", "body")
        p = os.path.join(sd, "SKILL.md")
        with open(p, "wb") as fh:
            fh.write(b"---\nname: badutf-skill\ndescription: x\n---\n\xff\xfe bad bytes")
        errors, warnings = skill_lint.lint(sd)
        self.assertTrue(any("not valid UTF-8" in e for e in errors),
                        "invalid UTF-8 should fail closed; got: %r" % errors)

    # --- Chinese description and triggers ---------------------------------
    def test_chinese_description_accepted(self):
        skill_dir = os.path.join(self.tmp, "zh-skill")
        os.makedirs(os.path.join(skill_dir, "references"))
        content = (
            "---\n"
            "name: zh-skill\n"
            "description: 从PDF文件中提取结构化数据。当用户需要将文档转换为表格或JSON时使用此技能。\n"
            "---\n"
            "这是一个中文技能。见 [指南](references/guide.md)。\n"
        )
        with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(content)
        with open(os.path.join(skill_dir, "references", "guide.md"), "w", encoding="utf-8") as fh:
            fh.write("# 指南\n")
        errors, warnings = skill_lint.lint(skill_dir)
        self.assertEqual(errors, [], "Chinese description should pass; got: %r" % errors)

    # --- Unsafe reference rejection ---------------------------------------
    def test_backslash_reference_rejected(self):
        sd = write_skill(self.tmp, "bs-skill", "See references\\evil.md for details.")
        write_file(sd, "references/evil.md", "x")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("backslash" in e for e in errors),
                        "backslash reference should be an error; got: %r" % errors)

    def test_absolute_path_rejected(self):
        sd = write_skill(self.tmp, "abs-skill", "See [secret](/etc/passwd) for details.")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("absolute path" in e for e in errors),
                        "absolute path reference should be an error; got: %r" % errors)

    def test_drive_qualified_rejected(self):
        sd = write_skill(self.tmp, "drv-skill", "See [secret](C:/Users/secret.txt) for details.")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("drive-qualified" in e for e in errors),
                        "drive-qualified path should be an error; got: %r" % errors)

    def test_traversal_rejected_even_if_file_exists(self):
        sd = write_skill(self.tmp, "trav-skill", "See [secret](../../escape.md) for details.")
        # Create the file outside the skill dir so traversal would "find" it
        outside = os.path.join(self.tmp, "escape.md")
        with open(outside, "w", encoding="utf-8") as fh:
            fh.write("escaped!")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("traversal" in e or "outside" in e for e in errors),
                        "traversal should be rejected even if file exists; got: %r" % errors)

    def test_symlink_escape_rejected(self):
        sd = write_skill(self.tmp, "sym-skill", "See [link](references/link.md) for details.")
        os.makedirs(os.path.join(sd, "references"), exist_ok=True)
        target = os.path.join(self.tmp, "outside_target.md")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write("outside")
        link = os.path.join(sd, "references", "link.md")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not supported on this platform")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("outside" in e for e in errors),
                        "symlink escape should be rejected; got: %r" % errors)

    # --- JSON output ------------------------------------------------------
    def test_json_has_tool_version(self):
        sd = write_skill(self.tmp, "json-skill", "See [g](references/g.md).")
        write_file(sd, "references/g.md", "x")
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self._run(sd, as_json=True)
        import json as _json
        out = _json.loads(buf.getvalue())
        self.assertEqual(out["tool_version"], skill_lint.TOOL_VERSION)
        self.assertEqual(out["schema_version"], skill_lint.SCHEMA_VERSION)
        self.assertIn("passed", out)
        self.assertTrue(out["passed"])

    # === EXPECTED-RED (Task 116) ==========================================

    def test_red_duplicate_name_frontmatter_key_rejected(self):
        """Expected-red: duplicate `name` frontmatter key must be a lint error."""
        sd = os.path.join(self.tmp, "dup-name")
        os.makedirs(os.path.join(sd, "references"))
        content = (
            "---\n"
            "name: dup-name\n"
            "name: other-name\n"
            "description: Extracts data. Use when testing duplicates.\n"
            "---\nSee [g](references/g.md).\n"
        )
        with open(os.path.join(sd, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(content)
        with open(os.path.join(sd, "references", "g.md"), "w") as fh:
            fh.write("x")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("duplicate" in e.lower() for e in errors),
                        "duplicate name key must be an error; got: %r" % errors)

    def test_red_duplicate_description_frontmatter_key_rejected(self):
        """Expected-red: duplicate `description` frontmatter key must be a lint error."""
        sd = os.path.join(self.tmp, "dup-desc")
        os.makedirs(os.path.join(sd, "references"))
        content = (
            "---\n"
            "name: dup-desc\n"
            "description: First description. Use when testing.\n"
            "description: Second description. Use when testing again.\n"
            "---\nSee [g](references/g.md).\n"
        )
        with open(os.path.join(sd, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(content)
        with open(os.path.join(sd, "references", "g.md"), "w") as fh:
            fh.write("x")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("duplicate" in e.lower() for e in errors),
                        "duplicate description key must be an error; got: %r" % errors)

    def test_red_duplicate_arbitrary_frontmatter_key_rejected(self):
        """Expected-red: duplicate arbitrary frontmatter key (not just
        name/description) must also be detected."""
        sd = os.path.join(self.tmp, "dup-compat")
        os.makedirs(os.path.join(sd, "references"))
        content = (
            "---\n"
            "name: dup-compat\n"
            "description: Extracts data. Use when testing duplicates.\n"
            "compatibility: python>=3.8\n"
            "compatibility: python>=3.10\n"
            "---\nSee [g](references/g.md).\n"
        )
        with open(os.path.join(sd, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(content)
        with open(os.path.join(sd, "references", "g.md"), "w") as fh:
            fh.write("x")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("duplicate" in e.lower() and "compatibility" in e.lower()
                            for e in errors),
                        "duplicate compatibility key must be an error; got: %r" % errors)

    def test_red_duplicate_keys_separated_by_other_key(self):
        """Expected-red: duplicate keys separated by an unrelated frontmatter
        line must still be detected (not just adjacent duplicates)."""
        sd = os.path.join(self.tmp, "dup-sep")
        os.makedirs(os.path.join(sd, "references"))
        content = (
            "---\n"
            "name: dup-sep\n"
            "description: Extracts data. Use when testing.\n"
            "compatibility: python>=3.8\n"
            "name: overwritten-name\n"
            "---\nSee [g](references/g.md).\n"
        )
        with open(os.path.join(sd, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(content)
        with open(os.path.join(sd, "references", "g.md"), "w") as fh:
            fh.write("x")
        errors, _ = skill_lint.lint(sd)
        self.assertTrue(any("duplicate" in e.lower() for e in errors),
                        "separated duplicate keys must be detected; got: %r" % errors)

    # --- Read-only / non-execution ----------------------------------------
    def test_does_not_rewrite_files(self):
        body = "See [guide](references/guide.md)."
        sd = write_skill(self.tmp, "ro-skill", body)
        write_file(sd, "references/guide.md", "content")
        skill_md = os.path.join(sd, "SKILL.md")
        before = open(skill_md, "rb").read()
        skill_lint.lint(sd)
        after = open(skill_md, "rb").read()
        self.assertEqual(before, after, "lint must not rewrite SKILL.md")

    # --- Windows junction root rejected -----------------------------------
    def test_junction_root_rejected(self):
        """A Windows directory junction as the input skill root must be
        rejected with a lint error (exit 1) before reading through it.
        Uses cmd /c mklink /J to create a real junction fixture."""
        if os.name != "nt":
            self.skipTest("junction tests require Windows")
        # Create a real valid skill whose name matches the junction dir name
        junction_name = "junction-skill"
        real_skill = os.path.join(self.tmp, "real-skill")
        os.makedirs(os.path.join(real_skill, "references"))
        with open(os.path.join(real_skill, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("---\nname: %s\ndescription: Extracts structured data from PDF "
                      "files. Use when the user needs to convert a document into "
                      "rows or JSON.\n---\nSee [g](references/g.md).\n" % junction_name)
        with open(os.path.join(real_skill, "references", "g.md"), "w") as fh:
            fh.write("x")
        junction = os.path.join(self.tmp, junction_name)
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", junction, real_skill],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0,
                         "mklink /J must succeed on Windows: %s" % result.stderr)
        code = self._run(junction, as_json=True)
        self.assertEqual(code, 1, "junction root must be rejected with exit 1")
        errors, _ = skill_lint.lint(junction)
        self.assertTrue(any("link" in e.lower() or "junction" in e.lower() or "reparse" in e.lower()
                            for e in errors),
                        "junction root must produce a link/junction/reparse error; got: %r" % errors)

    def test_junction_root_not_read_through(self):
        """The junction root must not be read through — even if the target
        contains a perfectly valid skill, lint must fail at the root level."""
        if os.name != "nt":
            self.skipTest("junction tests require Windows")
        junction_name = "jct-skill"
        real_skill = os.path.join(self.tmp, "real-target")
        os.makedirs(os.path.join(real_skill, "references"))
        with open(os.path.join(real_skill, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("---\nname: %s\ndescription: Extracts structured data from PDF "
                      "files. Use when the user needs to convert a document into "
                      "rows or JSON.\n---\nSee [g](references/g.md).\n" % junction_name)
        with open(os.path.join(real_skill, "references", "g.md"), "w") as fh:
            fh.write("x")
        junction = os.path.join(self.tmp, junction_name)
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", junction, real_skill],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0,
                         "mklink /J must succeed: %s" % result.stderr)
        errors, warnings = skill_lint.lint(junction)
        # Must fail with a root-link error, not pass or produce name-mismatch etc.
        self.assertTrue(errors, "junction root must produce errors")
        self.assertTrue(any("link" in e.lower() or "junction" in e.lower() or "reparse" in e.lower()
                            for e in errors),
                        "error must mention link/junction/reparse; got: %r" % errors)


def run_all():
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(TestLint)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_all())
