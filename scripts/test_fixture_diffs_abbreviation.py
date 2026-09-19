"""The fixture validator reads the same diff however Git is set to abbreviate hashes."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
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


if __name__ == "__main__":
    unittest.main()
