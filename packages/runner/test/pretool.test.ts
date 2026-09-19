import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMISSION_RULES, judgeCommand } from "../src/admission.js";
import {
  PRE_TOOL_JUDGED_TOOLS,
  discardPreToolGuard,
  judgePreToolCall,
  attemptSettings,
  preparePreToolGuard,
  readPreToolDecisions,
  runPreToolHook,
  type PreToolGuardState,
} from "../src/pretool.js";
import { UNKNOWN_CWD, inspectToolWrite } from "../src/prohibited.js";
import { buildPermissionProfile } from "../src/profile.js";
import { scratch } from "./support.js";

/**
 * SCP-177: the judgement that runs before the tool.
 *
 * Nothing here spawns an agent. What is being checked is the decision itself —
 * that a mutating verb is admitted on where its paths land rather than on its
 * name, that a path outside the root is refused whichever tool names it, and
 * that a refused call leaves the shell where it was, because a refused `cd`
 * never happened. The live test beside this one proves the pinned binary obeys
 * the answer; this one proves the answer is right.
 */

// The resolver walks symlinks, and on macOS `/var` is one, so the root a
// decision names is the resolved spelling.
const root = realpathSync(resolve(scratch("perbo-pretool-")));
mkdirSync(join(root, "packages", "evaluation"), { recursive: true });
const tmp = join(root, ".perbo-tmp");
mkdirSync(tmp, { recursive: true });
const profile = buildPermissionProfile({ worktree: root });

const stateAt = (cwd: string = root, paths_allowed: string[] = []): PreToolGuardState => ({
  root,
  tmpdir: tmp,
  cwd,
  paths_allowed,
  paths_prohibited: [],
  allow_list: [...profile.command_allow_list],
  deny_list: [...profile.command_deny_list],
});

const judgeBash = (command: string, cwd: string = root, paths_allowed: string[] = []) =>
  judgePreToolCall(
    { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command } },
    stateAt(cwd, paths_allowed),
    new Date("2026-09-03T00:00:00.000Z"),
  );

const judgeFile = (tool: string, file_path: string, paths_allowed: string[] = []) =>
  judgePreToolCall(
    { tool_name: tool, tool_use_id: "toolu_2", tool_input: { file_path } },
    stateAt(root, paths_allowed),
    new Date("2026-09-03T00:00:00.000Z"),
  );

describe("what the guard vouches for", () => {
  // The three commands AYO-13's executor was refused, verbatim in shape: it
  // built a fixture store inside its own worktree and could not remove it.
  it("admits AYO-13's three commands, none of whose verbs is on the allow-list", () => {
    for (const command of [
      "mkdir -p .scratch-judging/.perbo && printf '{}' > .scratch-judging/package.json",
      "rm -r .scratch-judging",
      `rm -rf ${root}/.scratch-judging`,
    ]) {
      expect(judgeBash(command).decision.answer, command).toBe("allow");
    }
    for (const verb of ["mkdir -p a/b", "touch a", "cp a b", "mv a b", "chmod 644 a", "rm a"]) {
      expect(judgeBash(verb).decision.answer, verb).toBe("allow");
    }
  });

  it("refuses the same verbs on a target outside the worktree, naming the path", () => {
    const outside = judgeBash("rm -r /tmp/x").decision;
    expect(outside.answer).toBe("deny");
    expect(outside.decision).toBe("denied");
    expect(outside.rule).toBe(ADMISSION_RULES.write);
    expect(outside.target).toBe("/tmp/x");

    const home = judgeBash("cp a ~/b").decision;
    expect(home.answer).toBe("deny");
    expect(home.rule).toBe(ADMISSION_RULES.write);
    expect(home.target).toBe("~/b");
  });

  it("says nothing about a verb it has no grounds for, so the outer list decides", () => {
    // `allow` here would run it: a hook's admission bypasses `--allowedTools`
    // entirely. Silence is what keeps `script -q /dev/null …` refused, and the
    // same silence is what stops the runner refusing `pwd`, which the agent's
    // own layer has always admitted with no entry of its own.
    expect(judgeBash("script -q /dev/null node build.js").decision.answer).toBe("defer");
    expect(judgeBash("pwd").decision.answer).toBe("defer");
    expect(judgeBash("ls -la").decision.answer).toBe("defer");
    // And one unvouched command on the line takes the whole line with it.
    expect(judgeBash("mkdir -p a && script -q /dev/null node x.js").decision.answer).toBe("defer");
  });

  it("keeps the scratch directory inside and the literal /tmp outside", () => {
    expect(judgeBash("printf x > $TMPDIR/x").decision.answer).toBe("allow");
    expect(judgeBash("printf x > /tmp/x").decision.answer).toBe("deny");
  });

  it("vouches for a directory move and the line it was made for", () => {
    // AYO-13's `cd apps/cli && pnpm vitest run` was refused because `cd` is on
    // no list. Moving the shell is not an effect the list has anything to say
    // about, and where it leaves the next line is SCP-170's tracking.
    expect(judgeBash("cd packages/evaluation && pnpm test").decision.answer).toBe("allow");
  });
});

