import { describe, expect, it } from "vitest";
import { ADMISSION_RULES, judgeCommand } from "./admission.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "./profile.js";

/**
 * A config key whose value is a program git runs — a pager, an editor, a
 * file-system monitor, a hook directory, a diff, merge or filter driver —
 * set by the line for one command or written for the lines after it, or a
 * variable git reads for the same program. `git -c core.fsmonitor=/tmp/x
 * status` runs `/tmp/x` through a verb that reads, so the refusal is keyed on
 * the key and the value it is given, and a value that runs nothing stays
 * admitted.
 */

const judge = (command: string) =>
  judgeCommand({
    tool: "Bash",
    detail: command,
    allow_list: DEFAULT_COMMAND_ALLOW_LIST,
    deny_list: DEFAULT_COMMAND_DENY_LIST,
    scope: { root: "/tmp/perbo-program-config-fixture", home: "/Users/nobody" },
  }).admission;

const expectRefused = (command: string, target: string) => {
  const admission = judge(command);
  expect(admission, command).toMatchObject({
    decision: "denied",
    rule: ADMISSION_RULES.git_program_config,
    target,
  });
  expect(admission.reason ?? "", command).toContain(target);
  expect(admission.reason ?? "", command).toContain("a program");
};

const expectAdmitted = (command: string) => {
  expect(judge(command), command).toMatchObject({ decision: "allowed", rule: null });
};

describe("every program key, set through `-c` to a program", () => {
  const KEYS = [
    "core.pager", "pager.log", "core.editor", "sequence.editor", "core.fsmonitor", "core.hooksPath",
    "core.askPass", "core.gitProxy", "core.alternateRefsCommand", "diff.external", "diff.drv.command",
    "diff.drv.textconv", "interactive.diffFilter", "difftool.t.cmd", "difftool.t.path", "mergetool.t.cmd",
    "mergetool.t.path", "merge.drv.driver", "filter.drv.clean", "filter.drv.smudge", "filter.drv.process",
    "gpg.program", "gpg.ssh.program", "gpg.ssh.defaultKeyCommand", "sendemail.sendmailCmd",
    "sendemail.smtpServer", "sendemail.toCmd", "sendemail.ccCmd", "sendemail.work.sendmailCmd",
    "sendemail.work.smtpServer", "sendemail.work.toCmd", "sendemail.work.ccCmd", "imap.tunnel",
    "trailer.t.cmd", "trailer.t.command", "submodule.s.update", "remote.origin.uploadpack",
    "remote.origin.receivepack", "remote.origin.vcs", "uploadpack.packObjectsHook", "init.templateDir",
    "protocol.allow", "protocol.ext.allow", "browser.b.cmd", "browser.b.path", "man.m.cmd", "man.m.path",
    "guitool.g.cmd", "instaweb.httpd",
  ];
  for (const key of KEYS) {
    it(`refuses \`git -c ${key}=/tmp/x status\``, () => {
      expectRefused(`git -c ${key}=/tmp/x status`, key);
    });
  }

  it("refuses a file-system monitor through `-c` and a hook directory through GIT_CONFIG_PARAMETERS", () => {
    expectRefused("git -c core.fsmonitor=/tmp/x status", "core.fsmonitor");
    expectRefused("GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/tmp/x'\" git status", "core.hooksPath");
  });

  it("reads past git's other global options, and on the rest of a line whose walk stops", () => {
    expectRefused("git -C . --no-pager -c core.pager=/tmp/x log", "core.pager");
    expectRefused("git --unknown-option -c core.pager=/tmp/x log", "core.pager");
  });

  it("judges a line whose last global option is missing its value", () => {
    expect(() => judge("git -C")).not.toThrow();
    expect(() => judge("git -c")).not.toThrow();
  });

  it("does not read a `-c` after the verb, which is the verb's own word", () => {
    expectAdmitted("git log -c core.pager=/tmp/x");
  });
});

