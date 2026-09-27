import { describe, expect, it } from "vitest";
import { loopMergeDecision, type LoopMergeObservation } from "./merge.js";

/**
 * SCP-227: an approval survives a clean re-level and nothing else.
 *
 * The queue keeps every open branch level with its base, and each re-level
 * moves the head. The approval is bound to what was approved — the change
 * set's content and the contract's scope — rather than to the sha alone, so
 * the gate reads what the runner established about the earlier head.
 */

const APPROVED = "a".repeat(40);
const NOW = "b".repeat(40);

const approval = (head: string): string =>
  `**D-073 review — claude-fable-5-1 — verdict: APPROVE** (head \`${head.slice(0, 12)}\`)`;

const observed = (over: Partial<LoopMergeObservation> = {}): LoopMergeObservation => ({
  state: "open",
  head_sha: NOW,
  base_ref: "main",
  mergeable: "mergeable",
  checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
  comments: [approval(APPROVED)],
  commits: [
    { sha: APPROVED, message: "seal\n\nAttempt: att_0000000000000001", verified: true },
    { sha: NOW, message: "AYO-1: merge main into the attempt branch\n\nAttempt: att_0000000000000001\nBase: c", verified: true },
  ],
  ...over,
});

describe("an approval across a re-level", () => {
  it("carries when the content is unchanged and the base touched nothing in scope", () => {
    const decision = loopMergeDecision({
      mode: "loop",
      observed: observed({ carried_approvals: [{ head: APPROVED, content_equal: true, scope_touched: [] }] }),
    });
    expect(decision).toEqual({ merge: true, approved_head: APPROVED });
  });

  it("names the head it was given directly, when the approval names the head now", () => {
    const decision = loopMergeDecision({ mode: "loop", observed: observed({ comments: [approval(NOW)] }) });
    expect(decision).toEqual({ merge: true, approved_head: NOW });
  });

  it("stops when the content changed, and says so", () => {
    const decision = loopMergeDecision({
      mode: "loop",
      observed: observed({ carried_approvals: [{ head: APPROVED, content_equal: false, scope_touched: [] }] }),
    });
    expect(decision.merge).toBe(false);
    if (decision.merge) throw new Error("unreachable");
    expect(decision.rule_id).toBe("merge.head_moved_after_approval");
    expect(decision.statement).toContain("no longer what was approved");
  });

  it("stops when the base advance touched the scope, naming the paths", () => {
    const decision = loopMergeDecision({
      mode: "loop",
      observed: observed({
        carried_approvals: [{ head: APPROVED, content_equal: true, scope_touched: ["src/feature.ts"] }],
      }),
    });
    expect(decision.merge).toBe(false);
    if (decision.merge) throw new Error("unreachable");
    expect(decision.rule_id).toBe("merge.head_moved_after_approval");
    expect(decision.statement).toContain("src/feature.ts");
    expect(decision.statement).toContain("inside the change's own scope");
  });

  it("names five of the paths the base touched whole, then how many more (D-NEW-nothing-shown-is-cut)", () => {
    const paths = [1, 2, 3, 4, 5, 6, 7].map((n) => `src/feature-${n}.ts`);
    const decision = loopMergeDecision({
      mode: "loop",
      observed: observed({ carried_approvals: [{ head: APPROVED, content_equal: true, scope_touched: paths }] }),
    });
    if (decision.merge) throw new Error("unreachable");
    expect(decision.statement).toContain("src/feature-5.ts and 2 more inside the change's own scope");
  });

  it("fails closed where the runner could not read the branch", () => {
    for (const carried of [undefined, []] as const) {
      const decision = loopMergeDecision({
        mode: "loop",
        observed: observed(carried === undefined ? {} : { carried_approvals: carried }),
      });
      expect(decision.merge).toBe(false);
      if (decision.merge) throw new Error("unreachable");
      expect(decision.statement).toContain("something reached this branch after the approval");
    }
  });

  it("ignores a carried reading for a head no approval named", () => {
    const decision = loopMergeDecision({
      mode: "loop",
      observed: observed({
        carried_approvals: [{ head: "c".repeat(40), content_equal: true, scope_touched: [] }],
      }),
    });
    expect(decision.merge).toBe(false);
  });
});
