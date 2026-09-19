"""The fixture validator reads the same diff whatever Git is set to do."""

from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent
FIXTURES = SCRIPTS.parent / "packages/evaluation/corpus/fixtures"

sys.path.insert(0, str(SCRIPTS))
from validate_fixture_diffs import generate  # noqa: E402


class Abbreviation(unittest.TestCase):
    def test_every_authored_fixture_matches_whatever_length_git_abbreviates_to(self) -> None:
        # Twelve stands for any length but the committed seven, and `auto` for
        # the length Git picks from the size of the repository it runs in.
        for length in ("12", "auto"):
            with self.subTest(core_abbrev=length):
                result = subprocess.run(
                    [sys.executable, "validate_fixture_diffs.py"],
                    cwd=SCRIPTS,
                    env={
                        **os.environ,
                        "GIT_CONFIG_COUNT": "1",
                        "GIT_CONFIG_KEY_0": "core.abbrev",
                        "GIT_CONFIG_VALUE_0": length,
                    },
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=300,
                )
                self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-2000:])

    def test_every_authored_fixture_matches_under_a_persons_own_git_settings(self) -> None:
        # Each of these changes a generated diff on its own: the prefixes, the
        # hunks the algorithm finds, the context around them and between them,
        # the heuristic that places a hunk, the hash length.
        # Laid over the person's own configuration, not in its place, which would
        # drop a core.autocrlf their checkout depends on.
        settings = {
            "diff.noprefix": "true", "diff.mnemonicPrefix": "true", "diff.algorithm": "histogram",
            "diff.context": "5", "diff.interHunkContext": "10", "diff.indentHeuristic": "false",
            "diff.external": "false-external-diff", "core.abbrev": "12",
        }
        env = {**os.environ, "GIT_CONFIG_COUNT": str(len(settings))}
        for index, (key, value) in enumerate(settings.items()):
            env[f"GIT_CONFIG_KEY_{index}"] = key
            env[f"GIT_CONFIG_VALUE_{index}"] = value
        result = subprocess.run(
            [sys.executable, "validate_fixture_diffs.py"],
            cwd=SCRIPTS,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=300,
        )
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-2000:])


    def test_a_windows_checkout_matches_where_git_turns_its_line_endings_back(self) -> None:
        # Git for Windows sets core.autocrlf in its system configuration, and a
        # checkout's text files then end their lines in CRLF on disk.
        fixture = next(
            directory
            for directory in sorted(FIXTURES.iterdir())
            if (directory / "change.diff").is_file()
            and b"\r" not in (directory / "change.diff").read_bytes().replace(b"\r\n", b"\n")
        )
        with tempfile.TemporaryDirectory() as home:
            copy = Path(home) / fixture.name
            shutil.copytree(fixture, copy)
            for path in [*(copy / "before").rglob("*"), *(copy / "after").rglob("*")]:
                if path.is_file():
                    path.write_bytes(re.sub(rb"(?<!\r)\n", b"\r\n", path.read_bytes()))
            system = Path(home) / "gitconfig"
            system.write_text("[core]\n\tautocrlf = true\n", encoding="utf-8")
            # Only that system file: a person's own global setting would otherwise win.
            with mock.patch.dict(os.environ, {"GIT_CONFIG_SYSTEM": str(system), "GIT_CONFIG_GLOBAL": os.devnull}):
                os.environ.pop("GIT_CONFIG_NOSYSTEM", None)
                generated = generate(copy)
        self.assertEqual(generated, (fixture / "change.diff").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
