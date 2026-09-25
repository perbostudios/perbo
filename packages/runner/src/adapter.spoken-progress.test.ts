import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, readSpoken } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { runAgent } from "./adapter.js";
import { AttemptCeilings } from "./ceilings.js";
import { buildPermissionProfile } from "./profile.js";
import { fakeAgent, type ScriptedStep } from "./test-support/fake-agent.js";

const scratch = scratchDirectories("perbo-runner-");

/** Every progress line the adapter said while the scripted stream ran, in order. */
async function said(steps: readonly ScriptedStep[]): Promise<string[]> {
  const worktree = realpathSync(resolve(scratch("perbo-spoken-progress-")));
  mkdirSync(join(worktree, "src"), { recursive: true });
  const { binary } = fakeAgent(scratch, [{ kind: "scripted", steps }]);
  const lines: string[] = [];
  await runAgent({
    binary,
    worktree,
    prompt: "implement the ticket",
    model: "claude-opus-5",
    profile: buildPermissionProfile({ worktree }),
    paths_allowed: ["src/**"],
    ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} })),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    onProgress: (line) => lines.push(line),
    redact: (text) => text.replaceAll("sk-live-SECRET", "[redacted]"),
  });
  return lines;
}

const CHILD = { parent: "toolu_task_a", id: "a1068d4ecef4890c3", type: "perbo-implementer" };

describe("the executor's words as the run prints them", () => {
  it(
    "says each of the executor's own turns whole as it arrives, redacted and on one physical line, and none of its tool calls or a subagent's words",
    async () => {
      const lines = await said([
        { step: "text", text: "Reading the mailer first." },
        { step: "tool_use", id: "toolu_read", tool: "Read", input: { file_path: "src/mailer.ts" } },
        { step: "hook", id: "toolu_read", tool: "Read", input: { file_path: "src/mailer.ts" } },
        { step: "tool_result", id: "toolu_read", text: "export const send = () => {};" },
        { step: "text", text: "A subagent's own summary.", agent: CHILD },
        { step: "text", text: "The key sk-live-SECRET is not needed.\nAdding the retry now." },
        { step: "result" },
      ]);
      const words = lines.map(readSpoken).filter((line) => line !== null);
      expect(words).toEqual([
        { speaker: "executor", words: "Reading the mailer first." },
        { speaker: "executor", words: "The key [redacted] is not needed.\nAdding the retry now." },
      ]);
      // Said in the order the stream carried them, among the runner's own lines.
      const first = lines.findIndex((line) => line.startsWith("executor says: Reading"));
      const second = lines.findIndex((line) => line.startsWith("executor says: The key"));
      expect(first).toBeGreaterThan(lines.findIndex((line) => line.startsWith("agent ready:")));
      expect(second).toBeGreaterThan(first);
      expect(lines.join("\n")).not.toContain("sk-live-SECRET");
      expect(lines.filter((line) => /[\n\r]/.test(line))).toEqual([]);
      expect(lines.some((line) => /\bRead\b|src\/mailer\.ts/.test(line))).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