describe("the key read as git reads it", () => {
  it("reads the section and the variable in any case", () => {
    expectRefused("git -c Core.FsMonitor=/tmp/x status", "Core.FsMonitor");
    expectRefused("git -c CORE.PAGER=/tmp/x log", "CORE.PAGER");
    expectRefused("git -c Diff.MyDriver.COMMAND=/tmp/x diff", "Diff.MyDriver.COMMAND");
    expectRefused("git -c Protocol.ext.ALLOW=always status", "Protocol.ext.ALLOW");
  });

  it("reads the subsection as spelled: `protocol.EXT.allow` is not the `ext` protocol's", () => {
    expectAdmitted("git -c protocol.EXT.allow=always status");
  });

  it("strips the shell's quotes and backslashes from the key and the value", () => {
    expectRefused("git -c 'core.pager=/tmp/x' log", "core.pager");
    expectRefused('git -c "core.hooksPath"=/tmp/x status', "core.hooksPath");
    expectRefused("git -c core.fsmon\\itor=/tmp/x status", "core.fsmonitor");
    expectAdmitted("git -c 'core.pager=less -R' log");
  });
});

describe("the same keys through `--config-env`, whose value the line does not show", () => {
  it("refuses a program key, a pager's included", () => {
    expectRefused("git --config-env=core.fsmonitor=MONITOR status", "core.fsmonitor");
    expectRefused("git --config-env core.pager=PAGER_VAR log", "core.pager");
    // `cat` here names the variable the pager is read from, not the pager.
    expectRefused("git --config-env=core.pager=cat log", "core.pager");
    // git splits a `--config-env` at its last `=`, so the key before it can hold one.
    expectRefused("git --config-env='diff.a=b.command=V' diff", "diff.a=b.command");
  });

  it("keeps a key that names no program admitted", () => {
    expectAdmitted("git --config-env=color.ui=COLOR log --oneline");
  });
});

describe("the same keys through git's config variables", () => {
  it("reads GIT_CONFIG_PARAMETERS in its `'key'='value'` form and its `'key=value'` form", () => {
    expectRefused("GIT_CONFIG_PARAMETERS=\"'core.fsmonitor'='/tmp/x'\" git status", "core.fsmonitor");
    expectRefused("GIT_CONFIG_PARAMETERS=\"'core.fsmonitor=/tmp/x'\" git status", "core.fsmonitor");
    expectRefused("GIT_CONFIG_PARAMETERS=\"'color.ui'='always' 'diff.external'='/tmp/x'\" git diff", "diff.external");
  });

  it("reads the credential rule's keys in the `'key'='value'` form as well", () => {
    expect(judge("GIT_CONFIG_PARAMETERS=\"'credential.helper'='store'\" git status")).toMatchObject({
      decision: "denied",
      rule: ADMISSION_RULES.git_credential_config,
      target: "credential.helper",
    });
  });

  it("reads a quote inside a value, `'\\''`, and goes on to the next pair", () => {
    // The shell hands git `'color.ui'='al'\''ways' 'core.pager'='/tmp/x'`.
    expectRefused(
      "GIT_CONFIG_PARAMETERS=\"'color.ui'='al'\"'\\'\"''ways' 'core.pager'='/tmp/x'\" git log",
      "core.pager",
    );
  });

  it("reads a key with no value as true", () => {
    expectRefused("GIT_CONFIG_PARAMETERS=\"'core.fsmonitor'\" git status", "core.fsmonitor");
    expectAdmitted("GIT_CONFIG_PARAMETERS=\"'pager.log'\" git log");
  });

  it("admits a value that runs nothing, in either form", () => {
    expectAdmitted("GIT_CONFIG_PARAMETERS=\"'core.pager'='cat'\" git log");
    expectAdmitted("GIT_CONFIG_PARAMETERS=\"'core.pager=cat' 'color.ui'='always'\" git log");
  });

  it("leaves a GIT_CONFIG_PARAMETERS git would refuse as malformed, or one the line builds, to the alias rule, which refuses it", () => {
    for (const command of ["GIT_CONFIG_PARAMETERS=garbage git status", 'GIT_CONFIG_PARAMETERS="$P" git log']) {
      expect(judge(command), command).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_alias });
    }
  });

  it("reads a GIT_CONFIG_KEY_<n> with the GIT_CONFIG_VALUE_<n> beside it", () => {
    expectRefused("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=/tmp/x git log", "core.pager");
    expectAdmitted("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=cat git log");
    expectAdmitted("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=always git log");
  });

  it("pairs each GIT_CONFIG_KEY_<n> with the value of its own index", () => {
    expectAdmitted(
      "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=/tmp/x GIT_CONFIG_KEY_1=core.pager GIT_CONFIG_VALUE_1=cat git log",
    );
    expectRefused(
      "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=cat GIT_CONFIG_KEY_1=core.pager GIT_CONFIG_VALUE_1=/tmp/x git log",
      "core.pager",
    );
  });

  it("refuses a GIT_CONFIG_KEY_<n> whose value the line builds or does not set", () => {
    expectRefused("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=$V git log", "core.pager");
    expectRefused("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager git log", "core.pager");
  });

  it("reads them handed to `env`, past its options, and exported ahead of git", () => {
    expectRefused("env -u LANG GIT_CONFIG_PARAMETERS=\"'core.pager'='/tmp/x'\" git log", "core.pager");
    expectRefused("export GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/tmp/x'\"; git status", "core.hooksPath");
  });

  it("leaves a config file the line chooses to the alias rule, which refuses it", () => {
    for (const command of ["GIT_CONFIG_GLOBAL=/tmp/cfg git log", "GIT_CONFIG_SYSTEM=/tmp/cfg git status"]) {
      expect(judge(command), command).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_alias });
    }
  });

  it("leaves a key the line builds to the alias rule, which refuses it", () => {
    expect(judge("git -c $K=/tmp/x log")).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_alias });
  });
});

