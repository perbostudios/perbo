import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, type CommandRecord } from "@perbo/contracts";
import { runAgent, type AgentResult } from "../src/adapter.js";
import { SUBAGENT_TOOL_NAMES } from "../src/agents.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { EXECUTOR_ACCOUNT_HEADING, executorAccount } from "../src/account.js";
import { buildPermissionProfile } from "../src/profile.js";
import { fakeAgent, scratch, SPAWN_TEST_TIMEOUT_MS, type ScriptedStep } from "./support.js";

/**
 * D-106 criterion 3: every command a subagent runs is recorded against it, and
 * the executor's account is the top-level session's last word alone.
 *
 * The stream is driven step by step through a real binary that runs the
 * runner's hook where the pinned one runs it, so the `parent_tool_use_id` a
 * child's events carry and the `agent_id`/`agent_type` its hook payload
 * carries (ADR-0038) both reach the adapter the way they do in an attempt.
 */

const IMPLEMENTER = { parent: "toolu_task_a", id: "a1068d4ecef4890c3", type: "perbo-implementer" };
const EXPLORER = { parent: "toolu_task_b", id: "b2f7c04d1e9a35b86", type: "perbo-explorer" };

const ACCOUNT = `${EXECUTOR_ACCOUNT_HEADING}\n\nI wrote src/a.ts and ran the tests.`;
const CHILD_ACCOUNT = `${EXECUTOR_ACCOUNT_HEADING}\n\nDONE-A: I wrote src/a.ts.`;

