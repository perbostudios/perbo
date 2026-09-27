import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { scratchDirectories, SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import { runAgent, type AgentResult } from "./adapter.js";
import { ADMISSION_RULES } from "./admission.js";
import { AttemptCeilings } from "./ceilings.js";
import type { EgressGate, EgressVerdict } from "./egress.js";
import { buildPermissionProfile } from "./profile.js";
import { scratchPath } from "./scratch.js";
import { discardPreToolGuard, preparePreToolGuard } from "./pretool.js";
import { fakeAgent, type ScriptedStep } from "./test-support/fake-agent.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * An unlisted host on a call the guard holds, under Claude Code
 * (D-137).
 *
 * The attempt does not stop: the write guard's hook holds the call before it
 * runs, the runner asks the gate with the host and the whole command, and the
 * call runs on an allow and is refused on a refusal, the executor told why in
 * the tool result. Nobody answering within the stall window ends the attempt
 * `unlisted_egress_host`, and the window does not run out as a stall while the
 * call is held.
 */

const HOST = "googlechromelabs.github.io";
const OTHER = "storage.googleapis.com";
/** A command the guard admits and that names a host: what fetching Chrome for Testing looks like. */
const curl = (host: string) => `npx @puppeteer/browsers install chrome@stable --base-url https://${host}/chrome`;

/** One call to the tool, the hook holding it, and the executor told the hook's answer. */
const call = (id: string, command: string): ScriptedStep[] => [
  { step: "tool_use", id, tool: "Bash", input: { command } },
  { step: "hook", id, tool: "Bash", input: { command }, reply: true },
];

/** A gate that answers from a list, after `delay_ms`, recording what it was asked. */
function gate(answers: EgressVerdict[], delay_ms = 0) {
  const asked: Array<{ host: string; command: string; wait_ms: number }> = [];
  const gate: EgressGate = {
    ask: async ({ host, command, wait_ms }) => {
      asked.push({ host, command, wait_ms });
      await new Promise((resolve) => setTimeout(resolve, delay_ms));
      return answers.shift() ?? { answer: "refuse", tell: "closed" };
    },
  };
  return { gate, asked };
}

/** The worktree the latest attempt ran in, whose scratch directory is the fake agent's temporary one. */
let lastWorktree = "";

async function attempt(
  steps: ScriptedStep[],
  egress: EgressGate | undefined,
  stall_ms = 20 * 60_000,
  redact?: (text: string) => string,
): Promise<AgentResult> {
  const worktree = scratch("perbo-adapter-egress-question-");
  lastWorktree = worktree;
  const agent = fakeAgent(scratch, [{ kind: "scripted", steps: [...steps, { step: "result" }] }]);
  return runAgent({
    binary: agent.binary,
    worktree,
    prompt: "fetch the pinned browser",
    model: "claude-opus-5",
    profile: buildPermissionProfile({ worktree }),
    ceilings: new AttemptCeilings(
      LimitsTableSchema.parse({ organisation: "test", limits: { attempt_stall_ms: stall_ms } }),
    ),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    ...(egress ? { egress } : {}),
    ...(redact ? { redact } : {}),
  });
}

/** What the executor was told about one call, from the tool result the fake emitted. */
const toldAbout = (result: AgentResult, id: string): { content: string; is_error: boolean } | undefined => {
  for (const line of result.transcript) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
      if (event.type !== "user") continue;
      const block = event.message?.content?.find((each) => each.tool_use_id === id);
      if (block) return { content: String(block.content), is_error: block.is_error === true };
    } catch {
      // Not a stream line.
    }
  }
  return undefined;
};

