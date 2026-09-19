#!/usr/bin/env python3
"""Number the placeholder ids a pull request carries. Whoever merges it runs this.

A branch names a new decision `D-NEW-<label>` (a heading in
docs/11-open-decisions.md) and a new ADR `docs/adr/NEW-<label>.md` (headed
`# ADR-NEW-<label>: Title`), where a label is lowercase letters and digits in
hyphen-separated runs. A backlog entry is numbered where the backlog lives, not
here: a numbered `SCP-` id is ordinary text to this script, and an
`SCP-NEW-<label>` is a placeholder that nothing here declares.

    git fetch origin
    python3 scripts/assign_ids.py            # print the mapping; write nothing
    python3 scripts/assign_ids.py --apply    # write it, then run the validators strictly

Each kind continues from the highest number it has ever held: on the base ref
(default origin/main), in the working tree, or anywhere in the history of the
base ref and HEAD. A number a deleted decision or ADR once held is never
reused. A shallow clone is refused, because its history is incomplete.
Placeholders are numbered in order of first appearance: decisions down the
register and ADRs down the ADR index (docs/adr/README.md), then by filename for
any the index does not mention.

--apply rewrites every occurrence in tracked text files, including decision
heading anchors (`#d-new-<label>--` becomes `#d-nnn--`) and ADR filenames in
links and paths (`NEW-<label>.md` becomes `nnnn-<label>.md`), renames each ADR
file with `git mv`, then runs validate_docs.py --strict and validate_diagrams.py,
and exits non-zero if either fails. A placeholder id or anchor that a tracked
file mentions and nothing declares stops the run before anything is written.
"""
from __future__ import annotations

import argparse
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys

from repository_rules import DECISION_HEADING, PLACEHOLDER_LABEL

ROOT = Path(__file__).resolve().parents[1]
REGISTER = "docs/11-open-decisions.md"
ADR_DIRECTORY = "docs/adr"
ADR_INDEX = "docs/adr/README.md"
VALIDATORS = (
    ("validate_docs.py", "--strict"),
    ("validate_diagrams.py",),
)

_BEFORE = r"(?<![A-Za-z0-9_-])"
_AFTER = r"(?![A-Za-z0-9_-])"
# Every form a placeholder takes in a tracked file: the id, a decision heading's
# anchor, and an ADR's filename. A backlog placeholder matches too, only so that
# a mention of one is refused.
PLACEHOLDER = re.compile(
    rf"{_BEFORE}(?P<kind>D|ADR)-NEW-(?P<label>{PLACEHOLDER_LABEL}){_AFTER}"
    rf"|#d-new-(?P<anchor>{PLACEHOLDER_LABEL})--"
    rf"|{_BEFORE}NEW-(?P<file>{PLACEHOLDER_LABEL})\.md{_AFTER}"
    rf"|{_BEFORE}(?P<backlog>SCP-NEW-{PLACEHOLDER_LABEL}){_AFTER}"
)
ADR_PLACEHOLDER_FILE = re.compile(rf"{ADR_DIRECTORY}/NEW-({PLACEHOLDER_LABEL})\.md")
NUMBERED_ADR = re.compile(r"([0-9]{4})-.+\.md")


class AssignError(Exception):
    """Stops the run; the message says why."""


@dataclass(frozen=True)
class Placeholder:
    kind: str  # "D" or "ADR"
    label: str

    def __str__(self) -> str:
        return f"{self.kind}-NEW-{self.label}"


@dataclass(frozen=True)
class Highest:
    decision: int
    adr: int

    def __str__(self) -> str:
        return f"D-{self.decision:03d}, ADR-{self.adr:04d}"


@dataclass(frozen=True)
class Plan:
    base: str
    base_commit: str
    base_highest: Highest
    tree_highest: Highest
    history_highest: Highest
    mapping: dict[Placeholder, int]
    texts: dict[str, str]
    untracked: list[str]


def numbered(placeholder: Placeholder, number: int) -> str:
    width = 4 if placeholder.kind == "ADR" else 3
    return f"{placeholder.kind}-{number:0{width}d}"


def adr_path(label: str, number: int | None = None) -> str:
    prefix = "NEW" if number is None else f"{number:04d}"
    return f"{ADR_DIRECTORY}/{prefix}-{label}.md"


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(ROOT), *args],
        capture_output=True,
        encoding="utf-8",
        errors="surrogateescape",
        check=False,
    )


def read_text(relative: str) -> str | None:
    try:
        return (ROOT / relative).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as error:
        raise AssignError(f"Could not read {relative}: {error}") from error


def headings(register: str | None) -> list[re.Match[str]]:
    return [
        match
        for line in (register or "").removeprefix("\ufeff").splitlines()
        if (match := DECISION_HEADING.fullmatch(line)) is not None
    ]


