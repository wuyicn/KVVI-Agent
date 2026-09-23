#!/usr/bin/env python3
"""Black-box conformance tests for both reference implementations."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
VECTORS_PATH = ROOT / "vectors.json"
PYTHON_IMPL = ROOT / "python" / "kvvi_json_c14n.py"
NODE_IMPL = ROOT / "node" / "kvvi-json-c14n.mjs"


class ConformanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
        cls.node = shutil.which("node")
        if cls.node is None:
            raise AssertionError("Node.js is required for the two-language conformance gate")

    def invoke(self, command: list[str], vector: dict[str, str]) -> tuple[int, dict[str, str]]:
        profile = vector.get("profile", self.vectors["profile"])
        completed = subprocess.run(
            [*command, "--profile", profile],
            input=vector["input"].encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(
            completed.stderr,
            b"",
            completed.stderr.decode("utf-8", errors="replace"),
        )
        try:
            payload = json.loads(completed.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self.fail(f"implementation did not emit one UTF-8 JSON result: {exc}")
        return completed.returncode, payload

    def assert_positive_vectors(self, command: list[str]) -> None:
        for vector in self.vectors["positive"]:
            with self.subTest(vector=vector["id"]):
                returncode, payload = self.invoke(command, vector)
                self.assertEqual(returncode, 0)
                self.assertEqual(payload.get("status"), "ok")
                self.assertEqual(payload.get("profile"), self.vectors["profile"])
                self.assertEqual(payload.get("canonical"), vector["canonical"])
                self.assertEqual(
                    payload.get("canonical_utf8_hex"),
                    vector["canonical_utf8_hex"],
                )
                self.assertEqual(payload.get("digest"), f"sha256:{vector['sha256']}")

    def assert_negative_vectors(self, command: list[str]) -> None:
        for vector in self.vectors["negative"]:
            with self.subTest(vector=vector["id"]):
                returncode, payload = self.invoke(command, vector)
                self.assertEqual(returncode, 2)
                self.assertEqual(payload, {
                    "status": "error",
                    "error_code": vector["error_code"],
                })

    def test_vector_manifest_covers_the_go_0_minimum(self) -> None:
        self.assertEqual([v["id"] for v in self.vectors["positive"]], [
            "C1", "C2", "C3", "C4", "C5", "C6", "C7",
        ])
        self.assertEqual([v["id"] for v in self.vectors["negative"]], [
            "N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10",
        ])

    def test_python_positive_vectors(self) -> None:
        self.assert_positive_vectors([sys.executable, str(PYTHON_IMPL)])

    def test_python_negative_vectors(self) -> None:
        self.assert_negative_vectors([sys.executable, str(PYTHON_IMPL)])

    def test_node_positive_vectors(self) -> None:
        self.assert_positive_vectors([self.node, str(NODE_IMPL)])

    def test_node_negative_vectors(self) -> None:
        self.assert_negative_vectors([self.node, str(NODE_IMPL)])

    def test_python_and_node_emit_identical_results(self) -> None:
        for vector in [*self.vectors["positive"], *self.vectors["negative"]]:
            with self.subTest(vector=vector["id"]):
                python_result = self.invoke([sys.executable, str(PYTHON_IMPL)], vector)
                node_result = self.invoke([self.node, str(NODE_IMPL)], vector)
                self.assertEqual(python_result, node_result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
