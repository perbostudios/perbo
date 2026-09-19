#!/usr/bin/env python3
"""Regression tests for repository inputs that the happy-path validators reject."""
from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from repository_rules import (
    decision_heading_errors,
    decision_register_errors,
    repository_action_pin_errors,
    workflow_action_pin_errors,
)

ROOT = Path(__file__).resolve().parents[1]

# Placeholder ids are spelled through NEW so this file carries none of its own:
# scripts/assign_ids.py refuses a tree that mentions a placeholder nothing declares.
NEW = "NEW"


class DecisionValidationTests(unittest.TestCase):
    def test_valid_and_non_heading_mentions_are_allowed(self) -> None:
        text = "### D-001 — First decision\nA note mentioning D-001 is not another decision.\n"
        self.assertEqual(decision_heading_errors(text, "register.md"), [])

    def test_duplicate_and_malformed_headings_are_rejected(self) -> None:
        duplicate = "### D-001 — First\n### D-001 — Again\n"
        errors = decision_heading_errors(duplicate, "register.md")
        self.assertEqual(
            errors,
            ["Duplicate decision ID D-001 at register.md:1 and register.md:2"],
        )
        malformed = decision_heading_errors("### D-01 — Too short\n", "register.md")
        self.assertEqual(len(malformed), 1)
        self.assertIn("Invalid decision heading", malformed[0])

    def test_commonmark_indentation_blank_titles_and_unicode_digits_are_checked(self) -> None:
        indented_duplicate = "   ### D-001 — First\n### D-001 — Second\n"
        errors = decision_heading_errors(indented_duplicate, "register.md")
        self.assertEqual(
            errors,
            ["Duplicate decision ID D-001 at register.md:1 and register.md:2"],
        )
        self.assertTrue(
            decision_heading_errors("### D-001 —    \n", "register.md")
        )
        self.assertTrue(
            decision_heading_errors("### D-٠٠١ — Unicode digits\n", "register.md")
        )
        self.assertEqual(
            decision_heading_errors("\ufeff### D-001 — Byte-order mark\n", "register.md"),
            [],
        )

    def test_commonmark_heading_separator_whitespace_is_checked(self) -> None:
        for separator in ("  ", "\t"):
            with self.subTest(separator=repr(separator)):
                text = f"###{separator}D-001 — First\n### D-001 — Second\n"
                errors = decision_heading_errors(text, "register.md")
                self.assertEqual(
                    errors,
                    ["Duplicate decision ID D-001 at register.md:1 and register.md:2"],
                )

    def test_missing_register_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.md"
            self.assertEqual(
                decision_register_errors(missing, "docs/11-open-decisions.md"),
                ["Missing docs/11-open-decisions.md"],
            )

    def test_placeholder_headings_are_accepted(self) -> None:
        text = f"### D-001 — First\n### D-{NEW}-queue-design — Second\n### D-{NEW}-q2 — Third\n"
        self.assertEqual(decision_heading_errors(text, "register.md"), [])

    def test_duplicate_placeholder_labels_are_rejected(self) -> None:
        text = f"### D-{NEW}-queue — First\n### D-001 — Numbered\n### D-{NEW}-queue — Again\n"
        self.assertEqual(
            decision_heading_errors(text, "register.md"),
            [f"Duplicate decision placeholder D-{NEW}-queue at register.md:1 and register.md:3"],
        )

    def test_malformed_placeholder_labels_are_rejected(self) -> None:
        for label in ("Queue", "queue-", "-queue", "queue--design", "queue_design", ""):
            with self.subTest(label=label):
                errors = decision_heading_errors(f"### D-{NEW}-{label} — Title\n", "register.md")
                self.assertEqual(len(errors), 1, errors)
                self.assertIn("Invalid decision heading", errors[0])

    def test_strict_rejects_every_placeholder_and_nothing_else(self) -> None:
        text = f"### D-001 — First\n### D-{NEW}-queue — Second\n"
        errors = decision_heading_errors(text, "register.md", strict=True)
        self.assertEqual(len(errors), 1, errors)
        self.assertIn(f"D-{NEW}-queue at register.md:2", errors[0])
        self.assertIn("scripts/assign_ids.py", errors[0])
        self.assertEqual(decision_heading_errors("### D-001 — First\n", "register.md", strict=True), [])

    def test_a_register_needs_no_counter_and_takes_strict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            register = Path(directory) / "register.md"
            register.write_text(f"### D-001 — First\n### D-{NEW}-queue — Second\n", encoding="utf-8")
            self.assertEqual(decision_register_errors(register, "register.md"), [])
            errors = decision_register_errors(register, "register.md", strict=True)
            self.assertEqual(len(errors), 1, errors)
            self.assertIn(f"D-{NEW}-queue", errors[0])

    def test_live_register_is_valid(self) -> None:
        self.assertEqual(
            decision_register_errors(
                ROOT / "docs" / "11-open-decisions.md", "docs/11-open-decisions.md"
            ),
            [],
        )


