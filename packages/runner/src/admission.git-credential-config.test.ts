import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { ADMISSION_RULES, judgeCommand } from "./admission.js";
import { codexCommandDecision } from "./codex/index.js";
import { opencodeDecision } from "./opencode/index.js";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "./profile.js";

/**
 * SCP-201 criterion 1: `git config` reaches the same credential wiring
 * `gh auth setup-git` writes, and no entry on either list names it.
 *
 * `Bash(gh:*)` refuses the command that asks `gh` to write the helper; it says
 * nothing about `git config credential.helper` writing the same file directly.
 * Nor is this a write-target rule — the SCP-156 resolver has no path to judge
 * here, only a key `git config` was given — so the refusal is keyed on the
 * config key itself, at whichever scope it is written under, and reads of the
 * same keys stay admitted.
 */

const judge = (command: string) =>
  judgeCommand({
    tool: "Bash",
    detail: command,
    allow_list: DEFAULT_COMMAND_ALLOW_LIST,
    deny_list: DEFAULT_COMMAND_DENY_LIST,
    scope: { root: "/tmp/perbo-scp201-fixture", home: "/Users/nobody" },
  }).admission;

describe("git's own credential wiring, reached through `git config`", () => {
  const CREDENTIAL_WRITES: Array<[string, string]> = [
    ["git config credential.helper store", "credential.helper"],
    ["git config --global credential.helper '!gh auth git-credential'", "credential.helper"],
    ["git config --system core.sshCommand 'ssh -i ~/.ssh/id_ed25519'", "core.sshCommand"],
    [
      "git config url.https://example.com/.insteadOf git://example.com/",
      "url.https://example.com/.insteadOf",
    ],
    ["git config include.path ~/.gitconfig-extra", "include.path"],
  ];

  for (const [command, key] of CREDENTIAL_WRITES) {
    it(`refuses \`${command}\`, naming the credential rule`, () => {
      const admission = judge(command);
      expect(admission.decision, command).toBe("denied");
      expect(admission.rule, command).toBe(ADMISSION_RULES.git_credential_config);
      expect(admission.target, command).toBe(key);
      expect(admission.reason ?? "", command).toContain("credential");
    });
  }

  it("refuses at every scope, and at none", () => {
    for (const command of [
      "git config credential.helper store",
      "git config --global credential.helper store",
      "git config --system credential.helper store",
      "git config --local credential.helper store",
      "git config --worktree credential.helper store",
      "git config --file /tmp/other-config credential.helper store",
    ]) {
      expect(judge(command).decision, command).toBe("denied");
    }
  });

  it("refuses `includeIf`, not only the bare `include` key", () => {
    const admission = judge("git config includeIf.gitdir:~/work/.path ~/.gitconfig-work");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });

  it("refuses `url.*.pushInsteadOf`, not only `insteadOf`", () => {
    const admission = judge("git config url.https://example.com/.pushInsteadOf git://example.com/");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });
});

describe("what stays admitted", () => {
  it("keeps a non-credential key admitted, however it is set", () => {
    // The mutant this pins: a rule keyed on nothing would refuse every
    // `git config`, and this is the one that would catch it.
    expect(judge("git config user.name Perbo").decision).toBe("allowed");
    expect(judge("git config --global user.email a@example.com").decision).toBe("allowed");
  });

  it("keeps a read of the same credential key admitted", () => {
    for (const command of [
      "git config --get credential.helper",
      "git config --get-all credential.helper",
      "git config --list",
      "git config -l",
    ]) {
      expect(judge(command).decision, command).toBe("allowed");
    }
  });
});

/**
 * Follow-up review of SCP-201: a probe on the built branch found three
 * spellings still admitted. `-c key=value` (and `--config-env`) set a config
 * key for one command on any subcommand, not only `config`; git's own global
 * options (`-C`, `--git-dir`, `--no-pager`, …) can stand between `git` and
 * `config` and the key parser only ever looked at the second word; and git
 * reads config from the environment as well as from the command line.
 */
describe("the same credential key set through `-c`, on any subcommand", () => {
  it("refuses `-c credential.helper=…` on a command that is not `config` at all", () => {
    const admission = judge("git -c credential.helper='!gh auth git-credential' fetch origin");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
    expect(admission.target).toBe("credential.helper");
  });

  it("refuses the same shape through `--config-env`", () => {
    const admission = judge("git --config-env=credential.helper=MY_HELPER clone https://example.com/x.git");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });

  it("refuses `core.sshCommand` set the same way", () => {
    const admission = judge("git -c core.sshCommand='ssh -oProxyCommand=evil' pull");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });

  it("keeps a non-credential `-c` admitted — the pin the reviewer named", () => {
    expect(judge("git -c color.ui=false status").decision).toBe("allowed");
  });

  it("refuses it wherever a wrapper puts it, the way the deny-list already does", () => {
    const admission = judge("sh -c \"git -c credential.helper=store fetch\"");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });
});

