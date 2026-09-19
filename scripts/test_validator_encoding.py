"""Every validator names UTF-8 for the text it reads, writes and decodes."""

from __future__ import annotations

import ast
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).resolve().parent


def names_utf8(call: ast.Call) -> bool:
    """Whether the call passes `encoding="utf-8"`."""
    return any(
        keyword.arg == "encoding"
        and isinstance(keyword.value, ast.Constant)
        and keyword.value.value == "utf-8"
        for keyword in call.keywords
    )


def binary_open(call: ast.Call) -> bool:
    """Whether an `open` call's mode is binary: `open(file, mode)` or `path.open(mode)`."""
    position = 0 if isinstance(call.func, ast.Attribute) else 1
    modes = [keyword.value for keyword in call.keywords if keyword.arg == "mode"]
    if len(call.args) > position:
        modes.append(call.args[position])
    return any(isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "b" in mode.value for mode in modes)


def not_utf8(source: str) -> list[int]:
    """The lines of text reads, writes and subprocess decodes that do not name UTF-8.

    Where no encoding is named, Python uses the locale's, which on a Windows
    host is a codepage such as cp1252 rather than UTF-8: a document's non-ASCII
    text then reads as other characters, or fails to decode.
    """
    lines = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call) or names_utf8(node):
            continue
        function = node.func
        name = function.attr if isinstance(function, ast.Attribute) else getattr(function, "id", None)
        keywords = {keyword.arg for keyword in node.keywords}
        if name in ("read_text", "write_text"):
            lines.append(node.lineno)
        elif name == "open" and not binary_open(node):
            lines.append(node.lineno)
        elif name in ("run", "check_output", "Popen") and keywords & {"text", "universal_newlines"}:
            lines.append(node.lineno)
    return lines


class ValidatorEncoding(unittest.TestCase):
    def test_every_validator_names_utf8(self) -> None:
        validators = sorted(SCRIPTS.glob("validate_*.py"))
        self.assertGreater(len(validators), 0)
        unnamed = {path.name: lines for path in validators if (lines := not_utf8(path.read_text(encoding="utf-8")))}
        self.assertEqual(unnamed, {})

    def test_a_read_write_or_decode_without_utf8_is_found(self) -> None:
        source = "\n".join(
            [
                "import subprocess",
                "from pathlib import Path",
                "Path('a').read_text()",
                "Path('a').write_text('x')",
                "open('a')",
                "open('a', 'rb')",
                "subprocess.run(['git'], text=True)",
                "subprocess.run(['git'], capture_output=True)",
                "Path('a').read_text(encoding='utf-8')",
                "Path('a').read_text(encoding='latin-1')",
                "open('backlog.json')",
                "Path('a').open('rb')",
                "open('a', encoding='utf-8')",
            ]
        )
        self.assertEqual(not_utf8(source), [3, 4, 5, 7, 10, 11])


if __name__ == "__main__":
    unittest.main()
