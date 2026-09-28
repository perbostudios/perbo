import { describe, expect, it } from "vitest";
import { ADMISSION_RULES, matchesListEntry } from "@perbo/runner";
import { INTERVIEW_DENIED_TOOLS, interviewGuardState, judgeInterviewCall } from "./index.js";

/**
 * The Architect lists branches — to see the one a stopped loop left — and
 * changes none (D-102). The session's `disallowedTools` does not name the
 * verb, its read-only shapes carry it, and the runner's guard, which judges
 * the line first, refuses every form of `git branch` that changes a branch.
 * One judgement answers the chat on Claude Code, Codex and OpenCode alike.
 */

const state = interviewGuardState({
  repositoryRoot: "/work/tree",
  storeFolder: ".perbo",
  specFolder: "specs",
  workFolder: "specs/the-work",
  adrFolder: "docs/adr",
});
const judged = (command: string) => judgeInterviewCall({ tool_name: "Bash", tool_input: { command } }, state);

describe("the chat listing branches", () => {
  for (const command of [
    "git branch -a -v",
    "git branch",
    "git branch -vv",
    "git branch --list 'perbo/*'",
    "git branch -r --merged main",
    "git branch --show-current",
    "git branch --contains HEAD",
    "git branch --sort=-committerdate --format='%(refname:short)'",
    "git branch -a | head -20",
  ]) {
    it(`admits ${JSON.stringify(command)}`, () => {
      expect(INTERVIEW_DENIED_TOOLS.some((entry) => matchesListEntry(entry, "Bash", command)), command).toBe(false);
      expect(judged(command), command).toMatchObject({ allow: true, rule: null });
    });
  }
});

describe("the chat changing a branch", () => {
  for (const command of [
    "git branch -D perbo/left",
    "git branch --delete perbo/left",
    "git branch -m perbo/left perbo/right",
    "git branch -c perbo/left perbo/copy",
    "git branch -u origin/main",
    "git branch --unset-upstream",
    "git branch --edit-description",
    "git branch -f perbo/left HEAD",
    "git branch --track perbo/new origin/main",
    "git branch --create-reflog perbo/new",
    "git branch perbo/new",
    "git branch -- perbo/new",
    "X=-D; git branch $X perbo/left",
    "cat \"$(git branch perbo/new)\"",
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(judged(command), command).toMatchObject({ allow: false, rule: ADMISSION_RULES.git_branch_write });
    });
  }
});

describe("the chat defining a git alias", () => {
  for (const command of [
    "git -c alias.x='branch -D' x perbo/left",
    'git -c "alias.x=branch -D" x perbo/left',
    "git --config-env=alias.x=VAR x perbo/left",
    "GIT_CONFIG_PARAMETERS=\"'alias.x=branch -D'\" git x perbo/left",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='branch -D' git x perbo/left",
    "git config alias.x 'branch -D'",
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(judged(command), command).toMatchObject({ allow: false, rule: ADMISSION_RULES.git_alias });
    });
  }
});

describe("the chat pointing git at a repository or config file of its own", () => {
  for (const command of [
    "HOME=/tmp/h git log",
    "XDG_CONFIG_HOME=/tmp/c git log",
    "GIT_DIR=/tmp/r/.git git log",
    "env GIT_WORK_TREE=/tmp/w git status",
    "export GIT_COMMON_DIR=/tmp/r/.git; git log",
    "GIT_CEILING_DIRECTORIES=/ git log",
    "git --git-dir=/tmp/r/.git log",
    "git --work-tree=/tmp/w status",
    "git --namespace=other log",
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(judged(command), command).toMatchObject({ allow: false, rule: ADMISSION_RULES.git_repository_redirect });
    });
  }

  it("does not refuse a variable that removes configuration by this rule", () => {
    for (const command of ["GIT_CONFIG_NOSYSTEM=1 git log", "GIT_TERMINAL_PROMPT=0 git status"]) {
      expect(judged(command).rule, command).not.toBe(ADMISSION_RULES.git_repository_redirect);
    }
  });
});

describe("the chat running a git verb git does not define", () => {
  // `-C` into the chat's own spec folder: a directory it could have made a
  // repository in, and one the write rule admits, so the verb is what is judged.
  for (const command of ["git x", "git -C specs/the-work x", "sh -c 'git x'", 'cat "$(git x)"', "git st"]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(judged(command), command).toMatchObject({ allow: false, rule: ADMISSION_RULES.git_verb_unknown });
    });
  }

  it("admits git's help for one, which only prints", () => {
    for (const command of ["git help x", "git x --help"]) {
      expect(judged(command).rule, command).not.toBe(ADMISSION_RULES.git_verb_unknown);
    }
  });
});

describe("the chat setting git's credential environment inside a nested shell", () => {
  for (const command of [
    'sh -c "GIT_ASKPASS=/tmp/askpass git log"',
    "bash -c 'GIT_SSH_COMMAND=ssh git log'",
    'cat "$(GIT_ASKPASS=/tmp/askpass git log)"',
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(judged(command), command).toMatchObject({ allow: false, rule: ADMISSION_RULES.git_credential_config });
    });
  }
});