describe("the shell the refusal did not move", () => {
  it("carries a directory forward from an admitted move", () => {
    const moved = judgeBash("cd packages/evaluation");
    expect(moved.decision.decision).toBe("allowed");
    expect(moved.next_cwd).toBe(join(root, "packages", "evaluation"));
    // SCP-170's pair: the second line is judged from where the first one left it.
    expect(judgeBash("rm -rf ../../.perbo-tmp/x", moved.next_cwd).decision.decision).toBe(
      "allowed",
    );
  });

  it("leaves the directory where it was when the call was refused", () => {
    // The `cd` is on a line the guard refuses, so the tool never ran and the
    // shell never moved. The reading after the fact cannot know this, because
    // before the hook existed a refused command had already executed.
    const refused = judgeBash("cd packages/evaluation && printf x > /tmp/x");
    expect(refused.decision.answer).toBe("deny");
    expect(refused.next_cwd).toBe(root);
  });

  it("refuses a move it cannot read, and so never loses track of the shell", () => {
    // SCP-170 marked the directory unknown here and refused every later
    // relative write by name, because before this hook a `cd` the runner could
    // not read had already happened. Enforced before the tool, the same line is
    // refused by the write rule and the shell stays where it was, so the writes
    // after it are still judged rather than all refused. The unknown state
    // remains reachable from the reading after the fact, which is what the
    // attempt's second reading still is, and it still refuses relative targets.
    const moved = judgeBash("cd $DIR");
    expect(moved.decision.answer).toBe("deny");
    expect(moved.decision.rule).toBe(ADMISSION_RULES.write);
    expect(moved.next_cwd).toBe(root);
    expect(judgeBash("printf x > y", moved.next_cwd).decision.answer).toBe("allow");
    expect(judgeBash("printf x > y", UNKNOWN_CWD).decision.answer).toBe("deny");
  });
});

describe("a file tool's path, judged before the write", () => {
  it("says nothing about a path inside the worktree, which the outer list carries", () => {
    expect(judgeFile("Write", join(root, "src", "index.ts")).decision.answer).toBe("defer");
    expect(judgeFile("Edit", join(root, "packages", "evaluation", "x.ts")).decision.answer).toBe(
      "defer",
    );
  });

  it("refuses a path outside it, with the write rule and the path (SCP-161)", () => {
    const decision = judgeFile("Write", "/tmp/perbo-scp177-unit").decision;
    expect(decision.answer).toBe("deny");
    expect(decision.decision).toBe("denied");
    expect(decision.rule).toBe(ADMISSION_RULES.write);
    expect(decision.target).toBe("/tmp/perbo-scp177-unit");
  });

  it("refuses a path that climbs out of the worktree however it is spelled", () => {
    expect(judgeFile("Edit", join(root, "..", "escape.ts")).decision.answer).toBe("deny");
  });

  it("says nothing about a tool it was not built for, even one carrying a path", () => {
    // `Read` carries `file_path` too, and the guard's file-tool branch is about
    // where a *write* lands. Judging a read on that rule refused it under
    // `write_outside_worktree`, which is a sentence about the wrong act. The
    // matcher never sends one here; the function says so itself now.
    for (const tool of ["Read", "Glob", "Grep", "WebFetch"]) {
      const decision = judgeFile(tool, "/tmp/perbo-scp177-read").decision;
      expect(decision.answer, tool).toBe("defer");
      expect(decision.rule, tool).toBeNull();
    }
    // And the five it was built for still answer.
    for (const tool of PRE_TOOL_JUDGED_TOOLS.filter((name) => name !== "Bash")) {
      expect(judgeFile(tool, "/tmp/perbo-scp177-read").decision.answer, tool).toBe("deny");
    }
  });
});

