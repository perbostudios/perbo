import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { ADMISSION_RULES } from "./admission.js";
import { codexCommandDecision } from "./codex/index.js";
import { opencodeDecision } from "./opencode/index.js";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "./profile.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A line that runs git and points it at a repository or a config file the
 * line picks: an agent-written `.gitconfig` under a redirected `HOME` defines
 * aliases the alias rule never sees, so `HOME=/tmp/h git x main` can run any
 * verb. Refused as `git_repository_redirect` on Claude Code's hook, Codex's
 * approvals and OpenCode's permission requests alike; a variable that removes
 * configuration, and one set on a line that runs no git, stay admitted.
 */
const ROOT = realpathSync(scratch("perbo-git-repository-"));

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
  judgePreToolCall({ tool_name: "Bash", tool_use_id: "t", tool_input: { command: line } }, state, new Date(0))
    .decision;
const codex = (line: string) => codexCommandDecision(line, ROOT, state);
const opencode = (line: string) =>
  opencodeDecision({ toolCallId: "t", kind: "execute", rawInput: { command: line, cwd: ROOT } }, state);

const REDIRECTS = [
  // Each variable, in front of git.
  "HOME=/tmp/h git x main",
  "XDG_CONFIG_HOME=/tmp/c git x main",
  "GIT_DIR=/tmp/r/.git git x main",
  "GIT_WORK_TREE=. git status",
  "GIT_COMMON_DIR=/tmp/r/.git git log",
  "GIT_CEILING_DIRECTORIES=/ git log",
  // Handed to `env`, past its options, or set for the segments after it.
  "env HOME=/tmp/h git x main",
  "env -i HOME=/tmp/h git x main",
  "env -u PAGER HOME=/tmp/h git x main",
  "export HOME=/tmp/h; git x main",
  "HOME=/tmp/h; git x main",
  "declare -x XDG_CONFIG_HOME=/tmp/c; git x main",
  "export GIT_DIR=/tmp/r/.git && git log",
  // env's options read as getopt reads them: a cluster letter that takes a
  // value takes the rest of its word, or the next word where nothing follows.
  "env -iu X HOME=/tmp/h git status",
  "env -vu X HOME=/tmp/h git status",
  "env -iC /tmp HOME=/tmp/h git status",
  "env -uX HOME=/tmp/h git status",
  "env -a name HOME=/tmp/h git status",
  // An escaped quote opens nothing, a single-quoted backslash escapes
  // nothing, and a double-quoted one escapes the quote after it.
  "X=\\' HOME=/tmp/h git status \\'",
  "X='a\\' HOME=/tmp/h git status",
  'X="a\\" " HOME=/tmp/h git status',
  // Made by the shell's own assigning commands, whatever their options: a
  // variable the environment already exports keeps its export.
  "declare -gx HOME=/tmp/h; git status",
  "declare HOME=/tmp/h; git status",
  "local -x HOME=/tmp/h; git status",
  "readonly HOME=/tmp/h; git status",
  "export -- HOME=/tmp/h; git status",
  "export PAGER HOME=/tmp/h; git status",
  // `env` and the assigning builtins are handed their words as the shell
  // hands them over, quotes and backslashes removed.
  'env "HOME=/tmp/h" git status',
  "env H\\OME=/tmp/h git status",
  "env -i 'XDG_CONFIG_HOME=/tmp/c' git status",
  "export 'HOME=/tmp/h'; git status",
  'declare -x "HOME=/tmp/h"; git status',
  // `env` reads every operand that holds an `=` as an assignment, whatever its name.
  "env A+=1 HOME=/tmp/h git status",
  "env 'A B=1' HOME=/tmp/h git status",
  "env 1=2 HOME=/tmp/h git status",
  // `NAME+=value` appends to NAME, in front of git and through a builtin.
  "HOME+=/x git status",
  "export HOME+=/x; git status",
  "GIT_DIR+=/x git log",
  // Through a wrapper, a nested shell and a substitution.
  "HOME=/tmp/h sh -c 'git x main'",
  "sh -c 'HOME=/tmp/h git x main'",
  'echo "$(HOME=/tmp/h git x main)"',
  "HOME=/tmp/h env git x main",
  // git's own global options.
  "git --git-dir=/tmp/r/.git x main",
  "git --git-dir /tmp/r/.git log",
  "git --work-tree=. status",
  "git --work-tree . status",
  "git --namespace=other log",
  "git -C . --git-dir=/tmp/r/.git log",
  "git --no-pager --work-tree=/tmp/w status",
  "git --weird --git-dir=/tmp/r/.git log",
  "/usr/bin/git --git-dir=/tmp/r/.git log",
];

