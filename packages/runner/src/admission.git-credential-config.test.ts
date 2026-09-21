import { describe, expect, it } from "vitest";
import { ADMISSION_RULES, judgeCommand } from "./admission.js";
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
 * Round 3: the assignment can stand in its own segment, introduced by
 * `export`, `declare -x` or `typeset -x` rather than by `env` or by standing
 * bare in front of the command — `export GIT_SSH_COMMAND=…; git fetch` sets
 * the variable in one segment and runs git in the next, and the env reader
 * only knew to look past a leading `env`.
 */
describe("the same environment reached through export/declare -x/typeset -x", () => {
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

  it("keeps a plain (non-exported) declare admitted", () => {
    expect(judge("declare GIT_SSH_COMMAND='ssh -i /tmp/k'; git fetch").decision).toBe("allowed");
  });
});