class WorkflowPinTests(unittest.TestCase):
    def test_full_sha_and_local_actions_are_allowed(self) -> None:
        workflow = """
        steps:
          - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
          - uses: "./.github/actions/local"
        """
        self.assertEqual(workflow_action_pin_errors(workflow, "workflow.yml"), [])

    def test_tag_reference_is_rejected(self) -> None:
        errors = workflow_action_pin_errors(
            "steps:\n  - uses: actions/checkout@v7\n", "workflow.yml"
        )
        self.assertEqual(len(errors), 1)
        self.assertIn("Unpinned external Action", errors[0])

    def test_equivalent_yaml_forms_and_composite_actions_are_checked(self) -> None:
        documents = (
            "steps:\n  - { uses: actions/checkout@v7 }\n",
            "steps:\n  - 'uses': actions/checkout@v7\n",
            "steps:\n  - uses : actions/checkout@v7\n",
            "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v6\n",
        )
        for document in documents:
            with self.subTest(document=document):
                errors = workflow_action_pin_errors(document, "action.yml")
                self.assertEqual(len(errors), 1)
                self.assertIn("Unpinned external Action", errors[0])

    def test_unpinned_docker_action_is_rejected(self) -> None:
        errors = workflow_action_pin_errors(
            "steps:\n  - uses: docker://alpine:3.22\n", "workflow.yml"
        )
        self.assertEqual(len(errors), 1)
        self.assertIn("Unpinned Docker Action", errors[0])

    def test_referenced_local_composite_action_is_inspected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = root / ".github" / "workflows" / "main.yml"
            action = root / "actions" / "local" / "action.yml"
            workflow.parent.mkdir(parents=True)
            action.parent.mkdir(parents=True)
            workflow.write_text(
                "steps:\n  - uses: ./actions/local\n", encoding="utf-8"
            )
            action.write_text(
                "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v6\n",
                encoding="utf-8",
            )
            errors = repository_action_pin_errors(root, [workflow])
            self.assertEqual(len(errors), 1)
            self.assertIn("actions/local/action.yml:4", errors[0])



DOCS_SCRIPTS = ("repository_rules.py", "validate_docs.py")


