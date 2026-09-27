import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  TICKET_STATES_REACHABLE,
  TicketSchema,
  isActive,
  transition,
  withReconciliation,
  withWaits,
  type Ticket,
} from "./ticket.js";
import { TICKET_TRANSITIONS } from "./ticket-transitions.js";

/**
 * `blocked` is reachable now: the queue derives it from `depends_on` and from
 * scope overlap (SCP-008 criterion 5), and a ticket in it is one the queue
 * will start on its own once what it waits on has merged.
 */

const base = (): Ticket =>
  TicketSchema.parse({
    schema_version: 1,
    ticket_id: "ticket_blocked0001",
    key: "AYO-7",
    title: "Something.",
    state: "ready",
    priority: "normal",
    labels: [],
    depends_on: ["AYO-6"],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_blocked0001",
    plan_version: 1,
    approved_at: "2026-09-10T10:00:00.000Z",
    admitted_at: "2026-09-10T09:00:00.000Z",
    updated_at: "2026-09-10T10:00:00.000Z",
    admission: { elapsed_ms: 10, criteria_source: "typed", criteria_count: 1 },
    history: [
      { at: "2026-09-10T09:00:00.000Z", from: null, to: "plan_review", note: "admitted" },
      { at: "2026-09-10T10:00:00.000Z", from: "plan_review", to: "ready", note: "approved" },
    ],
  });

describe("blocked is a state the queue can put a ticket into", () => {
  it("is declared reachable and has its three rows", () => {
    expect(TICKET_STATES_REACHABLE).toContain("blocked");
    expect(TICKET_TRANSITIONS).toContainEqual({ from: "ready", to: "blocked" });
    expect(TICKET_TRANSITIONS).toContainEqual({ from: "blocked", to: "ready" });
    expect(TICKET_TRANSITIONS).toContainEqual({ from: "blocked", to: "cancelled" });
    // Nowhere else: a blocked ticket runs only after it is ready again.
    expect(TICKET_TRANSITIONS.filter((row) => row.from === "blocked").map((row) => row.to).sort()).toEqual([
      "cancelled",
      "ready",
    ]);
  });

  it("walks ready -> blocked -> ready and records why on each row", () => {
    const blocked = transition(base(), "blocked", "waits on AYO-6 (depends_on: executing)");
    expect(blocked.state).toBe("blocked");
    const again = transition(blocked, "ready", "AYO-6 merged");
    expect(again.state).toBe("ready");
    expect(again.history.slice(-2).map((row) => `${row.from}->${row.to}`)).toEqual([
      "ready->blocked",
      "blocked->ready",
    ]);
  });

  it("refuses to run a blocked ticket directly", () => {
    const blocked = transition(base(), "blocked", "waits");
    expect(() => transition(blocked, "provisioning", "run")).toThrow(IllegalTransitionError);
  });

  it("counts as active in the listing", () => {
    expect(isActive(transition(base(), "blocked", "waits"))).toBe(true);
  });
});

describe("the scheduling record on the ticket", () => {
  it("defaults to no waits, so every stored ticket still parses", () => {
    const parsed = base();
    expect(parsed.scheduling).toEqual({ waits_on: [], decided_at: null, reconciliation: null });
  });

  it("is written whole by withWaits, with the time it was decided", () => {
    const at = new Date("2026-09-10T11:00:00.000Z");
    const written = withWaits(
      base(),
      [
        { key: "AYO-6", reason: "depends_on", paths: [], state: "executing" },
        { key: "AYO-5", reason: "scope_overlap", paths: ["packages/runner/**"], state: "pr_open" },
      ],
      at,
    );
    expect(written.scheduling).toEqual({
      waits_on: [
        { key: "AYO-6", reason: "depends_on", paths: [], state: "executing" },
        { key: "AYO-5", reason: "scope_overlap", paths: ["packages/runner/**"], state: "pr_open" },
      ],
      decided_at: "2026-09-10T11:00:00.000Z",
      reconciliation: null,
    });
    // Nothing else moved: the record is the queue's, the lifecycle is `transition`'s.
    expect(written.state).toBe("ready");
    expect(written.history).toEqual(base().history);
  });

  it("refuses a wait with an unknown reason", () => {
    expect(() =>
      TicketSchema.parse({
        ...base(),
        scheduling: { waits_on: [{ key: "AYO-6", reason: "vibes", paths: [], state: null }], decided_at: null },
      }),
    ).toThrow();
  });
});

describe("the reconciliation record", () => {
  it("is written whole, kept by withWaits, and cleared with null", () => {
    const at = new Date("2026-09-10T11:00:00.000Z");
    const record = { base_tip: "c".repeat(40), exit_code: 3, at: "2026-09-10T10:59:00.000Z", reason: "carries 1 commit the loop did not make" };
    const written = withReconciliation(base(), record);
    expect(written.scheduling.reconciliation).toEqual(record);
    expect(withWaits(written, [], at).scheduling.reconciliation).toEqual(record);
    expect(withReconciliation(written, null).scheduling.reconciliation).toBeNull();
    // A record written before the reason was kept reads back with none.
    const older = { base_tip: record.base_tip, exit_code: record.exit_code, at: record.at };
    expect(withReconciliation(base(), older).scheduling.reconciliation).toEqual({ ...older, reason: null });
  });

  it("refuses a base tip that is not a commit sha", () => {
    expect(() => withReconciliation(base(), { base_tip: "main", exit_code: 3, at: "2026-09-10T10:59:00.000Z" })).toThrow();
  });
});