describe("git pointed at a repository or config file the line picks", () => {
  for (const line of REDIRECTS) {
    it(`refuses ${JSON.stringify(line)}`, () => {
      expect(claude(line), line).toMatchObject({
        decision: "denied",
        answer: "deny",
        rule: ADMISSION_RULES.git_repository_redirect,
      });
      expect(codex(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_repository_redirect });
      expect(opencode(line), line).toMatchObject({
        decision: "denied",
        rule: ADMISSION_RULES.git_repository_redirect,
      });
    });
  }

  it("says why in one sentence", () => {
    expect(claude("HOME=/tmp/h git x main").reason).toBe(
      "HOME points git at a repository or config file the line picks rather than the worktree's own, " +
        "whose aliases the line does not show",
    );
  });
});

describe("what the rule leaves to the others", () => {
  for (const line of ["git rev-parse --git-dir", "git log --oneline", "echo \\'hi\\'"]) {
    it(`admits ${JSON.stringify(line)} on every executor`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).decision, line).toBe("allowed");
      expect(opencode(line), line).toEqual({ decision: "allowed" });
    });
  }

  for (const line of [
    "GIT_CONFIG_NOSYSTEM=1 git log --oneline",
    "GIT_TERMINAL_PROMPT=0 git status",
    "GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git diff",
  ]) {
    it(`does not refuse ${JSON.stringify(line)}, which removes configuration`, () => {
      // No refusal on the hook. On Codex and OpenCode a leading assignment
      // puts the line outside every prefix entry, so the allow list refuses it.
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).rule, line).not.toBe(ADMISSION_RULES.git_repository_redirect);
      expect(opencode(line), line).not.toMatchObject({ rule: ADMISSION_RULES.git_repository_redirect });
    });
  }

  for (const line of [
    "env -iu X git status",
    "declare -g FOO=1; git status",
    // A quoted name in front of a program is that program's name, and assigns nothing.
    "'HOME=/x' git status",
    "H\\OME=/x git status",
    // `env` sets `HOME+`, and leaves `HOME` as it was.
    "env HOME+=/x git status",
    "export FOO+=x; git log",
  ]) {
    it(`admits ${JSON.stringify(line)} on the hook, where the allow list is what decides it`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).rule, line).not.toBe(ADMISSION_RULES.git_repository_redirect);
      expect(opencode(line), line).not.toMatchObject({ rule: ADMISSION_RULES.git_repository_redirect });
    });
  }

  it("leaves a HOME on a line that runs no git to the other rules", () => {
    for (const line of ["HOME=/tmp/h node scripts/build.js", "sh -c 'HOME=/tmp/h node x.js'"]) {
      expect(claude(line).rule, line).not.toBe(ADMISSION_RULES.git_repository_redirect);
    }
  });

  for (const line of ["env 'A=1' pnpm test", "export PATH+=:/x; pnpm test", "env 'HOME=/tmp/h' pnpm test"]) {
    it(`admits ${JSON.stringify(line)} on the hook, which runs no git`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).rule, line).not.toBe(ADMISSION_RULES.git_repository_redirect);
      expect(opencode(line), line).not.toMatchObject({ rule: ADMISSION_RULES.git_repository_redirect });
    });
  }

  it("leaves a HOME appended to on a line that runs no git to the other rules", () => {
    for (const line of ["HOME+=/x node scripts/build.js"]) {
      expect(claude(line).rule, line).not.toBe(ADMISSION_RULES.git_repository_redirect);
    }
  });

  for (const line of ["git -C", "git status; git -C"]) {
    it(`reads ${JSON.stringify(line)}, whose last option has no value, on every executor`, () => {
      // git refuses the line and runs nothing, and the guard reads it rather than failing.
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).rule, line).not.toBe(ADMISSION_RULES.git_repository_redirect);
      expect(opencode(line), line).not.toMatchObject({ rule: ADMISSION_RULES.git_repository_redirect });
    });
  }

  it("leaves `git -C . log` to the allow list: no refusal on the hook, the allow list's on Codex and OpenCode", () => {
    expect(claude("git -C . log")).toMatchObject({ decision: "allowed", rule: null });
    expect(codex("git -C . log")).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.allow_list });
    expect(opencode("git -C . log")).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.allow_list });
  });
});
