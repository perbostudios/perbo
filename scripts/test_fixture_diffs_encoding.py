"""The fixture validator reads Git's output as UTF-8 whatever the host's locale."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parent
# The authored fixture whose diff carries Cyrillic text.
FIXTURE = SCRIPTS.parent / "packages/evaluation/corpus/fixtures/scp-009-dependency-added-to-the-root-manifest"

# Run in a child interpreter so the host is a Windows one: UTF-8 mode off, which
# a host with no locale set turns on by itself, and the locale's encoding the
# codepage a Windows host defaults to. Both spellings of "the locale's encoding"
# are replaced, because which one `subprocess` asks depends on the version.
CHILD = """
import locale, sys
locale.getencoding = lambda: "cp1252"
locale.getpreferredencoding = lambda do_setlocale=True: "cp1252"
from pathlib import Path
from validate_fixture_diffs import generate
fixture = Path(sys.argv[1])
generated = generate(fixture)
sys.exit(0 if generated == (fixture / "change.diff").read_text(encoding="utf-8") else 3)
"""


class GitOutputEncoding(unittest.TestCase):
    def test_a_fixture_with_cyrillic_text_matches_under_a_cp1252_locale(self) -> None:
        committed = (FIXTURE / "change.diff").read_text(encoding="utf-8")
        # The case only means something while the fixture carries non-ASCII text.
        self.assertTrue(any(ord(character) > 127 for character in committed))
        # Decoded as cp1252, each Cyrillic letter's two UTF-8 bytes become two
        # other characters, so the diff generated differs from the one
        # committed. A letter whose bytes cp1252 does not define would instead
        # fail to decode; either way the child exits non-zero.
        result = subprocess.run(
            [sys.executable, "-X", "utf8=0", "-c", CHILD, str(FIXTURE)],
            cwd=SCRIPTS,
            env=os.environ,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