def highest(register: str | None, adr_names: Iterable[str]) -> Highest:
    return Highest(
        decision=max((int(match.group(1)) for match in headings(register) if match.group(1)), default=0),
        adr=max((int(match.group(1)) for name in adr_names if (match := NUMBERED_ADR.fullmatch(name))), default=0),
    )


def base_highest(ref: str) -> tuple[str, Highest]:
    resolved = git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
    if resolved.returncode != 0:
        raise AssignError(f"Cannot resolve the base ref {ref!r}: run `git fetch origin`, or name another with --base.")

    def show(path: str) -> str | None:
        result = git("show", f"{ref}:{path}")
        return result.stdout if result.returncode == 0 else None

    # `git show <ref>:<directory>/` lists the directory's entries, one per line.
    return resolved.stdout.strip(), highest(
        show(REGISTER),
        (show(f"{ADR_DIRECTORY}/") or "").splitlines(),
    )


def history_highest(refs: Iterable[str]) -> Highest:
    """The highest number each kind has held at any commit reachable from the refs.

    The register is read from every patch that touched it, added, removed and
    context lines alike, and the ADR directory from every name it has held, so a
    deleted entry's number still counts. Every commit is read, and a merge is
    diffed against each parent, so neither a merge that kept one side's records
    nor a number only a conflict resolution held can hide one.
    """
    if git("rev-parse", "--is-shallow-repository").stdout.strip() == "true":
        raise AssignError(
            "This clone is shallow, so the history that holds deleted numbers is not all here: "
            "run `git fetch --unshallow`, then run this again."
        )
    reachable = [ref for ref in refs if git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode == 0]
    if not reachable:
        return Highest(0, 0)
    every_commit = ("--full-history", "--diff-merges=separate", "--no-renames", "--no-color")
    patches = git("log", "-p", *every_commit, "--format=", *reachable, "--", REGISTER)
    if patches.returncode != 0:
        raise AssignError(f"git log failed: {patches.stderr.strip()}")
    decisions: list[int] = []
    for line in patches.stdout.splitlines():
        content = line[1:]  # past the diff marker
        if (match := DECISION_HEADING.fullmatch(content)) is not None and match.group(1):
            decisions.append(int(match.group(1)))
    names = git("log", *every_commit, "--format=", "--name-only", *reachable, "--", ADR_DIRECTORY)
    if names.returncode != 0:
        raise AssignError(f"git log failed: {names.stderr.strip()}")
    adrs = [int(match.group(1)) for path in names.stdout.splitlines() if (match := NUMBERED_ADR.fullmatch(Path(path).name))]
    return Highest(max(decisions, default=0), max(adrs, default=0))


def tracked_files() -> list[str]:
    listing = git("ls-files", "-z")
    if listing.returncode != 0:
        raise AssignError(f"git ls-files failed: {listing.stderr.strip()}")
    return [name for name in listing.stdout.split("\0") if name]


def placeholder_texts(tracked: Iterable[str]) -> dict[str, str]:
    """Every tracked UTF-8 text file that could mention a placeholder, by path."""
    texts: dict[str, str] = {}
    for name in tracked:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data or (b"NEW-" not in data and b"#d-new-" not in data):
            continue
        try:
            texts[name] = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
    return texts


def declared(register: str | None, tracked: list[str]) -> tuple[list[Placeholder], ...]:
    """Each kind's placeholders in order of first appearance."""
    decisions = dict.fromkeys(match.group(2) for match in headings(register) if match.group(2))
    adr_labels = [
        match.group(1)
        for name in tracked
        if (match := ADR_PLACEHOLDER_FILE.fullmatch(name)) is not None and (ROOT / name).is_file()
    ]
    index = read_text(ADR_INDEX) or ""
    first_mention: dict[str, int] = {}
    for match in PLACEHOLDER.finditer(index):
        label = match.group("label") if match.group("kind") == "ADR" else match.group("file")
        if label is not None:
            first_mention.setdefault(label, match.start())
    adrs = sorted(adr_labels, key=lambda label: (first_mention.get(label, len(index)), label))
    return (
        [Placeholder("D", label) for label in decisions],
        [Placeholder("ADR", label) for label in adrs],
    )


def mentioned(match: re.Match[str]) -> Placeholder | None:
    """The placeholder an id or an anchor names. A dangling ADR filename is the link check's to report."""
    if match.group("kind") is not None:
        return Placeholder(match.group("kind"), match.group("label"))
    if match.group("anchor") is not None:
        return Placeholder("D", match.group("anchor"))
    return None


