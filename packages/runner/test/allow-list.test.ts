import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMISSION_RULES, judgeCommand, matchesListEntry } from "../src/admission.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../src/profile.js";

/**
 * SCP-163: a command's admission is decided by where its writes land.
 *
 * Two lists decide a command, and they are not the same list. `judgeCommand` is
 * the decision the runner **records**, and its refusals are the deny-list and
 * the write rules (outside the worktree, a prohibited path, outside the
 * contract's globs), never absence from a list. A verb the
 * allow-list does not carry is admitted — the agent's permission layer runs
 * `cd`, `echo` and `pwd` with no entry, so a name denial here would land on
 * commands that ran. The `--allowedTools` list the runner hands the agent is
 * the control that decides whether a command runs at all, and it carries no
 * write verb — so `rm -r .scratch` is refused by name before the runner ever
 * reads it, and the agent's report of that refusal is what the record carries.
 * Both halves are asserted here, because a file that stated only the first
 * would describe a permission the executor does not have.
 *
 * Every judgement is made against a worktree that exists on disk, so the
 * resolver walks real directories and real symlinks rather than a string.
 */

const worktree = mkdtempSync(join(tmpdir(), "perbo-scp163-"));
mkdirSync(join(worktree, "sub"), { recursive: true });
writeFileSync(join(worktree, "a"), "contents\n");

const judge = (command: string, tool = "Bash") =>
  judgeCommand({
    tool,
    detail: command,
    allow_list: DEFAULT_COMMAND_ALLOW_LIST,
    deny_list: DEFAULT_COMMAND_DENY_LIST,
    scope: { root: worktree, home: "/Users/nobody" },
  }).admission;

/** The prefix match the agent's own permission layer applies to the same list. */
const admittedByName = (command: string): boolean =>
  DEFAULT_COMMAND_ALLOW_LIST.some((entry) => matchesListEntry(entry, "Bash", command));

const ADMITTED = [
  // The AYO-13 clean-up lines, in the spelling the executor used.
  "mkdir -p .scratch/.perbo",
  "rm -r .scratch",
  `rm -rf ${worktree}/.scratch`,
  // The rest of the mutating vocabulary, all of it inside the worktree.
  "cp a b",
  "touch a",
  "chmod +x a",
  "mv a sub/a",
  "mkdir -m 755 sub/deep",
  "rmdir sub",
  "ln -s a link",
  "tee sub/log.txt",
  // A wrapper does not change the act, so it does not change the decision.
  "env cp a b",
  "/bin/cp a b",
  "sh -c 'rm -rf sub'",
];

const READ_AND_PACKAGE_MANAGER = [
  "ls -la",
  "cat package.json",
  "rg TODO src",
  "git status",
  "git log --oneline",
  "pnpm test",
  "pnpm exec vitest run",
  "pnpm typecheck",
  "npx tsc --noEmit",
  "node scripts/build.js",
  "./node_modules/.bin/tsc --noEmit",
];

describe("the decision recorded for a mutating command whose targets are all inside", () => {
  for (const command of ADMITTED) {
    it(`admits ${command}`, () => {
      const admission = judge(command);
      expect(admission.reason ?? "", command).toBe("");
      expect(admission.decision, command).toBe("allowed");
    });
  }
});

describe("the same verb reaching outside it", () => {
  const cases: Array<[string, string]> = [
    ["rm -r /tmp/x", "/tmp/x"],
    ["cp a ~/b", "~/b"],
    ["mv a /tmp/b", "/tmp/b"],
    ["touch /tmp/b", "/tmp/b"],
    ["mkdir -p /tmp/b", "/tmp/b"],
    ["chmod +x /etc/hosts", "/etc/hosts"],
    ["rm -r ../escape", "../escape"],
    ["printf x > /tmp/out", "/tmp/out"],
    ["env cp a ~/b", "~/b"],
  ];

  for (const [command, target] of cases) {
    it(`refuses ${command}, naming ${target}`, () => {
      const admission = judge(command);
      expect(admission.decision, command).toBe("denied");
      expect(admission.rule, command).toBe(ADMISSION_RULES.write);
      expect(admission.target, command).toBe(target);
    });
  }

  it("refuses the line whose second command escapes, though its first is inside", () => {
    const admission = judge("mkdir -p .scratch && cp .scratch/x ~/keep");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.write);
    expect(admission.target).toBe("~/keep");
  });
});

