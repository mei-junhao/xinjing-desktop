#!/usr/bin/env python3
"""Deterministic tests for the XinJing-adapted run_trigger_evals.py (self-contained, tempdir fixtures, exit 0/1)."""

import io
import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VENDOR = os.path.join(PROJECT_ROOT, "tools", "awesome-llm-apps", "skill-evals")
sys.path.insert(0, VENDOR)

import run_trigger_evals as rte  # noqa: E402


def make_skill(skills_root, name, description):
    sd = os.path.join(skills_root, name)
    os.makedirs(sd)
    with open(os.path.join(sd, "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write("---\nname: %s\ndescription: %s\n---\nBody.\n" % (name, description))
    return sd


def make_cases(evals_root, name, cases):
    ed = os.path.join(evals_root, name)
    os.makedirs(ed)
    with open(os.path.join(ed, "trigger-cases.json"), "w", encoding="utf-8") as fh:
        json.dump({"cases": cases}, fh, ensure_ascii=False)


class TestTriggerEvals(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="xj_trig_")
        self.skills_root = os.path.join(self.tmp, "skills")
        self.evals_root = os.path.join(self.tmp, "evals")
        os.makedirs(self.skills_root)
        os.makedirs(self.evals_root)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, skills_root=None, evals_root=None, as_json=False):
        argv = []
        argv += ["--skills-root", skills_root or self.skills_root]
        argv += ["--evals-root", evals_root or self.evals_root]
        if as_json:
            argv.append("--json")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = rte.main(argv)
        return code, buf.getvalue()

    def _json(self, **kw):
        code, out = self._run(as_json=True, **kw)
        return code, json.loads(out)

    # --- explicit roots honored (not hard-coded) --------------------------
    def test_explicit_roots_honored(self):
        make_skill(self.skills_root, "pdf-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "pdf-skill", [
            {"id": "p1", "prompt": "extract data from this PDF", "should_trigger": True},
            {"id": "n1", "prompt": "play some music now", "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(code, 0)
        self.assertEqual(data["skills_root"], self.skills_root)
        self.assertEqual(data["evals_root"], self.evals_root)
        self.assertFalse(data["used_default"])

    def test_hardcoded_root_not_used_when_explicit_given(self):
        """If the tool ignored --skills-root and used a hard-coded path,
        it would report 'no skills found' or wrong skills. This test kills
        that mutation."""
        make_skill(self.skills_root, "pdf-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "pdf-skill", [
            {"id": "p1", "prompt": "extract data from this PDF", "should_trigger": True},
            {"id": "n1", "prompt": "play some music now", "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(code, 0, "explicit roots should find the skill; got: %r" % data)
        self.assertIn("pdf-skill", str(data["details"]))

    # --- Chinese positive and near-miss -----------------------------------
    def test_chinese_positive_beats_near_miss(self):
        make_skill(self.skills_root, "zh-mail-summary",
                   "从邮件中提取摘要。当用户需要总结邮件内容或生成每日邮件报告时使用此技能。")
        make_cases(self.evals_root, "zh-mail-summary", [
            {"id": "p1", "prompt": "帮我总结今天的邮件内容", "should_trigger": True},
            {"id": "p2", "prompt": "生成每日邮件摘要报告", "should_trigger": True},
            {"id": "n1", "prompt": "帮我写一封新的邮件", "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(code, 0, "Chinese positives should clear near-miss; got: %r" % data)
        self.assertEqual(data["verdict"], "PASS")

    # --- English positive and near-miss -----------------------------------
    def test_english_positive_beats_near_miss(self):
        make_skill(self.skills_root, "pdf-extractor",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "pdf-extractor", [
            {"id": "p1", "prompt": "extract data from this PDF", "should_trigger": True},
            {"id": "n1", "prompt": "play some music now", "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(code, 0)

    # --- Adjacent skill conflict (ties fail) ------------------------------
    def test_adjacent_skills_dont_misroute(self):
        make_skill(self.skills_root, "pdf-extractor",
                   "Extracts text and tables from PDF documents. Use when the user "
                   "needs to read or convert a PDF into machine-readable format.")
        make_skill(self.skills_root, "csv-extractor",
                   "Parses CSV spreadsheet files into Python dictionaries. Use when "
                   "the user needs to load or transform tabular comma-separated data.")
        make_cases(self.evals_root, "pdf-extractor", [
            {"id": "p1", "prompt": "extract text from this PDF document", "should_trigger": True},
            {"id": "n1", "prompt": "parse this CSV spreadsheet file", "should_trigger": False},
        ])
        make_cases(self.evals_root, "csv-extractor", [
            {"id": "p1", "prompt": "parse this CSV spreadsheet into dictionaries", "should_trigger": True},
            {"id": "n1", "prompt": "extract text from this PDF document", "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(code, 0, "adjacent skills should route correctly; got: %r" % data)

    # --- Malformed cases fail closed --------------------------------------
    def test_malformed_json_fails_closed(self):
        make_skill(self.skills_root, "bad-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        ed = os.path.join(self.evals_root, "bad-skill")
        os.makedirs(ed)
        with open(os.path.join(ed, "trigger-cases.json"), "w", encoding="utf-8") as fh:
            fh.write("{not valid json")
        code, data = self._json()
        self.assertEqual(code, 1, "malformed JSON should fail closed")

    def test_duplicate_case_id_fails_closed(self):
        make_skill(self.skills_root, "dup-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "dup-skill", [
            {"id": "p1", "prompt": "extract data from PDF", "should_trigger": True},
            {"id": "p1", "prompt": "duplicate id", "should_trigger": True},
        ])
        code, data = self._json()
        self.assertEqual(code, 1, "duplicate case IDs should fail closed")

    def test_unknown_case_key_fails_closed(self):
        make_skill(self.skills_root, "unk-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "unk-skill", [
            {"id": "p1", "prompt": "extract data from PDF", "should_trigger": True,
             "bogus_key": "evil"},
        ])
        code, data = self._json()
        self.assertEqual(code, 1, "unknown case keys should fail closed")

    # --- Missing expected skill fails closed ------------------------------
    def test_missing_skill_fails_closed(self):
        make_skill(self.skills_root, "orphan-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        # evals root has cases for a skill that does not exist in skills root
        make_cases(self.evals_root, "ghost-skill", [
            {"id": "p1", "prompt": "extract data from PDF", "should_trigger": True},
        ])
        code, data = self._json()
        self.assertEqual(code, 1, "missing expected skill should fail closed")

    # --- UTF-8 BOM accepted on case files ---------------------------------
    def test_bom_case_file_accepted(self):
        make_skill(self.skills_root, "bom-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        ed = os.path.join(self.evals_root, "bom-skill")
        os.makedirs(ed)
        raw = json.dumps({"cases": [
            {"id": "p1", "prompt": "extract data from PDF", "should_trigger": True},
            {"id": "n1", "prompt": "play music", "should_trigger": False},
        ]}, ensure_ascii=False).encode("utf-8")
        with open(os.path.join(ed, "trigger-cases.json"), "wb") as fh:
            fh.write(b"\xef\xbb\xbf" + raw)
        code, data = self._json()
        self.assertEqual(code, 0, "BOM on case file should be accepted")

    # --- JSON output has tool_version -------------------------------------
    def test_json_has_versions(self):
        make_skill(self.skills_root, "ver-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "ver-skill", [
            {"id": "p1", "prompt": "extract data from PDF", "should_trigger": True},
            {"id": "n1", "prompt": "play music", "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(data["tool_version"], rte.TOOL_VERSION)
        self.assertEqual(data["schema_version"], rte.SCHEMA_VERSION)

    # --- Chinese tokenization: bigrams present ----------------------------
    def test_chinese_bigram_tokens(self):
        toks = rte.tokens("帮我总结今天的邮件内容")
        # Should contain overlapping bigrams like "总结", "邮件", "内容"
        self.assertIn("总结", toks, "Chinese bigrams should be generated")
        self.assertIn("邮件", toks)
        # Full contiguous span should also be a token
        self.assertIn("帮我总结今天的邮件内容", toks)

    def test_single_chinese_char_not_dominant(self):
        """Single Han characters should not be standalone tokens."""
        toks = rte.tokens("数据")
        # "数" and "据" should not be standalone tokens, only the bigram "数据"
        self.assertNotIn("数", toks)
        self.assertNotIn("据", toks)
        self.assertIn("数据", toks)

    # === EXPECTED-RED (Task 116) ==========================================

    def test_red_single_chinese_stop_char_excluded(self):
        """Expected-red: tokens("我") must NOT contain the single-char stop word."""
        toks = rte.tokens("我")
        self.assertNotIn("我", toks,
                         "single Chinese stop char must not be a token; got: %r" % toks)

    def test_red_non_string_case_id_fails_deterministic(self):
        """Expected-red: a list-valued case id must fail closed without TypeError."""
        make_skill(self.skills_root, "badid-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "badid-skill", [
            {"id": ["not", "a", "string"], "prompt": "extract data from PDF",
             "should_trigger": True},
        ])
        code, data = self._json()
        self.assertEqual(code, 1, "non-string case id must fail closed; got: %r" % data)
        self.assertNotIn("TypeError", json.dumps(data),
                         "must not raise TypeError; got: %r" % data)

    def test_red_missing_skills_root_returns_exit1_not_traceback(self):
        """Expected-red: missing skills root must return exit 1 structured
        failure, not FileNotFoundError traceback."""
        missing = os.path.join(self.tmp, "does_not_exist")
        code, data = self._json(skills_root=missing)
        self.assertEqual(code, 1, "missing skills root must exit 1; got: %r" % data)
        self.assertNotIn("Traceback", json.dumps(data),
                         "must not produce a traceback; got: %r" % data)

    def test_red_missing_evals_root_returns_exit1_not_traceback(self):
        """Expected-red: missing evals root must return exit 1 structured
        failure, not FileNotFoundError traceback."""
        make_skill(self.skills_root, "pdf-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        make_cases(self.evals_root, "pdf-skill", [
            {"id": "p1", "prompt": "extract data from this PDF", "should_trigger": True},
            {"id": "n1", "prompt": "play some music now", "should_trigger": False},
        ])
        missing = os.path.join(self.tmp, "no_evals")
        code, data = self._json(evals_root=missing)
        self.assertEqual(code, 1, "missing evals root must exit 1; got: %r" % data)
        self.assertNotIn("Traceback", json.dumps(data),
                         "must not produce a traceback; got: %r" % data)

    def test_red_non_string_case_ids_variants(self):
        """Expected-red: object, boolean, number, null, and blank-string case
        IDs must all fail closed deterministically without stringifying into
        accepted IDs."""
        make_skill(self.skills_root, "badid2-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        for bad_id in [{}, True, 42, None, ""]:
            ed = os.path.join(self.evals_root, "badid2-skill")
            os.makedirs(ed, exist_ok=True)
            with open(os.path.join(ed, "trigger-cases.json"), "w", encoding="utf-8") as fh:
                json.dump({"cases": [
                    {"id": bad_id, "prompt": "extract data from PDF",
                     "should_trigger": True},
                ]}, fh, ensure_ascii=False)
            code, data = self._json()
            self.assertEqual(code, 1,
                             "case id %r must fail closed; got: %r" % (bad_id, data))
            self.assertNotIn("TypeError", json.dumps(data),
                             "must not raise TypeError for id %r; got: %r" % (bad_id, data))

    def test_red_nested_eval_junction_rejected(self):
        """Expected-red: a Windows junction at evals/<skill>/ must be rejected
        before reading trigger-cases.json through it."""
        if os.name != "nt":
            self.skipTest("junction tests require Windows")
        make_skill(self.skills_root, "njct-skill",
                   "Extracts structured data from PDF files. Use when the user "
                   "needs to convert a document into rows or JSON.")
        # Build a real eval directory elsewhere with a trigger-cases.json
        real_eval = os.path.join(self.tmp, "real-eval")
        os.makedirs(real_eval)
        with open(os.path.join(real_eval, "trigger-cases.json"), "w",
                  encoding="utf-8") as fh:
            json.dump({"cases": [
                {"id": "p1", "prompt": "extract data from PDF", "should_trigger": True},
            ]}, fh, ensure_ascii=False)
        # Create a junction at evals/njct-skill -> real-eval
        junction = os.path.join(self.evals_root, "njct-skill")
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", junction, real_eval],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0,
                         "mklink /J must succeed: %s" % result.stderr)
        code, data = self._json()
        self.assertEqual(code, 1,
                         "nested eval junction must be rejected; got: %r" % data)
        detail_str = json.dumps(data["details"], ensure_ascii=False)
        self.assertTrue("link" in detail_str.lower() or "junction" in detail_str.lower()
                        or "reparse" in detail_str.lower(),
                        "must report link/junction/reparse; got: %r" % data["details"])

    def test_red_non_directory_skills_root_returns_exit1(self):
        """Expected-red: a file (not directory) supplied as skills-root must
        return structured exit 1, not a traceback."""
        filepath = os.path.join(self.tmp, "not_a_dir.txt")
        with open(filepath, "w") as fh:
            fh.write("x")
        code, data = self._json(skills_root=filepath)
        self.assertEqual(code, 1, "non-directory root must exit 1; got: %r" % data)
        self.assertNotIn("Traceback", json.dumps(data),
                         "must not produce a traceback; got: %r" % data)

    # --- Strict tie rejection (expected sorts first) ----------------------
    def test_tie_rejected_expected_first(self):
        """Two low-overlap skills sharing only the prompt token; expected
        skill sorts first alphabetically.  Equal scores must fail with a
        tie/equal-score message, not exit 0."""
        make_skill(self.skills_root, "aaa-skill",
                   "shared alpha thing widgets gizmos processors")
        make_skill(self.skills_root, "zzz-skill",
                   "shared zulu thing gadgets modules converters")
        make_cases(self.evals_root, "aaa-skill", [
            {"id": "p1", "prompt": "shared", "should_trigger": True},
            {"id": "n1", "prompt": "completely unrelated gibberish nonsense",
             "should_trigger": False},
        ])
        make_cases(self.evals_root, "zzz-skill", [
            {"id": "p1", "prompt": "shared", "should_trigger": True},
            {"id": "n1", "prompt": "completely unrelated gibberish nonsense",
             "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(code, 1, "exact tie must fail")
        detail_str = json.dumps(data["details"], ensure_ascii=False)
        self.assertTrue("tie" in detail_str.lower() or "equal score" in detail_str.lower(),
                        "tie detail must say tie/equal score; got: %r" % data["details"])

    # --- Strict tie rejection (expected sorts last) -----------------------
    def test_tie_rejected_expected_last(self):
        """Same tie but expected skill sorts last alphabetically.  The tie
        message must name the expected skill and tied competitor, not just
        say 'routes to X instead'."""
        make_skill(self.skills_root, "aaa-skill",
                   "shared alpha thing widgets gizmos processors")
        make_skill(self.skills_root, "zzz-skill",
                   "shared zulu thing gadgets modules converters")
        # Only test zzz-skill (sorts last); max() would pick aaa-skill.
        make_cases(self.evals_root, "zzz-skill", [
            {"id": "p1", "prompt": "shared", "should_trigger": True},
            {"id": "n1", "prompt": "completely unrelated gibberish nonsense",
             "should_trigger": False},
        ])
        code, data = self._json()
        self.assertEqual(code, 1, "exact tie must fail even when expected sorts last")
        detail_str = json.dumps(data["details"], ensure_ascii=False)
        self.assertTrue("tie" in detail_str.lower() or "equal score" in detail_str.lower(),
                        "tie detail must say tie/equal score; got: %r" % data["details"])
        self.assertIn("zzz-skill", detail_str,
                      "tie message must name the expected skill")


def run_all():
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(TestTriggerEvals)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_all())
