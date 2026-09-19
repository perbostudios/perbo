#!/usr/bin/env python3
"""Regression tests for repository inputs that the happy-path validators reject."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

from git_remote import github_repository_from_remote
from repository_rules import (
    decision_heading_errors,
    decision_register_errors,
    repository_action_pin_errors,
    workflow_action_pin_errors,
)
from validate_backlog import (
    BacklogValidationError,
    load_validated_backlog,
    validate_backlog_data,
)

ROOT = Path(__file__).resolve().parents[1]

# Placeholder ids are spelled through NEW so this file carries none of its own:
# scripts/assign_ids.py refuses a tree that mentions a placeholder nothing declares.
NEW = "NEW"


def valid_backlog() -> dict[str, object]:
    """Return the smallest backlog that satisfies the current schema."""
    return {
        "version": 4,
        "generated_at": "2026-09-01",
        "milestones": [{"title": "M1", "description": "First milestone"}],
        "labels": [{"name": "type:test", "color": "0052CC", "description": "Tests"}],
        "issues": [
            {
                "id": "SCP-001",
                "title": "Prove the validator",
                "milestone": "M1",
                "labels": ["type:test"],
                "outcome": "Malformed backlog data cannot reach GitHub.",
                "acceptance_criteria": ["Every invalid shape returns an error."],
                "depends_on": [],
            }
        ],
    }


def first_issue(backlog: dict[str, object]) -> dict[str, object]:
    """Return the first issue from a test backlog with its expected runtime shape."""
    issues = backlog["issues"]
    assert isinstance(issues, list)
    issue = issues[0]
    assert isinstance(issue, dict)
    return issue


def done_backlog(notes: str = "Done 2026-09-02 in #207.") -> dict[str, object]:
    """A valid backlog whose one issue is done: the label, the state and a closing note."""
    backlog = valid_backlog()
    labels = backlog["labels"]
    assert isinstance(labels, list)
    labels.append({"name": "status:done", "color": "EDEDED", "description": "Done"})
    issue = first_issue(backlog)
    issue["labels"] = ["type:test", "status:done"]
    issue["state"] = "done"
    issue["notes"] = notes
    return backlog


def placeholder_backlog() -> dict[str, object]:
    """A valid backlog whose second issue is a placeholder the first depends on."""
    backlog = valid_backlog()
    issues = backlog["issues"]
    assert isinstance(issues, list)
    second = copy.deepcopy(first_issue(backlog))
    second["id"] = f"SCP-{NEW}-serve-queue"
    second["title"] = "Serve a queue"
    issues.append(second)
    first_issue(backlog)["depends_on"] = [f"SCP-{NEW}-serve-queue"]
    return backlog


FAKE_GH = """#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\\n' "$GH_ISSUES"
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "https://github.com/owner/repo/issues/8"
fi
exit 0
"""


def run_sync(
    backlog: dict[str, object],
    github_issues: list[dict[str, object]],
    *flags: str,
    repo: str | None = "owner/repo",
    origin: str | None = None,
    run_from_origin: str | None = None,
    push_origin: str | None = None,
) -> tuple[subprocess.CompletedProcess[str], str]:
    """Run the sync script against a fake `gh`; return the process and the gh call log.

    `repo` is passed as `--repo` unless it is None, and `origin` makes the temporary
    directory a git repository with that remote, which is where the script reads the
    repository from when `--repo` is absent. `run_from_origin` runs the command from a
    different git repository with that remote, which the script must ignore.
    """
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        scripts = root / "scripts"
        binaries = root / "bin"
        scripts.mkdir()
        (root / "backlog").mkdir()
        binaries.mkdir()
        shutil.copy2(ROOT / "scripts" / "sync_github_issues.py", scripts)
        shutil.copy2(ROOT / "scripts" / "validate_backlog.py", scripts)
        shutil.copy2(ROOT / "scripts" / "git_remote.py", scripts)
        (root / "backlog" / "issues.json").write_text(json.dumps(backlog), encoding="utf-8")
        fake_gh = binaries / "gh"
        fake_gh.write_text(FAKE_GH, encoding="utf-8")
        fake_gh.chmod(fake_gh.stat().st_mode | stat.S_IXUSR)
        call_log = root / "gh-calls"
        environment = os.environ.copy()
        environment["PATH"] = f"{binaries}{os.pathsep}{environment.get('PATH', '')}"
        environment["GH_LOG"] = str(call_log)
        environment["GH_ISSUES"] = json.dumps(github_issues)
        if origin is not None:
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            subprocess.run(["git", "remote", "add", "origin", origin], cwd=root, check=True)
            if push_origin is not None:
                subprocess.run(
                    ["git", "remote", "set-url", "--push", "origin", push_origin], cwd=root, check=True
                )
        working_directory = root
        if run_from_origin is not None:
            # Inside the temporary directory, so its cleanup takes it with the
            # rest. It is a git repository of its own, so git run from here
            # stops here rather than walking up into `root` — which is what
            # makes it stand in for a checkout somewhere else entirely.
            working_directory = root / "elsewhere"
            working_directory.mkdir()
            subprocess.run(["git", "init", "--quiet"], cwd=working_directory, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", run_from_origin], cwd=working_directory, check=True
            )
        command = [sys.executable, str(scripts / "sync_github_issues.py")]
        if repo is not None:
            command += ["--repo", repo]
        result = subprocess.run(
            [*command, *flags],
            capture_output=True,
            text=True,
            env=environment,
            cwd=working_directory,
            check=False,
        )
        calls = call_log.read_text(encoding="utf-8") if call_log.exists() else ""
        return result, calls


def github_issue(number: int, backlog_id: str, **overrides: object) -> dict[str, object]:
    issue: dict[str, object] = {
        "number": number,
        "title": f"[{backlog_id}] Anything",
        "state": "OPEN",
        "body": "",
        "milestone": None,
        "labels": [],
    }
    issue.update(overrides)
    return issue


WRITE_CALLS = ("label create", "issue close", "issue create", "issue edit", "--method POST", "-X PATCH")


class BacklogValidationTests(unittest.TestCase):
    def test_minimal_backlog_is_valid(self) -> None:
        self.assertEqual(validate_backlog_data(valid_backlog()), [])

    def test_structural_and_relational_failures_are_rejected(self) -> None:
        cases: list[tuple[str, dict[str, object], str]] = []

        missing_dependency_list = valid_backlog()
        first_issue(missing_dependency_list).pop("depends_on")
        cases.append(
            (
                "missing dependency list",
                missing_dependency_list,
                "missing required field 'depends_on'",
            )
        )

        empty_title = valid_backlog()
        first_issue(empty_title)["title"] = ""
        cases.append(("empty title", empty_title, "title: expected a non-empty string"))

        duplicate_label = valid_backlog()
        first_issue(duplicate_label)["labels"] = ["type:test", "type:test"]
        cases.append(("duplicate label", duplicate_label, "duplicate values are not allowed"))

        bad_reference = valid_backlog()
        first_issue(bad_reference)["depends_on"] = ["SCP-999"]
        cases.append(("unknown dependency", bad_reference, "unknown dependency 'SCP-999'"))

        bad_color = valid_backlog()
        labels = bad_color["labels"]
        assert isinstance(labels, list) and isinstance(labels[0], dict)
        labels[0]["color"] = "blue"
        cases.append(("bad color", bad_color, "expected exactly six hexadecimal digits"))

        unknown_field = valid_backlog()
        first_issue(unknown_field)["surprise"] = True
        cases.append(("unknown field", unknown_field, "unknown field 'surprise'"))

        empty_backlog = valid_backlog()
        empty_backlog["issues"] = []
        cases.append(("empty backlog", empty_backlog, "must contain at least one issue"))

        for name, backlog, expected in cases:
            with self.subTest(name=name):
                errors = validate_backlog_data(backlog)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_duplicate_ids_and_dependency_cycles_are_rejected(self) -> None:
        backlog = valid_backlog()
        issues = backlog["issues"]
        assert isinstance(issues, list)
        second = copy.deepcopy(first_issue(backlog))
        second["title"] = "Second issue"
        issues.append(second)
        errors = validate_backlog_data(backlog)
        self.assertTrue(any("duplicate issue id 'SCP-001'" in error for error in errors), errors)

        cyclic = valid_backlog()
        cyclic_issues = cyclic["issues"]
        assert isinstance(cyclic_issues, list)
        second = copy.deepcopy(first_issue(cyclic))
        second["id"] = "SCP-002"
        second["depends_on"] = ["SCP-001"]
        first_issue(cyclic)["depends_on"] = ["SCP-002"]
        cyclic_issues.append(second)
        errors = validate_backlog_data(cyclic)
        self.assertIn("Dependency cycle: SCP-001 -> SCP-002 -> SCP-001", errors)

    def test_done_state_and_done_label_must_agree(self) -> None:
        self.assertEqual(validate_backlog_data(done_backlog()), [])

        label_only = done_backlog()
        first_issue(label_only).pop("state")
        errors = validate_backlog_data(label_only)
        self.assertTrue(any("label 'status:done' requires state 'done'" in e for e in errors), errors)

        state_only = done_backlog()
        first_issue(state_only)["labels"] = ["type:test"]
        errors = validate_backlog_data(state_only)
        self.assertTrue(any("state 'done' requires the 'status:done' label" in e for e in errors), errors)

    def test_placeholder_ids_and_dependencies_on_them_are_accepted(self) -> None:
        self.assertEqual(validate_backlog_data(placeholder_backlog()), [])

    def test_duplicate_and_malformed_placeholder_ids_are_rejected(self) -> None:
        duplicate = placeholder_backlog()
        issues = duplicate["issues"]
        assert isinstance(issues, list)
        issues.append(copy.deepcopy(issues[1]))
        errors = validate_backlog_data(duplicate)
        self.assertTrue(any(f"duplicate issue id 'SCP-{NEW}-serve-queue'" in e for e in errors), errors)
        for malformed in (f"SCP-{NEW}-Serve", f"SCP-{NEW}-", f"SCP-{NEW}-serve--queue", f"SCP-{NEW}-serve_queue"):
            with self.subTest(malformed=malformed):
                backlog = valid_backlog()
                first_issue(backlog)["id"] = malformed
                errors = validate_backlog_data(backlog)
                self.assertTrue(any(".id: expected SCP- followed by" in e for e in errors), errors)

    def test_strict_rejects_placeholder_ids_and_nothing_else(self) -> None:
        errors = validate_backlog_data(placeholder_backlog(), strict=True)
        self.assertEqual(len(errors), 1, errors)
        self.assertIn(f"'SCP-{NEW}-serve-queue'", errors[0])
        self.assertIn("scripts/assign_ids.py", errors[0])
        self.assertEqual(validate_backlog_data(valid_backlog(), strict=True), [])

    def test_the_command_line_takes_strict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            (root / "backlog").mkdir()
            shutil.copy2(ROOT / "scripts" / "validate_backlog.py", root / "scripts")
            (root / "backlog" / "issues.json").write_text(json.dumps(placeholder_backlog()), encoding="utf-8")
            script = str(root / "scripts" / "validate_backlog.py")
            lenient = subprocess.run([sys.executable, script], capture_output=True, text=True, check=False)
            self.assertEqual(lenient.returncode, 0, lenient.stdout + lenient.stderr)
            strict = subprocess.run([sys.executable, script, "--strict"], capture_output=True, text=True, check=False)
            self.assertNotEqual(strict.returncode, 0, strict.stdout)
            self.assertIn(f"SCP-{NEW}-serve-queue", strict.stdout)

    def test_invalid_record_keeps_later_source_indexes(self) -> None:
        backlog = valid_backlog()
        issue = first_issue(backlog)
        issue["title"] = ""
        backlog["issues"] = ["not an object", issue]
        errors = validate_backlog_data(backlog)
        self.assertIn("backlog.issues[0]: expected an object with string keys", errors)
        self.assertIn("backlog.issues[1].title: expected a non-empty string", errors)

    def test_loader_rejects_malformed_and_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            malformed = root / "malformed.json"
            malformed.write_text("{", encoding="utf-8")
            with self.assertRaises(BacklogValidationError):
                load_validated_backlog(malformed)
            with self.assertRaises(BacklogValidationError):
                load_validated_backlog(root / "missing.json")

    def test_loader_rejects_duplicate_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate.json"
            text = json.dumps(valid_backlog())
            path.write_text(f'{text[:-1]}, "issues": []}}', encoding="utf-8")
            with self.assertRaises(BacklogValidationError) as raised:
                load_validated_backlog(path)
            self.assertTrue(
                any("duplicate JSON key 'issues'" in error for error in raised.exception.errors),
                raised.exception.errors,
            )

    def test_sync_exits_before_gh_when_backlog_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            backlog = root / "backlog"
            binaries = root / "bin"
            scripts.mkdir()
            backlog.mkdir()
            binaries.mkdir()
            shutil.copy2(ROOT / "scripts" / "sync_github_issues.py", scripts)
            shutil.copy2(ROOT / "scripts" / "validate_backlog.py", scripts)
            shutil.copy2(ROOT / "scripts" / "git_remote.py", scripts)
            (backlog / "issues.json").write_text("{}", encoding="utf-8")

            marker = root / "gh-was-called"
            fake_gh = binaries / "gh"
            fake_gh.write_text('#!/bin/sh\n: > "$GH_MARKER"\nexit 99\n', encoding="utf-8")
            fake_gh.chmod(fake_gh.stat().st_mode | stat.S_IXUSR)
            environment = os.environ.copy()
            environment["PATH"] = f"{binaries}{os.pathsep}{environment.get('PATH', '')}"
            environment["GH_MARKER"] = str(marker)

            result = subprocess.run(
                [sys.executable, str(scripts / "sync_github_issues.py"), "--repo", "owner/repo"],
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Backlog validation failed", result.stderr)
            self.assertFalse(marker.exists(), "sync invoked gh before validating the backlog")

    def test_apply_refuses_unconfirmed_closures_before_any_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            backlog = root / "backlog"
            binaries = root / "bin"
            scripts.mkdir()
            backlog.mkdir()
            binaries.mkdir()
            shutil.copy2(ROOT / "scripts" / "sync_github_issues.py", scripts)
            shutil.copy2(ROOT / "scripts" / "validate_backlog.py", scripts)
            shutil.copy2(ROOT / "scripts" / "git_remote.py", scripts)
            (backlog / "issues.json").write_text(
                json.dumps(valid_backlog()), encoding="utf-8"
            )

            call_log = root / "gh-calls"
            fake_gh = binaries / "gh"
            fake_gh.write_text(
                """#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\n' '[{"number":7,"title":"[SCP-999] Removed","state":"OPEN","body":"","milestone":null,"labels":[]}]'
