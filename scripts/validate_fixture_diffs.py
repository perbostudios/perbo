#!/usr/bin/env python3
"""Every authored fixture's change.diff must be exactly what its trees produce.

A fixture shows the reviewer `change.diff` and, when it is run, executes
`after/`. If the two disagree the fixture is measuring something nobody wrote:
the reviewer reads one change and the checks report on another, and nothing in
the corpus would say so.

Pinned fixtures have no trees here — their diff is produced from the clone at
review time — so they are skipped, which is checked rather than assumed.

    python3 scripts/validate_fixture_diffs.py            # verify
    python3 scripts/validate_fixture_diffs.py --write    # regenerate
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "packages/evaluation/corpus/fixtures"
PREFIX = re.compile(r"([ab])/(?:before|after)/")


def generate(fixture: Path) -> str:
    """`git diff --no-index` over the two trees, with the authoring prefixes removed."""
    result = subprocess.run(
        ["git", "diff", "--no-index", "--no-color", "before", "after"],
        cwd=fixture,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    # git diff exits 1 when there are differences, which is the normal case here.
    if result.returncode not in (0, 1):
        raise SystemExit(f"{fixture.name}: git diff failed: {result.stderr.strip()}")
    return PREFIX.sub(r"\1/", result.stdout)


def main() -> int:
    write = "--write" in sys.argv
    checked = 0
    skipped = 0
    wrong: list[str] = []

    for directory in sorted(FIXTURES.iterdir()):
        if not directory.is_dir():
            continue
        meta = json.loads((directory / "fixture.json").read_text(encoding="utf-8"))
        if meta.get("pinned_repository"):
            for absent in ("before", "after", "change.diff"):
                if (directory / absent).exists():
                    wrong.append(f"{directory.name}: pinned, but carries {absent}")
            skipped += 1
            continue

        expected = generate(directory)
        path = directory / "change.diff"
        if write:
            path.write_text(expected, encoding="utf-8")
        elif path.read_text(encoding="utf-8") != expected:
            wrong.append(f"{directory.name}: change.diff does not match its before/ and after/ trees")
        checked += 1

    if wrong:
        for line in wrong:
            print(f"  {line}")
        print(f"{len(wrong)} fixture(s) disagree with their trees")
        return 1
    print(f"Fixture diffs valid: {checked} authored fixtures match their trees, {skipped} pinned skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