describe("a program key written with `git config`, for the lines after it", () => {
  it("refuses the write at every scope, whatever the value", () => {
    for (const command of [
      "git config core.pager /tmp/x",
      "git config --global core.hooksPath /tmp/hooks",
      "git config --file /tmp/cfg core.fsmonitor /tmp/x",
      "git config set core.editor /tmp/x",
      "git config diff.drv.textconv /tmp/x",
      "git config core.pager cat",
      "git config --unset core.hooksPath",
      "git -C . config filter.drv.smudge /tmp/x",
      "git config core.fsmon\\itor /tmp/x",
    ]) {
      expect(judge(command), command).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_program_config });
      expect(judge(command).reason ?? "", command).toContain("lines after this one");
    }
  });

  it("refuses a section renamed onto, or removed from, one that holds a program key", () => {
    expectRefused("git config --rename-section tools core", "core");
    expectRefused("git config --rename-section x diff.drv", "diff.drv");
    expectRefused("git config --rename-section x pager", "pager");
    expectRefused("git config --remove-section filter.drv", "filter.drv");
  });

  it("keeps a section that holds none admitted", () => {
    expectAdmitted("git config --rename-section x user");
    expectAdmitted("git config --rename-section x color.diff");
  });

  it("reads past a type and its value, `--type bool` and `-t bool`, to the key", () => {
    expectRefused("git config --type bool core.fsmonitor false", "core.fsmonitor");
    expectRefused("git config -t bool core.fsmonitor false", "core.fsmonitor");
    expect(judge("git config --type bool credential.helper x")).toMatchObject({
      decision: "denied",
      rule: ADMISSION_RULES.git_credential_config,
    });
  });

  it("reads past a read's default to the key it reads", () => {
    expectAdmitted("git config --default core.pager user.name");
  });

  it("keeps a read of any key admitted", () => {
    for (const command of [
      "git config core.pager",
      "git config --get core.pager",
      "git config --get-all core.hooksPath",
      "git config get core.pager",
      "git config --list",
      "git config user.name",
      "git config user.name Perbo",
    ]) {
      expectAdmitted(command);
    }
  });

  it("reads a lone program key the shell can split as the write it can be", () => {
    // With `X='pager /tmp/x'`, `git config core.$X` writes `core.pager`.
    expect(judge("git config core.$X")).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_alias });
  });
});