describe("`config` found past git's own global options", () => {
  const STILL_CONFIG: string[] = [
    "git -C /tmp/other config credential.helper store",
    "git -C . config credential.helper store",
    "git --git-dir=.git config credential.helper store",
    "git --git-dir .git config credential.helper store",
    "git --work-tree=. config credential.helper store",
    "git --namespace=x config credential.helper store",
    "git --no-pager config credential.helper store",
    "git --bare config credential.helper store",
    "git -p config credential.helper store",
    "git --paginate config credential.helper store",
    "git --literal-pathspecs config credential.helper store",
    "git --no-optional-locks config credential.helper store",
    "git --exec-path=/usr/lib/git-core config credential.helper store",
    "git -C /tmp/other -c foo=bar --no-pager config credential.helper store",
  ];

  for (const command of STILL_CONFIG) {
    it(`still reads \`${command}\` as \`git config\``, () => {
      const admission = judge(command);
      expect(admission.decision, command).toBe("denied");
      expect(admission.rule, command).toBe(ADMISSION_RULES.git_credential_config);
      expect(admission.target, command).toBe("credential.helper");
    });
  }
});

describe("git's own environment variables", () => {
  it("refuses a credential key named through GIT_CONFIG_PARAMETERS, via `env`", () => {
    const admission = judge("env GIT_CONFIG_PARAMETERS=\"'credential.helper=store'\" git fetch");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
    expect(admission.reason ?? "").toContain("GIT_CONFIG_PARAMETERS");
  });

  it("refuses a credential key named through GIT_CONFIG_PARAMETERS, as a leading assignment", () => {
    const admission = judge("GIT_CONFIG_PARAMETERS=\"'credential.helper=store'\" git fetch");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });

  it("refuses a credential key named through GIT_CONFIG_KEY_<n>", () => {
    const admission = judge(
      "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git fetch",
    );
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
    expect(admission.reason ?? "").toContain("GIT_CONFIG_KEY_0");
  });

  const PROGRAM_VARS = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EXEC_PATH"];
  for (const name of PROGRAM_VARS) {
    it(`refuses ${name}, naming the variable, however it is set`, () => {
      const admission = judge(`${name}=/tmp/evil git fetch`);
      expect(admission.decision, name).toBe("denied");
      expect(admission.rule, name).toBe(ADMISSION_RULES.git_credential_config);
      expect(admission.reason ?? "", name).toContain(name);
    });
  }

  it("keeps an unrelated leading assignment admitted — the pin the reviewer named", () => {
    expect(judge("GIT_PAGER=cat git log").decision).toBe("allowed");
  });

  it("keeps a non-credential GIT_CONFIG_KEY_<n> admitted", () => {
    const admission = judge(
      "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.editor GIT_CONFIG_VALUE_0=vim git fetch",
    );
    expect(admission.decision).toBe("allowed");
  });
});

/**
 * The assignment can stand in its own segment, made by `export`, `declare`,
 * `typeset`, `local` or `readonly` rather than handed to `env` or standing
 * bare in front of the command — `export GIT_SSH_COMMAND=…; git fetch` sets
 * the variable in one segment and runs git in the next.
 */
describe("the same environment reached through export, declare and typeset", () => {
  it("refuses GIT_SSH_COMMAND exported in its own segment ahead of the git command", () => {
    const admission = judge("export GIT_SSH_COMMAND='ssh -i /tmp/k'; git fetch");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
    expect(admission.reason ?? "").toContain("GIT_SSH_COMMAND");
  });

  it("refuses a credential key named through GIT_CONFIG_PARAMETERS via `declare -x`", () => {
    const admission = judge(
      "declare -x GIT_CONFIG_PARAMETERS=\"'credential.helper=store'\"; git fetch",
    );
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });

  it("refuses the same shape through `typeset -x`", () => {
    const admission = judge("typeset -x GIT_ASKPASS=/tmp/evil.sh; git fetch");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
    expect(admission.reason ?? "").toContain("GIT_ASKPASS");
  });

  it("keeps an unrelated export admitted — the pin the reviewer named", () => {
    expect(judge("export PAGER=cat; git log").decision).toBe("allowed");
  });

  it("refuses a declare with no -x, as a bare assignment is refused", () => {
    // A variable the environment already exports keeps its export when
    // `declare` assigns it, so git sees the new value.
    const admission = judge("declare GIT_SSH_COMMAND='ssh -i /tmp/k'; git fetch");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
  });

  it("keeps a declare of an unrelated variable admitted", () => {
    expect(judge("declare -g FOO=1; git status").decision).toBe("allowed");
  });
});

