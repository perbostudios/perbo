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
            // A write the tool itself failed: its result is an error, and nothing was written.
            { step: "tool_use", id: "toolu_failed", tool: "Write", input: { file_path: join(worktree, "src", "failed.ts"), content: "x" } },
            { step: "hook", id: "toolu_failed", tool: "Write", input: { file_path: join(worktree, "src", "failed.ts"), content: "x" } },
            { step: "tool_result", id: "toolu_failed", text: "could not write", is_error: true },
            // The hook refused what the transcript reading admitted, the disagreement a
            // record's second reading keeps: the hook's answer is the one that held.
            { step: "tool_use", id: "toolu_disagreed", tool: "Write", input: { file_path: join(worktree, "src", "held.ts"), content: "x" } },
            { step: "hook", id: "toolu_disagreed", tool: "Write", input: { file_path: join(worktree, "docs", "held.md"), content: "x" } },
            { step: "tool_result", id: "toolu_disagreed", text: "ok" },
            // A call no hook answered and no result followed: the record keeps the
            // transcript's reading of it, and the tally comes to the record at the end.
            { step: "tool_use", id: "toolu_unanswered", tool: "Read", input: { file_path: "src/mailer.ts" } },
            { step: "text", text: "done" },
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

      // No tally ever named the refused path, not even between the call and the hook's answer.
      for (const tally of tallies) {
        expect(tally.written).not.toContain("docs/notes.md");
        expect(tally.written).not.toContain("src/failed.ts");
        expect(tally.written).not.toContain("src/held.ts");
      }
      // A write counts once it is settled, and not on the block alone.
      expect(tallies.some((tally) => tally.written.includes("src/retry.ts"))).toBe(true);
      // The words came first, and counted as no command.
      expect(tallies[0]?.commands).toBe(0);
      expect(result.commands.find((command) => command.detail.includes("notes.md"))?.decision).toBe("denied");
      expect(result.commands).toHaveLength(8);
      const last = tallies.at(-1)!;
      // Only the commands the guard admitted: the refused write and the one the hook refused are not.
      const admitted = result.commands.filter((command) => command.decision === "allowed").length;
      expect(admitted).toBe(result.commands.length - 2);
      for (const tally of tallies) expect(tally.commands).toBeLessThanOrEqual(admitted);
      expect(last).toEqual({
        commands: admitted,
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
