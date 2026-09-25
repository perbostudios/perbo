import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { matchesListEntry } from "./admission.js";
import { codexCommandDecision } from "./codex/index.js";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "./profile.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * `git rev-parse`, `git merge-base`, `git ls-files` and `date` are on the
 * executor's allow list, judged here against the profile's own lists.
 *
 * Each writes nothing under any flag, so the hook takes one as grounds to admit
 * its line, as it takes `echo`, bare or inside a substitution, beside other
 * listed commands; Codex admits every line whose commands are all listed.
 * Without the entry, the substitution's segment is one the hook cannot vouch
 * for and Codex refuses.
 */
const ROOT = realpathSync(scratch("perbo-orientation-"));
mkdirSync(join(ROOT, "src"));

const state: PreToolGuardState = {
  root: ROOT,
  cwd: ROOT,
  tmpdir: null,
  paths_allowed: ["**"],
  paths_prohibited: [],
  allow_list: [...DEFAULT_COMMAND_ALLOW_LIST],
  deny_list: [...DEFAULT_COMMAND_DENY_LIST],
};

const claude = (line: string) =>
  judgePreToolCall(
    { tool_name: "Bash", tool_use_id: "t", tool_input: { command: line } },
    state,
    new Date(0),
  ).decision;

const codex = (line: string) => codexCommandDecision(line, ROOT, state).decision;

/** The prefix match the agent's own permission layer applies to the same list. */
const admittedByName = (command: string): boolean =>
  DEFAULT_COMMAND_ALLOW_LIST.some((entry) => matchesListEntry(entry, "Bash", command));

const BARE = [
  "git rev-parse HEAD",
  "git rev-parse --git-dir",
  "git rev-parse --show-toplevel",
  "git merge-base HEAD main",
  "git merge-base --is-ancestor HEAD main",
  "git ls-files",
  "git ls-files --error-unmatch src/a.ts",
  "date",
  "date -u +%Y-%m-%dT%H:%M:%SZ",
];

/** Substitutions, beside `echo` and beside other listed commands alone. */
const SUBSTITUTED = [
  'echo "$(git rev-parse HEAD)"',
  'echo "base $(git merge-base HEAD main)"',
  "echo $(git ls-files)",
  'echo "stamped $(date -u +%s)"',
  "git diff $(git merge-base HEAD main)",
  "wc -l $(git ls-files)",
  "cat <<EOF\nstamped $(date)\nEOF",
  "git log $(git rev-parse HEAD)",
];

describe("the read-only orientation commands", () => {
  for (const line of BARE) {
    it(`admits ${line} bare`, () => {
      expect(admittedByName(line), line).toBe(true);
      expect(claude(line).answer, line).toBe("allow");
      expect(codex(line), line).toBe("allowed");
    });
  }

  for (const line of SUBSTITUTED) {
    it(`admits ${JSON.stringify(line)} on the hook and on Codex`, () => {
      expect(claude(line).answer, line).toBe("allow");
      expect(codex(line), line).toBe("allowed");
    });
  }
});

describe("what stays as it was", () => {
  for (const line of ["git branch -D main", "git push origin HEAD", 'echo "$(git push origin HEAD)"']) {
    it(`refuses ${line} by the deny list`, () => {
      expect(claude(line)).toMatchObject({ answer: "deny", rule: "command_deny_list" });
      expect(codex(line)).toBe("denied");
    });
  }

  it("leaves a line of other listed commands to the outer list", () => {
    // `git diff`, `git log` and `git show` write with `--output`, and `git
    // status` refreshes the index, so none of them is grounds on its own.
    for (const line of ["ls -la", "git status", "git diff", "git log --oneline", "cat src/a.ts | wc -l"]) {
      expect(admittedByName(line.split(" | ")[0]!), line).toBe(true);
      expect(claude(line), line).toMatchObject({ answer: "defer", decision: "allowed" });
      expect(codex(line), line).toBe("allowed");
    }
  });

  it("refuses a denied command inside an orientation command's line", () => {
    for (const line of ["git diff $(git branch --show-current)", "git rev-parse HEAD && git push"]) {
      expect(claude(line), line).toMatchObject({ answer: "deny", rule: "command_deny_list" });
      expect(codex(line), line).toBe("denied");
    }
  });

  it("does not vouch for an unlisted command beside an orientation command", () => {
    for (const line of ["git rev-parse HEAD && script -q /dev/null node x.js", "perl -e 1 $(date)"]) {
      expect(claude(line).answer, line).toBe("defer");
      expect(codex(line), line).toBe("denied");
    }
  });

  it("refuses a write outside the worktree on an orientation command's line", () => {
    expect(claude("date > ~/stamp.txt")).toMatchObject({ answer: "deny", rule: "write_outside_worktree" });
    expect(codex("date > ~/stamp.txt")).toBe("denied");
    const output = "git diff --output=../x $(git merge-base HEAD main)";
    expect(claude(output)).toMatchObject({ answer: "deny", rule: "write_outside_worktree" });
    expect(codex(output)).toBe("denied");
  });

  it("leaves `mktemp` unlisted, since it creates a file", () => {
    expect(admittedByName("mktemp")).toBe(false);
    expect(claude("mktemp").answer).toBe("defer");
    expect(codex("mktemp")).toBe("denied");
    expect(codex('echo "$(mktemp)"')).toBe("denied");
  });
});

describe("`date` setting the clock", () => {
  for (const line of [
    'date -s "2020-01-01 00:00"',
    "date --set=2020-01-01",
    'echo "$(date -s 2020-01-01)"',
    // Every spelling `date` reads as setting the clock is its `--set` entry's.
    "date -us 2020-01-01",
    "date -su 2020-01-01",
    "date -ius 2020-01-01",
    "date --se=2020-01-01",
    "date --se 2020-01-01",
    "date --s=2020-01-01",
    "date 01021230",
    "date -u 010212302020.30",
    "/bin/date -us 2020-01-01",
    "env date -us 2020-01-01",
    'echo "$(date --se=2020-01-01)"',
  ]) {
    it(`refuses ${line} by the deny list`, () => {
      expect(claude(line)).toMatchObject({ answer: "deny", rule: "command_deny_list" });
      expect(codex(line)).toBe("denied");
    });
  }

  for (const line of [
    "date",
    "date -u",
    "date +%s",
    "date -d yesterday",
    "date -d 2020-01-01 +%s",
    "date -r src",
    "date --iso-8601",
    "date -Iseconds",
    "date > src/stamp.txt",
  ]) {
    it(`admits ${line}, which reads the clock`, () => {
      expect(claude(line).decision, line).toBe("allowed");
      expect(codex(line), line).toBe("allowed");
    });
  }
});
