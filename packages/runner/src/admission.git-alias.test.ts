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
 * A `git` line that defines an alias runs a verb it does not name: `git -c
 * alias.x='branch -D' x main` deletes a branch while every rule keyed on a
 * verb reads `x`. So the definition is refused before any verb is read
 * (`git_alias_defined`), on Claude Code's hook, Codex's approvals and
 * OpenCode's permission requests alike, and a `-c` that sets no alias stays
 * admitted.
 */
const ROOT = realpathSync(scratch("perbo-git-alias-"));

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

const DEFINITIONS = [
  // `-c` and `--config-env`, however the shell quotes them.
  "git -c alias.x='branch -D' x main",
  'git -c "alias.x=branch -D" x main',
  'git -c alias.x="branch -D" x main',
  "git -c alias.st=status st",
  "git -c ALIAS.x=push x",
  "git -c 'alias.x=!rm -rf .' x",
  "git --config-env=alias.x=VAR x main",
  "git --config-env alias.x=VAR x main",
  "git -C . -c alias.x='branch -D' x main",
  "git --weird -c alias.x='branch -D' x main",
  "git -c $KEY='branch -D' x main",
  // A `--config-env` is split at its last `=`, so a variable name the line
  // builds can end the key anywhere, past an option the walk does not know too.
  "git --config-env url.https://e/=$V fetch",
  "git --weird --config-env url.https://e/=$V fetch",
  // The environment git reads its config from.
  "GIT_CONFIG_PARAMETERS=\"'alias.x=branch -D'\" git x main",
  "GIT_CONFIG_PARAMETERS=\"'color.ui=always' 'alias.x=branch -D'\" git x main",
  'GIT_CONFIG_PARAMETERS="$P" git x main',
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='branch -D' git x main",
  "GIT_CONFIG_COUNT=1 git x main",
  "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=always git x main",
  "GIT_CONFIG_COUNT=$N GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=always git x main",
  "GIT_CONFIG_KEY_0=alias.x git x main",
  "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='branch -D' git x main",
  "export GIT_CONFIG_COUNT=1; git x main",
  "GIT_CONFIG_GLOBAL=aliases.cfg git x main",
  "GIT_CONFIG_SYSTEM=aliases.cfg git x main",
  // Handed to `env` past its own options, which the environment walk steps over.
  "env -i GIT_CONFIG_GLOBAL=/tmp/cfg git status",
  "env -u X GIT_CONFIG_GLOBAL=/tmp/cfg git status",
  "env --unset=X GIT_CONFIG_SYSTEM=/tmp/cfg git status",
  "env -i -u X GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='branch -D' git x main",
  "env -i GIT_CONFIG_PARAMETERS=\"'alias.x=branch -D'\" git x main",
  "env -- GIT_CONFIG_GLOBAL=/tmp/cfg git status",
  // env's options read as getopt reads them: a cluster letter that takes a
  // value takes the rest of its word, or the next word where nothing follows,
  // and a long option by any prefix getopt accepts.
  "env -iu X GIT_CONFIG_GLOBAL=/tmp/cfg git status",
  "env -a name GIT_CONFIG_GLOBAL=/tmp/cfg git status",
  "env --argv0 name GIT_CONFIG_GLOBAL=/tmp/cfg git status",
  "env --un X GIT_CONFIG_GLOBAL=/tmp/cfg git status",
  // An escaped quote opens nothing, so it hides no word after it.
  "X=\\' GIT_CONFIG_GLOBAL=/tmp/cfg git status \\'",
  // Made by the shell's own assigning commands, whatever their options.
  "declare -gx GIT_CONFIG_GLOBAL=/tmp/cfg; git status",
  "declare -xg GIT_CONFIG_GLOBAL=/tmp/cfg; git status",
  "local -x GIT_CONFIG_GLOBAL=/tmp/cfg; git status",
  "export -- GIT_CONFIG_GLOBAL=/tmp/cfg; git status",
  "export PAGER GIT_CONFIG_GLOBAL=/tmp/cfg; git status",
  // Handed to `env` and the assigning builtins as the shell hands them their
  // words, quotes and backslashes removed, and to `env` whatever the name
  // before an operand's `=`.
  "env -i 'GIT_CONFIG_GLOBAL=/tmp/c' git status",
  'env "GIT_CONFIG_SYSTEM=/tmp/c" git status',
  "env GIT_CONFIG_\\GLOBAL=/tmp/c git status",
  "export 'GIT_CONFIG_GLOBAL=/tmp/c'; git status",
  'declare -x "GIT_CONFIG_COUNT=1"; git x main',
  "env 1=2 GIT_CONFIG_GLOBAL=/tmp/c git status",
  "env 'A B=1' GIT_CONFIG_GLOBAL=/tmp/c git status",
  // `NAME+=value` appends to what NAME already holds, so what it sets is built when the line runs.
  "GIT_CONFIG_COUNT+=1 git x main",
  "GIT_CONFIG_PARAMETERS+=\" 'color.ui=always'\" git x main",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0+=.x GIT_CONFIG_VALUE_0='branch -D' git x main",
  "export GIT_CONFIG_GLOBAL+=.cfg; git status",
  // GIT_CONFIG_PARAMETERS in both of git's forms: `'key=value'` and `'key'='value'`.
  "GIT_CONFIG_PARAMETERS=\"'alias.x'='branch -D'\" git x main",
  "GIT_CONFIG_PARAMETERS=\"'color.ui'='always' 'alias.x'='branch -D'\" git x main",
  "GIT_CONFIG_PARAMETERS=\"'core.x=it'\\''s' 'alias.x'='branch -D'\" git x main",
  "GIT_CONFIG_PARAMETERS=\"'alias.x'\" git x main",
  // A value git's grammar does not read is one the guard cannot vouch for.
  "GIT_CONFIG_PARAMETERS=\"'color.ui=always\" git x main",
  // The key as the shell hands it over, its quotes and escapes applied.
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=ali\\as.x GIT_CONFIG_VALUE_0='branch -D' git x main",
  "git -c ali\\as.x='branch -D' x main",
  "git --weird -c ali\\as.x='branch -D' x main",
  // An alias written for the lines after this one.
  "git config alias.x 'branch -D'",
  "git config --local alias.x 'branch -D'",
  "git config set alias.x 'branch -D'",
  "git config --rename-section tools alias",
  // Behind a wrapper, a nested shell and a substitution.
  "env git -c alias.x='branch -D' x main",
  "sh -c \"git -c alias.x='branch -D' x main\"",
  "echo \"$(git -c alias.x='branch -D' x main)\"",
];

