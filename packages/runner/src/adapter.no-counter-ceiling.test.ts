import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { runAgent } from "./adapter.js";
import { AttemptCeilings } from "./ceilings.js";
import { buildPermissionProfile } from "./profile.js";
import { fakeAgent } from "./test-support/fake-agent.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * D-096: an attempt is stopped by the stall detector, by a cost cap where the
 * executor is billed per token, and by a ceiling the repository set itself, and
 * by nothing counted in iterations or tool calls.
 *
 * An iteration is one assistant event on the executor's stream — a message,
 * not a tool call — and a command is one tool call. A repository that sets one
 * of the three counters gets exactly the ceiling it asked for; absent, there is
 * none, and the counts are still kept on the record.
 *
 * The fake agent emits one assistant message per command, so a run of n
 * commands is n iterations and n tool calls.
 */

const table = (limits: Record<string, number> = {}) =>
  LimitsTableSchema.parse({ organisation: "test", limits });

const runTurns = async (
  turns: number,
  limits: Record<string, number>,
  options: { round?: boolean } = {},
) => {
  const worktree = scratch("perbo-no-counter-");
  const agent = fakeAgent(scratch, [
    { kind: "shell", commands: Array.from({ length: turns }, () => "git status") },
  ]);
  return runAgent({
    binary: agent.binary,
    worktree,
    prompt: "do the thing",
    model: "claude-opus-5",
    profile: buildPermissionProfile({ worktree }),
    ceilings: new AttemptCeilings(table(limits), Date.now, {
      ...(options.round ? { iterations: "round_iterations" as const } : {}),
    }),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
};

describe("an attempt no counter bounds", () => {
  it(
    "runs past the counts that used to end it, and records them",
    async () => {
      const result = await runTurns(201, {});

      expect(result.termination.reason).toBe("completed");
      expect(result.usage.iterations).toBe(201);
      expect(result.commands).toHaveLength(201);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "still ends at attempt_iterations where the repository set one",
    async () => {
      const result = await runTurns(201, { attempt_iterations: 60 });

      expect(result.termination.reason).toBe("iteration_ceiling_exceeded");
      expect(result.termination.detail).toContain("above the limit of 60");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "still ends at attempt_commands where the repository set one",
    async () => {
      // The ceiling sits mid-stream, with a hundred turns still to come, so
      // the breach is read while the transport is still writing rather than
      // on its last line.
      const result = await runTurns(201, { attempt_commands: 100 });

      expect(result.termination.reason, JSON.stringify(result.usage)).toBe("command_ceiling_exceeded");
      expect(result.termination.detail).toContain("above the limit of 100");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("a remediation round no counter bounds", () => {
  it(
    "runs past the eighty that used to end it",
    async () => {
      const result = await runTurns(81, {}, { round: true });

      expect(result.termination.reason).toBe("completed");
      expect(result.usage.iterations).toBe(81);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "still ends at round_iterations where the repository set one",
    async () => {
      const result = await runTurns(101, { round_iterations: 80 }, { round: true });

      expect(result.termination.reason, JSON.stringify(result.usage)).toBe("round_iteration_ceiling_exceeded");
      expect(result.termination.detail).toContain("above the limit of 80");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
