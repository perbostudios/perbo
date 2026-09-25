import { describe, expect, it } from "vitest";
import { retainedOutput } from "./retained-output.js";

describe("the retained transcript", () => {
  it("keeps each turn the executor's own session spoke, and no row for a tool call, a subagent's words or the result", () => {
    const record = [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading the mailer first." },
            { type: "tool_use", name: "Read", input: { file_path: "src/mailer.ts" } },
            { type: "text", text: "Then its tests." },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } },
      { type: "assistant", parent_tool_use_id: "toolu_task", message: { content: [{ type: "text", text: "A child's summary." }] } },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "The retry is in." }] } },
      { method: "item/completed", item: { id: "c1", type: "commandExecution", command: "pnpm lint", aggregatedOutput: "ok" } },
      { method: "item/completed", item: { id: "m1", type: "agentMessage", text: "Codex says it is done." } },
      { type: "result", result: "The retry is in." },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const { entries, terminal } = retainedOutput(record);
    expect(entries).toEqual([
      { author: "Executor", label: "message", text: "Reading the mailer first.\nThen its tests." },
      { author: "Executor", label: "message", text: "The retry is in." },
      { author: "Executor", label: "message", text: "Codex says it is done." },
    ]);
    // A command the executor ran stays where commands are read: the terminal.
    expect(terminal).toBe("$ pnpm lint\nok");
  });

  it("keeps no Codex subagent's words, which its record line marks as the subagent's, and keeps its commands in the terminal", () => {
    const record = [
      { method: "item/completed", item: { id: "m1", type: "agentMessage", text: "Splitting the work." } },
      { method: "item/completed", item: { id: "m2", type: "agentMessage", text: "A child's summary." }, subagent: true },
      {
        method: "item/completed",
        item: { id: "c1", type: "commandExecution", command: "pnpm test", aggregatedOutput: "ok" },
        subagent: true,
      },
      { method: "item/completed", item: { id: "m3", type: "agentMessage", text: "Both halves are in." } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const { entries, terminal } = retainedOutput(record);
    expect(entries.map((entry) => entry.text)).toEqual(["Splitting the work.", "Both halves are in."]);
    expect(terminal).toBe("$ pnpm test\nok");
  });
});
