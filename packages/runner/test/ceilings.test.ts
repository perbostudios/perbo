import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { AttemptCeilings } from "../src/ceilings.js";

/**
 * SCP-230: a ceiling a caller does not want is absent, not enormous.
 *
 * The registered direct-agent arm is bounded by its ticket's dollar budget and
 * by a hang guard, and by nothing else — the loop spends the same budget across
 * as many attempts as it needs, so a per-attempt count applied to the arm's one
 * invocation makes it lose a large ticket by construction. Saying that with a
 * very large number would still be a ceiling, and a reader could not tell a
 * bound nobody meant from one somebody chose.
 */

const table = LimitsTableSchema.parse({
  organisation: "test",
  limits: { attempt_iterations: 1, attempt_commands: 1, attempt_tokens: 1, attempt_wall_clock_ms: 1 },
});

describe("a ceiling named unbounded never breaches", () => {
  it("counts the resource and refuses to stop on it", () => {
    const ceilings = new AttemptCeilings(table, Date.now, {
      unbounded: ["attempt_iterations", "attempt_commands", "attempt_tokens"],
    });
    for (let i = 0; i < 5; i += 1) {
      expect(ceilings.noteIteration()).toBeNull();
      expect(ceilings.noteCommand()).toBeNull();
      expect(ceilings.noteTokens(1_000)).toBeNull();
    }
    expect(ceilings.breached()).toBeNull();
    // The counts are still kept: the record says what the run did, and only
    // the stopping is dropped.
    expect(ceilings.counts().iterations).toBe(5);
    expect(ceilings.counts().commands).toBe(5);
    expect(ceilings.counts().tokens).toBe(5_000);
  });

  it("leaves every ceiling the caller did not name alone", () => {
    const ceilings = new AttemptCeilings(table, Date.now, {
      unbounded: ["attempt_iterations", "attempt_commands", "attempt_tokens"],
    });
    // Cost is the arm's real bound and is not on the list.
    const breach = ceilings.noteCostMicros(99_000_000);
    expect(breach?.resource).toBe("attempt_cost_micros");
  });

  it("stops on all of them when nothing is named, which is the executor", () => {
    const ceilings = new AttemptCeilings(table);
    expect(ceilings.noteIteration()).toBeNull();
    expect(ceilings.noteIteration()?.resource).toBe("attempt_iterations");
  });
});