describe("a git line that defines an alias", () => {
  for (const line of DEFINITIONS) {
    it(`refuses ${JSON.stringify(line)} before any verb is read`, () => {
      expect(claude(line), line).toMatchObject({
        decision: "denied",
        answer: "deny",
        rule: ADMISSION_RULES.git_alias,
      });
      expect(codex(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_alias });
      expect(opencode(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_alias });
    });
  }

  it("says why in one sentence", () => {
    expect(claude("git -c alias.x='branch -D' x main").reason).toBe(
      "alias.x defines a git alias on the line, so the verb git runs is not the one the line names",
    );
    expect(claude("git config alias.x 'branch -D'").reason).toBe(
      "alias.x writes a git alias for the lines after this one, so a later git line runs a verb it does not name",
    );
  });
});

describe("a git line that sets config and defines no alias", () => {
  for (const line of [
    "git -c core.pager=cat branch -a",
    "git -c color.ui=false status",
    "git --config-env=color.ui=COLOR log --oneline",
    "GIT_CONFIG_PARAMETERS=\"'color.ui=always'\" git status",
    "GIT_CONFIG_PARAMETERS=\"'color.ui'='always' 'core.pager'='less -R'\" git status",
    "GIT_CONFIG_PARAMETERS=\"'core.x=alias.y'\" git status",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=always git status",
    "git config --get alias.x",
    "git config get alias.x",
    "git config --get-regexp '^alias\\.'",
    "git config --list",
    "git -c 'color.ui=always' status",
    "git --config-env=color.ui=COLOR status",
  ]) {
    it(`admits ${JSON.stringify(line)}`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed" });
      expect(claude(line).rule, line).toBeNull();
    });
  }

  for (const line of ["env -i git status", "env -iu X git status", "declare -g FOO=1; git status"]) {
    it(`admits ${JSON.stringify(line)} on the hook, where the allow list is what decides it`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).rule, line).not.toBe(ADMISSION_RULES.git_alias);
      expect(opencode(line), line).not.toMatchObject({ rule: ADMISSION_RULES.git_alias });
    });
  }

  for (const line of ["echo \\'hi\\'", "git log --grep \"it\\'s\""]) {
    it(`admits ${JSON.stringify(line)}, whose escaped quote opens nothing, on every executor`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(opencode(line), line).toEqual({ decision: "allowed" });
    });
  }

  it("leaves `git commit -m \"it\\'s\"` to the deny list", () => {
    const line = "git commit -m \"it\\'s\"";
    for (const decision of [claude(line), codex(line), opencode(line)]) {
      expect(decision, line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.deny_list });
    }
  });

  it("leaves the plain -c listing to the allow list on Codex and OpenCode", () => {
    // A prefix names the words in front, so `git -c … branch` is outside the
    // `git branch` entry as `git -C . log` is outside `git log`: what refuses
    // it there is the allow list, never the alias rule.
    const line = "git -c core.pager=cat branch -a";
    expect(codex(line)).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.allow_list });
    expect(opencode(line)).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.allow_list });
  });
});
