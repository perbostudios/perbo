import { describe, expect, it } from "vitest";
import {
  ANSWERS_OWED_NOTE,
  APPROVED_NOTE,
  gateClosedNote,
  incompleteNote,
  retainedBranch,
  runEndedOn,
  settledRow,
} from "./retained.js";
import type { Ticket } from "./ticket.js";

/**
 * D-136: which ticket has a retained branch to
 * publish, read from the ticket's own record of how its last run ended.
 */

const BRANCH = "prb/326a80e3846f75d7/the-repo-root-holds-resignation";

const ended = (
  state: Ticket["state"],
  note: string,
  delivery: Partial<Ticket["delivery"]> = {},
): Parameters<typeof retainedBranch>[0] => ({
  key: "PRB-8",
  state,
  history: [
    { at: "2026-09-24T21:04:33.638Z", from: "plan_review", to: "ready", note: "contract approved" },
    { at: "2026-09-24T21:06:52.764Z", from: "independent_review", to: state, note },
  ],
  delivery: {
    branch: BRANCH,
    pull_request_url: null,
    pull_request_number: null,
    state: "none",
    observed_at: "2026-09-24T21:06:52.764Z",
    opened_by: null,
    arm: "loop",
    ...delivery,
  } as Ticket["delivery"],
});

describe("a retained branch to publish", () => {
  it("is an approved run's, at pr_open with no pull request", () => {
    expect(retainedBranch(ended("pr_open", "approved; a human merges it"))).toEqual({
      branch: BRANCH,
      outcome: "approved",
      refusal: null,
    });
  });

  it("is an escalated run's, on the row that names the escalation", () => {
    expect(retainedBranch(ended("changes_requested", gateClosedNote("escalated"))).outcome).toBe("escalated");
  });

  it("is still an escalated run's after a run the loop refused for owed answers returned the ticket there", () => {
    const escalated = ended("changes_requested", gateClosedNote("escalated"));
    const refusedSince = {
      ...escalated,
      history: [
        ...escalated.history,
        { at: "2026-09-24T21:10:00.000Z", from: "changes_requested", to: "ready", note: "new attempt after changes_requested" },
        { at: "2026-09-24T21:10:00.001Z", from: "ready", to: "provisioning", note: "run started against plan_1" },
        { at: "2026-09-24T21:10:01.000Z", from: "provisioning", to: "changes_requested", note: ANSWERS_OWED_NOTE },
      ],
    } satisfies Parameters<typeof retainedBranch>[0];
    expect(retainedBranch(refusedSince)).toEqual({ branch: BRANCH, outcome: "escalated", refusal: null });
    expect(settledRow(refusedSince.history)?.note).toBe(gateClosedNote("escalated"));
  });

  it("is refused where the run ended anything but approved or escalated", () => {
    expect(retainedBranch(ended("changes_requested", gateClosedNote("remediation_exhausted"))).refusal).toBe(
      "PRB-8 is changes_requested, and its last run ended the gate closed: remediation_exhausted: only a run " +
        "that ended approved or escalated retains a branch to publish",
    );
    expect(retainedBranch(ended("failed", "the attempt did not complete: terminated")).refusal).toBe(
      "PRB-8 is failed: only a run that ended approved or escalated retains a branch to publish",
    );
  });

  it("is refused where the ticket already has its pull request", () => {
    expect(
      retainedBranch(
        ended("pr_open", "approved; a human merges it", {
          pull_request_url: "https://github.com/o/r/pull/7",
          pull_request_number: 7,
          state: "open",
        }),
      ).refusal,
    ).toBe("PRB-8 already has its pull request, https://github.com/o/r/pull/7");
  });

  it("is refused where the delivery is not the loop's own, or names no branch", () => {
    expect(retainedBranch(ended("pr_open", "approved", { opened_by: "hand_off" })).refusal).toBe(
      "PRB-8's delivery is a person's hand-off, which is not the loop's to publish",
    );
    expect(retainedBranch(ended("pr_open", "approved", { arm: "direct" })).refusal).toBe(
      "PRB-8's delivery is the direct arm's, which is not the loop's to publish",
    );
    expect(retainedBranch(ended("pr_open", "approved", { branch: null })).refusal).toBe(
      "PRB-8 records no branch, so its run retained nothing to publish",
    );
  });
});

describe("the outcome a ticket's row records its run ending on", () => {
  it("reads each run-ending row the CLI writes, and nothing else", () => {
    expect(runEndedOn(APPROVED_NOTE)).toBe("approved");
    expect(runEndedOn(gateClosedNote("remediation_stalled"))).toBe("remediation_stalled");
    expect(runEndedOn(incompleteNote("no_changes"))).toBe("no_changes");
    expect(runEndedOn("run started against plan_0e106f5ed0ddb333")).toBeNull();
    expect(runEndedOn(incompleteNote("the review did not complete"))).toBeNull();
    expect(runEndedOn(ANSWERS_OWED_NOTE)).toBeNull();
  });
});