describe("the allow-list the runner already had", () => {
  for (const command of READ_AND_PACKAGE_MANAGER) {
    it(`still admits ${command}`, () => {
      expect(judge(command).decision, command).toBe("allowed");
    });
  }

  it("still admits the file tools by name", () => {
    for (const tool of ["Read", "Edit", "Write", "Glob", "Grep"]) {
      expect(judge(`${tool} ${worktree}/a`, tool).decision, tool).toBe("allowed");
    }
  });

  /**
   * `script -q /dev/null …` is refused, and not by the runner. It is on no
   * allow-list, so the agent's own permission layer stops it before it runs and
   * reports it in the result envelope, which is what puts `command_allow_list`
   * on the record. What the runner must not do is author that refusal itself:
   * the same list admits `cd`, `echo` and `pwd` with no entry, so a name
   * denial written here lands on commands that ran.
   */
  it("records `script -q /dev/null …` as allowed, the agent's layer being what refuses it", () => {
    const admission = judge("script -q /dev/null node x.js");
    expect(admission.decision).toBe("allowed");
    expect(admission.rule).toBeNull();
    expect(admission.target).toBeNull();
    expect(admittedByName("script -q /dev/null node x.js")).toBe(false);
  });

  it("records the same verb standing beside a write inside a wrapper as allowed", () => {
    const admission = judge("sh -c 'touch a; script -q /dev/null node x.js'");
    expect(admission.decision).toBe("allowed");
    expect(admission.rule).toBeNull();
  });

  it("records a verb the list does not carry as allowed where it stays inside", () => {
    const admission = judge("perl -e 'print 1'");
    expect(admission.decision).toBe("allowed");
    expect(admission.rule).toBeNull();
    expect(admittedByName("perl -e 'print 1'")).toBe(false);
  });

  /**
   * The built-ins the defect was found on: the agent's layer runs all three
   * without a list entry, so the runner has nothing to record but `allowed`.
   */
  for (const command of [
    "cd packages/evaluation",
    "cd apps/cli && pnpm exec eslint .",
    `echo "TMPDIR=$TMPDIR"; node -e 'process.stdout.write("ok")'`,
    "pwd",
  ]) {
    it(`records \`${command}\` as allowed, carrying no rule`, () => {
      const admission = judge(command);
      expect(admission.decision, command).toBe("allowed");
      expect(admission.rule, command).toBeNull();
      expect(admission.reason ?? "", command).toBe("");
    });
  }

  it("refuses a deny-listed verb before it asks where anything landed", () => {
    const admission = judge(`curl https://example.com > ${worktree}/page.html`);
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.deny_list);
  });

  /**
   * A deny-list entry matches by prefix, so it reads only the front of the line
   * as typed. While every unlisted verb was refused by name, a wrapper in front
   * of a refused one changed nothing: `env sudo rm -r sub` was denied because
   * `env sudo rm` is not an allow-list prefix either. Deciding a mutating
   * command by where its writes land removes that second line — the writes here
   * are all inside the worktree — so the deny-list has to be read against the
   * command the resolver found, not only against the line's first word.
   */
  const WRAPPED_DENIALS = [
    "env sudo rm -r sub",
    "nohup sudo rm -r sub",
    "timeout 5 sudo rm -r sub",
    "sh -c 'sudo rm -r sub'",
    "/usr/bin/sudo rm -r sub",
    "env -i sudo touch a",
    "xargs sudo rm",
  ];

  for (const command of WRAPPED_DENIALS) {
    it(`refuses ${command}, whose writes all land inside`, () => {
      // The same line without its refused verb is admitted, which is what makes
      // the refusal a fact about `sudo` rather than about the wrapper.
      expect(judge(command.replace("sudo ", "")).decision, command).toBe("allowed");

      const admission = judge(command);
      expect(admission.decision, command).toBe("denied");
      expect(admission.rule, command).toBe(ADMISSION_RULES.deny_list);
      expect(admission.reason ?? "", command).toContain("sudo");
    });
  }

  it("names the deny-list, not the allow-list, for a refused verb behind a wrapper", () => {
    // `gh` writes nothing the worktree could admit it for, so it was already
    // refused — but as an unlisted name. The rule a record carries has to be
    // the one that decided it.
    const admission = judge("env gh pr merge 1");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.deny_list);
    expect(admission.target).toBe("env gh pr merge 1");
  });

  it("refuses a tool the deny-list names, and names that list", () => {
    // `WebFetch` is denied rather than merely absent, which is what still makes
    // it a decision the runner authors about a non-Bash tool.
    const admission = judge("WebFetch https://example.com", "WebFetch");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.deny_list);
  });

  it("admits a non-Bash tool the profile simply does not list", () => {
    // `NotebookEdit` is on neither list. Whether the agent's layer ran it is
    // its own report to make, so the runner records what it saw asked for.
    const admission = judge("NotebookEdit notebook.ipynb", "NotebookEdit");
    expect(admission.decision).toBe("allowed");
    expect(admission.rule).toBeNull();
  });
});

