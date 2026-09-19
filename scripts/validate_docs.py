#!/usr/bin/env python3
"""Validate canonical documentation, ADR numbering, links, and diagram renderings."""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

from repository_rules import (
    PLACEHOLDER_LABEL,
    decision_register_errors,
    repository_action_pin_errors,
)

ROOT = Path(__file__).resolve().parents[1]

_parser = argparse.ArgumentParser(description=__doc__)
_parser.add_argument(
    "--strict",
    action="store_true",
    help="also reject placeholder decision headings and ADR files, which scripts/assign_ids.py numbers at merge",
)
_arguments = _parser.parse_args()
DOCS = ROOT / "docs"
ERRORS: list[str] = []


def error(message: str) -> None:
    ERRORS.append(message)


def report_and_exit(summary: str) -> None:
    if ERRORS:
        print("Documentation validation failed:")
        for message in ERRORS:
            print(f"- {message}")
        sys.exit(1)
    print(summary)
    sys.exit(0)


# The canonical docs are the numbered top-level Markdown files, one per prefix.
canonical = sorted(DOCS.glob("[0-9][0-9]-*.md"))
by_prefix: dict[str, list[str]] = {}
for path in canonical:
    by_prefix.setdefault(path.name[:2], []).append(path.name)
for prefix, names in sorted(by_prefix.items()):
    if len(names) > 1:
        error(f"Duplicate canonical document prefix {prefix}: {', '.join(names)}")

# Decision identifiers are stable cross-document references and must be unique.
for message in decision_register_errors(
    DOCS / "11-open-decisions.md", "docs/11-open-decisions.md", strict=_arguments.strict
):
    error(message)

# External Actions are executable dependencies. Follow local Actions recursively;
# tags move, while full commit SHAs do not.
for message in repository_action_pin_errors(
    ROOT, sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
):
    error(message)

# ADR prefixes and headings must be unique and agree.
adr_files = sorted((DOCS / "adr").glob("[0-9][0-9][0-9][0-9]-*.md"))
seen_prefixes: set[str] = set()
seen_heading_numbers: set[str] = set()
for path in adr_files:
    prefix = path.name[:4]
    if prefix in seen_prefixes:
        error(f"Duplicate ADR file prefix {prefix}")
    seen_prefixes.add(prefix)
    first_heading = next((line for line in path.read_text(encoding="utf-8").splitlines() if line.startswith("# ")), "")
    match = re.match(r"# ADR-(\d{4}):\s+.+", first_heading)
    if not match:
        error(f"Invalid ADR heading in {path.relative_to(ROOT)}: {first_heading!r}")
        continue
    heading_number = match.group(1)
    if heading_number != prefix:
        error(f"ADR filename/heading mismatch in {path.relative_to(ROOT)}: {prefix} vs {heading_number}")
    if heading_number in seen_heading_numbers:
        error(f"Duplicate ADR heading number {heading_number}")
    seen_heading_numbers.add(heading_number)

# A new ADR is docs/adr/NEW-<label>.md, headed with its own label, until
# scripts/assign_ids.py numbers it at merge.
adr_placeholders = sorted((DOCS / "adr").glob("NEW-*.md"))
seen_labels: set[str] = set()
for path in adr_placeholders:
    rel = path.relative_to(ROOT)
    label = path.name[len("NEW-"):-len(".md")]
    if re.fullmatch(PLACEHOLDER_LABEL, label) is None:
        error(
            f"Invalid ADR placeholder filename {rel}: "
            "the label is lowercase letters and digits in hyphen-separated runs"
        )
        continue
    if _arguments.strict:
        error(f"ADR placeholder {rel} is not numbered; scripts/assign_ids.py --apply numbers it at merge")
    first_heading = next((line for line in path.read_text(encoding="utf-8").splitlines() if line.startswith("# ")), "")
    match = re.match(rf"# ADR-NEW-({PLACEHOLDER_LABEL}):\s+.+", first_heading)
    if not match:
        error(f"Invalid ADR placeholder heading in {rel}: {first_heading!r}")
        continue
    heading_label = match.group(1)
    if heading_label != label:
        error(f"ADR placeholder filename/heading mismatch in {rel}: {label} vs {heading_label}")
    if heading_label in seen_labels:
        error(f"Duplicate ADR placeholder label {heading_label}")
    seen_labels.add(heading_label)

# Check local Markdown links. Ignore URLs, anchors, mailto, and template placeholders.
link_pattern = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)|!\[[^\]]*\]\(([^)]+)\)")
markdown_files = [
    ROOT / "README.md",
    ROOT / "AGENTS.md",
    *ROOT.glob("docs/**/*.md"),
    # Package and app READMEs cross-link into docs/. Corpus fixture trees are
    # excluded: they are sample repositories, and their contents are the thing
    # under review.
    *(
        path
        for pattern in ("packages/**/*.md", "apps/**/*.md", "tooling/**/*.md")
        for path in ROOT.glob(pattern)
        if "node_modules" not in path.parts
        and "fixtures" not in path.parts
        # Pinned upstream skills contain illustrative links into an imaginary
        # consuming repository. Their bytes are checked by tooling/skills/build.mjs;
        # they are not canonical documentation links in this repository.
        and not path.is_relative_to(ROOT / "tooling" / "skills" / "mattpocock")
    ),
]
for path in markdown_files:
    text = path.read_text(encoding="utf-8")
    for match in link_pattern.finditer(text):
        raw = (match.group(1) or match.group(2) or "").strip()
        target = raw.split(maxsplit=1)[0].strip("<>")
        if not target or target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        target = target.split("#", 1)[0]
        if not target or "<" in target or ">" in target:
            continue
        resolved = (path.parent / target).resolve()
        try:
            resolved.relative_to(ROOT.resolve())
        except ValueError:
            error(f"Link escapes repository in {path.relative_to(ROOT)}: {raw}")
            continue
        if not resolved.exists():
            error(f"Broken local link in {path.relative_to(ROOT)}: {raw}")