def plan(base: str) -> Plan:
    base_commit, base_numbers = base_highest(base)
    register = read_text(REGISTER)
    tracked = tracked_files()
    tree_numbers = highest(register, (path.name for path in (ROOT / ADR_DIRECTORY).glob("*.md")))
    history_numbers = history_highest([base, "HEAD"])
    starts = (
        max(base_numbers.decision, tree_numbers.decision, history_numbers.decision),
        max(base_numbers.adr, tree_numbers.adr, history_numbers.adr),
    )
    mapping: dict[Placeholder, int] = {}
    for placeholders, start in zip(declared(register, tracked), starts):
        for offset, placeholder in enumerate(placeholders, start=1):
            mapping[placeholder] = start + offset

    tracked_names = set(tracked)
    untracked = sorted(
        name
        for path in (ROOT / ADR_DIRECTORY).glob("NEW-*.md")
        if (name := path.relative_to(ROOT).as_posix()) not in tracked_names
    )
    texts = placeholder_texts(tracked)
    problems: list[str] = []
    for name, text in texts.items():
        for match in PLACEHOLDER.finditer(text):
            placeholder = mentioned(match)
            if match.group("backlog") is not None or (placeholder is not None and placeholder not in mapping):
                line = text.count("\n", 0, match.start()) + 1
                problems.append(f"  {name}:{line}: {match.group(0)}")
    if problems:
        notes = [f"{name} is not tracked, so it declares nothing until it is added." for name in untracked]
        raise AssignError(
            "Tracked files mention placeholders that nothing declares; nothing was written:\n"
            + "\n".join([*problems, *notes])
        )
    return Plan(base, base_commit, base_numbers, tree_numbers, history_numbers, mapping, texts, untracked)


def rewrite(text: str, mapping: dict[Placeholder, int]) -> str:
    def replace(match: re.Match[str]) -> str:
        if match.group("kind") is not None:
            placeholder = Placeholder(match.group("kind"), match.group("label"))
            number = mapping.get(placeholder)
            return match.group(0) if number is None else numbered(placeholder, number)
        if match.group("anchor") is not None:
            number = mapping.get(Placeholder("D", match.group("anchor")))
            return match.group(0) if number is None else f"#d-{number:03d}--"
        label = match.group("file")
        number = mapping.get(Placeholder("ADR", label))
        return match.group(0) if number is None else f"{number:04d}-{label}.md"

    return PLACEHOLDER.sub(replace, text)


def report(assignment: Plan) -> None:
    print(f"Highest on {assignment.base} ({assignment.base_commit[:12]}): {assignment.base_highest}")
    print(f"Highest in the working tree: {assignment.tree_highest}")
    print(f"Highest ever, in the history of {assignment.base} and HEAD: {assignment.history_highest}")
    for name in assignment.untracked:
        print(f"Warning: {name} is not tracked, so it is not numbered; git add it and run again.", file=sys.stderr)
    if not assignment.mapping:
        print("No placeholders to assign.")
    for placeholder, number in assignment.mapping.items():
        line = f"{placeholder} -> {numbered(placeholder, number)}"
        if placeholder.kind == "ADR":
            line += f"  ({adr_path(placeholder.label)} -> {adr_path(placeholder.label, number)})"
        print(line)


def write(assignment: Plan) -> None:
    rewritten = 0
    for name, text in assignment.texts.items():
        updated = rewrite(text, assignment.mapping)
        if updated != text:
            (ROOT / name).write_bytes(updated.encode("utf-8"))
            rewritten += 1
    renamed = 0
    for placeholder, number in assignment.mapping.items():
        if placeholder.kind != "ADR":
            continue
        source, target = adr_path(placeholder.label), adr_path(placeholder.label, number)
        moved = git("mv", "--", source, target)
        if moved.returncode != 0:
            raise AssignError(f"git mv {source} {target} failed: {moved.stderr.strip()}")
        renamed += 1
    if assignment.mapping:
        print(f"Rewrote {rewritten} files and renamed {renamed} ADRs.")


def validate() -> int:
    failed: list[str] = []
    for script, *flags in VALIDATORS:
        print(f"\n$ python3 scripts/{' '.join([script, *flags])}", flush=True)
        if subprocess.run([sys.executable, str(ROOT / "scripts" / script), *flags], check=False).returncode != 0:
            failed.append(script)
    if failed:
        print(f"\nFailed: {', '.join(failed)}. The tree is written but not ready to merge.", file=sys.stderr)
        return 1
    print("\nThe validators pass. Review the diff and commit it.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="origin/main", help="ref to read the highest numbers from (default: origin/main)")
    parser.add_argument("--apply", action="store_true", help="write the mapping, then run the validators strictly")
    arguments = parser.parse_args(argv)
    try:
        assignment = plan(arguments.base)
        report(assignment)
        if not arguments.apply:
            if assignment.mapping:
                print("Dry run: nothing written. Run again with --apply to write it.")
            return 0
        write(assignment)
    except AssignError as error:
        print(error, file=sys.stderr)
        return 1
    return validate()


if __name__ == "__main__":
    raise SystemExit(main())
