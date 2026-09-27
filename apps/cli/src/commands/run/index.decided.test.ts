import { describe, expect, it } from "vitest";
import { transition, type Ticket } from "@perbo/contracts";
import type { TicketRunResult } from "@perbo/runner";
import { UnreachableStateError, applyObservedPath } from "../admit.js";
import { makeTicket } from "../../test-support/records.js";
import { observedPath, reopen } from "./index.js";

/**
 * D-132: a run that delivers on a
 * person's decisions executes and reviews nothing, so the ticket moves from
 * `provisioning` straight to `pr_open` — on that run's own row, and on no
 * other evidence.
 */

const AT = new Date("2026-09-24T12:00:00.000Z");

/** PRB-13 after its review stopped for a person, and the next run started. */
function provisioning(): Ticket {
  const stopped = makeTicket({
    key: "PRB-13",
    ticket_id: "ticket_prb13000001",
    repository_root: "/nowhere/repo",
    state: "changes_requested",
  });
  return transition(reopen(stopped, "new attempt after changes_requested"), "provisioning", "run started", AT);
}

const result = (over: Partial<TicketRunResult>): TicketRunResult =>
  ({
    rounds: [],
    outcome: "approved",
    detail: "",
    decided: [],
    ...over,
  }) as TicketRunResult;

describe("a delivery a person's decisions took", () => {
  it("moves the ticket from provisioning to pr_open, saying which decisions it rests on", () => {
    const moved = applyObservedPath(
      provisioning(),
      observedPath(
        result({
          decided: [
            {
              finding_key: "1".repeat(64),
              choice: "ship_as_is",
              review_id: null,
              note: "package-lock.json is authoritative",
              author: "Owen <owen@example.com>",
              decided_at: AT.toISOString(),
            },
          ],
        }),
      ),
      AT,
    );
    expect(moved.state).toBe("pr_open");
    const last = moved.history[moved.history.length - 1]!;
    expect(last.from).toBe("provisioning");
    expect(last.note).toContain("every finding the review routed to a person is decided");
    expect(last.note).toContain("111111111111");
  });

  it("is the only thing that takes that row: an approval with no round and no decision is refused", () => {
    expect(() => applyObservedPath(provisioning(), observedPath(result({})), AT)).toThrow(
      UnreachableStateError,
    );
    expect(() => transition(provisioning(), "pr_open", "a pull request is open", AT)).toThrow(
      /cannot move to pr_open/,
    );
  });
});

/**
 * A run a person's decision continued, whose remediation rounds were each
 * judged by a closure verification. A later round is not reviewed again
 * (D-061): its verification is what moves it to `independent_review`, as its
 * bundle's `VERIFYING → INDEPENDENT_REVIEW` records, and the run has no round
 * 0 of its own.
 */
describe("a run that continued a review's findings", () => {
  const OPEN = ["403ca670", "3a70c95b", "8084f939", "bbe53035", "035aedb1"].map((key) => key.padEnd(64, "0"));
  const HANDED = "77f96b29".padEnd(64, "0");

  /** A remediation round the closure verifier judged, as the loop records it. */
  const verified = (round: number, closed: readonly string[], open: readonly string[]) =>
    ({
      round,
      kind: "remediate",
      review: null,
      node_reviews: [],
      verification: {
        all_closed: open.length === 0,
        deterministic_failure: null,
        per_finding: [
          ...closed.map((finding_key) => ({ finding_key, status: "closed" })),
          ...open.map((finding_key) => ({ finding_key, status: "not_closed" })),
        ],
        open_keys: [...open],
      },
      checks: [],
      remediable_findings: open.length,
      directly_verified: 0,
      declines: [],
    }) as unknown as TicketRunResult["rounds"][number];

  /** Round 1 closed the finding the person handed over; round 2 added nothing and closed nothing. */
  const closedThenStalled = [verified(1, [HANDED], OPEN), verified(2, [], OPEN)];

  it("ends where the verification left it, through independent_review", () => {
    const moved = applyObservedPath(
      provisioning(),
      observedPath(result({ rounds: closedThenStalled, outcome: "remediation_stalled" })),
      AT,
    );
    expect(moved.state).toBe("changes_requested");
    expect(moved.history.slice(-4).map((row) => [row.from, row.to])).toEqual([
      ["provisioning", "executing"],
      ["executing", "verifying"],
      ["verifying", "independent_review"],
      ["independent_review", "changes_requested"],
    ]);
  });

  it.each([
    ["approved", [verified(1, [HANDED, ...OPEN], [])], "pr_open"],
    ["escalated", closedThenStalled, "changes_requested"],
    ["changes_requested", closedThenStalled, "changes_requested"],
    ["remediation_exhausted", closedThenStalled, "changes_requested"],
    ["remediation_stalled", closedThenStalled, "changes_requested"],
    ["review_failed", closedThenStalled, "failed"],
    ["base_conflict", closedThenStalled, "failed"],
    ["terminated", closedThenStalled, "failed"],
    ["no_changes", closedThenStalled, "failed"],
  ] as const)("reaches its terminal state through independent_review when it ends %s", (outcome, rounds, state) => {
    const moved = applyObservedPath(
      provisioning(),
      observedPath(result({ rounds: [...rounds], outcome })),
      AT,
    );
    expect(moved.state).toBe(state);
    expect(moved.history.filter((row) => row.to === "independent_review")).toHaveLength(1);
  });

  it("ends a widened round at changes_requested through independent_review, where its scope refusal moved it", () => {
    const refusal =
      "remediation round 1 was given 1 scope finding(s) and widened the change set instead: " +
      "test/extra.test.ts were not in the change set it was asked to narrow.";
    const widened = {
      ...verified(1, [], [HANDED]),
      verification: {
        prompt_version: "none",
        per_finding: [{ finding_key: HANDED, status: "cannot_tell", pointer: "", idiomatic: "cannot_tell", practice: "" }],
        deterministic_failure: refusal,
        deterministic_failure_kind: "scope",
        all_closed: false,
        open_keys: [HANDED],
        cost_micros: 0,
        cost_basis: "not_incurred",
      },
    } as unknown as TicketRunResult["rounds"][number];
    const moved = applyObservedPath(
      provisioning(),
      observedPath(result({ rounds: [widened], outcome: "changes_requested", detail: refusal })),
      AT,
    );
    expect(moved.state).toBe("changes_requested");
    expect(moved.history.slice(-2).map((row) => [row.from, row.to, row.note])).toEqual([
      ["verifying", "independent_review", "1 remediation round judged by closure verification"],
      ["independent_review", "changes_requested", expect.any(String)],
    ]);
  });

  it("claims no review for a round that stopped before anything judged it", () => {
    const moved = applyObservedPath(
      provisioning(),
      observedPath(result({ rounds: [{ ...closedThenStalled[0]!, verification: null }], outcome: "terminated" })),
      AT,
    );
    expect(moved.state).toBe("failed");
    expect(moved.history.at(-1)).toMatchObject({ from: "verifying", to: "failed" });
    expect(moved.history.some((row) => row.to === "independent_review")).toBe(false);
  });
});
