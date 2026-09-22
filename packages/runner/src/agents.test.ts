import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { ADMISSION_RULES } from "./admission.js";
import { PERBO_AGENT_ROLES, SUBAGENT_TOOL_NAMES } from "./agents.js";
import { buildArgv } from "./adapter.js";
import {
  attemptSettings,
  discardPreToolGuard,
  guardHookEntry,
  preparePreToolGuard,
  readPreToolDecisions,
  type PreToolGuard,
} from "./pretool.js";
import {
  buildPermissionProfile,
  DEFAULT_AGENT_TOOLS,
  DEFAULT_COMMAND_ALLOW_LIST,
  DEFAULT_COMMAND_DENY_LIST,
} from "./profile.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * D-106 criterion 1: the executor may start only Perbo's roles.
 *
 * ADR-0038's live test found that once `Task` is allowed, Claude Code offers
 * the executor its own built-in agents, the ones a plugin supplies and the
 * ones the person keeps in `~/.claude/agents` — and that none of those calls
 * reached the guard, because the hook was installed for the five writing tools
 * alone. So the enforcement has two halves, and both are driven here: the
 * invocation offers Perbo's roles and nothing else, and the hook refuses a
 * call naming anything outside that set before the subagent starts, under
 * either name Claude Code answers to for the tool — `Agent`, the name the
 * pinned binary sends, and `Task`, its former name (SCP-326).
 *
 * The hook is driven as Claude Code drives it — the program, the guard's
 * directory as its one argument, the call as JSON on stdin — because what a
 * refusal is made of is this program's standard output and nothing else.
 */

const root = realpathSync(resolve(scratch("perbo-subagent-roles-")));
const profile = buildPermissionProfile({ worktree: root });

const guardFor = (): PreToolGuard =>
  preparePreToolGuard({ worktree: root, tmpdir: null, profile, paths_allowed: ["src/**"] });