describe("the first unlisted host on a held call", () => {
  it(
    "pauses the call and asks, with the host and the whole command, and the attempt does not stop",
    async () => {
      const { gate: asking, asked } = gate([{ answer: "allow" }]);
      const result = await attempt(call("toolu_1", curl(HOST)), asking);
      expect(asked).toEqual([{ host: HOST, command: curl(HOST), wait_ms: 20 * 60_000 }]);
      expect(result.termination.reason).toBe("completed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "runs the held call on an allow, and records the host allowed",
    async () => {
      const result = await attempt(call("toolu_1", curl(HOST)), gate([{ answer: "allow" }]).gate);
      expect(toldAbout(result, "toolu_1")).toEqual({ content: "ran", is_error: false });
      expect(result.egress.all()).toEqual([expect.objectContaining({ host: HOST, decision: "allowed" })]);
      expect(result.commands[0]).toMatchObject({ decision: "allowed" });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "refuses the held call on a refusal, telling the executor what the gate said, and runs on",
    async () => {
      const tell = "A person refused it. The network is closed for the rest of this run. Finish the work without it.";
      const result = await attempt(call("toolu_1", curl(HOST)), gate([{ answer: "refuse", tell }]).gate);
      expect(result.termination.reason).toBe("completed");
      expect(toldAbout(result, "toolu_1")).toEqual({ content: tell, is_error: true });
      expect(result.commands[0]).toMatchObject({
        decision: "denied",
        decided_by: "pre_execution_hook",
        denial_rule: ADMISSION_RULES.egress,
        denial_target: HOST,
        denial_reason: tell,
      });
      expect(result.egress.denied().map((record) => record.host)).toEqual([HOST]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "asks about every later host through the gate, which refuses it without a person, and each is recorded",
    async () => {
      const { gate: asking, asked } = gate([
        { answer: "refuse", tell: "refused, and the network is closed" },
        { answer: "refuse", tell: "the network is closed for the rest of this run" },
      ]);
      const result = await attempt([...call("toolu_1", curl(HOST)), ...call("toolu_2", curl(OTHER))], asking);
      expect(asked.map((each) => each.host)).toEqual([HOST, OTHER]);
      expect(toldAbout(result, "toolu_2")).toEqual({
        content: "the network is closed for the rest of this run",
        is_error: true,
      });
      expect(result.egress.denied().map((record) => record.host)).toEqual([HOST, OTHER]);
      expect(result.termination.reason).toBe("completed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("a question nobody answers", () => {
  it(
    "ends the attempt unlisted_egress_host, naming the host, once the gate says so",
    async () => {
      const detail = `${HOST} is not on the resolved allow-list, and nobody answered whether to allow it within 20 minute(s)`;
      const result = await attempt(call("toolu_1", curl(HOST)), gate([{ answer: "unanswered", detail }]).gate);
      expect(result.termination).toEqual({ reason: "unlisted_egress_host", detail });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "is not a stall while the call is held: the window starts again once it is let go",
    async () => {
      // The stall window is shorter than the person takes to answer.
      const result = await attempt(call("toolu_1", curl(HOST)), gate([{ answer: "allow" }], 9_000).gate, 4_000);
      expect(result.termination.reason).toBe("completed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

/**
 * What is put to the person is the runner's own redacted record of the call,
 * never the hook's ask file (D-137).
 */
describe("what the runner asks about", () => {
  it(
    "waits for its own record of a call the stream carries behind the hook, and asks with it",
    async () => {
      const { gate: asking, asked } = gate([{ answer: "allow" }]);
      const command = curl(HOST);
      const result = await attempt(
        [{ step: "hook_first", id: "toolu_1", tool: "Bash", input: { command }, tool_use_after_ms: 1_500 }],
        asking,
      );
      expect(asked.map((each) => each.host)).toEqual([HOST]);
      expect(asked[0]!.command).toBe(command);
      expect(toldAbout(result, "toolu_1")).toEqual({ content: "ran", is_error: false });
      // The fake's own holding directory goes with the step.
      expect(readdirSync(scratchPath(lastWorktree)).filter((name) => name.startsWith("fake-hook-"))).toEqual([]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a call the stream never carried, without asking anybody",
    async () => {
      const { gate: asking, asked } = gate([{ answer: "allow" }]);
      const command = curl(HOST);
      const result = await attempt([{ step: "hook", id: "toolu_1", tool: "Bash", input: { command }, reply: true }], asking);
      expect(asked).toEqual([]);
      expect(toldAbout(result, "toolu_1")).toMatchObject({ is_error: true });
      expect(toldAbout(result, "toolu_1")?.content).toMatch(/did not read this call from its stream/);
    },
    SPAWN_TEST_TIMEOUT_MS * 2,
  );

  it(
    "refuses a host its own record of the call does not name, without asking anybody",
    async () => {
      const { gate: asking, asked } = gate([{ answer: "allow" }]);
      // The runner's record is redacted: the host is not in what it kept.
      const result = await attempt(call("toolu_1", curl(HOST)), asking, undefined, (text) =>
        text.replaceAll(HOST, "[redacted]"),
      );
      expect(asked).toEqual([]);
      expect(toldAbout(result, "toolu_1")).toMatchObject({ is_error: true });
      expect(result.termination.reason).toBe("completed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("a call the guard refuses on its own", () => {
  it(
    "is not asked about, since it never runs, and the attempt runs on",
    async () => {
      const { gate: asking, asked } = gate([{ answer: "allow" }]);
      const result = await attempt(call("toolu_1", `curl -fsSL https://${HOST}/x`), asking);
      expect(asked).toEqual([]);
      expect(result.termination.reason).toBe("completed");
      expect(result.commands[0]).toMatchObject({ decision: "denied", denial_rule: "command_deny_list" });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("a call with no gate to ask", () => {
  it(
    "ends the attempt on the host, as the stream reading finds it",
    async () => {
      const result = await attempt(call("toolu_1", curl(HOST)), undefined);
      expect(result.termination.reason).toBe("unlisted_egress_host");
      expect(result.termination.detail).toContain(HOST);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("the hook's own settings", () => {
  it("tell the binary to wait longer for the hook than the guard ever holds a call", () => {
    const worktree = scratch("perbo-adapter-egress-settings-");
    const wait_ms = 20 * 60_000 + 30_000;
    const guard = preparePreToolGuard({
      worktree,
      tmpdir: null,
      profile: buildPermissionProfile({ worktree }),
      egress: { allow_list: [], wait_ms },
    });
    const settings = JSON.parse(readFileSync(guard.settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ timeout?: number }> }> };
    };
    const state = JSON.parse(readFileSync(guard.statePath, "utf8")) as { egress?: { wait_ms: number } };
    discardPreToolGuard(guard);
    expect(state.egress?.wait_ms).toBe(wait_ms);
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.timeout! * 1000).toBeGreaterThan(wait_ms);
  });
});