describe("the variables that name the same programs", () => {
  const GIT_VARIABLES = [
    "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR",
  ];
  for (const name of GIT_VARIABLES) {
    it(`refuses ${name} set to a program`, () => {
      expectRefused(`${name}=/tmp/x git diff`, name);
    });
  }

  it("refuses GIT_EXTERNAL_DIFF and GIT_PAGER in front of git, however the line sets them", () => {
    expectRefused("GIT_EXTERNAL_DIFF=/tmp/x git diff", "GIT_EXTERNAL_DIFF");
    expectRefused("env GIT_EXTERNAL_DIFF=/tmp/x git diff", "GIT_EXTERNAL_DIFF");
    expectRefused("env 'GIT_EXTERNAL_DIFF=/tmp/x' git diff", "GIT_EXTERNAL_DIFF");
    expectRefused("export GIT_EXTERNAL_DIFF=/tmp/x; git diff", "GIT_EXTERNAL_DIFF");
    expectRefused("declare -x GIT_EXTERNAL_DIFF=/tmp/x; git diff", "GIT_EXTERNAL_DIFF");
    expectRefused("export -- GIT_PAGER=/tmp/x; git log", "GIT_PAGER");
    expectRefused("declare -xr GIT_PAGER=/tmp/x; git log", "GIT_PAGER");
    expectRefused("export GIT_PAGER; declare GIT_PAGER=/tmp/x; git log", "GIT_PAGER");
    expectRefused("GIT_PAGER+=/tmp/x git log", "GIT_PAGER");
  });

  it("refuses GIT_ALLOW_PROTOCOL where it lets `ext::` through, and admits it elsewhere", () => {
    expectRefused("GIT_ALLOW_PROTOCOL=file:ext git fetch", "GIT_ALLOW_PROTOCOL");
    expectAdmitted("GIT_ALLOW_PROTOCOL=file:https git fetch");
  });

  it("refuses PAGER, EDITOR and VISUAL on a line that runs git", () => {
    expectRefused("PAGER=/tmp/x git log", "PAGER");
    expectRefused("export EDITOR=vim; git status", "EDITOR");
    expectRefused("VISUAL=/tmp/x sh -c 'git log'", "VISUAL");
  });

  it("admits PAGER, EDITOR and VISUAL on a line that runs no git", () => {
    expectAdmitted("PAGER=/tmp/x psql -l");
    expectAdmitted("export EDITOR=vim; ls");
    expectAdmitted("VISUAL=/tmp/x crontab -l");
  });
});

describe("what stays admitted", () => {
  it("admits a pager that runs nothing, through each route", () => {
    for (const command of [
      "git -c core.pager=cat log",
      "git -c core.pager= log",
      "git -c core.pager=less log",
      "git -c core.pager='less -FRX' log",
      "git -c core.pager=more log",
      "git -c pager.log=false log",
      "git -c pager.log=OFF log",
      "git -c pager.log log",
      "git -c pager.log=less log",
      "GIT_PAGER=cat git log",
      "GIT_PAGER= git log",
      "PAGER='less -R' git log",
      "export PAGER=cat; git log",
    ]) {
      expectAdmitted(command);
    }
  });

  it("refuses a pager that runs something the line chose", () => {
    for (const [command, key] of [
      ["git -c core.pager='less | tee /tmp/x' log", "core.pager"],
      ["git -c core.pager=/usr/bin/less log", "core.pager"],
      ["git -c core.pager='less +F' log", "core.pager"],
      ["git -c core.pager='cat; touch x' log", "core.pager"],
      ["git -c core.pager=$P log", "core.pager"],
      ["git -c pager.log=/tmp/x log", "pager.log"],
      ["GIT_PAGER='less | tee /tmp/x' git log", "GIT_PAGER"],
      ["GIT_PAGER=\"$P\" git log", "GIT_PAGER"],
    ] as const) {
      expectRefused(command, key);
    }
  });

  it("admits an editor that runs nothing, and refuses one that does", () => {
    expectAdmitted("GIT_EDITOR=true git merge --continue");
    expectAdmitted("GIT_SEQUENCE_EDITOR=: git status");
    expectAdmitted("git -c core.editor=true status");
    expectRefused("git -c core.editor=vim status", "core.editor");
  });

  it("admits a file-system monitor set false, and refuses one set true, which starts a daemon", () => {
    for (const value of ["false", "no", "off", "0", ""]) expectAdmitted(`git -c core.fsmonitor=${value} status`);
    expectRefused("git -c core.fsmonitor=true status", "core.fsmonitor");
    expectRefused("git -c core.fsmonitor status", "core.fsmonitor");
  });

  it("admits a hook directory of /dev/null, which holds no hook", () => {
    expectAdmitted("git -c core.hooksPath=/dev/null status");
  });

  it("admits a protocol policy of never, and a policy for a protocol other than ext", () => {
    expectAdmitted("git -c protocol.allow=never status");
    expectAdmitted("git -c protocol.ext.allow=never status");
    expectAdmitted("git -c protocol.file.allow=always status");
    expectRefused("git -c protocol.ext.allow=user status", "protocol.ext.allow");
  });

  it("admits a key that names no program", () => {
    for (const command of [
      "git -c color.ui=false status",
      "git -c core.quotepath=off diff",
      "git -c diff.noprefix=true diff",
      "git -c user.name=x log",
      "git -c diff.tool=vimdiff status",
    ]) {
      expectAdmitted(command);
    }
  });
});