const runHook = (directory: string, call: Record<string, unknown>): string =>
  execFileSync(process.execPath, [guardHookEntry(), directory], {
    input: JSON.stringify(call),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

/**
 * The hook payload for a call to the subagent tool, under whichever name the
 * test drives — `tool` has no default, so every call site says which one.
 */
const subagentCall = (
  tool: string,
  input: Record<string, unknown>,
  over: Record<string, unknown> = {},
) => ({
  session_id: "922fba1c-0000-0000-0000-000000000000",
  cwd: root,
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_use_id: "toolu_task_1",
  tool_input: input,
  ...over,
});

interface HookAnswer {
  hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
}

/** The role name the person's own definition declares, read out of the file itself. */
function personalAgentName(): string {
  const home = scratch("perbo-fake-home-");
  const definitions = join(home, ".claude", "agents");
  mkdirSync(definitions, { recursive: true });
  const file = join(definitions, "shipper.md");
  writeFileSync(
    file,
    "---\nname: shipper\ndescription: The person's own agent\n---\nYou ship things.\n",
    "utf8",
  );
  const front = /^name:[ \t]*(\S+)[ \t]*$/m.exec(readFileSync(file, "utf8"));
  if (front === null) throw new Error("the fixture definition declares no name");
  return front[1]!;
}

describe("what the executor is offered (D-106, ADR-0038)", () => {
  it("passes Perbo's roles and no others", () => {
    const { argv } = buildArgv({
      worktree: root,
      prompt: "do the thing",
      model: "claude-opus-5",
      profile,
      settingsPath: "/tmp/perbo-guard/settings.json",
    });
    expect(argv).toContain("--agents");
    const offered = JSON.parse(argv[argv.indexOf("--agents") + 1]!) as Record<string, unknown>;
    // Written out rather than compared against the constant the code reads, so
    // adding a role is a change a reader of this test has to make on purpose.
    expect(Object.keys(offered).sort()).toEqual([
      "perbo-explorer",
      "perbo-implementer",
      "perbo-verifier",
    ]);
  });

  it("hands the executor the tool that starts one, under both names, and no role the tool to nest", () => {
    for (const tool of SUBAGENT_TOOL_NAMES) {
      // The allow-list beside the tool list: `--tools` offers the tool and the
      // enforced allow-list is what stops the agent's own permission layer
      // refusing it ahead of the guard. Without this entry delegation is off,
      // silently and fail-closed, and the guard never sees a call to judge.
      expect([...DEFAULT_AGENT_TOOLS], tool).toContain(tool);
      expect([...DEFAULT_COMMAND_ALLOW_LIST], tool).toContain(tool);
      expect([...DEFAULT_COMMAND_DENY_LIST], tool).not.toContain(tool);
      for (const [name, role] of Object.entries(PERBO_AGENT_ROLES)) {
        expect([...role.tools], `${name}/${tool}`).not.toContain(tool);
      }
    }
  });

  it("installs the guard's hook for the tool that starts one, under both names", () => {
    const settings = attemptSettings("/bin/true") as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    const matcher = settings.hooks.PreToolUse[0]!.matcher.split("|");
    for (const tool of SUBAGENT_TOOL_NAMES) expect(matcher, tool).toContain(tool);
  });
});

describe.each(SUBAGENT_TOOL_NAMES)("what the guard does with a %s call (D-106 criterion 1)", (tool) => {
  it("refuses a subagent the person defined in their own ~/.claude/agents", () => {
    const guard = guardFor();
    const personal = personalAgentName();
    const printed = runHook(guard.directory, subagentCall(tool, { subagent_type: personal, prompt: "go" }));
    const answer = JSON.parse(printed) as HookAnswer;
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(answer.hookSpecificOutput.permissionDecisionReason).toContain(personal);

    const [decision] = readPreToolDecisions(guard.decisionsPath);
    expect(decision?.tool).toBe(tool);
    expect(decision?.answer).toBe("deny");
    expect(decision?.decision).toBe("denied");
    expect(decision?.rule).toBe(ADMISSION_RULES.subagent_role);
    expect(decision?.target).toBe(personal);
    discardPreToolGuard(guard);
  });

  /**
   * The invariant, driven through the spellings, rather than a test per
   * spelling: the name is a member of a closed set or it is not, and every
   * near-miss of a real role is a different name. A guard that trimmed or
   * lowercased first would be admitting one spelling in place of another.
   *
   * A case per spelling, because each one spawns the hook and vitest's budget
   * is per case.
   */
  it.each([
    // Claude Code's own built-ins and a plugin's, both measured as offered.
    "general-purpose",
    "Explore",
    "agent-sdk-dev:agent-sdk-verifier-py",
    // Near-misses of a real role.
    "perbo-explorer ",
    " perbo-explorer",
    "Perbo-Explorer",
    "PERBO-EXPLORER",
    "perbo-explorer\n",
    "perbo-explorer/../perbo-explorer",
    "perbo_explorer",
    "perbo-explorers",
  ])("refuses %j, which is not exactly a name Perbo defines", (name) => {
    const guard = guardFor();
    const printed = runHook(guard.directory, subagentCall(tool, { subagent_type: name }));
    const answer = JSON.parse(printed) as HookAnswer;
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    // The rule that refused it, so a spelling refused by some other rule on the
    // way would show here rather than passing as this rule's work.
    expect(readPreToolDecisions(guard.decisionsPath).map((each) => each.rule)).toEqual([
      ADMISSION_RULES.subagent_role,
    ]);
    discardPreToolGuard(guard);
  });

  /**
   * The record names the tool rather than the value, because a record's target
   * is a string a person reads — and `CommandRecord.denial_target` takes no
   * empty one, so a blank `subagent_type` recorded as itself would fail the
   * seal rather than the call.
   */
  it.each([{}, { subagent_type: 7 }, { subagent_type: null }, { subagent_type: "" }])(
    "refuses a call whose input names no subagent: %j",
    (input) => {
      const guard = guardFor();
      const answer = JSON.parse(runHook(guard.directory, subagentCall(tool, input))) as HookAnswer;
      expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(readPreToolDecisions(guard.decisionsPath).map((each) => each.target)).toEqual([tool]);
      discardPreToolGuard(guard);
    },
  );

  /**
   * A guard whose state predates the roles cannot say a name is among them.
   *
   * The state file is the hook's whole knowledge of the attempt, and it is
   * written once when the round starts. One that carries no role list is not
   * an attempt that offered every role — it is one whose roles the guard
   * cannot read, and admitting on that is admitting the person's own agent
   * definitions.
   */
  it("refuses every role where the attempt's state declares none", () => {
    const guard = guardFor();
    const state = JSON.parse(readFileSync(guard.statePath, "utf8")) as Record<string, unknown>;
    delete state["agent_roles"];
    writeFileSync(guard.statePath, JSON.stringify(state), "utf8");
    for (const name of Object.keys(PERBO_AGENT_ROLES)) {
      const answer = JSON.parse(
        runHook(guard.directory, subagentCall(tool, { subagent_type: name })),
      ) as HookAnswer;
      expect(answer.hookSpecificOutput.permissionDecision, name).toBe("deny");
      // And the refusal says which it is, rather than listing an empty set.
      expect(answer.hookSpecificOutput.permissionDecisionReason).toContain(
        "this attempt declares none",
      );
    }
    discardPreToolGuard(guard);
  });

  /**
   * Nesting, refused rather than only unoffered (ADR-0038).
   *
   * No role carries `Agent` or `Task`, so the binary refuses this first — but
   * a role's `tools` list is a request the binary honours, and the same
   * reasoning that makes the role names worth checking at all makes this
   * worth a second holder: a nested generation is the one breach of the
   * closed set whose depth nothing bounds.
   */
  it("refuses a call a subagent made, whatever role it names", () => {
    const guard = guardFor();
    const child = { agent_id: "a1068d4ecef4890c3", agent_type: "perbo-implementer" };
    const roles = Object.keys(PERBO_AGENT_ROLES);
    for (const name of roles) {
      const printed = runHook(guard.directory, subagentCall(tool, { subagent_type: name }, child));
      const answer = JSON.parse(printed) as HookAnswer;
      expect(answer.hookSpecificOutput.permissionDecision, name).toBe("deny");
      // Refused for who asked, not for which name — each of these is a role
      // the same payload from the session would have been let through for.
      expect(answer.hookSpecificOutput.permissionDecisionReason, name).toContain(
        "a subagent starting a subagent",
      );
    }
    const decisions = readPreToolDecisions(guard.decisionsPath);
    expect(decisions.map((each) => each.rule)).toEqual(
      roles.map(() => ADMISSION_RULES.subagent_nesting),
    );
    // And the record names the child that asked, which is the half of
    // criterion 3 this branch of the guard carries.
    expect(decisions.map((each) => each.agent)).toEqual(roles.map(() => "perbo-implementer"));
    expect(decisions.map((each) => each.target)).toEqual(roles);
    discardPreToolGuard(guard);
  });

  /**
   * A subagent's payload carries `agent_id` and `agent_type` together
   * (ADR-0038, 2026-09-12). One carrying only the id is still not the
   * session's: the id is what says whose call it is, and the role is only the
   * name a person reads.
   */
  it("reads a payload carrying an agent id and no role as a subagent's", () => {
    const guard = guardFor();
    const printed = runHook(
      guard.directory,
      subagentCall(tool, { subagent_type: "perbo-explorer" }, { agent_id: "a1068d4ecef4890c3" }),
    );
    const answer = JSON.parse(printed) as HookAnswer;
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    const [decision] = readPreToolDecisions(guard.decisionsPath);
    expect(decision?.rule).toBe(ADMISSION_RULES.subagent_nesting);
    // Nothing to name it by, so the record names none rather than the session.
    expect(decision?.agent).toBe(null);
    discardPreToolGuard(guard);
  });

  it("lets a role Perbo defines through to the agent's own permission layer", () => {
    const guard = guardFor();
    for (const name of Object.keys(PERBO_AGENT_ROLES)) {
      expect(runHook(guard.directory, subagentCall(tool, { subagent_type: name })), name).toBe("");
    }
    const decisions = readPreToolDecisions(guard.decisionsPath);
    expect(decisions.map((each) => each.answer)).toEqual(
      Object.keys(PERBO_AGENT_ROLES).map(() => "defer"),
    );
    expect(decisions.map((each) => each.decision)).toEqual(
      Object.keys(PERBO_AGENT_ROLES).map(() => "allowed"),
    );
    discardPreToolGuard(guard);
  });
});

/**
 * The rule names this change adds, as the strings they are.
 *
 * Every other assertion compares a decision's `rule` against `ADMISSION_RULES`
 * itself, so all of them would stay green if a value were renamed — the
 * constant and the expectation move together. The value is not an internal
 * detail: it is written into `decisions.jsonl`, which `perbo inspect` prints
 * and a person reads, so renaming one silently changes a record's vocabulary.
 * These spell the strings out, which is what `write_outside_worktree` already
 * gets from being written as a literal in a dozen files.
 */
describe("the names these refusals go on the record under", () => {
  it("are the strings the record carries, not whatever the constant is set to", () => {
    expect(ADMISSION_RULES.subagent_role).toBe("subagent_role_undefined");
    expect(ADMISSION_RULES.subagent_nesting).toBe("subagent_nesting_refused");
    expect(ADMISSION_RULES.agent_directory_unknown).toBe("agent_directory_unknown");
  });
});
