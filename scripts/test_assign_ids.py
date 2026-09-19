#!/usr/bin/env python3
"""scripts/assign_ids.py run against scratch git repositories."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_repository_validators import NEW, write_docs_tree

SCRIPTS = (
    "assign_ids.py",
    "repository_rules.py",
    "validate_diagrams.py",
    "validate_docs.py",
)

# Scratch repositories read no user or system git configuration, so a global
# commit.gpgsign or hooks path cannot reach a test commit, and the scripts they
# run write no bytecode into the tree they check.
ENVIRONMENT = {
    **{key: value for key, value in os.environ.items() if not key.startswith("GIT_")},
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
    "PYTHONDONTWRITEBYTECODE": "1",
}


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, env=ENVIRONMENT, check=False
    )
    if result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def read(root: Path, relative: str) -> str:
    return (root / relative).read_text(encoding="utf-8")


class AssignIdsTests(unittest.TestCase):
    def repository(self) -> Path:
        """A scratch repository on main, committed, that the validators accept and that holds no placeholder."""
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        write_docs_tree(root, SCRIPTS)
        git(root, "init", "--quiet", "--initial-branch=main")
        self.commit(root, "Base")
        return root

    def commit(self, root: Path, message: str) -> None:
        git(root, "add", "--all")
        git(root, "commit", "--quiet", "--message", message)

    def assign(self, root: Path, *args: str, base: str | None = "main") -> subprocess.CompletedProcess[str]:
        command = [sys.executable, str(root / "scripts" / "assign_ids.py"), *args]
        if base is not None:
            command += ["--base", base]
        return subprocess.run(command, cwd=root, capture_output=True, text=True, env=ENVIRONMENT, check=False)

    def test_numbers_follow_first_appearance_in_the_register_and_the_adr_index(self) -> None:
        root = self.repository()
        write(
            root,
            "docs/11-open-decisions.md",
            f"# Decisions\n\n### D-001 — First\n### D-{NEW}-zeta — Listed first\n### D-{NEW}-alpha — Listed second\n",
        )
        # docs/00 sorts before docs/11 and names the decisions the other way round;
        # the register's order decides.
        write(root, "docs/00-thesis.md", f"# Thesis\n\nSee D-{NEW}-alpha, then D-{NEW}-zeta.\n")
        for label in ("alpha", "beta", "gamma"):
            write(root, f"docs/adr/{NEW}-{label}.md", f"# ADR-{NEW}-{label}: {label.title()}\n")
        # The index lists beta before alpha and leaves gamma out, so gamma comes last.
        write(
            root,
            "docs/adr/README.md",
            f"# ADRs\n\n- [ADR-{NEW}-beta]({NEW}-beta.md)\n- [ADR-{NEW}-alpha]({NEW}-alpha.md)\n",
        )
        self.commit(root, "Placeholders")

        result = self.assign(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for line in (
            f"D-{NEW}-zeta -> D-002",
            f"D-{NEW}-alpha -> D-003",
            f"ADR-{NEW}-beta -> ADR-0002",
            f"ADR-{NEW}-alpha -> ADR-0003",
            f"ADR-{NEW}-gamma -> ADR-0004",
        ):
            self.assertIn(line, result.stdout)
        self.assertEqual(git(root, "status", "--porcelain"), "", "a dry run wrote to the tree")

    def test_numbering_continues_from_the_higher_of_the_base_and_the_tree(self) -> None:
        root = self.repository()
        git(root, "checkout", "--quiet", "-b", "pull-request")
        write(root, "docs/adr/0007-seventh.md", "# ADR-0007: Seventh\n")
        write(root, "docs/11-open-decisions.md", f"# Decisions\n\n### D-001 — First\n### D-{NEW}-queue — Queue\n")
        write(root, f"docs/adr/{NEW}-local.md", f"# ADR-{NEW}-local: Local\n")
        self.commit(root, "Placeholders")
        git(root, "checkout", "--quiet", "main")
        write(root, "docs/11-open-decisions.md", "# Decisions\n\n### D-001 — First\n### D-905 — Fifth\n")
        self.commit(root, "Main moves on")
        git(root, "checkout", "--quiet", "pull-request")

        result = self.assign(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # Decisions run highest on main, ADRs in the tree.
        self.assertIn(f"D-{NEW}-queue -> D-906", result.stdout)
        self.assertIn(f"ADR-{NEW}-local -> ADR-0008", result.stdout)

    def number_then_delete(self, root: Path) -> None:
        """Commit D-905 and ADR-0007, then a commit that deletes both."""
        write(root, "docs/11-open-decisions.md", "# Decisions\n\n### D-001 — First\n### D-905 — Fifth\n")
        write(root, "docs/adr/0007-seventh.md", "# ADR-0007: Seventh\n")
        self.commit(root, "Numbers")
        write(root, "docs/11-open-decisions.md", "# Decisions\n\n### D-001 — First\n")
        (root / "docs/adr/0007-seventh.md").unlink()
        self.commit(root, "Delete them")

    def write_placeholders(self, root: Path) -> None:
        write(root, "docs/11-open-decisions.md", f"# Decisions\n\n### D-001 — First\n### D-{NEW}-queue — Queue\n")
        write(root, f"docs/adr/{NEW}-local.md", f"# ADR-{NEW}-local: Local\n")
        self.commit(root, "Placeholders")

    def test_a_number_deleted_on_the_branch_is_never_reused(self) -> None:
        root = self.repository()
        git(root, "checkout", "--quiet", "-b", "pull-request")
        self.number_then_delete(root)
        self.write_placeholders(root)

        result = self.assign(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # Neither main nor the tree holds D-905 or ADR-0007; the branch's history does.
        self.assertIn(f"D-{NEW}-queue -> D-906", result.stdout)
        self.assertIn(f"ADR-{NEW}-local -> ADR-0008", result.stdout)

    def test_a_number_deleted_on_the_base_is_never_reused(self) -> None:
        root = self.repository()
        git(root, "checkout", "--quiet", "-b", "pull-request")
        self.write_placeholders(root)
        git(root, "checkout", "--quiet", "main")
        self.number_then_delete(root)
        git(root, "checkout", "--quiet", "pull-request")

        result = self.assign(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"D-{NEW}-queue -> D-906", result.stdout)
        self.assertIn(f"ADR-{NEW}-local -> ADR-0008", result.stdout)

    def merge(self, root: Path, branch: str) -> None:
        """Start merging `branch` without committing; the caller resolves any conflict."""
        subprocess.run(
            ["git", "-C", str(root), "merge", "--no-ff", "--no-commit", branch],
            capture_output=True,
            text=True,
            env=ENVIRONMENT,
            check=False,
        )

    def merge_keeping(self, root: Path, branch: str, side: str) -> None:
        """Merge `branch`, finishing with `side`'s register and without ADR-0002."""
        self.merge(root, branch)
        git(root, "checkout", side, "--", "docs/11-open-decisions.md")
        if (root / "docs/adr/0002-second.md").exists():
            git(root, "rm", "--quiet", "--force", "docs/adr/0002-second.md")
        self.commit(root, f"Merge {branch}")

    def write_second(self, root: Path) -> None:
        write(root, "docs/11-open-decisions.md", "# Decisions\n\n### D-001 — First\n### D-002 — Second\n")
        write(root, "docs/adr/0002-second.md", "# ADR-0002: Second\n")

    def test_a_number_a_merge_dropped_is_never_reused(self) -> None:
        root = self.repository()
        git(root, "checkout", "--quiet", "-b", "rename", "main")
        self.write_second(root)
        self.commit(root, "Number D-002 and ADR-0002")
        git(root, "checkout", "--quiet", "-b", "pull-request", "main")
        self.write_placeholders(root)
        self.merge_keeping(root, "rename", "HEAD")
        git(root, "branch", "--quiet", "-D", "rename")

        result = self.assign(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # The merge kept this branch's records, so only the merged side's history holds the numbers.
        self.assertIn(f"D-{NEW}-queue -> D-003", result.stdout)
        self.assertIn(f"ADR-{NEW}-local -> ADR-0003", result.stdout)

    def test_a_number_only_a_merge_resolution_held_is_never_reused(self) -> None:
        root = self.repository()
        git(root, "checkout", "--quiet", "-b", "side", "main")
        write(root, "side.txt", "side\n")
        self.commit(root, "Side")
        git(root, "checkout", "--quiet", "-b", "pull-request", "main")
        write(root, "pull-request.txt", "pull request\n")
        self.commit(root, "Pull request")
        # This resolution numbers D-002 and ADR-0002, which neither parent holds.
        self.merge(root, "side")
        self.write_second(root)
        self.commit(root, "Merge side")
        git(root, "checkout", "--quiet", "main")
        write(root, "main.txt", "main\n")
        self.commit(root, "Main moves on")
        git(root, "checkout", "--quiet", "pull-request")
        self.merge_keeping(root, "main", "main")
        git(root, "branch", "--quiet", "-D", "side")
        self.write_placeholders(root)

        result = self.assign(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"D-{NEW}-queue -> D-003", result.stdout)
        self.assertIn(f"ADR-{NEW}-local -> ADR-0003", result.stdout)

    def test_a_shallow_clone_is_refused(self) -> None:
        root = self.repository()
        self.number_then_delete(root)
        self.write_placeholders(root)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        clone = Path(directory.name) / "clone"
        git(Path(directory.name), "clone", "--quiet", "--depth", "1", root.as_uri(), str(clone))

        result = self.assign(clone)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("git fetch --unshallow", result.stderr)
        self.assertNotIn(" -> ", result.stdout)

    def test_colour_in_the_git_configuration_hides_no_number(self) -> None:
        root = self.repository()
        git(root, "config", "color.ui", "always")
        self.number_then_delete(root)
        git(root, "checkout", "--quiet", "-b", "pull-request")
        self.write_placeholders(root)

        result = self.assign(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"D-{NEW}-queue -> D-906", result.stdout)
        self.assertIn(f"ADR-{NEW}-local -> ADR-0008", result.stdout)

    def test_apply_renames_the_adr_and_numbers_its_heading(self) -> None:
        root = self.repository()
        write(root, f"docs/adr/{NEW}-local-queue.md", f"# ADR-{NEW}-local-queue: Serve a local queue\n\nBody.\n")
        self.commit(root, "Placeholder ADR")

        result = self.assign(root, "--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((root / f"docs/adr/{NEW}-local-queue.md").exists())
        self.assertEqual(read(root, "docs/adr/0002-local-queue.md"), "# ADR-0002: Serve a local queue\n\nBody.\n")
        # The rename is in the index, so committing the tree's changes carries it.
        tracked = git(root, "ls-files", "docs/adr").split()
        self.assertIn("docs/adr/0002-local-queue.md", tracked)
        self.assertNotIn(f"docs/adr/{NEW}-local-queue.md", tracked)

    def test_apply_rewrites_ids_anchors_and_links_in_every_tracked_file(self) -> None:
        root = self.repository()
        anchor = f"#d-{NEW.lower()}-queue-design--serve-a-queue"
        write(
            root,
            "docs/11-open-decisions.md",
            "# Decisions\n\n### D-001 — First\n"
            f"### D-{NEW}-queue-design — Serve a queue\n\n"
            f"Recorded in [ADR-{NEW}-local](adr/{NEW}-local.md) and tracked as SCP-007.\n",
        )
        write(
            root,
            f"docs/adr/{NEW}-local.md",
            f"# ADR-{NEW}-local: Local queue\n\nDecided in [D-{NEW}-queue-design](../11-open-decisions.md{anchor}).\n",
        )
        write(
            root,
            "docs/adr/README.md",
            f"# ADRs\n\n| [0001](0001-first.md) | accepted |\n| [ADR-{NEW}-local]({NEW}-local.md) | proposed |\n",
        )
        write(
            root,
            "AGENTS.md",
            f"# Agents\n\nSee [D-{NEW}-queue-design](docs/11-open-decisions.md{anchor}) "
            f"and docs/adr/{NEW}-local.md. D-001 and ADR-0001 stay as they are.\n",
        )
        self.commit(root, "Placeholders")

        result = self.assign(root, "--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            read(root, "docs/11-open-decisions.md"),
            "# Decisions\n\n### D-001 — First\n### D-002 — Serve a queue\n\n"
            "Recorded in [ADR-0002](adr/0002-local.md) and tracked as SCP-007.\n",
        )
        self.assertEqual(
            read(root, "docs/adr/0002-local.md"),
            "# ADR-0002: Local queue\n\nDecided in [D-002](../11-open-decisions.md#d-002--serve-a-queue).\n",
        )
        self.assertEqual(
            read(root, "docs/adr/README.md"),
            "# ADRs\n\n| [0001](0001-first.md) | accepted |\n| [ADR-0002](0002-local.md) | proposed |\n",
        )
        self.assertEqual(
            read(root, "AGENTS.md"),
            "# Agents\n\nSee [D-002](docs/11-open-decisions.md#d-002--serve-a-queue) "
            "and docs/adr/0002-local.md. D-001 and ADR-0001 stay as they are.\n",
        )

    def test_a_tree_without_placeholders_is_left_alone(self) -> None:
        root = self.repository()
        write(root, "docs/11-open-decisions.md", f"# Decisions\n\n### D-001 — First\n### D-{NEW}-queue — Second\n")
        self.commit(root, "Placeholder")
        first = self.assign(root, "--apply")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.commit(root, "Numbered")

        second = self.assign(root, "--apply")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("No placeholders", second.stdout)
        self.assertEqual(git(root, "status", "--porcelain"), "")

    def test_apply_exits_non_zero_when_a_strict_validator_fails(self) -> None:
        root = self.repository()
        write(root, "docs/11-open-decisions.md", f"# Decisions\n\n### D-001 — First\n### D-{NEW}-queue — Second\n")
        self.commit(root, "Placeholder")
        # Never added, so assign_ids.py leaves it alone, and only the strict docs
        # check rejects a well-formed placeholder.
        write(root, f"docs/adr/{NEW}-late.md", f"# ADR-{NEW}-late: Late\n")

        result = self.assign(root, "--apply")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"ADR placeholder docs/adr/{NEW}-late.md is not numbered", result.stdout)
        # The assignment was written before the validators ran.
        self.assertIn("### D-002 — Second", read(root, "docs/11-open-decisions.md"))

    def test_an_undeclared_placeholder_stops_the_run_before_anything_is_written(self) -> None:
        root = self.repository()
        write(root, "docs/11-open-decisions.md", f"# Decisions\n\n### D-001 — First\n### D-{NEW}-queue — Second\n")
        write(root, "docs/00-thesis.md", f"# Thesis\n\nSee D-{NEW}-queue and D-{NEW}-queu.\n")
        self.commit(root, "A typo")

        result = self.assign(root, "--apply")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"docs/00-thesis.md:3: D-{NEW}-queu", result.stderr)
        self.assertEqual(git(root, "status", "--porcelain"), "")

    def test_a_backlog_placeholder_stops_the_run_because_nothing_here_declares_one(self) -> None:
        root = self.repository()
        write(root, "docs/11-open-decisions.md", f"# Decisions\n\n### D-001 — First\n### D-{NEW}-queue — Second\n")
        write(root, "docs/00-thesis.md", f"# Thesis\n\nD-{NEW}-queue is tracked as SCP-{NEW}-serve.\n")
        self.commit(root, "A backlog placeholder")

        result = self.assign(root, "--apply")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"docs/00-thesis.md:3: SCP-{NEW}-serve", result.stderr)
        self.assertEqual(git(root, "status", "--porcelain"), "")

    def test_the_base_defaults_to_origin_main_and_must_resolve(self) -> None:
        root = self.repository()
        result = self.assign(root, base=None)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("origin/main", result.stderr)


if __name__ == "__main__":
    unittest.main()
