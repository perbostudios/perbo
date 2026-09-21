import { describe, expect, it } from "vitest";
import { D073_CHANGES_REQUESTED, loopMergeDecision, readD073Verdicts } from "./merge.js";

/**
 * The two verdicts a D-073 review comment carries.
 *
 * `APPROVE` is one word and `CHANGES REQUESTED` is two, and the reader has to
 * take both: SCP-252 decides a closed pull request's ticket from whether a
 * CHANGES REQUESTED verdict is on it, so a reader that stops at the first word
 * reads every such comment as no verdict at all.
 */
const comment = (verdict: string, head = "75e790e2b1c4"): string =>
  `**D-073 review — claude-fable-5-1 — verdict: ${verdict}** (head \`${head}\`)\n\nBody.`;

describe("reading a D-073 verdict comment", () => {
  it("reads an approval", () => {
    expect(readD073Verdicts(comment("APPROVE"))).toEqual([
      { model: "claude-fable-5-1", verdict: "APPROVE", head: "75e790e2b1c4" },
    ]);
  });

  it("reads a two-word CHANGES REQUESTED verdict", () => {
    expect(readD073Verdicts(comment("CHANGES REQUESTED"))).toEqual([
      { model: "claude-fable-5-1", verdict: D073_CHANGES_REQUESTED, head: "75e790e2b1c4" },
    ]);
  });

  it("names that verdict once, so no caller spells it twice", () => {
    expect(D073_CHANGES_REQUESTED).toBe("CHANGES REQUESTED");
  });

  it("still reads nothing out of a person talking on the pull request", () => {
    expect(readD073Verdicts("looks good to me")).toEqual([]);
  });

  it("still refuses to merge on a CHANGES REQUESTED verdict, and says which it read", () => {
    const decision = loopMergeDecision({
      mode: "loop",
      observed: {
        state: "open",
        head_sha: "75e790e2b1c4d5e6f708192a3b4c5d6e7f809192",
        base_ref: "main",
        mergeable: "mergeable",
        checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
        comments: [comment("CHANGES REQUESTED")],
        commits: [],
      },
    });
    expect(decision.merge).toBe(false);
    expect(decision.merge === false && decision.rule_id).toBe("merge.no_separate_approval");
    expect(decision.merge === false && decision.statement).toContain(D073_CHANGES_REQUESTED);
  });
});