describe("the list entries themselves", () => {
  it("keeps the read verbs and the package-manager entries it had", () => {
    for (const entry of [
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(rg:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(pnpm test:*)",
      "Bash(pnpm exec:*)",
      "Bash(npm run:*)",
      "Bash(npx:*)",
      "Bash(./node_modules/.bin/:*)",
    ]) {
      expect(DEFAULT_COMMAND_ALLOW_LIST as readonly string[]).toContain(entry);
    }
  });

  it("matches a prefix at a word boundary, so `rm` is not `rmdir`'s permission", () => {
    // The boundary is asserted on the matcher itself: the runner no longer
    // decides anything by name, and this is the rule both the deny-list here
    // and the agent's own permission layer read an entry by.
    expect(matchesListEntry("Bash(rm:*)", "Bash", "rm -r sub")).toBe(true);
    expect(matchesListEntry("Bash(rm:*)", "Bash", "rmzap sub")).toBe(false);
    expect(matchesListEntry("Bash(./node_modules/.bin/:*)", "Bash", "./node_modules/.bin/tsc")).toBe(
      true,
    );
  });

  it("still refuses a deny-listed prefix at that boundary and not past it", () => {
    const decision = (command: string) =>
      judgeCommand({
        tool: "Bash",
        detail: command,
        allow_list: [],
        deny_list: ["Bash(rm:*)"],
        scope: { root: worktree, home: "/Users/nobody" },
      }).admission;
    expect(decision("rm -r sub").decision).toBe("denied");
    expect(decision("rm -r sub").rule).toBe(ADMISSION_RULES.deny_list);
    expect(decision("rmzap sub").decision).toBe("allowed");
  });
});

/**
 * The enforced permission, which is not the recorded judgement.
 *
 * `--allowedTools` is the one control that stops a command before it runs. The
 * judgement cannot be that control: it reads a `tool_use` block, which is the
 * agent's account of a command it has already run, and on the local provider it
 * records rather than prevents (ADR-0004's amendment). Putting the write verbs
 * on the list so the judgement could decide them would let `rm -rf ~/x` run
 * once and be judged afterwards, so the list carries none of them and every one
 * is refused by name. SCP-177 runs the judgement before the tool does; that is
 * the ticket that changes what this describes.
 */
describe("the enforced allow-list, until SCP-177 runs the judgement first", () => {
  for (const command of ADMITTED) {
    it(`refuses ${command} by name, though the judgement admits it`, () => {
      expect(judge(command).decision, command).toBe("allowed");
      expect(admittedByName(command), command).toBe(false);
    });
  }

  it("carries no write verb", () => {
    for (const verb of [
      "cd", "mkdir", "rmdir", "rm", "cp", "mv", "ln", "touch", "chmod", "echo", "printf", "tee",
    ]) {
      expect(DEFAULT_COMMAND_ALLOW_LIST as readonly string[]).not.toContain(`Bash(${verb}:*)`);
    }
  });

  it("refuses the AYO-13 redirect by name, though the runner's record admits it", () => {
    // The resolver puts the target inside, so the runner records `allowed`; the
    // enforced list carries no `printf`, so the agent's layer is what stops it
    // and its report is what puts `command_allow_list` on the record.
    expect(judge(`printf '{}' > .scratch/package.json`).decision).toBe("allowed");
    expect(admittedByName(`printf '{}' > .scratch/package.json`)).toBe(false);
  });
});