/**
 * SCP-195: the contract's allowed paths, enforced before the write.
 *
 * AYO-31 edited the root `package.json` and AYO-34 the assembler, both outside
 * their contracts' `paths_allowed`, and both were found at review — one run
 * each. The worktree root was never the whole boundary: a contract names the
 * globs an attempt may write under, and the guard that already resolves a
 * destination is the thing that can refuse one before it exists.
 *
 * The globs are the contract's, widened exactly as the contract itself widens
 * them (`admittedWriteGlobs`), so the sentence the executor is given and the
 * sentence the refusal prints are the same sentence.
 */
describe("the contract's allowed paths, before the write", () => {
  const scoped = ["apps/cli/**"];
  const everything = ["**"];

  it("refuses a shell write outside the globs, naming the glob", () => {
    const decision = judgeBash("echo x > packages/contracts/src/a.ts", root, scoped).decision;
    expect(decision.answer).toBe("deny");
    expect(decision.decision).toBe("denied");
    expect(decision.rule).toBe(ADMISSION_RULES.scope);
    expect(decision.target).toBe("packages/contracts/src/a.ts");
    expect(decision.reason).toContain("apps/cli/**");
  });

  it("refuses a file tool's destination outside the globs, naming the glob", () => {
    const decision = judgeFile("Write", "package.json", scoped).decision;
    expect(decision.answer).toBe("deny");
    expect(decision.rule).toBe(ADMISSION_RULES.scope);
    expect(decision.target).toBe("package.json");
    expect(decision.reason).toContain("apps/cli/**");
    // The absolute spelling of the same file is the same write.
    expect(judgeFile("Write", join(root, "package.json"), scoped).decision.answer).toBe("deny");
  });

  it("admits both of them under `**`, which is the ticketless run's scope", () => {
    expect(judgeBash("echo x > packages/contracts/src/a.ts", root, everything).decision.decision).toBe(
      "allowed",
    );
    expect(judgeFile("Write", "package.json", everything).decision.decision).toBe("allowed");
    expect(judgeFile("Write", "package.json", everything).decision.answer).not.toBe("deny");
  });

  it("admits a write inside the globs, and the scratch directory outside them", () => {
    expect(judgeBash("echo x > apps/cli/src/a.ts", root, scoped).decision.answer).toBe("allow");
    expect(judgeFile("Write", join(root, "apps", "cli", "src", "a.ts"), scoped).decision.answer).toBe(
      "defer",
    );
    // `$TMPDIR` is the runner's own directory inside the worktree; it is never
    // sealed, so no contract names it and the globs do not judge it.
    expect(judgeBash("printf x > $TMPDIR/x", root, scoped).decision.answer).toBe("allow");
  });

  it("leaves a read outside the globs alone: the rule is about writes", () => {
    expect(judgeFile("Read", "package.json", scoped).decision.answer).toBe("defer");
    expect(judgeFile("Read", "package.json", scoped).decision.rule).toBeNull();
    for (const command of ["cat package.json", "git show HEAD:package.json", "rg TODO packages"]) {
      expect(judgeBash(command, root, scoped).decision.decision, command).toBe("allowed");
    }
  });

  it("still refuses a write outside the worktree under the worktree rule", () => {
    // The two refusals stay distinct: leaving the tree is not leaving the scope,
    // and the record has to say which one happened.
    const decision = judgeBash("printf x > /tmp/x", root, scoped).decision;
    expect(decision.answer).toBe("deny");
    expect(decision.rule).toBe(ADMISSION_RULES.write);
  });
});

/**
 * The two readings, on the same call.
 *
 * The runner reads a tool call twice: the hook reads it before it runs, and the
 * transcript reads it as the agent announces it. They are one reading in two
 * places — the hook calls `judgeCommand`, which calls the same `shell.ts` the
 * adapter's reading does — and that is a property worth a test, because the
 * two arrived from different tickets and only their agreement makes the
 * sentence docs/08 prints true. A shape the transcript refuses and the hook
 * defers on is a write that happens and is then reported.
 */
