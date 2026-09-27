import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { ADMISSION_RULES, matchesListEntry } from "./admission.js";
import { runAgent } from "./adapter.js";
import { AttemptCeilings } from "./ceilings.js";
import { codexCommandDecision } from "./codex/index.js";
import { opencodeDecision } from "./opencode/index.js";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import { buildPermissionProfile, DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "./profile.js";
import { fakeAgent } from "./test-support/fake-agent.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * `git branch` lists branches and, given other words, changes one. The
 * listing is a read the executor and the chat both reach for — the chat to
 * see the branch a stopped loop left — so the allow list carries the verb and
 * the guard refuses, by the words it is given, every form that changes a
 * branch (`git_branch_write`). Each variant is run through every executor's
 * decision: Claude Code's hook, Codex's approvals and OpenCode's permission
 * requests, with the outer permission layer's own prefix match beside them.
 */
const ROOT = realpathSync(scratch("perbo-git-branch-"));

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

/** The prefix match the agent's own permission layer applies to the same lists. */
const listed = (list: readonly string[], line: string): boolean =>
  list.some((entry) => matchesListEntry(entry, "Bash", line));

/** The listing forms, `git branch -a -v` — the chat's look at a stopped loop's branch — among them. */
const LISTS = [
  "git branch",
  "git branch -a -v",
  "git branch -a",
  "git branch --all",
  "git branch -r",
  "git branch --remotes",
  "git branch -v",
  "git branch -vv",
  "git branch --verbose",
  "git branch -avv",
  "git branch --list",
  "git branch -l",
  "git branch --list 'feat/*'",
  "git branch -l 'feat/*'",
  "git branch 'feat/*' --list",
  "git branch -al 'feat/*'",
  "git branch --show-current",
  "git branch --contains",
  "git branch --contains HEAD",
  "git branch --contains=HEAD",
  "git branch --no-contains main",
  "git branch --merged",
  "git branch --merged main",
  "git branch -r --merged main",
  "git branch --no-merged main",
  "git branch --points-at HEAD",
  "git branch --sort=-committerdate",
  "git branch --sort -committerdate",
  "git branch --format='%(refname:short)'",
  "git branch --format '%(refname:short) %(upstream)'",
  "git branch --color",
  "git branch --color=always -a",
  "git branch --no-color",
  "git branch --column",
  "git branch --column=never",
  "git branch --no-column",
  "git branch --abbrev=7 -v",
  "git branch --no-abbrev -v",
  "git branch -i --list 'Feat*'",
  "git branch --ignore-case --list 'feat*'",
  "git branch -a 2>/dev/null",
  "git branch -a -v 2>&1",
];

/** Every form that changes a branch, or whose words the guard cannot read. */
const WRITES = [
  // Deletes, renames, copies.
  "git branch -d feature",
  "git branch -D feature",
  "git branch --delete feature",
  "git branch -m old new",
  "git branch -M new",
  "git branch --move old new",
  "git branch -c old new",
  "git branch -C new",
  "git branch --copy old new",
  // Upstream, description, force, tracking, reflog.
  "git branch -u origin/main",
  "git branch --set-upstream-to=origin/main",
  "git branch --set-upstream-to origin/main",
  "git branch --unset-upstream",
  "git branch --edit-description",
  "git branch -f feature HEAD",
  "git branch --force feature HEAD",
  "git branch --track feature origin/feature",
  "git branch --no-track feature origin/main",
  "git branch --create-reflog feature",
  // A name with no `--list` beside it creates the branch.
  "git branch feature",
  "git branch feature HEAD~1",
  "git branch -v feature",
  "git branch --sort=refname feature",
  // A write flag among read ones, clustered, or where a commit could stand.
  "git branch -aD feature",
  "git branch -a -D feature",
  "git branch --list -D feature",
  "git branch --contains -D feature",
  // git's own abbreviations of a write flag.
  "git branch --del feature",
  "git branch --mo old new",
  // Quoted, the shell hands git the flag all the same.
  'git branch "-D" feature',
  "git branch '-D' feature",
  // A word the line builds when it runs.
  "git branch $(printf -- -D) feature",
  "git branch `printf -- -D` feature",
  "X=-D; git branch $X feature",
  'git branch "$NAME"',
  "git branch --list --sort $(printf refname) 'x*'",
  "git branch --list feat*",
  "git branch {-D,feature}",
  // `--` and `--end-of-options` make what follows a name.
  "git branch -- feature",
  "git branch --list -- 'feat*'",
  "git branch --end-of-options feature",
  // A line continuation joins the flag to the verb.
  "git branch \\\n -D feature",
  // Past git's global options, behind wrappers, and inside a substitution.
  "git -C . branch -D feature",
  "git --no-pager branch -D feature",
  "git -P branch -D feature",
  "git --super-prefix=x/ branch -D feature",
  "/usr/bin/git branch -D feature",
  "env git branch -D feature",
  "command git branch feature",
  "sh -c 'git branch -D feature'",
  'echo "$(git branch -D feature)"',
  "git status && git branch -D feature",
  "git branch -a | xargs git branch -D",
];

describe("git branch's listing forms", () => {
  for (const line of LISTS) {
    it(`admits ${JSON.stringify(line)} on every executor`, () => {
      expect(listed(DEFAULT_COMMAND_ALLOW_LIST, line), line).toBe(true);
      expect(listed(DEFAULT_COMMAND_DENY_LIST, line), line).toBe(false);
      // The hook has no refusal and leaves the line to the agent's own layer,
      // which admits it by the allow list's entry.
      expect(claude(line), line).toMatchObject({ decision: "allowed", answer: "defer" });
      expect(codex(line).decision, line).toBe("allowed");
      expect(opencode(line), line).toEqual({ decision: "allowed" });
    });
  }

  it("has no refusal past git's global options, where the prefix entry does not reach", () => {
    // A prefix names the words in front, so `git -C . log` is outside every
    // `git` entry on the list, and `git -C . branch -a` is too: the guard
    // refuses nothing here, and the agent's own layer decides.
    for (const line of ["git -C . branch -a", "git --no-pager branch -a -v", "git -P branch -a"]) {
      expect(listed(DEFAULT_COMMAND_ALLOW_LIST, line), line).toBe(false);
      expect(claude(line), line).toMatchObject({ decision: "allowed", rule: null });
    }
  });
});

describe("git branch changing a branch", () => {
  for (const line of WRITES) {
    it(`refuses ${JSON.stringify(line)} on every executor`, () => {
      expect(claude(line), line).toMatchObject({
        decision: "denied",
        answer: "deny",
        rule: ADMISSION_RULES.git_branch_write,
      });
      expect(codex(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_branch_write });
      expect(opencode(line), line).toMatchObject({ decision: "denied", rule: ADMISSION_RULES.git_branch_write });
    });
  }

  it("says which word made it a write", () => {
    expect(claude("git branch -D feature").reason).toContain("-D changes a branch");
    expect(claude("git branch --set-upstream-to=origin/main").reason).toContain("--set-upstream-to changes a branch");
    expect(claude("git branch feature").reason).toContain("feature names a branch for git branch to create");
    expect(claude("git branch -- feature").reason).toContain("-- makes every word after it");
    expect(claude("X=-D; git branch $X feature").reason).toContain("$X is expanded when the line runs");
  });

  it("keeps the deny list's other git verbs where they were", () => {
    for (const line of ["git push origin HEAD", "git commit -m x", "git tag v1", "git remote add x y"]) {
      expect(claude(line), line).toMatchObject({ answer: "deny", rule: ADMISSION_RULES.deny_list });
    }
  });
});

describe("an executor that lists branches", () => {
  it("lists them, is refused a delete, and carries on", async () => {
    const worktree = realpathSync(scratch("perbo-git-branch-run-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: worktree,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git("init", "--quiet", "--initial-branch=main");
    writeFileSync(join(worktree, "README.md"), "# fixture\n");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "init");
    git("branch", "perbo/left-by-a-stopped-loop");

    const agent = fakeAgent(scratch, [
      {
        kind: "guarded",
        calls: [
          { tool: "Bash", input: { command: "git branch -a -v > branches.txt" } },
          { tool: "Bash", input: { command: "git branch -D perbo/left-by-a-stopped-loop" } },
          { tool: "Write", input: { file_path: join(worktree, "notes.md"), content: "carried on\n" } },
        ],
      },
    ]);
    const result = await runAgent({
      binary: agent.binary,
      worktree,
      prompt: "look at the branches",
      model: "none",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });

    expect(result.commands.map((command) => [command.decision, command.denial_rule])).toEqual([
      ["allowed", null],
      ["denied", ADMISSION_RULES.git_branch_write],
      ["allowed", null],
    ]);
    // The listing ran and printed the branch; the delete did not run.
    expect(readFileSync(join(worktree, "branches.txt"), "utf8")).toContain("perbo/left-by-a-stopped-loop");
    expect(git("branch", "--list", "perbo/left-by-a-stopped-loop")).toContain("perbo/left-by-a-stopped-loop");
    expect(existsSync(join(worktree, "notes.md"))).toBe(true);
    expect(result.termination.reason).toBe("completed");
  }, 60_000);
});