async function run(steps: readonly ScriptedStep[]): Promise<AgentResult> {
  const worktree = realpathSync(resolve(scratch("perbo-subagent-records-")));
  for (const each of ["src", "docs"]) mkdirSync(join(worktree, each), { recursive: true });
  const profile = buildPermissionProfile({ worktree });
  const { binary } = fakeAgent([{ kind: "scripted", steps }]);
  return runAgent({
    binary,
    worktree,
    prompt: "implement the ticket",
    model: "claude-opus-5",
    profile,
    paths_allowed: ["src/**"],
    ceilings: new AttemptCeilings(
      LimitsTableSchema.parse({ organisation: "test", limits: {} }),
    ),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
}

/**
 * One subagent writing one file, hook and result included, under its parent's
 * subagent-starting call. `tool` defaults to `Agent`, the name the pinned
 * binary sends; a caller proving the former name still works passes `Task`.
 */
const delegation = (
  agent: { parent: string; id: string; type: string },
  file: string,
  callId: string,
  tool: string = "Agent",
): ScriptedStep[] => [
  {
    step: "tool_use",
    id: agent.parent,
    tool,
    input: { subagent_type: agent.type, prompt: `write ${file}` },
  },
  { step: "hook", id: agent.parent, tool, input: { subagent_type: agent.type } },
  {
    step: "tool_use",
    id: callId,
    tool: "Write",
    input: { file_path: file, content: "export const a = 1;\n" },
    agent,
  },
  { step: "hook", id: callId, tool: "Write", input: { file_path: file }, agent },
  { step: "tool_result", id: callId, text: "written", agent },
  { step: "tool_result", id: agent.parent, text: "DONE" },
];

const forTool = (result: AgentResult, tool: string): CommandRecord[] =>
  result.commands.filter((command) => command.tool === tool);

describe("which agent a command record names (D-106 criterion 3)", () => {
  it.each(SUBAGENT_TOOL_NAMES)(
    "names the role on a subagent's %s call and nothing on the session's own",
    async (tool) => {
      const result = await run([
        ...delegation(IMPLEMENTER, "src/a.ts", "toolu_write_a", tool),
        ...delegation(EXPLORER, "src/b.ts", "toolu_write_b", tool),
        { step: "tool_use", id: "toolu_status", tool: "Bash", input: { command: "git status" } },
        { step: "hook", id: "toolu_status", tool: "Bash", input: { command: "git status" } },
        { step: "tool_result", id: "toolu_status", text: "" },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);

      // The two writes, each against the role that made it. Written out rather
      // than read off the roles the test passed in, so a record that named the
      // wrong child shows as the wrong name and not as a matching mistake.
      expect(forTool(result, "Write").map((command) => command.agent)).toEqual([
        "perbo-implementer",
        "perbo-explorer",
      ]);
      // The subagent-starting calls and the `git status` are the executor's
      // own: the events that carry them have no parent.
      expect(forTool(result, tool).map((command) => command.agent)).toEqual([null, null]);
      expect(forTool(result, "Bash").map((command) => command.agent)).toEqual([null]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "names a subagent's call by the call that started it where no subagent-starting block arrived",
    async () => {
      // The stream the stop cut short, or a torn line: the child's events
      // carry a parent the runner never read a subagent-starting block for, so
      // there is no role to name it by. It is still not the executor's own
      // call, and recording it as the session's would put a subagent's write
      // on the executor's name.
      const result = await run([
        {
          step: "tool_use",
          id: "toolu_write_orphan",
          tool: "Write",
          input: { file_path: "src/a.ts", content: "export const a = 1;\n" },
          agent: IMPLEMENTER,
        },
        { step: "tool_result", id: "toolu_write_orphan", text: "written", agent: IMPLEMENTER },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      expect(forTool(result, "Write").map((command) => command.agent)).toEqual(["toolu_task_a"]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "records no agent where an event carries an empty parent",
    async () => {
      // An absent parent and a blank one both mean the top-level session, and
      // `CommandRecord.agent` takes no empty string: recorded as itself it
      // would fail the seal rather than the call.
      const blank = { parent: "", id: "a1068d4ecef4890c3", type: "perbo-implementer" };
      const result = await run([
        {
          step: "tool_use",
          id: "toolu_blank",
          tool: "Bash",
          input: { command: "git status" },
          agent: blank,
        },
        { step: "tool_result", id: "toolu_blank", text: "", agent: blank },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      expect(forTool(result, "Bash").map((command) => command.agent)).toEqual([null]);
      // And the words on an event with a blank parent are the executor's own.
      expect(result.final_message).toBe(ACCOUNT);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "names a subagent's call the hook answered and the stream never carried",
    async () => {
      // The hook runs and the `tool_use` block never reaches the runner: a
      // stream a stop cut short, or a torn line. The hook is handed the role
      // directly, so the record it stands in for is still named.
      const result = await run([
        {
          step: "hook",
          id: "toolu_unseen",
          tool: "Write",
          input: { file_path: "/etc/passwd" },
          agent: IMPLEMENTER,
        },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      const unseen = result.commands.find(
        (command) => command.second_reading === "the runner never read this call's tool_use block",
      );
      expect(unseen?.decision).toBe("denied");
      expect(unseen?.agent).toBe("perbo-implementer");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "judges each agent's relative write from that agent's own directory",
    async () => {
      // The executor moves into `docs`, which the contract does not admit; the
      // subagent never moved, so its relative `src/a.ts` is inside. One shared
      // directory would resolve the child's path under `docs` and end the
      // attempt for a write that never left the contract's globs.
      const child = { ...IMPLEMENTER, parent: "toolu_task_c" };
      const result = await run([
        { step: "tool_use", id: "toolu_cd", tool: "Bash", input: { command: "cd docs" } },
        { step: "hook", id: "toolu_cd", tool: "Bash", input: { command: "cd docs" } },
        { step: "tool_result", id: "toolu_cd", text: "" },
        {
          step: "tool_use",
          id: child.parent,
          tool: "Agent",
          input: { subagent_type: child.type, prompt: "write a" },
        },
        { step: "hook", id: child.parent, tool: "Agent", input: { subagent_type: child.type } },
        {
          step: "tool_use",
          id: "toolu_child_write",
          tool: "Bash",
          input: { command: "echo x > src/a.ts" },
          agent: child,
        },
        { step: "tool_result", id: "toolu_child_write", text: "", agent: child },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);

      // No hook answers the child's write, so what judged it is the transcript
      // reading, from the directory it holds for that child.
      const write = forTool(result, "Bash").find((command) => command.detail.includes("src/a.ts"));
      expect(write?.agent).toBe("perbo-implementer");
      expect(write?.cwd).toBe(".");
      expect(write?.decision).toBe("allowed");
      expect(write?.decided_by).toBe("transcript_reading");
      // And the attempt ran to the end: a write inside the contract must not
      // be read as an escape because another agent had moved.
      expect(result.termination.reason).toBe("completed");
      expect(result.prohibited).toEqual([]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe.each(SUBAGENT_TOOL_NAMES)("a subagent the hook never judged, from a %s call (D-106 criterion 1)", (tool) => {
  it(
    "ends the attempt where a call outside the roles was not refused before it ran",
    async () => {
      // The hook is the enforcement, and this is the reading behind it: a
      // call the hook never answered started a subagent from a definition
      // the approved plan never saw, which is the executor widening its own
      // permissions.
      const result = await run([
        {
          step: "tool_use",
          id: "toolu_task_outside",
          tool,
          input: { subagent_type: "general-purpose", prompt: "go" },
        },
        { step: "tool_result", id: "toolu_task_outside", text: "done" },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      expect(result.termination.reason).toBe("prohibited_action");
      expect(result.prohibited.map((hit) => hit.action)).toEqual(["enable_own_tooling"]);
      expect(result.prohibited[0]?.detail).toContain("general-purpose");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends nothing where the hook refused the same call before it ran",
    async () => {
      const result = await run([
        {
          step: "tool_use",
          id: "toolu_task_refused",
          tool,
          input: { subagent_type: "general-purpose", prompt: "go" },
        },
        {
          step: "hook",
          id: "toolu_task_refused",
          tool,
          input: { subagent_type: "general-purpose" },
        },
        { step: "tool_result", id: "toolu_task_refused", text: "refused", is_error: true },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      // The subagent never started, so there is nothing to end the attempt
      // for; the refusal is on the record instead.
      expect(result.termination.reason).toBe("completed");
      expect(result.prohibited).toEqual([]);
      const task = forTool(result, tool)[0];
      expect(task?.decision).toBe("denied");
      expect(task?.decided_by).toBe("pre_execution_hook");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The same backstop for the other half of criterion 1 (ADR-0038): the hook
   * refuses a call a subagent made, and this is what notices one it never
   * answered. A nested subagent that ran is a generation below the set a
   * person approved, and it is the executor widening its own permissions in
   * the one direction nothing bounds.
   */
  it(
    "ends the attempt where a subagent started a subagent and nothing refused it",
    async () => {
      const result = await run([
        {
          step: "tool_use",
          id: IMPLEMENTER.parent,
          tool,
          input: { subagent_type: IMPLEMENTER.type, prompt: "write a" },
        },
        { step: "hook", id: IMPLEMENTER.parent, tool, input: { subagent_type: IMPLEMENTER.type } },
        {
          step: "tool_use",
          id: "toolu_nested",
          tool,
          input: { subagent_type: "perbo-explorer", prompt: "look" },
          agent: IMPLEMENTER,
        },
        { step: "tool_result", id: "toolu_nested", text: "done", agent: IMPLEMENTER },
        { step: "tool_result", id: IMPLEMENTER.parent, text: "DONE" },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      expect(result.termination.reason).toBe("prohibited_action");
      expect(result.prohibited.map((hit) => hit.action)).toEqual(["enable_own_tooling"]);
      // The role the parent's own call named is a role Perbo defines, so a
      // hit that read only the name would have found nothing here.
      expect(result.prohibited[0]?.detail).toContain(
        "perbo-implementer started perbo-explorer",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * A subagent-starting block off the stream with no input at all — a torn
   * line, or one a stop cut mid-write. Every reader of `block.input` is
   * handed it, and the one that reads the role is the first. A reader that
   * assumed an object throws out of the stream's own data handler, where
   * nothing catches it: the event is dropped, the run reports `completed`,
   * and a call the runner could not name leaves no trace at all. Silence, not
   * a crash, which is why the case is worth driving rather than reasoning
   * about.
   */
  it(
    "refuses a subagent-starting block that carries no input rather than throwing on it",
    async () => {
      const result = await run([
        { step: "tool_use", id: "toolu_task_bare", tool, input: null },
        { step: "tool_result", id: "toolu_task_bare", text: "done" },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      expect(result.termination.reason).toBe("prohibited_action");
      expect(result.prohibited.map((hit) => hit.action)).toEqual(["enable_own_tooling"]);
      expect(result.prohibited[0]?.detail).toContain("the executor started a subagent");
      // And the call is still on the record, which a thrown attempt would have
      // lost along with everything after it.
      expect(forTool(result, tool)).toHaveLength(1);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends nothing for a role Perbo defines, hook or no hook",
    async () => {
      const result = await run([
        {
          step: "tool_use",
          id: "toolu_task_ok",
          tool,
          input: { subagent_type: "perbo-explorer", prompt: "go" },
        },
        { step: "tool_result", id: "toolu_task_ok", text: "done" },
        { step: "text", text: ACCOUNT },
        { step: "result" },
      ]);
      expect(result.termination.reason).toBe("completed");
      expect(result.prohibited).toEqual([]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("whose last word becomes the executor's account (D-106 criterion 3, D-092)", () => {
  it(
    "takes no account at all where only a subagent spoke",
    async () => {
      // The executor ends on a tool call rather than on words, which is
      // ordinary: the last text on the stream is then the child's summary.
      const result = await run([
        ...delegation(IMPLEMENTER, "src/a.ts", "toolu_write_a"),
        { step: "text", text: CHILD_ACCOUNT, agent: IMPLEMENTER },
        { step: "tool_use", id: "toolu_status", tool: "Bash", input: { command: "git status" } },
        { step: "hook", id: "toolu_status", tool: "Bash", input: { command: "git status" } },
        { step: "tool_result", id: "toolu_status", text: "" },
        { step: "result" },
      ]);

      expect(result.final_message).toBe(null);
      expect(executorAccount(result.final_message)).toBe(null);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "takes the executor's own last word, past a subagent that spoke after it",
    async () => {
      const result = await run([
        ...delegation(IMPLEMENTER, "src/a.ts", "toolu_write_a"),
        { step: "text", text: ACCOUNT },
        { step: "text", text: CHILD_ACCOUNT, agent: IMPLEMENTER },
        { step: "result" },
      ]);

      expect(result.final_message).toBe(ACCOUNT);
      expect(executorAccount(result.final_message)).toBe(
        "I wrote src/a.ts and ran the tests.",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
