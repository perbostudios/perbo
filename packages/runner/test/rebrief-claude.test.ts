import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attemptSettings,
  discardPreToolGuard,
  guardHookEntry,
  preparePreToolGuard,
} from "../src/pretool.js";
import { briefStateBlock, readReinjections, reinjectedBrief } from "../src/brief.js";
import { buildPermissionProfile } from "../src/profile.js";
import { briefRecords, scratch } from "./support.js";

/**
 * D-096 on Claude: after a compaction the executor, and each subagent, gets
 * its brief again.
 *
 * The mechanism is a `SessionStart` hook with the `compact` matcher in the
 * attempt's own settings file, running the same program the write guard's
 * `PreToolUse` hook runs. It is driven here as Claude Code drives it — the
 * program, its one argument, the call on stdin — because what the criterion
 * asks about is what reaches the model's context, and that is this program's
 * standard output and nothing else.
 *
 * The settings file applies to the whole session, subagents included
 * (ADR-0038), so the subagent case is the same invocation with the `agent_id`
 * and `agent_type` a child's payload carries.
 */

const root = realpathSync(resolve(scratch("perbo-rebrief-")));
mkdirSync(join(root, "src"), { recursive: true });
const tmp = join(root, ".perbo-tmp");
mkdirSync(tmp, { recursive: true });
const profile = buildPermissionProfile({ worktree: root });

const BRIEF = "You are implementing one approved ticket in a Git worktree.";
const RECORDS = briefRecords();

const guardWithBrief = () =>
  preparePreToolGuard({
    worktree: root,
    tmpdir: tmp,
    profile,
    brief: { text: BRIEF, records: RECORDS },
  });

/** The hook exactly as Claude Code runs it: the program, the directory, the call on stdin. */
const runHook = (directory: string, call: Record<string, unknown>): string =>
  execFileSync(process.execPath, [guardHookEntry(), directory], {
    input: JSON.stringify(call),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

const sessionStart = (over: Record<string, unknown> = {}) => ({
  session_id: "922fba1c-0000-0000-0000-000000000000",
  transcript_path: "/dev/null",
  cwd: root,
  hook_event_name: "SessionStart",
  source: "compact",
  ...over,
});

describe("the attempt's settings file (D-096, SCP-177)", () => {
  it("carries exactly two hooks: the write guard's, and the brief's", () => {
    const settings = attemptSettings("/bin/true") as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    expect(settings.hooks["SessionStart"]).toHaveLength(1);
    expect(settings.hooks["SessionStart"]![0]!.matcher).toBe("compact");
    // Both run the runner's own program, and nothing a model returned reaches it.
    expect(settings.hooks["SessionStart"]![0]!.hooks[0]!.command).toBe("/bin/true");
    expect(settings.hooks["PreToolUse"]![0]!.hooks[0]!.command).toBe("/bin/true");
  });

  it("names the runner's compiled hook program, from a path the runner computed", () => {
    const guard = guardWithBrief();
    const written = JSON.parse(readFileSync(guard.settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of ["PreToolUse", "SessionStart"]) {
      const command = written.hooks[event]![0]!.hooks[0]!.command;
      expect(command).toContain(guardHookEntry());
      expect(command).toContain(guard.directory);
    }
    discardPreToolGuard(guard);
  });
});

describe("what the hook program prints after a compaction (D-096)", () => {
  it("prints the recorded brief and the state block, and nothing else", () => {
    const guard = guardWithBrief();
    const printed = runHook(guard.directory, sessionStart());
    expect(printed).toBe(reinjectedBrief(BRIEF, RECORDS));
    expect(printed).toContain(BRIEF);
    expect(printed).toContain(briefStateBlock(RECORDS));
    discardPreToolGuard(guard);
  });

  it("prints the same to a subagent of the attempt, and records which agent", () => {
    const guard = guardWithBrief();
    const printed = runHook(
      guard.directory,
      sessionStart({ agent_id: "a1068d4ecef4890c3", agent_type: "writer-b" }),
    );
    expect(printed).toBe(reinjectedBrief(BRIEF, RECORDS));

    const recorded = readReinjections(guard.directory);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.target).toBe("a1068d4ecef4890c3");
    expect(recorded[0]!.mechanism).toBe("session_start_hook");
    expect(Date.parse(recorded[0]!.at)).not.toBeNaN();
    discardPreToolGuard(guard);
  });

  it("prints nothing for any other source, and records nothing", () => {
    const guard = guardWithBrief();
    for (const source of ["startup", "resume", "clear"]) {
      expect(runHook(guard.directory, sessionStart({ source }))).toBe("");
    }
    expect(readReinjections(guard.directory)).toEqual([]);
    discardPreToolGuard(guard);
  });

  it("records the session's own re-injections beside its subagents'", () => {
    const guard = guardWithBrief();
    runHook(guard.directory, sessionStart());
    runHook(guard.directory, sessionStart({ agent_id: "a1068d4ecef4890c3", agent_type: "writer-b" }));
    const recorded = readReinjections(guard.directory);
    expect(recorded.map((entry) => entry.target)).toEqual([null, "a1068d4ecef4890c3"]);
    discardPreToolGuard(guard);
  });

  it("skips a torn line in the record and keeps the lines around it", () => {
    const guard = guardWithBrief();
    runHook(guard.directory, sessionStart());
    appendFileSync(join(guard.directory, "reinjections.jsonl"), '{"target":"a1068d4ecef4890c3","mech');
    appendFileSync(join(guard.directory, "reinjections.jsonl"), "\n");
    runHook(guard.directory, sessionStart({ agent_id: "a1068d4ecef4890c3", agent_type: "writer-b" }));
    expect(readReinjections(guard.directory).map((entry) => entry.target)).toEqual([null, "a1068d4ecef4890c3"]);
    discardPreToolGuard(guard);
  });

  it("still judges a tool call, which is the other hook on the same program", () => {
    const guard = guardWithBrief();
    const answer = JSON.parse(
      runHook(guard.directory, {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_use_id: "toolu_a",
        tool_input: { file_path: "/tmp/perbo-scp324" },
      }),
    ) as { hookSpecificOutput: { permissionDecision: string } };
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(readReinjections(guard.directory)).toEqual([]);
    discardPreToolGuard(guard);
  });
});
