import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { codexNotificationHandler, type CodexItem } from "../src/adapter-codex.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { EgressLog } from "../src/egress.js";

/**
 * The Codex transport's half of the stall detector (SCP-323, D-096), driven
 * at the handler the app-server session calls, because the session itself
 * needs a Codex binary to speak to.
 */

const table = (limits: Record<string, number> = {}) =>
  LimitsTableSchema.parse({ organisation: "test", limits });

function attempt(limits: Record<string, number> = {}) {
  let now = 0;
  const ceilings = new AttemptCeilings(table(limits), () => now);
  const recorded: CodexItem[] = [];
  const stops: { reason: string; detail: string }[] = [];
  const lines: string[] = [];
  const transcript: string[] = [];
  const rebriefs: (string | null)[] = [];
  const subagentsStarted: { parent: string | null; child: string }[] = [];
  const handle = codexNotificationHandler({
    ceilings,
    items: new Map(),
    transcript,
    redact: (text) => text,
    record: (item) => recorded.push(item),
    egress: new EgressLog([]),
    stop: (reason, detail) => stops.push({ reason, detail }),
    progress: (line) => lines.push(line),
    rebrief: (threadId) => rebriefs.push(threadId),
    onSubagentStarted: (parent, child) => subagentsStarted.push({ parent, child }),
  });
  return {
    ceilings,
    handle,
    recorded,
    stops,
    lines,
    transcript,
    rebriefs,
    subagentsStarted,
    at: (value: number) => (now = value),
  };
}

const command = (id: string, text: string): CodexItem => ({ id, type: "commandExecution", command: text });
const edit = (id: string, path: string): CodexItem => ({
  id,
  type: "fileChange",
  changes: [{ path, kind: { type: "update" } }],
});

describe("what a Codex notification does to the stall window", () => {
  it("restarts it when a command starts and again when a file change completes", () => {
    const { handle, ceilings, at } = attempt({ attempt_stall_ms: 1_000 });
    at(900);
    handle("item/started", { item: command("c1", "git status") });
    at(1_800);
    expect(ceilings.tick()).toBeNull();
    handle("item/completed", { item: edit("f1", "src/a.ts") });
    at(2_700);
    expect(ceilings.tick()).toBeNull();
    at(2_801);
    expect(ceilings.tick()?.reason).toBe("stalled");
  });

  it("leaves it alone for a message, which is the executor talking rather than working", () => {
    const { handle, ceilings, at } = attempt({ attempt_stall_ms: 1_000 });
    at(900);
    handle("item/completed", { item: { id: "m1", type: "agentMessage", text: "thinking" } });
    at(1_001);
    expect(ceilings.tick()?.reason).toBe("stalled");
  });
});

describe("what else the handler does with a tool item", () => {
  it("records it, announces its start, and keeps the completed transcript line", () => {
    const { handle, recorded, lines, transcript } = attempt();
    handle("item/started", { item: command("c1", "pnpm test") });
    handle("item/completed", { item: command("c1", "pnpm test") });
    expect(recorded.map((item) => item.id)).toEqual(["c1", "c1"]);
    expect(lines).toEqual(["Codex pnpm test"]);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toContain('"method":"item/completed"');
  });

  it("stops the attempt at a command naming a host outside the allow-list", () => {
    const { handle, stops } = attempt();
    handle("item/started", { item: command("c1", "curl https://example.com/setup.sh") });
    expect(stops.map((stop) => stop.reason)).toEqual(["unlisted_egress_host"]);
  });

  it("stops the attempt at a capability the isolated session should not have", () => {
    const { handle, stops } = attempt();
    handle("item/started", { item: { id: "t1", type: "mcpToolCall" } });
    expect(stops.map((stop) => stop.reason)).toEqual(["agent_error"]);
    expect(stops[0]?.detail).toContain("mcpToolCall");
  });

  it("does not stop the attempt at a collabAgentToolCall, which is the parent's own wait (D-106)", () => {
    const { handle, stops } = attempt();
    handle("item/started", {
      item: { id: "w1", type: "collabAgentToolCall", tool: "wait", senderThreadId: "root" },
    });
    expect(stops).toEqual([]);
  });

  it("stops the attempt when the model is rerouted, and ignores what is not an event", () => {
    const { handle, stops, recorded } = attempt();
    handle("item/started", "not an event");
    handle("model/rerouted", {});
    expect(recorded).toEqual([]);
    expect(stops.map((stop) => stop.reason)).toEqual(["agent_error"]);
  });
});

describe("what the handler does with a subagent's own activity (D-106)", () => {
  it("re-briefs the thread a contextCompaction completed on, root or child alike (AC4)", () => {
    const { handle, rebriefs } = attempt();
    handle("item/completed", { threadId: "root", item: { id: "k1", type: "contextCompaction" } });
    handle("item/completed", { threadId: "child-1", item: { id: "k2", type: "contextCompaction" } });
    expect(rebriefs).toEqual(["root", "child-1"]);
  });

  it("reports a started subagent by the thread that spawned it and the thread it names", () => {
    const { handle, subagentsStarted } = attempt();
    handle("item/started", {
      threadId: "root",
      item: { id: "sa1", type: "subAgentActivity", kind: "started", agentPath: "/root/write_a", agentThreadId: "child-1" },
    });
    expect(subagentsStarted).toEqual([{ parent: "root", child: "child-1" }]);
  });

  it("ignores a subAgentActivity of any other kind", () => {
    const { handle, subagentsStarted } = attempt();
    handle("item/started", {
      threadId: "root",
      item: { id: "sa2", type: "subAgentActivity", kind: "interacted", agentThreadId: "child-1" },
    });
    expect(subagentsStarted).toEqual([]);
  });
});