# Every Graphviz source requires current user-consumable renderings.
for source in sorted((ROOT / "diagrams").glob("*.dot")):
    for extension in (".svg", ".png"):
        rendered = source.with_suffix(extension)
        if not rendered.exists():
            error(f"Missing diagram rendering: {rendered.relative_to(ROOT)}")
        elif rendered.stat().st_size == 0:
            error(f"Empty diagram rendering: {rendered.relative_to(ROOT)}")

# docs/README.md must link every canonical document and diagram, matched by filename.
docs_index = DOCS / "README.md"
if not docs_index.exists():
    error("Missing docs/README.md")
else:
    index_text = docs_index.read_text(encoding="utf-8")
    for path in canonical:
        if path.name not in index_text:
            error(f"docs/README.md does not reference canonical document {path.name}")
    for source in sorted((ROOT / "diagrams").glob("*.dot")):
        svg = source.with_suffix(".svg").name
        if svg not in index_text:
            error(f"docs/README.md does not reference diagram {svg}")

# Lifecycle state names must agree between the specification and the diagram.
lifecycle_doc = DOCS / "04-ticket-workspace-and-review.md"
lifecycle_dot = ROOT / "diagrams" / "ticket-lifecycle.dot"
if lifecycle_doc.exists() and lifecycle_dot.exists():
    doc_text = lifecycle_doc.read_text(encoding="utf-8")
    section = re.search(
        r"^## Ticket lifecycle\n(.*?)^## ", doc_text, re.MULTILINE | re.DOTALL
    )
    if not section:
        error("docs/04-ticket-workspace-and-review.md has no '## Ticket lifecycle' section")
    else:
        body = section.group(1)
        doc_states = set()
        # Primary and optional-continuation flows live in fenced blocks.
        for block in re.findall(r"```text\n(.*?)```", body, re.DOTALL):
            doc_states.update(re.findall(r"\b([A-Z][A-Z_]{2,})\b", block))
        # Side states are backticked bullets.
        doc_states.update(re.findall(r"^- `([A-Z][A-Z_]{2,})`", body, re.MULTILINE))

        dot_states = set()
        for label in re.findall(r'label="([^"]+)"', lifecycle_dot.read_text(encoding="utf-8")):
            # Only the first line of a node label carries the state name.
            dot_states.update(re.findall(r"\b([A-Z][A-Z_]{2,})\b", label.split("\\n")[0]))

        for missing in sorted(doc_states - dot_states):
            error(f"Lifecycle state {missing} is in docs/04 but not in diagrams/ticket-lifecycle.dot")
        for missing in sorted(dot_states - doc_states):
            error(f"Lifecycle state {missing} is in diagrams/ticket-lifecycle.dot but not in docs/04")

# No relationship may be expressed both as a foreign key and as an entity edge.
domain_doc = DOCS / "03-domain-and-event-model.md"
if domain_doc.exists():
    domain_text = domain_doc.read_text(encoding="utf-8")
    # Foreign keys are written as `child.parent_id`; the implied relationship is parent -> child.
    fk_pairs = {
        (parent, child)
        for child, parent in re.findall(r"`([a-z_]+)\.([a-z_]+)_id`", domain_text)
    }
    # Edges are written as `source --RELATION--> target`.
    edge_pairs = {
        (source, target)
        for source, _relation, target in re.findall(
            r"^([a-z_]+) --([A-Z_]+)--> ([a-z_]+)$", domain_text, re.MULTILINE
        )
    }
    for pair in sorted(fk_pairs & edge_pairs):
        error(
            f"Relationship {pair[0]} -> {pair[1]} is expressed as both a foreign key "
            "and an entity edge in docs/03-domain-and-event-model.md"
        )

# A Markdown file that still carries a merge's conflict markers. Nothing else
# sees them: Markdown is past the typechecker and the linter, and no test reads
# a canonical document, so a whole gate comes back green over a file that says
# both things and neither.
#
# Keyed on the two markers no Markdown has a use for. `=======` is left out
# because it is also a heading's underline, and a rule that counted markers
# instead would fail a document with three such headings.
SKIP = {"node_modules", "dist", ".git", "build", "coverage"}
for path in sorted(ROOT.rglob("*.md")):
    if SKIP.intersection(path.relative_to(ROOT).parts):
        continue
    found = [
        at + 1
        for at, line in enumerate(path.read_text(encoding="utf-8").splitlines())
        if line.startswith("<<<<<<< ") or line.startswith(">>>>>>> ")
    ]
    if found:
        error(
            f"{path.relative_to(ROOT)} carries conflict markers at "
            f"{', '.join(str(at) for at in found[:6])}: resolve the merge before committing it"
        )

# Component template is mandatory.
template = DOCS / "templates" / "component-technical-specification.md"
if not template.exists():
    error("Missing component technical specification template")

report_and_exit(
    f"Documentation valid: {len(canonical)} canonical docs, "
    f"{len(adr_files)} ADRs and {len(adr_placeholders)} ADR placeholders, "
    f"{len(list((ROOT / 'diagrams').glob('*.dot')))} diagrams, "
    "lifecycle, edge, decision and workflow-pin checks passed"
)
