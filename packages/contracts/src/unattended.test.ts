import { describe, expect, it } from "vitest";
import {
  TICKET_SCHEMA_VERSION,
  TicketSchema,
  type Ticket,
} from "./ticket.js";
import {
  DIRECT_ARM_COMMIT_TRAILER,
  commitCarriesArm,
  commitCarriesLoopAttempt,
  mergedAt,
  summariseUnattendedMerges,
  unattendedMergeStatus,
} from "./unattended.js";

/**
 * SCP-196: the loop's own success as a live number.
 *
 * `delivery.opened_by` (SCP-173/176) already says who opened the pull
 * request; what is tested here is the second half these add — whether a
 * commit on it came from outside the loop, decided from the message alone —
 * and the two combined into one verdict per ticket and one share over many.
 */

const MERGED_AT = "2026-09-03T12:00:00.000Z";

const ticket = (overrides: Partial<Ticket> = {}): Ticket =>
  TicketSchema.parse({
    schema_version: TICKET_SCHEMA_VERSION,
    ticket_id: "ticket_01abcdef",
    key: "AYO-1",
    title: "New users receive an activation email within 60 seconds of signing up.",
    state: "plan_review",
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_01abcdef",
    plan_version: 1,
    approved_at: null,
    admitted_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    admission: { elapsed_ms: 4200, criteria_source: "typed", criteria_count: 3 },
    history: [{ at: "2026-08-28T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" }],
    ...overrides,
  });

/** A ticket that reached `merged` behind a pull request, with the two SCP-196 facts set. */
const mergedTicket = (over: {
  opened_by: "loop" | "direct" | "hand_off" | null;
  commits_outside_loop: boolean | null;
  merged_at?: string;
  arm?: "loop" | "direct";
}): Ticket =>
  ticket({
    state: "merged",
    delivery: {
      branch: "ayo/AYO-1/activation-email",
      pull_request_url: "https://github.com/o/r/pull/1",
      pull_request_number: 1,
      state: "merged",
      observed_at: MERGED_AT,
      opened_by: over.opened_by,
      mergeable: null,
      commits_outside_loop: over.commits_outside_loop,
      github_credential: null,
      arm: over.arm ?? "loop",
      merged_by: null,
      incomplete_review: null,
      checks: [],
      checks_state: null,
    },
    history: [
      { at: "2026-08-28T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" },
      { at: over.merged_at ?? MERGED_AT, from: "pr_open", to: "merged", note: "merged" },
    ],
  });

describe("commitCarriesLoopAttempt", () => {
  it("finds the trailer sealChangeSet and mergeUp write", () => {
    expect(commitCarriesLoopAttempt("AYO-1: activation email\n\nAttempt: att_1\nBase: abc123\n")).toBe(true);
    expect(commitCarriesLoopAttempt("AYO-1: merge main into the attempt branch\n\nAttempt: att_1\nBase: def456\n")).toBe(
      true,
    );
  });

  it("is false for a message with no trailer, whoever git says wrote it", () => {
    expect(commitCarriesLoopAttempt("fix typo in README")).toBe(false);
    // A person's commit message that merely mentions an attempt in passing,
    // not the trailer line the runner writes, still does not count.
    expect(commitCarriesLoopAttempt("continuing the attempt from yesterday")).toBe(false);
  });
});

describe("commitCarriesArm", () => {
  it("reads the loop's attempt trailer for the loop's arm", () => {
    const sealed = "AYO-1: activation email\n\nAttempt: att_1\nBase: abc123\n";
    expect(commitCarriesArm(sealed, "loop")).toBe(true);
    expect(commitCarriesArm("fix typo in README", "loop")).toBe(false);
    // The loop's own name for the same rule, kept for the callers that read it.
    expect(commitCarriesLoopAttempt(sealed)).toBe(commitCarriesArm(sealed, "loop"));
  });

  it("reads the direct arm's own trailer for the direct arm", () => {
    expect(commitCarriesArm(`signup rejects it\n\n${DIRECT_ARM_COMMIT_TRAILER}\n`, "direct")).toBe(true);
    // A commit the agent made without the trailer reads as outside the arm.
    // Nothing else can show it was the arm's, and guessing would be the
    // fabrication the whole measure exists to avoid.
    expect(commitCarriesArm("signup rejects it", "direct")).toBe(false);
    // Neither arm's trailer counts for the other.
    expect(commitCarriesArm("x\n\nAttempt: att_1\n", "direct")).toBe(false);
    expect(commitCarriesArm(`x\n\n${DIRECT_ARM_COMMIT_TRAILER}\n`, "loop")).toBe(false);
  });
});