fi
exit 0
""",
                encoding="utf-8",
            )
            fake_gh.chmod(fake_gh.stat().st_mode | stat.S_IXUSR)
            environment = os.environ.copy()
            environment["PATH"] = f"{binaries}{os.pathsep}{environment.get('PATH', '')}"
            environment["GH_LOG"] = str(call_log)

            result = subprocess.run(
                [
                    sys.executable,
                    str(scripts / "sync_github_issues.py"),
                    "--repo",
                    "owner/repo",
                    "--apply",
                ],
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not exactly match --expect-close", result.stderr)
            calls = call_log.read_text(encoding="utf-8")
            self.assertIn("issue list", calls)
            for write_call in (
                "label create",
                "issue close",
                "issue create",
                "issue edit",
                "--method POST",
                "-X PATCH",
            ):
                self.assertNotIn(write_call, calls)

    def test_dry_run_plans_done_and_removed_closures_apart(self) -> None:
        result, calls = run_sync(
            done_backlog(),
            [github_issue(7, "SCP-001"), github_issue(9, "SCP-999")],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY RUN", result.stdout)
        self.assertIn("close (done): 1 -> SCP-001", result.stdout)
        self.assertIn("close (removed): 1 -> SCP-999", result.stdout)
        # The done entry's label is not yet on GitHub, so the plan updates it too.
        self.assertIn("update: 1 -> SCP-001", result.stdout)
        self.assertIn("issue list", calls)
        for write_call in WRITE_CALLS:
            self.assertNotIn(write_call, calls)

    def test_dry_run_plans_a_done_entry_with_no_issue_as_create_then_close(self) -> None:
        result, calls = run_sync(done_backlog(), [])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("create: 1 -> SCP-001", result.stdout)
        self.assertIn("close (done): 1 -> SCP-001", result.stdout)
        self.assertIn("close (removed): 0", result.stdout)
        for write_call in WRITE_CALLS:
            self.assertNotIn(write_call, calls)

    def test_apply_refuses_unconfirmed_done_closure_before_any_write(self) -> None:
        for name, github_issues in (
            ("done entry with an open issue", [github_issue(7, "SCP-001")]),
            ("done entry with no issue yet", []),
        ):
            with self.subTest(name=name):
                result, calls = run_sync(done_backlog(), github_issues, "--apply")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("does not exactly match --expect-close", result.stderr)
                self.assertIn("Planned: SCP-001", result.stderr)
                self.assertIn("issue list", calls)
                for write_call in WRITE_CALLS:
                    self.assertNotIn(write_call, calls)

    def test_apply_refuses_when_only_one_of_two_closures_is_expected(self) -> None:
        result, calls = run_sync(
            done_backlog(),
            [github_issue(7, "SCP-001"), github_issue(9, "SCP-999")],
            "--apply",
            "--expect-close",
            "SCP-999",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Planned: SCP-001 SCP-999", result.stderr)
        self.assertIn("Expected: SCP-999", result.stderr)
        for write_call in WRITE_CALLS:
            self.assertNotIn(write_call, calls)

    def test_apply_closes_a_done_issue_as_completed_after_labelling_it(self) -> None:
        result, calls = run_sync(
            done_backlog(),
            [github_issue(7, "SCP-001")],
            "--apply",
            "--expect-close",
            "SCP-001",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("APPLIED", result.stdout)
        lines = calls.splitlines()
        edit = next(line for line in lines if line.startswith("issue edit 7 "))
        self.assertIn("--add-label status:done", edit)
        close = next(line for line in lines if line.startswith("issue close 7 "))
        self.assertIn("--reason completed", close)
        self.assertIn("Done in #207", close)
        self.assertLess(lines.index(edit), lines.index(close))
        self.assertNotIn("not planned", calls)

    def test_apply_creates_then_closes_a_done_entry_that_had_no_issue(self) -> None:
        result, calls = run_sync(
            done_backlog(notes="Landed in 1ee7daa, defaced nothing, ticket 1234567."),
            [],
            "--apply",
            "--expect-close",
            "SCP-001",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = calls.splitlines()
        create = next(line for line in lines if line.startswith("issue create "))
        self.assertIn("--label status:done", create)
        close = next(line for line in lines if line.startswith("issue close 8 "))
        self.assertIn("--reason completed", close)
        # The digest, not the word or the number that also look hexadecimal.
        self.assertIn("Done in 1ee7daa", close)
        self.assertLess(lines.index(create), lines.index(close))

    def test_removed_closure_still_closes_as_not_planned(self) -> None:
        result, calls = run_sync(
            valid_backlog(),
            [github_issue(9, "SCP-999")],
            "--apply",
            "--expect-close",
            "SCP-999",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        close = next(line for line in calls.splitlines() if line.startswith("issue close 9 "))
        self.assertIn("--reason not planned", close)
        self.assertIn(
            "Removed from the backlog. See docs/11-open-decisions.md for the decision that removed it.", close
        )
        self.assertNotIn("completed", close)


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
        "backlog/issues.json": json.dumps(valid_backlog(), indent=2) + "\n",
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



class GithubRepositoryFromRemote(unittest.TestCase):
    """`owner/repository` is read from whichever remote form the checkout holds."""

    def test_reads_both_url_forms(self) -> None:
        for url in (
            "git@github.com:perbostudios/perbo.git",
            "ssh://git@github.com/perbostudios/perbo.git",
            "https://github.com/perbostudios/perbo.git",
            "https://github.com/perbostudios/perbo",
            "  git@github.com:perbostudios/perbo.git\n",
        ):
            with self.subTest(url=url):
                self.assertEqual(github_repository_from_remote(url), "perbostudios/perbo")

    def test_refuses_a_remote_that_is_not_github(self) -> None:
        for url in ("git@gitlab.com:perbostudios/perbo.git", "/srv/git/perbo.git", ""):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    github_repository_from_remote(url)


class SyncRepositoryDefault(unittest.TestCase):
    """With no --repo, the sync script works on the repository `origin` names."""

    def test_reads_the_repository_from_the_origin_remote(self) -> None:
        result, calls = run_sync(
            valid_backlog(), [], repo=None, origin="git@github.com:acme/widgets.git"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("acme/widgets", calls)

    def test_writes_where_the_remote_pushes_when_that_differs_from_where_it_fetches(self) -> None:
        result, calls = run_sync(
            valid_backlog(),
            [],
            repo=None,
            origin="git@github.com:acme/mirror.git",
            push_origin="git@github.com:acme/widgets.git",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("acme/widgets", calls)
        self.assertNotIn("acme/mirror", calls)

    def test_ignores_the_repository_the_command_was_run_from(self) -> None:
        result, calls = run_sync(
            valid_backlog(),
            [],
            repo=None,
            origin="git@github.com:acme/widgets.git",
            run_from_origin="git@github.com:someone/unrelated.git",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("acme/widgets", calls)
        self.assertNotIn("someone/unrelated", calls)

    def test_says_what_to_pass_when_origin_is_not_a_github_remote(self) -> None:
        result, _ = run_sync(valid_backlog(), [], repo=None, origin="/srv/git/widgets.git")
        self.assertEqual(result.returncode, 1)
        self.assertIn("--repo", result.stderr)


if __name__ == "__main__":
    unittest.main()