describe("the credential key however the line spells its place", () => {
  for (const [command, key] of [
    // `-f` is `--file`: its value is the file, and the key is the word after it.
    ["git config -f x credential.helper y", "credential.helper"],
    // The subcommand form names the key as its first operand.
    ["git config set credential.helper x", "credential.helper"],
    // The shell hands git the key without the quotes around the assignment.
    ['git -c "credential.helper=x" fetch', "credential.helper"],
  ] as const) {
    it(`refuses \`${command}\` as a credential refusal`, () => {
      const admission = judge(command);
      expect(admission.decision).toBe("denied");
      expect(admission.rule).toBe(ADMISSION_RULES.git_credential_config);
      expect(admission.target).toBe(key);
    });
  }
});

/**
 * The same refusals on Claude Code's hook, Codex's approvals and OpenCode's
 * permission requests, however the environment reaches git — past `env`'s
 * own options, and through `GIT_CONFIG_PARAMETERS` in either of git's forms
 * — and git's `--exec-path=<dir>`, which chooses the programs git runs as
 * `GIT_EXEC_PATH` does.
 */
describe("on every executor, however the line reaches git", () => {
  const ROOT = realpathSync(scratchDirectories("perbo-runner-")("perbo-git-credential-"));
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

  const REFUSED: Array<[string, string]> = [
    // Past `env`'s own options.
    ["env -i GIT_CONFIG_PARAMETERS=\"'credential.helper=store'\" git fetch", "credential.helper"],
    ["env -u X GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store GIT_CONFIG_COUNT=1 git fetch", "credential.helper"],
    ["env --unset=X GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=x GIT_CONFIG_COUNT=1 git fetch", "core.sshCommand"],
    ["env -i -u X GIT_SSH_COMMAND='ssh -i /tmp/k' git fetch", "GIT_SSH_COMMAND"],
    ["env -i GIT_EXEC_PATH=/tmp/x git submodule status", "GIT_EXEC_PATH"],
    // A cluster, read as getopt reads it: `-u` takes the next word where nothing follows it.
    ["env -iu X GIT_CONFIG_PARAMETERS=\"'include.path=/tmp/c'\" git status", "include.path"],
    ["env -iu X GIT_SSH_COMMAND=/tmp/x git fetch", "GIT_SSH_COMMAND"],
    // An escaped quote opens nothing, so it hides no word after it.
    ["X=\\' GIT_SSH_COMMAND=/tmp/x git fetch \\'", "GIT_SSH_COMMAND"],
    // Made by the shell's own assigning commands, whatever their options.
    ["declare -gx GIT_SSH_COMMAND=/tmp/x; git fetch", "GIT_SSH_COMMAND"],
    ["export -- GIT_SSH_COMMAND=/tmp/x; git fetch", "GIT_SSH_COMMAND"],
    ["typeset -x -- FOO=1 GIT_ASKPASS=/tmp/x; git fetch", "GIT_ASKPASS"],
    // GIT_CONFIG_PARAMETERS in git's `'key'='value'` form, alone and among others.
    ["GIT_CONFIG_PARAMETERS=\"'credential.helper'='store'\" git fetch", "credential.helper"],
    ["GIT_CONFIG_PARAMETERS=\"'color.ui'='always' 'credential.helper'='store'\" git fetch", "credential.helper"],
    ["GIT_CONFIG_PARAMETERS=\"'color.ui=always' 'core.x=it'\\''s' 'credential.helper'='store'\" git fetch", "credential.helper"],
    ["GIT_CONFIG_PARAMETERS=\"'credential.helper'=\" git fetch", "credential.helper"],
    ["GIT_CONFIG_PARAMETERS=\"' credential.helper =store'\" git fetch", "credential.helper"],
    // The key as the shell hands it over.
    ["GIT_CONFIG_KEY_0=cred\\ential.helper GIT_CONFIG_VALUE_0=store GIT_CONFIG_COUNT=1 git fetch", "credential.helper"],
    ["GIT_CONFIG_KEY_0='credential'.helper GIT_CONFIG_VALUE_0=store GIT_CONFIG_COUNT=1 git fetch", "credential.helper"],
    // git's own --exec-path, attached as git reads it.
    ["git --exec-path=/tmp/x submodule status", "--exec-path"],
    ['git "--exec-path=/tmp/x" submodule status', "--exec-path"],
    ["git -C . --exec-path=/tmp/x bisect start", "--exec-path"],
    ["env -i git --exec-path=/tmp/x submodule status", "--exec-path"],
    // Past an option the global-option walk does not know, on the rest of the line.
    ["git --weird --exec-path=/tmp/x status", "--exec-path"],
    // A key as the shell hands it to git, its backslashes applied.
    ["git -c cred\\ential.helper=/tmp/h fetch", "credential.helper"],
    ["git config cred\\ential.helper /tmp/h", "credential.helper"],
    // An escaped `=` ends no key: the shell hands git the word without its
    // backslash, and git splits a `-c` at its first `=`.
    ["git -c core.sshCommand\\=/tmp/evil fetch", "core.sshCommand"],
    ["git -c url.https://evil.example/.insteadOf\\=https://github.com/ fetch", "url.https://evil.example/.insteadOf"],
    // git splits a `--config-env` at its last `=`, since the variable's name holds none.
    ["git --config-env 'url.https://e/?a=b.insteadOf=V' fetch", "url.https://e/?a=b.insteadOf"],
    ["git --config-env='url.https://e/?a=b.insteadOf=V' fetch", "url.https://e/?a=b.insteadOf"],
    // `env` and the assigning builtins are handed their words without quotes or backslashes.
    ["env 'GIT_SSH_COMMAND=/tmp/x' git fetch", "GIT_SSH_COMMAND"],
    ["env -i \"GIT_ASKPASS=/tmp/x\" git fetch", "GIT_ASKPASS"],
    ["env GIT_\\SSH=/tmp/x git fetch", "GIT_SSH"],
    ["export 'GIT_SSH_COMMAND=/tmp/x'; git fetch", "GIT_SSH_COMMAND"],
    ["declare -x \"GIT_CONFIG_PARAMETERS='credential.helper=store'\"; git fetch", "credential.helper"],
    // `env` reads every operand holding an `=` as an assignment, whatever its name.
    ["env 1=2 GIT_SSH_COMMAND=/tmp/x git fetch", "GIT_SSH_COMMAND"],
    ["env 'A B=1' GIT_SSH_COMMAND=/tmp/x git fetch", "GIT_SSH_COMMAND"],
    // `NAME+=value` appends to NAME, in front of git and through a builtin.
    ["GIT_SSH_COMMAND+=/tmp/x git fetch", "GIT_SSH_COMMAND"],
    ["export GIT_ASKPASS+=/tmp/x; git fetch", "GIT_ASKPASS"],
    ["declare -x 'GIT_EXEC_PATH+=/tmp/x'; git status", "GIT_EXEC_PATH"],
  ];

  for (const [line, target] of REFUSED) {
    it(`refuses ${JSON.stringify(line)} as a credential refusal`, () => {
      expect(claude(line), line).toMatchObject({
        decision: "denied",
        answer: "deny",
        rule: ADMISSION_RULES.git_credential_config,
        target,
      });
      expect(codex(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_credential_config });
      expect(opencode(line), line).toMatchObject({
        decision: "denied",
        rule: ADMISSION_RULES.git_credential_config,
      });
    });
  }

  it("names --exec-path as the program choice GIT_EXEC_PATH is", () => {
    expect(claude("git --exec-path=/tmp/x submodule status").reason).toBe(
      "--exec-path=/tmp/x chooses the programs git runs, as GIT_EXEC_PATH does, " +
        "which the credential rule refuses regardless of how it is set",
    );
  });

  for (const line of [
    "env -i git status",
    "git --exec-path",
    "GIT_CONFIG_PARAMETERS=\"'color.ui'='always'\" git status",
    // An escaped blank in a value is part of it, and the key before the `=` is `user.name`.
    "git -c user.name=a\\ b log",
    // `env` sets `GIT_SSH_COMMAND+`, a variable git never reads.
    "env GIT_SSH_COMMAND+=/tmp/x git fetch",
    // A quoted name in front of a program is that program's name, not an assignment.
    "'GIT_SSH_COMMAND=/tmp/x' git fetch",
  ]) {
    it(`admits ${JSON.stringify(line)} on the hook, where the allow list is what decides it`, () => {
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
      expect(codex(line).rule, line).not.toBe(ADMISSION_RULES.git_credential_config);
      expect(opencode(line), line).not.toMatchObject({ rule: ADMISSION_RULES.git_credential_config });
    });
  }
});
