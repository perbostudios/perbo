import { describe, expect, it } from "vitest";
import { TicketSchema, type Ticket } from "@perbo/contracts";
import { UsageError } from "../src/args.js";
import { reopen } from "../src/execute.js";

/**
 * `reopen` walks the shortest **legal** route back to `ready`, and a guarded
 * row is only legal for the record that satisfies its guard.
 *
 * Since SCP-252 there is a route out of `pr_open` — to `closed`, and to
 * `changes_requested` — and both are guarded on the delivery record reporting
 * the pull request closed. A search that ignored the guard would find those
 * routes for a ticket whose pull request is still open and then fail applying
 * them, turning a refusal a person can read into a stack trace.
 */

const ticket = (state: Ticket["state"], delivery: "none" | "open" | "closed"): Ticket =>
  TicketSchema.parse({
    schema_version: 1,
    ticket_id: "ticket_01abcdef",
    key: "AYO-1",
    title: "Search results are paginated.",
    state,
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_01abcdef",
    plan_version: 1,
    approved_at: "2026-09-06T08:00:00.000Z",
    admitted_at: "2026-09-06T08:00:00.000Z",
    updated_at: "2026-09-06T09:00:00.000Z",
    admission: { elapsed_ms: 25, criteria_source: "typed", criteria_count: 1 },
    delivery:
      delivery === "none"
        ? undefined
        : {
            branch: "ayo/ticket_01abcdef/search",
            pull_request_url: "https://github.com/o/r/pull/1",
            pull_request_number: 1,
            state: delivery,
            observed_at: "2026-09-06T09:00:00.000Z",
            opened_by: "loop",
            mergeable: null,
            commits_outside_loop: null,
            github_credential: null,
            arm: "loop",
          },
    history: [{ at: "2026-09-06T08:00:00.000Z", from: null, to: "plan_review", note: "admitted" }],
  });

describe("reopening a ticket for another attempt", () => {
  it("brings a failed ticket back to ready", () => {
    expect(reopen(ticket("failed", "none"), "new attempt after failed").state).toBe("ready");
  });

  it("brings back a pr_open ticket whose pull request the record says closed", () => {
    const reopened = reopen(ticket("pr_open", "closed"), "new attempt after pr_open");
    expect(reopened.state).toBe("ready");
    expect(reopened.history.map((row) => row.to)).toContain("closed");
  });

  it("refuses a pr_open ticket whose pull request is still open, and says why", () => {
    // The guarded rows are not this record's to take, so the lifecycle has no
    // route out of `pr_open` for it — the same refusal it gave before those
    // rows existed, rather than a walk through a state its pull request is not
    // in.
    expect(() => reopen(ticket("pr_open", "open"), "new attempt after pr_open")).toThrow(UsageError);
  });
});