describe("mergedAt", () => {
  it("reads the last row that moved the ticket to merged", () => {
    const t = mergedTicket({ opened_by: "loop", commits_outside_loop: false, merged_at: MERGED_AT });
    expect(mergedAt(t)).toBe(MERGED_AT);
  });

  it("is null for a ticket whose history never reached merged", () => {
    expect(mergedAt(ticket({ state: "pr_open" }))).toBeNull();
  });
});

describe("unattendedMergeStatus", () => {
  it("is unattended when the loop opened the pull request and no commit came from outside it", () => {
    const t = mergedTicket({ opened_by: "loop", commits_outside_loop: false });
    expect(unattendedMergeStatus(t)).toBe("unattended");
  });

  it("is attended when a commit on the loop's own pull request came from outside it", () => {
    const t = mergedTicket({ opened_by: "loop", commits_outside_loop: true });
    expect(unattendedMergeStatus(t)).toBe("attended");
  });

  it("is attended for a hand-off pull request, whatever its commits say", () => {
    const t = mergedTicket({ opened_by: "hand_off", commits_outside_loop: false });
    expect(unattendedMergeStatus(t)).toBe("attended");
  });

  it("is unknown for a ticket that has not merged", () => {
    expect(unattendedMergeStatus(ticket({ state: "pr_open" }))).toBe("unknown");
  });

  it("is unknown when opened_by was never decided", () => {
    const t = mergedTicket({ opened_by: null, commits_outside_loop: false });
    expect(unattendedMergeStatus(t)).toBe("unknown");
  });

  it("is unknown when the loop's pull request's commits have not been read yet", () => {
    const t = mergedTicket({ opened_by: "loop", commits_outside_loop: null });
    expect(unattendedMergeStatus(t)).toBe("unknown");
  });
});

describe("unattendedMergeStatus reads the direct arm by the same rule (SCP-206)", () => {
  it("counts a direct arm's own pull request with no commit outside it as unattended", () => {
    expect(
      unattendedMergeStatus(
        mergedTicket({ opened_by: "direct", commits_outside_loop: false, arm: "direct" }),
      ),
    ).toBe("unattended");
  });

  it("counts a commit outside that arm as attended, exactly as for the loop", () => {
    expect(
      unattendedMergeStatus(
        mergedTicket({ opened_by: "direct", commits_outside_loop: true, arm: "direct" }),
      ),
    ).toBe("attended");
  });

  it("still calls a hand-off attended and an undecided record unknown", () => {
    expect(
      unattendedMergeStatus(
        mergedTicket({ opened_by: "hand_off", commits_outside_loop: false, arm: "direct" }),
      ),
    ).toBe("attended");
    expect(
      unattendedMergeStatus(
        mergedTicket({ opened_by: "direct", commits_outside_loop: null, arm: "direct" }),
      ),
    ).toBe("unknown");
  });
});

describe("summariseUnattendedMerges", () => {
  it("counts unattended and attended, excludes unknown from the share, and reports n", () => {
    const tickets = [
      mergedTicket({ opened_by: "loop", commits_outside_loop: false }),
      mergedTicket({ opened_by: "loop", commits_outside_loop: false }),
      mergedTicket({ opened_by: "loop", commits_outside_loop: true }),
      mergedTicket({ opened_by: "hand_off", commits_outside_loop: null }),
      mergedTicket({ opened_by: "loop", commits_outside_loop: null }),
      ticket({ state: "ready" }),
    ];
    const summary = summariseUnattendedMerges(tickets);
    expect(summary.merged).toBe(5);
    expect(summary.unattended).toBe(2);
    expect(summary.attended).toBe(2);
    expect(summary.unknown).toBe(1);
    expect(summary.share.n).toBe(4);
    expect(summary.share.point).toBe(0.5);
  });

  it("has no reading over an empty population", () => {
    const summary = summariseUnattendedMerges([]);
    expect(summary.merged).toBe(0);
    expect(Number.isNaN(summary.share.point)).toBe(true);
  });
});