describe("the hook and the transcript reading agree on the same call", () => {
  const transcriptBash = (command: string) =>
    judgeCommand({
      tool: "Bash",
      detail: command,
      allow_list: profile.command_allow_list,
      deny_list: profile.command_deny_list,
      scope: { root, tmpdir: tmp, cwd: root },
    }).admission;

  it("refuses an interpreter's inline code by the path written in it", () => {
    const command = `python3 -c "open('/etc/x','w')"`;
    const hook = judgeBash(command).decision;
    expect(hook.answer).toBe("deny");
    expect(hook.rule).toBe(ADMISSION_RULES.write);
    expect(hook.reason).toContain("/etc/x");

    const transcript = transcriptBash(command);
    expect(transcript.decision).toBe("denied");
    expect(transcript.rule).toBe(hook.rule);
    expect(transcript.target).toBe(hook.target);
  });

  it("refuses inline code the read-only table cannot vouch for (SCP-190)", () => {
    // Not a path and not a named write call: the shape simply is not one the
    // table can show writes nothing. Both readings have to reach that the same
    // way, or the hook admits a line the transcript then terminates on. Since
    // SCP-234 the rule says which of the two write refusals this is — a program
    // the guard could not read, which places nothing.
    const command = `python3 -c "__import__('os').remove(chr(47)+'x')"`;
    const hook = judgeBash(command).decision;
    expect(hook.answer).toBe("deny");
    expect(hook.rule).toBe(ADMISSION_RULES.unreadable_inline_program);
    expect(hook.reason).toContain("python3");
    expect(hook.reason).toContain("__import__");

    const transcript = transcriptBash(command);
    expect(transcript.decision).toBe("denied");
    expect(transcript.rule).toBe(hook.rule);
    expect(transcript.target).toBe(hook.target);
    expect(transcript.reason).toBe(hook.reason);
  });

  it("keeps the three lines SCP-190 names on the allowed side of both", () => {
    for (const command of [
      `python3 -c "print(1+1)"`,
      `node -e "console.log(process.version)"`,
      `python3 -c "import json,sys; print(json.load(open('package.json'))['name'])"`,
    ]) {
      expect(judgeBash(command).decision.decision, command).toBe("allowed");
      expect(transcriptBash(command).decision, command).toBe("allowed");
    }
  });

  it("refuses a writer a redirect never passes through", () => {
    const command = "pnpm test | tee ~/log.txt";
    const hook = judgeBash(command).decision;
    expect(hook.answer).toBe("deny");
    expect(hook.rule).toBe(ADMISSION_RULES.write);
    expect(hook.target).toBe("~/log.txt");

    const transcript = transcriptBash(command);
    expect(transcript.decision).toBe("denied");
    expect(transcript.rule).toBe(hook.rule);
    expect(transcript.target).toBe(hook.target);
  });

  it("refuses a file tool's path outside the root under that same rule", () => {
    const target = "/tmp/perbo-agreement-outside.txt";
    const hook = judgeFile("Write", target).decision;
    expect(hook.answer).toBe("deny");
    expect(hook.rule).toBe(ADMISSION_RULES.write);
    expect(hook.target).toBe(target);

    // The transcript's reading of a file tool is `inspectToolWrite`, which puts
    // the same path through the same resolver and reports it as the same
    // prohibited action the rule is named for.
    const hits = inspectToolWrite("Write", { file_path: target }, { root, tmpdir: tmp });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe(ADMISSION_RULES.write);
    expect(hits[0]!.detail).toContain(target);
  });

  it("refuses a write outside the contract's globs on both sides (SCP-195)", () => {
    const scoped = ["apps/cli/**"];
    const command = "echo x > packages/contracts/src/a.ts";
    const hook = judgeBash(command, root, scoped).decision;
    expect(hook.answer).toBe("deny");
    expect(hook.rule).toBe(ADMISSION_RULES.scope);

    // The transcript reading takes the globs from the same scope object, so it
    // cannot reach a different answer about the same line.
    const transcript = judgeCommand({
      tool: "Bash",
      detail: command,
      allow_list: profile.command_allow_list,
      deny_list: profile.command_deny_list,
      scope: { root, tmpdir: tmp, cwd: root, paths_allowed: scoped },
    }).admission;
    expect(transcript.decision).toBe("denied");
    expect(transcript.rule).toBe(hook.rule);
    expect(transcript.target).toBe(hook.target);
    expect(transcript.reason).toBe(hook.reason);
  });

  it("refuses a file tool outside the globs on both sides, under the scope rule", () => {
    const scoped = ["apps/cli/**"];
    const hook = judgeFile("Write", "package.json", scoped).decision;
    expect(hook.answer).toBe("deny");
    expect(hook.rule).toBe(ADMISSION_RULES.scope);

    const hits = inspectToolWrite(
      "Write",
      { file_path: "package.json" },
      { root, tmpdir: tmp, paths_allowed: scoped },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe(ADMISSION_RULES.scope);
    expect(hits[0]!.detail).toContain("apps/cli/**");
  });

  it("admits the same two calls on both sides under `**`", () => {
    const everything = ["**"];
    for (const command of ["echo x > packages/contracts/src/a.ts", "cp a package.json"]) {
      expect(judgeBash(command, root, everything).decision.decision, command).toBe("allowed");
      expect(
        judgeCommand({
          tool: "Bash",
          detail: command,
          allow_list: profile.command_allow_list,
          deny_list: profile.command_deny_list,
          scope: { root, tmpdir: tmp, cwd: root, paths_allowed: everything },
        }).admission.decision,
        command,
      ).toBe("allowed");
    }
    expect(
      inspectToolWrite(
        "Write",
        { file_path: "package.json" },
        { root, tmpdir: tmp, paths_allowed: everything },
      ),
    ).toEqual([]);
  });

  it("keeps a program the line reads from a file on the allowed side of both", () => {
    // The exception docs/08 draws: a script **file** is read by the review, and
    // neither reading refuses it. Asserted so the refusals above are known to
    // be about inline code rather than about the interpreter's name.
    for (const command of ["python3 scripts/report.py", "node scripts/build.js"]) {
      expect(judgeBash(command).decision.decision, command).toBe("allowed");
      expect(transcriptBash(command).decision, command).toBe("allowed");
    }
  });
});

describe("the hook the adapter installs", () => {
  it("matches every tool that can write, and is one of the file's two hooks", () => {
    const settings = attemptSettings("/bin/true") as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    // The other is the brief a compaction gets back (D-096); nothing else.
    expect(Object.keys(settings.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    for (const tool of PRE_TOOL_JUDGED_TOOLS) {
      expect(settings.hooks.PreToolUse[0]!.matcher).toContain(tool);
    }
  });

  it("keeps its state outside the worktree, where a write to it is refused", () => {
    const guard = preparePreToolGuard({ worktree: root, tmpdir: tmp, profile });
    expect(guard.directory.startsWith(root)).toBe(false);
    // Which is the property that protects it: the guard refuses writes there.
    expect(judgeBash(`printf x > ${guard.statePath}`).decision.answer).toBe("deny");
    discardPreToolGuard(guard);
  });

  it("records one decision per call and advances the shell for the next one", () => {
    const guard = preparePreToolGuard({ worktree: root, tmpdir: tmp, profile });

    const first = runPreToolHook(
      guard.directory,
      JSON.stringify({
        tool_name: "Bash",
        tool_use_id: "toolu_a",
        tool_input: { command: "cd packages/evaluation" },
      }),
    );
    expect(first?.hookSpecificOutput.permissionDecision).toBe("allow");

    const second = runPreToolHook(
      guard.directory,
      JSON.stringify({
        tool_name: "Bash",
        tool_use_id: "toolu_b",
        tool_input: { command: "rm -rf ../../.perbo-tmp/x" },
      }),
    );
    expect(second?.hookSpecificOutput.permissionDecision).toBe("allow");

    const third = runPreToolHook(
      guard.directory,
      JSON.stringify({
        tool_name: "Write",
        tool_use_id: "toolu_c",
        tool_input: { file_path: "/tmp/perbo-scp177-hook" },
      }),
    );
    expect(third?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(third?.hookSpecificOutput.permissionDecisionReason).toContain(
      "/tmp/perbo-scp177-hook",
    );

    // A call it has nothing to say about prints nothing at all.
    const fourth = runPreToolHook(
      guard.directory,
      JSON.stringify({
        tool_name: "Bash",
        tool_use_id: "toolu_e",
        tool_input: { command: "ls -la" },
      }),
    );
    expect(fourth).toBeNull();

    const decisions = readPreToolDecisions(guard.decisionsPath);
    expect(decisions.map((decision) => decision.tool_use_id)).toEqual([
      "toolu_a",
      "toolu_b",
      "toolu_c",
      "toolu_e",
    ]);
    expect(decisions[3]!.answer).toBe("defer");
    expect(decisions[1]!.cwd).toBe(join("packages", "evaluation"));
    expect(decisions[2]!.rule).toBe(ADMISSION_RULES.write);
    // The command text is not in the file: it is unredacted, and it would put
    // a materialized secret outside the reach of the secret index.
    expect(readFileSync(guard.decisionsPath, "utf8")).not.toContain("rm -rf");
    discardPreToolGuard(guard);
  });

  it("refuses everything when it cannot read its own state, rather than failing open", () => {
    const guard = preparePreToolGuard({ worktree: root, tmpdir: tmp, profile });
    writeFileSync(guard.statePath, "{ this is not json", "utf8");
    const answer = runPreToolHook(
      guard.directory,
      JSON.stringify({ tool_name: "Bash", tool_use_id: "toolu_d", tool_input: { command: "ls" } }),
    );
    expect(answer?.hookSpecificOutput.permissionDecision).toBe("deny");
    discardPreToolGuard(guard);
  });
});
