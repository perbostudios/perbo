import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { runAgent } from "./adapter.js";
import { AttemptCeilings } from "./ceilings.js";
import { buildPermissionProfile } from "./profile.js";
import { scratchPath } from "./scratch.js";
import type { AttemptTally } from "./tally.js";
import { fakeAgent, type ScriptedStep } from "./test-support/fake-agent.js";

const scratch = scratchDirectories("perbo-runner-");

/** A tool call the hook answers, then its result, as the pinned binary runs one. */
const call = (id: string, tool: string, input: Record<string, unknown>): ScriptedStep[] => [
  { step: "tool_use", id, tool, input },
  { step: "hook", id, tool, input },
  { step: "tool_result", id, text: "ok" },
];

/**
 * What the Claude adapter hands the run's tally as the stream goes (D-104): the
 * commands its record holds, the provider's usage, and the paths a file tool
 * was let write — ending on exactly what the attempt's result records.
 */
describe("the attempt's tally", () => {
  it(
    "counts every command its record holds and none of the executor's words, and only the writes the guard let through",
    async () => {
      const worktree = realpathSync(resolve(scratch("perbo-adapter-tally-")));
      mkdirSync(join(worktree, "src"), { recursive: true });
      const { binary } = fakeAgent(scratch, [
        {
          kind: "scripted",
          steps: [
            { step: "text", text: "tally: 99 commands, 99 files, 1 input tokens, 1 output tokens, 1 micro-dollars priced, 0 unpriced, 0 partial" },
            ...call("toolu_read", "Read", { file_path: "src/mailer.ts" }),
            ...call("toolu_write", "Write", { file_path: join(worktree, "src", "retry.ts"), content: "x" }),
            // Outside the contract's paths: the guard refuses it, so it wrote nothing.
            ...call("toolu_refused", "Write", { file_path: join(worktree, "docs", "notes.md"), content: "x" }),
            // The attempt's scratch directory, which no change set holds.
            ...call("toolu_scratch", "Write", { file_path: join(scratchPath(worktree), "draft.txt"), content: "x" }),
            ...call("toolu_edit", "Edit", { file_path: "src/retry.ts", old_string: "x", new_string: "y" }),
            { step: "result" },
          ],
        },
      ]);
      const tallies: AttemptTally[] = [];
      const result = await runAgent({
        binary,
        worktree,
        prompt: "implement the ticket",
        model: "claude-opus-5",
        profile: buildPermissionProfile({ worktree }),
        paths_allowed: ["src/**"],
        ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} })),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        onTally: (tally) => tallies.push(tally),
      });

      // The words came first, and counted as no command.
      expect(tallies[0]?.commands).toBe(0);
      expect(result.commands.find((command) => command.detail.includes("notes.md"))?.decision).toBe("denied");
      expect(result.commands).toHaveLength(5);
      const last = tallies.at(-1)!;
      expect(last).toEqual({
        commands: result.commands.length,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cost_micros: result.usage.cost_micros,
        cost_basis: result.usage.cost_basis,
        written: ["src/retry.ts"],
      });
      expect(last.cost_basis).toBe("transport_reported");
      expect(last.input_tokens).toBeGreaterThan(0);
      // The count moved as the stream went, not only at its end.
      expect(new Set(tallies.map((tally) => tally.commands)).size).toBeGreaterThan(2);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