def run_validate_docs(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(root / "scripts" / "validate_docs.py"), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def write_docs_tree(root: Path, scripts: tuple[str, ...] = DOCS_SCRIPTS) -> None:
    """Write the smallest tree validate_docs.py accepts into `root`, with the named scripts."""
    files = {
        "README.md": "# Fixture\n",
        "AGENTS.md": "# Agents\n",
        "docs/README.md": (
            "# Index\n\n"
            "- [00-thesis](00-thesis.md)\n"
            "- [11-open-decisions](11-open-decisions.md)\n"
            "- [flow](../diagrams/flow.svg)\n"
        ),
        "docs/00-thesis.md": "# Thesis\n",
        "docs/11-open-decisions.md": "# Decisions\n\n### D-001 — First\n",
        "docs/adr/0001-first.md": "# ADR-0001: First\n",
        "docs/templates/component-technical-specification.md": "# Template\n",
        "diagrams/flow.dot": "digraph { a -> b }\n",
        "diagrams/flow.svg": "<svg></svg>\n",
        "diagrams/flow.png": "png\n",
    }
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    (root / "scripts").mkdir(exist_ok=True)
    for name in scripts:
        shutil.copy2(ROOT / "scripts" / name, root / "scripts" / name)


class DocsValidatorTests(unittest.TestCase):
    """validate_docs.py run whole against the tree write_docs_tree builds."""

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        write_docs_tree(self.root)

    def write(self, relative: str, text: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def index(self) -> str:
        return (self.root / "docs" / "README.md").read_text(encoding="utf-8")

    def assert_valid(self, *args: str) -> None:
        result = run_validate_docs(self.root, *args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_invalid(self, expected: str, *args: str) -> None:
        result = run_validate_docs(self.root, *args)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(expected, result.stdout)

    def test_the_tree_is_valid_without_docs_21_or_a_root_readme_index(self) -> None:
        self.assert_valid()
        self.assert_valid("--strict")

    def test_the_canonical_set_is_whatever_numbered_documents_exist(self) -> None:
        self.write("docs/05-specification.md", "# Specification\n")
        self.write("docs/README.md", self.index() + "- [05](05-specification.md)\n")
        self.assert_valid()
        self.write("docs/05-other.md", "# Other\n")
        self.write("docs/README.md", self.index() + "- [05 other](05-other.md)\n")
        self.assert_invalid("Duplicate canonical document prefix 05: 05-other.md, 05-specification.md")

    def test_docs_readme_references_every_canonical_document_and_diagram(self) -> None:
        index = self.index()
        self.write("docs/README.md", index.replace("- [00-thesis](00-thesis.md)\n", ""))
        self.assert_invalid("docs/README.md does not reference canonical document 00-thesis.md")
        self.write("docs/README.md", index.replace("- [flow](../diagrams/flow.svg)\n", ""))
        self.assert_invalid("docs/README.md does not reference diagram flow.svg")

    def test_a_numbered_adr_heading_still_agrees_with_its_prefix(self) -> None:
        self.write("docs/adr/0002-second.md", "# ADR-0003: Second\n")
        self.assert_invalid("ADR filename/heading mismatch in docs/adr/0002-second.md: 0002 vs 0003")

    def test_an_adr_placeholder_carries_its_own_label_in_its_heading(self) -> None:
        placeholder = f"docs/adr/{NEW}-local-queue.md"
        self.write(placeholder, f"# ADR-{NEW}-local-queue: Serve a local queue\n")
        self.assert_valid()
        for heading in (
            f"# ADR-{NEW}-other: Serve a local queue\n",
            "# ADR-0002: Serve a local queue\n",
            f"# ADR-{NEW}-local-queue:\n",
        ):
            with self.subTest(heading=heading):
                self.write(placeholder, heading)
                self.assert_invalid(placeholder)

    def test_an_adr_placeholder_label_is_lowercase_runs(self) -> None:
        self.write(f"docs/adr/{NEW}-Local.md", f"# ADR-{NEW}-Local: Serve a local queue\n")
        self.assert_invalid(f"Invalid ADR placeholder filename docs/adr/{NEW}-Local.md")

    def test_strict_rejects_adr_and_decision_placeholders(self) -> None:
        self.write(f"docs/adr/{NEW}-local-queue.md", f"# ADR-{NEW}-local-queue: Serve a local queue\n")
        self.write("docs/11-open-decisions.md", f"# Decisions\n\n### D-001 — First\n### D-{NEW}-queue — Second\n")
        self.assert_valid()
        result = run_validate_docs(self.root, "--strict")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"ADR placeholder docs/adr/{NEW}-local-queue.md is not numbered", result.stdout)
        self.assertIn(f"Decision placeholder D-{NEW}-queue", result.stdout)



if __name__ == "__main__":
    unittest.main()
