"""The fixture validator reads the same diff whatever Git is set to do."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


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
        # hunks the algorithm finds, the context around them, the hash length.
        with tempfile.TemporaryDirectory() as home:
            config = Path(home) / "gitconfig"
            config.write_text(
                "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\talgorithm = histogram\n\tcontext = 5\n"
                "[core]\n\tabbrev = 12\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, "validate_fixture_diffs.py"],
                cwd=SCRIPTS,
                env={**os.environ, "GIT_CONFIG_GLOBAL": str(config)},
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=300,
            )
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-2000:])


if __name__ == "__main__":
    unittest.main()
