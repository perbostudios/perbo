#!/usr/bin/env python3
"""Check that every rendered diagram still reflects its Graphviz source.

Compares label *text*, not bytes: Graphviz versions differ in layout coordinates
but not in the strings they emit, so a byte diff would fail for the wrong reason.
"""
from __future__ import annotations

from pathlib import Path
import html
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
DIAGRAMS = ROOT / "diagrams"
errors: list[str] = []

for source in sorted(DIAGRAMS.glob("*.dot")):
    svg_path = source.with_suffix(".svg")
    png_path = source.with_suffix(".png")

    for rendered in (svg_path, png_path):
        if not rendered.exists() or rendered.stat().st_size == 0:
            errors.append(f"Missing or empty rendering: {rendered.relative_to(ROOT)}")

    if not svg_path.exists() or svg_path.stat().st_size == 0:
        continue

    svg_text = html.unescape(svg_path.read_text(encoding="utf-8"))
    # Graphviz splits a label across one <text> element per line.
    rendered_text = " ".join(re.findall(r"<text[^>]*>(.*?)</text>", svg_text, re.DOTALL))

    for label in re.findall(r'label="((?:[^"\\]|\\.)*)"', source.read_text(encoding="utf-8")):
        for line in label.split("\\n"):
            line = line.strip()
            # Skip empty and punctuation-only fragments; they are not emitted verbatim.
            if len(line) < 3 or not any(character.isalnum() for character in line):
                continue
            if line not in rendered_text:
                errors.append(
                    f"{svg_path.relative_to(ROOT)} is stale: "
                    f"label text {line!r} from {source.name} is not in the rendering"
                )

if errors:
    print("Diagram validation failed:")
    for message in errors:
        print(f"- {message}")
    print("\nRegenerate with: for f in diagrams/*.dot; do dot -Tsvg \"$f\" -o \"${f%.dot}.svg\"; done")
    sys.exit(1)

print(f"Diagrams valid: {len(list(DIAGRAMS.glob('*.dot')))} sources match their renderings")
