#!/usr/bin/env python3
"""Independent expected-red tests for the real synthetic RAG validator."""

from __future__ import annotations

import ast
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
TOOL_DIR = PROJECT_ROOT / "tools" / "awesome-llm-apps" / "rag-failure-taxonomy"
PATTERNS = TOOL_DIR / "patterns.json"
FIXTURES = TOOL_DIR / "fixtures.json"
VALIDATOR = TOOL_DIR / "validate_rag_taxonomy.py"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_validator(patterns: Path, fixtures: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(VALIDATOR), "--patterns", str(patterns), "--fixtures", str(fixtures), "--json"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


class RagTaxonomyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.patterns_data = json.loads(PATTERNS.read_text(encoding="utf-8"))
        self.fixtures_data = json.loads(FIXTURES.read_text(encoding="utf-8"))

    def write_bundle(self, root: Path, patterns: object | None = None, fixtures: object | None = None) -> tuple[Path, Path]:
        pattern_path = root / "patterns.json"
        fixture_path = root / "fixtures.json"
        pattern_path.write_text(json.dumps(self.patterns_data if patterns is None else patterns, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        fixture_path.write_text(json.dumps(self.fixtures_data if fixtures is None else fixtures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return pattern_path, fixture_path

    def assert_invalid(self, patterns: object | None = None, fixtures: object | None = None, expected_code: str | None = None) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pattern_path, fixture_path = self.write_bundle(Path(directory), patterns, fixtures)
            result = run_validator(pattern_path, fixture_path)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            payload = json.loads(result.stdout)
            self.assertFalse(payload["ok"])
            if expected_code is not None:
                self.assertIn(expected_code, {error["code"] for error in payload["errors"]})

    def test_positive_all_patterns_and_fixtures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pattern_path, fixture_path = self.write_bundle(Path(directory))
            result = run_validator(pattern_path, fixture_path)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload, {"errors": [], "fixtureCount": 12, "ok": True, "patternCount": 12, "schemaVersion": "xj.rag.failure-fixtures.v1"})

    def test_utf8_and_deterministic_output(self) -> None:
        self.assertTrue(any("合成" in item["symptom"] for item in self.fixtures_data["fixtures"]))
        with tempfile.TemporaryDirectory() as directory:
            pattern_path, fixture_path = self.write_bundle(Path(directory))
            first = run_validator(pattern_path, fixture_path)
            second = run_validator(pattern_path, fixture_path)
            self.assertEqual(first.stdout, second.stdout)

    def test_input_immutability_and_no_validator_side_effects(self) -> None:
        before = {path: digest(path) for path in (PATTERNS, FIXTURES)}
        before_files = {path.relative_to(TOOL_DIR) for path in TOOL_DIR.rglob("*") if path.is_file()}
        result = run_validator(PATTERNS, FIXTURES)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(before, {path: digest(path) for path in (PATTERNS, FIXTURES)})
        after_files = {path.relative_to(TOOL_DIR) for path in TOOL_DIR.rglob("*") if path.is_file()}
        self.assertEqual(before_files, after_files)

    def test_expected_red_id_and_reference_mutations(self) -> None:
        missing = copy.deepcopy(self.patterns_data)
        missing["patterns"].pop()
        self.assert_invalid(missing, expected_code="pattern_ids")

        extra = copy.deepcopy(self.patterns_data)
        extra["patterns"].append(copy.deepcopy(extra["patterns"][0]) | {"id": "P99"})
        self.assert_invalid(extra, expected_code="pattern_ids")

        duplicate = copy.deepcopy(self.fixtures_data)
        duplicate["fixtures"][1]["id"] = duplicate["fixtures"][0]["id"]
        self.assert_invalid(fixtures=duplicate, expected_code="duplicate_id")

        wrong_reference = copy.deepcopy(self.fixtures_data)
        wrong_reference["fixtures"][0]["patternId"] = "P99"
        self.assert_invalid(fixtures=wrong_reference, expected_code="unknown_reference")

    def test_expected_red_schema_markers_and_content(self) -> None:
        unknown_schema = copy.deepcopy(self.patterns_data)
        unknown_schema["schemaVersion"] = "xj.unknown.v9"
        self.assert_invalid(unknown_schema, expected_code="unknown_schema")

        missing_marker = copy.deepcopy(self.fixtures_data)
        missing_marker.pop("syntheticOnly")
        self.assert_invalid(fixtures=missing_marker, expected_code="missing_fields")

        url_content = copy.deepcopy(self.patterns_data)
        url_content["patterns"][0]["summary"] = "see https://example.invalid"
        self.assert_invalid(url_content, expected_code="unsafe_content")

        secret_content = copy.deepcopy(self.fixtures_data)
        secret_content["fixtures"][0]["symptom"] = "api_key=sk_test_1234567890"
        self.assert_invalid(fixtures=secret_content, expected_code="unsafe_content")

        p08 = copy.deepcopy(self.fixtures_data)
        p08["fixtures"][7].pop("incomingSessionId")
        self.assert_invalid(fixtures=p08, expected_code="missing_fields")

    def test_expected_red_malformed_json_and_p08_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pattern_path, fixture_path = self.write_bundle(root)
            pattern_path.write_text("{", encoding="utf-8")
            result = run_validator(pattern_path, fixture_path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid_json", {error["code"] for error in json.loads(result.stdout)["errors"]})

        p08 = copy.deepcopy(self.fixtures_data)
        p08["fixtures"][7]["incomingClientId"] = p08["fixtures"][7]["originClientId"]
        self.assert_invalid(fixtures=p08, expected_code="p08_context")

    def test_validator_source_rejects_write_and_network_mutations(self) -> None:
        original = VALIDATOR.read_text(encoding="utf-8")

        def policy_ok(source: str) -> bool:
            try:
                tree = ast.parse(source)
            except SyntaxError:
                return False
            banned_modules = {"urllib", "requests", "httpx", "socket", "subprocess"}
            banned_calls = {"write_text", "write_bytes", "unlink", "rename", "replace", "urlopen", "connect"}
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    if any(alias.name.split(".")[0] in banned_modules for alias in node.names):
                        return False
                if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] in banned_modules:
                    return False
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in banned_calls:
                    return False
            return True

        self.assertTrue(policy_ok(original))
        self.assertFalse(policy_ok(original.replace("import re", "import re\nimport urllib.request", 1)))
        self.assertFalse(policy_ok(original.replace("return 0 if not errors else 1", "Path('escape-marker').write_text('x')\n    return 0 if not errors else 1", 1)))

    def test_required_files_and_no_upstream_runtime_copy(self) -> None:
        required = {
            Path("patterns.json"),
            Path("fixtures.json"),
            Path("README.md"),
            Path("validate_rag_taxonomy.py"),
            Path("UPSTREAM.md"),
        }
        files = {path.relative_to(TOOL_DIR) for path in TOOL_DIR.rglob("*") if path.is_file()}
        self.assertTrue(required.issubset(files))
        self.assertTrue(Path(__file__).resolve().exists())
        self.assertNotIn(Path("LICENSE"), files)
        self.assertNotIn(Path("rag_failure_diagnostics_clinic.py"), files)


if __name__ == "__main__":
    unittest.main(verbosity=2)