describe("the same line wherever a wrapper puts it", () => {
  it("refuses it inside `sh -c` and inside a substitution", () => {
    expectRefused("sh -c 'git -c core.pager=/tmp/x log'", "core.pager");
    expectRefused("sh -c 'GIT_EXTERNAL_DIFF=/tmp/x git diff'", "GIT_EXTERNAL_DIFF");
    expectRefused('echo "$(git -c core.hooksPath=/tmp/h status)"', "core.hooksPath");
    expectRefused("env git -c core.fsmonitor=/tmp/x status", "core.fsmonitor");
  });
});

describe("the variables git reads for a program where no config key is set", () => {
  it("refuses GIT_TEST_FSMONITOR unless it is false", () => {
    expectRefused("GIT_TEST_FSMONITOR=/tmp/x git status", "GIT_TEST_FSMONITOR");
    expectAdmitted("GIT_TEST_FSMONITOR=false git status");
  });

  it("refuses git difftool's command and git maintenance's scheduler", () => {
    expectRefused("GIT_DIFFTOOL_EXTCMD=/tmp/x git difftool", "GIT_DIFFTOOL_EXTCMD");
    expectRefused("GIT_TEST_MAINT_SCHEDULER=crontab:/tmp/x git maintenance start", "GIT_TEST_MAINT_SCHEDULER");
  });

  it("refuses the directory difftool and mergetool source their tools from, on a line that runs git", () => {
    expectRefused("MERGE_TOOLS_DIR=/tmp/t git mergetool", "MERGE_TOOLS_DIR");
    expectAdmitted("MERGE_TOOLS_DIR=/tmp/t ls");
  });

  it("refuses instaweb's module path, from which its server loads code", () => {
    expectRefused("git -c instaweb.modulePath=/tmp/m status", "instaweb.modulePath");
  });
});

describe("a pager and its own variables", () => {
  it("refuses `less` or `more` given an option that names a file", () => {
    for (const value of ["less -o/tmp/x", "less -Ofile", "less -kkeys", "more -Ro"]) {
      expectRefused(`git -c core.pager='${value}' log`, "core.pager");
    }
  });

  it("refuses LESSOPEN, LESSCLOSE, LESSKEY and LESSKEY_CONTENT on a line that runs git", () => {
    for (const name of ["LESSOPEN", "LESSCLOSE", "LESSKEY", "LESSKEY_CONTENT"]) {
      expectRefused(`${name}=/tmp/x git log`, name);
    }
    expectAdmitted("LESSOPEN='|/tmp/x %s' less README.md");
  });

  it("refuses LESS where its options name a file, and admits it otherwise", () => {
    expectRefused("LESS=-o/tmp/x git log", "LESS");
    expectRefused("LESS='R o/tmp/x' git log", "LESS");
    expectAdmitted("LESS=FRX git log");
    expectAdmitted("LESS='-R -S' git log");
  });

  it("reads git's booleans and protocol policies in any case", () => {
    expectAdmitted("git -c protocol.ext.allow=Never status");
    expectAdmitted("git -c core.fsmonitor=00 status");
    expectAdmitted("git -c pager.log=2 log");
  });

  it("refuses an editor that is a real editor, even one a person would use", () => {
    expectRefused("EDITOR=nano git status", "EDITOR");
  });
});
