import { describe, expect, it } from "vitest";
import {
  LOOP_MERGE_RULE_IDS,
  loopMergeDecision,
  mergeSwitchStop,
  reReadStillMerges,
  type LoopMergeDecision,
  type LoopMergeObservation,
  type LoopMergeRuleId,
  type LoopMergeStop,
} from "./merge.js";

/**
 * The sentences the merge decision hands a person, read for identifiers only
 * this repository knows.
 *
 * `merge.ts` ships in the release tarball, so its stops are printed in a terminal
 * belonging to somebody who has none of this repository's decision records: a
 * `D-0nn` or `SCP-nnn` there names a document they cannot open, in the one
 * line that is supposed to tell them what to do next.
 *
 * Every stop the module can return is driven, and the coverage is asserted
 * rather than assumed — a statement no case reaches is one this test does not
 * read.
 */

const DECISION_ID = /\b(D-0\d\d|SCP-\d{3})\b/;

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);

/** The verdict comment a separate review run leaves, naming a head. */
const approval = (head: string): string =>
  `**D-073 review — claude-opus-5 — verdict: APPROVE** (head \`${head.slice(0, 12)}\`)`;

/** A pull request every condition holds for, narrowed one field at a time. */
const observed = (over: Partial<LoopMergeObservation> = {}): LoopMergeObservation => ({
  state: "open",
  head_sha: HEAD,
  base_ref: "main",
  mergeable: "mergeable",
  checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
  comments: [approval(HEAD)],
  commits: [{ sha: HEAD, message: "seal the change set\n\nAttempt: att_0000000000000001", verified: true }],
  ...over,
});

/** The commit shape that satisfies both commit conditions, or fails one. */
const commit = (over: Partial<LoopMergeObservation["commits"][number]> = {}) => ({
  sha: HEAD,
  message: "seal the change set\n\nAttempt: att_0000000000000001",
  verified: true,
  ...over,
});

/** Every stop this module produces: one case per branch that writes a sentence. */
function everyStop(): LoopMergeStop[] {
  const found: LoopMergeStop[] = [];
  const take = (decision: LoopMergeDecision): void => {
    if (!decision.merge) found.push({ rule_id: decision.rule_id, statement: decision.statement });
  };
  const switched = mergeSwitchStop("person");
  if (switched !== null) found.push(switched);
  take(loopMergeDecision({ mode: "person", observed: observed() }));

  const decide = (over: Partial<LoopMergeObservation>): void =>
    take(loopMergeDecision({ mode: "loop", observed: observed(over) }));
  decide({ state: "closed", head_sha: null });
  decide({ state: "merged" });
  decide({ comments: ["looks good to me"] });
  decide({ comments: [approval(HEAD).replace("APPROVE", "CHANGES REQUESTED")] });
  decide({ checks: [] });
  decide({ checks: [{ name: "unit", status: "COMPLETED", conclusion: "FAILURE" }] });
  decide({ checks: [{ name: "unit", status: "IN_PROGRESS", conclusion: null }] });
  decide({ mergeable: "conflicting" });
  decide({ mergeable: null });
  decide({ commits: [] });
  decide({ commits: [commit({ message: "a fix typed by hand" })] });
  decide({ commits: [commit({ verified: false })] });
  decide({ commits: [commit({ verified: null })] });
  decide({ comments: [approval(MOVED)] });

  const reRead = (now: Partial<LoopMergeObservation>): void =>
    take(reReadStillMerges({ decided: observed(), now: observed(now) }));
  reRead({ state: "merged" });
  reRead({ head_sha: MOVED });
  reRead({ mergeable: "conflicting" });
  return found;
}

/** The two rule ids the runner writes the sentence for; `merge.ts` produces neither. */
const RUNNER_OWNED: readonly LoopMergeRuleId[] = ["merge.in_flight", "merge.refused_by_github"];

describe("the stops the merge decision prints", () => {
  it("carries no decision or ticket identifier in any of them", () => {
    for (const stop of everyStop()) {
      expect(stop.statement, `${stop.rule_id}: ${stop.statement}`).not.toMatch(DECISION_ID);
    }
  });

  it("drives every rule this module can stop with", () => {
    const produced = new Set(everyStop().map((stop) => stop.rule_id));
    const unread = LOOP_MERGE_RULE_IDS.filter(
      (id) => !RUNNER_OWNED.includes(id) && !produced.has(id),
    );
    expect(unread).toEqual([]);
  });
});
