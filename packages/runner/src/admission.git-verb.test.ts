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
 * A git verb git does not define runs what an alias — a nested repository's
 * own configuration among the places one comes from — or an external
 * `git-<x>` command says, none of which is on the line. So a verb outside
 * git's own table is refused (`git_verb_unknown`) wherever it stands, on
 * Claude Code's hook, Codex's approvals and OpenCode's permission requests
 * alike; a verb git defines goes on to the rules that judge it.
 *
 * And the credential rule's environment is read in every segment a line
 * holds, so an assignment in front of git inside a `sh -c` body or a
 * substitution is refused as the same assignment at the top level is.
 */
const ROOT = realpathSync(scratch("perbo-git-verb-"));

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

const UNKNOWN = [
  "git x",
  "git x main",
  "git -C . x",
  "git -C sub/repo x main",
  "git --no-pager x",
  "git -c color.ui=false x",
  "/usr/bin/git x",
  "env git x",
  "sh -c 'git x'",
  "cd sub/repo && git x main",
  'echo "$(git x)"',
  "cat <(git x)",
  "git st",
  "git Log",
  "git x main --help",
  "git $VERB main",
  "V=log; git $V",
  "git --weird log",
  // Verbs a git later than the table's adds: refused until the table names them.
  "git replay --onto main HEAD~1",
  "git refs verify",
];

describe("a git verb git does not define", () => {
  for (const line of UNKNOWN) {
    it(`refuses ${JSON.stringify(line)}`, () => {
      expect(claude(line), line).toMatchObject({
        decision: "denied",
        answer: "deny",
        rule: ADMISSION_RULES.git_verb_unknown,
      });
      expect(codex(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_verb_unknown });
      expect(opencode(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_verb_unknown });
    });
  }

  it("says why in one sentence", () => {
    expect(claude("git x").reason).toBe(
      "git x is not a verb git itself defines, so what runs is an alias or an external git-x command " +
        "the line does not show",
    );
  });
});

describe("a verb git defines, and a line that runs none", () => {
  for (const line of [
    "git status",
    "git log --oneline",
    "git diff --stat",
    "git show HEAD",
    "git branch -a -v",
    "git rev-parse HEAD",
    "git ls-files",
    "git help x",
    "git help stage",
    "git x --help",
  ]) {
    it(`admits ${JSON.stringify(line)} on every executor`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      if (line.startsWith("git help") || line.endsWith("--help")) return;
      expect(codex(line).decision, line).toBe("allowed");
      expect(opencode(line), line).toEqual({ decision: "allowed" });
    });
  }

  for (const line of [
    "git",
    "git --version",
    "git --exec-path",
    "git --list-cmds=builtins",
    "git stage src/a.ts",
    "git submodule status",
    "git bisect log",
    "git --no-replace-objects log",
    "git -C . log",
    "git -P log",
    "git --no-literal-pathspecs log",
    "git --shallow-file .git/shallow log",
  ]) {
    it(`does not refuse ${JSON.stringify(line)} by this rule`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).rule, line).not.toBe(ADMISSION_RULES.git_verb_unknown);
    });
  }

  it("leaves a known verb to the rules that judge it", () => {
    expect(claude("git push origin HEAD")).toMatchObject({ rule: ADMISSION_RULES.deny_list });
    expect(claude("git branch -D main")).toMatchObject({ rule: ADMISSION_RULES.git_branch_write });
  });
});

const NESTED_CREDENTIAL = [
  'sh -c "GIT_ASKPASS=/tmp/askpass git fetch"',
  "sh -c 'GIT_SSH_COMMAND=\"ssh -i k\" git fetch'",
  "bash -c 'GIT_SSH=/tmp/ssh git fetch'",
  'echo "$(GIT_ASKPASS=/tmp/askpass git fetch)"',
  "sh -c 'export GIT_ASKPASS=/tmp/askpass; git fetch'",
  "sh -c 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git fetch'",
];

describe("the credential rule's environment, inside a nested shell or a substitution", () => {
  for (const line of NESTED_CREDENTIAL) {
    it(`refuses ${JSON.stringify(line)}`, () => {
      expect(claude(line), line).toMatchObject({
        decision: "denied",
        answer: "deny",
        rule: ADMISSION_RULES.git_credential_config,
      });
      expect(codex(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_credential_config });
      expect(opencode(line), line).toMatchObject({
        decision: "denied",
        rule: ADMISSION_RULES.git_credential_config,
      });
    });
  }
});
