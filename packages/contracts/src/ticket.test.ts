import { describe, expect, it } from "vitest";
import {
  DECIDED_DELIVERY_NOTE,
  HAND_OFF_NOTE,
  HandOffEvidenceError,
  IllegalTransitionError,
  OPENER_UNKNOWN_NOTE,
  TICKET_SCHEMA_VERSION,
  TICKET_STATES,
  TICKET_STATES_REACHABLE,
  TICKET_TRANSITIONS,
  TicketSchema,
  attributePullRequest,
  attributionOnRecord,
  handOff,
  isActive,
  isHandOff,
  pullRequestAttribution,
  pullRequestWasHandedOff,
  resumeAtPullRequest,
  resumeWithUnrecordedOpener,
  transition,
  type Ticket,
} from "./ticket.js";

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
    history: [
      { at: "2026-08-28T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" },
    ],
    ...overrides,
  });

/** A delivery record, over the defaults a ticket carrying no pull request has. */
const delivery = (over: Partial<Ticket["delivery"]> = {}): Ticket["delivery"] => ({
  branch: null,
  pull_request_url: null,
  pull_request_number: null,
  state: "none",
  observed_at: null,
  opened_by: null,
  mergeable: null,
  commits_outside_loop: null,
  github_credential: null,
  arm: "loop",
  merged_by: null,
  incomplete_review: null,
  checks: [],
  checks_state: null,
  ...over,
});

describe("the native ticket", () => {
  it("carries every state the lifecycle diagram draws", () => {
    // The diagram is the source; the enum tracks it. If a state is added to one
    // and not the other, this is where the divergence surfaces.
    expect(TICKET_STATES).toContain("deployed");
    expect(TICKET_STATES).toContain("rolled_back");
    expect(new Set(TICKET_STATES).size).toBe(TICKET_STATES.length);
  });

  it("says which of those states Stage 3 can actually reach", () => {
    for (const state of TICKET_STATES_REACHABLE) {
      expect(TICKET_STATES).toContain(state);
    }
    // Deployment linkage does not exist yet, so nothing can put a ticket there.
    expect(TICKET_STATES_REACHABLE).not.toContain("deployed");
    expect(TICKET_STATES_REACHABLE).not.toContain("observing");
  });

  it("only has transitions between states it can reach", () => {
    const reachable = new Set<string>(TICKET_STATES_REACHABLE);
    for (const row of TICKET_TRANSITIONS) {
      expect(reachable, `${row.from} -> ${row.to}`).toContain(row.from);
      expect(reachable, `${row.from} -> ${row.to}`).toContain(row.to);
    }
  });

  it("takes a ready ticket to plan_invalid, which is where a stale spec leaves it", () => {
    // D-103: a run refuses to start a ticket whose spec has changed since the
    // contract was approved from it, and leaves the ticket saying so.
    const moved = transition(ticket({ state: "ready" }), "plan_invalid", "spec stale");
    expect(moved.state).toBe("plan_invalid");
    expect(moved.history.at(-1)).toMatchObject({ from: "ready", to: "plan_invalid" });
    // And nothing takes it out again: an approved contract is immutable
    // (ADR-0016), so the work is admitted again rather than re-approved.
    expect(TICKET_TRANSITIONS.filter((row) => row.from === "plan_invalid")).toEqual([]);
  });

  it("refuses a transition with no row, and names what is allowed instead", () => {
    expect(() => transition(ticket(), "pr_open", "skip ahead")).toThrow(IllegalTransitionError);
    try {
      transition(ticket(), "pr_open", "skip ahead");
    } catch (error) {
      expect((error as Error).message).toContain("ready");
    }
  });

  it("appends to history rather than rewriting it", () => {
    const at = new Date("2026-08-28T01:00:00.000Z");
    const moved = transition(ticket(), "ready", "contract approved", at);
    expect(moved.state).toBe("ready");
    expect(moved.history).toHaveLength(2);
    expect(moved.history[0]).toEqual(ticket().history[0]);
    expect(moved.history[1]).toEqual({
      at: "2026-08-28T01:00:00.000Z",
      from: "plan_review",
      to: "ready",
      note: "contract approved",
    });
  });

  it("cannot represent a project or a cycle, which are Phase 2", () => {
    expect(() =>
      TicketSchema.parse({ ...ticket(), project_id: "proj_1" }),
    ).toThrow();
  });

  it("records the admission cost, because E1 cannot be read without it", () => {
    const admitted = ticket();
    expect(admitted.admission.elapsed_ms).toBe(4200);
    expect(admitted.admission.criteria_source).toBe("typed");
  });

  it("reads a ticket admitted before the friction instrument existed", () => {
    // The three original fields are all a stored ticket has; the instrument's
    // fields are null until approval writes them, and null for ever on one
    // approved before they existed.
    const admitted = ticket();
    expect(admitted.admission.human_elapsed_ms).toBeNull();
    expect(admitted.admission.edit_count).toBeNull();
    expect(admitted.admission.drafted_at).toBeNull();
    expect(admitted.admission.level_source).toBeNull();
    expect(admitted.admission.derived_level).toBeNull();
  });

  it("reads a ticket admitted before the contract was counter-sealed, as unsealed", () => {
    // The field is absent from every ticket file written before it existed,
    // and null is what those tickets mean: no second copy of the contract was
    // written for them, so none is required of them and none is compared.
    // Reading such a store must not fail, and must not claim a seal it has not.
    const admitted = ticket();
    expect(admitted.admission.counter_sealed_at).toBeNull();
    const sealed = ticket({
      admission: { ...ticket().admission, counter_sealed_at: "2026-08-28T00:00:00.000Z" },
    });
    expect(sealed.admission.counter_sealed_at).toBe("2026-08-28T00:00:00.000Z");
    expect(() =>
      TicketSchema.parse({
        ...sealed,
        admission: { ...sealed.admission, counter_sealed_at: "yesterday" },
      }),
    ).toThrow();
  });

  it("records a drafted admission, its human time and what the person changed", () => {
    const drafted = ticket({
      admission: {
        ...ticket().admission,
        elapsed_ms: 9000,
        criteria_source: "drafted",
        criteria_count: 3,
        drafted_at: "2026-08-28T00:00:00.000Z",
        human_elapsed_ms: 61_000,
        edit_count: 2,
        level_source: "raised",
        derived_level: "P1",
      },
    });
    expect(drafted.admission.criteria_source).toBe("drafted");
    expect(drafted.admission.human_elapsed_ms).toBe(61_000);
    expect(drafted.admission.edit_count).toBe(2);
    expect(() =>
      TicketSchema.parse({
        ...drafted,
        admission: { ...drafted.admission, level_source: "lowered" },
      }),
    ).toThrow();
  });

  it("counts a ticket as active until it is merged, done or cancelled", () => {
    expect(isActive(ticket())).toBe(true);
    expect(isActive(ticket({ state: "pr_open" }))).toBe(true);
    expect(isActive(ticket({ state: "merged" }))).toBe(false);
    expect(isActive(ticket({ state: "cancelled" }))).toBe(false);
  });

  it("keeps the human key and the opaque id apart", () => {
    expect(() => TicketSchema.parse({ ...ticket(), key: "perbo-1" })).toThrow();
    expect(() => TicketSchema.parse({ ...ticket(), ticket_id: "AYO-1" })).toThrow();
  });
});

describe("SCP-157: a failed ticket can be handed off to pr_open", () => {
  it("admits the row structurally, between two states Stage 3 can reach", () => {
    expect(TICKET_TRANSITIONS).toContainEqual({ from: "failed", to: "pr_open" });
  });

  it("moves a failed ticket to pr_open when a pull request is the evidence", () => {
    const at = new Date("2026-08-29T00:00:00.000Z");
    const handed = handOff(
      ticket({ state: "failed" }),
      { pull_request_url: "https://github.com/o/r/pull/9" },
      "a person opened https://github.com/o/r/pull/9 on the ticket's branch",
      at,
    );
    expect(handed.state).toBe("pr_open");
    expect(handed.history.at(-1)).toEqual({
      at: at.toISOString(),
      from: "failed",
      to: "pr_open",
      note: "a person opened https://github.com/o/r/pull/9 on the ticket's branch",
      handed_off: true,
    });
  });

  it("is rejected without pull-request evidence, naming what is missing", () => {
    const failed = ticket({ state: "failed" });
    expect(() => handOff(failed, { pull_request_url: null }, "note")).toThrow(HandOffEvidenceError);
    try {
      handOff(failed, { pull_request_url: null }, "note");
    } catch (error) {
      expect((error as Error).message).toContain("no pull request is recorded on its branch");
    }
    // Refusing leaves the ticket exactly as it was — no half-applied transition.
    expect(failed.state).toBe("failed");
  });

  it("refuses a ticket that is not failed, even though pr_open is reachable from independent_review", () => {
    const reviewed = ticket({ state: "independent_review" });
    expect(() =>
      handOff(reviewed, { pull_request_url: "https://github.com/o/r/pull/9" }, "note"),
    ).toThrow(IllegalTransitionError);
  });
});

describe("SCP-173: who opened the pull request on a failed ticket's branch", () => {
  const opened = (
    pull_request_number: number | null,
    opened_by: Ticket["delivery"]["opened_by"] = pull_request_number === null ? null : "loop",
  ): Ticket["delivery"] =>
    delivery({
      branch: "ayo/fixture/x",
      pull_request_url: pull_request_number === null ? null : `https://github.com/o/r/pull/${pull_request_number}`,
      pull_request_number,
      state: pull_request_number === null ? "none" : "open",
      observed_at: "2026-08-29T00:00:00.000Z",
      opened_by,
    });

  it("attributes a pull request the delivery record already names to the loop", () => {
    expect(attributePullRequest(ticket({ delivery: opened(9) }), { pull_request_number: 9 })).toBe("loop");
  });

  it("attributes a number the record has never seen, and an empty record, to a hand-off", () => {
    expect(attributePullRequest(ticket({ delivery: opened(9) }), { pull_request_number: 12 })).toBe("hand_off");
    expect(attributePullRequest(ticket({ delivery: opened(null) }), { pull_request_number: 12 })).toBe("hand_off");
    // `gh` reporting no number is no evidence that the loop opened it either.
    expect(attributePullRequest(ticket({ delivery: opened(9) }), { pull_request_number: null })).toBe("hand_off");
  });

  it("keeps calling a number recorded as somebody else's a hand-off, however it was recorded", () => {
    // The record names 12 — because a sync saw it on the branch — and says whose
    // it was. A number on the record is not by itself the loop's.
    expect(attributePullRequest(ticket({ delivery: opened(12, "hand_off") }), { pull_request_number: 12 })).toBe(
      "hand_off",
    );
    // SCP-176: a record from before `opened_by` existed falls to the ticket's
    // own history, not to a bare default. This fixture's history has no
    // `pr_open` row at all, so there is nothing to attribute it from.
    expect(attributePullRequest(ticket({ delivery: opened(12, null) }), { pull_request_number: 12 })).toBeNull();
  });

  it("writes the loop's own pull request onto the same row, marked as no hand-off", () => {
    const at = new Date("2026-08-29T00:00:00.000Z");
    const resumed = resumeAtPullRequest(
      ticket({ state: "failed", delivery: opened(9) }),
      { pull_request_url: "https://github.com/o/r/pull/9" },
      "the loop opened https://github.com/o/r/pull/9 on an earlier round",
      at,
    );
    expect(resumed.state).toBe("pr_open");
    expect(resumed.history.at(-1)).toEqual({
      at: at.toISOString(),
      from: "failed",
      to: "pr_open",
      note: "the loop opened https://github.com/o/r/pull/9 on an earlier round",
      handed_off: false,
    });
    expect(isHandOff(resumed.history.at(-1)!)).toBe(false);
    expect(pullRequestWasHandedOff(resumed)).toBe(false);
  });

  it("holds the same two guards as a hand-off", () => {
    const failed = ticket({ state: "failed" });
    expect(() => resumeAtPullRequest(failed, { pull_request_url: null }, "note")).toThrow(HandOffEvidenceError);
    expect(() =>
      resumeAtPullRequest(ticket({ state: "pr_open" }), { pull_request_url: "https://github.com/o/r/pull/9" }, "note"),
    ).toThrow(IllegalTransitionError);
  });

  it("reads a hand-off recorded before the flag existed off its note", () => {
    const row = {
      at: "2026-08-29T00:00:00.000Z",
      from: "failed" as const,
      to: "pr_open" as const,
      note: `reconciled after the fact by \`perbo sync\` from \`gh\`: pull/9 exists on b — ${HAND_OFF_NOTE}`,
    };
    expect(row).not.toHaveProperty("handed_off");
    expect(isHandOff(row)).toBe(true);
    expect(pullRequestWasHandedOff(ticket({ history: [...ticket().history, row] }))).toBe(true);
  });

  it("reads the phrase only on a row that could be a hand-off, and never over the flag", () => {
    const quoting = {
      at: "2026-08-30T00:00:00.000Z",
      from: "pr_open" as const,
      to: "merged" as const,
      // A merge row narrating the hand-off that preceded it is still a merge row.
      note: `merged the pull request that was ${HAND_OFF_NOTE}`,
    };
    expect(isHandOff(quoting)).toBe(false);
    // And a row this version wrote says so in the flag, whatever its prose.
    expect(isHandOff({ ...quoting, from: "failed", to: "pr_open", handed_off: false })).toBe(false);
  });

  it("answers for the pull request the ticket is at, not for one handed off before it", () => {
    const at = new Date("2026-08-29T00:00:00.000Z");
    // A ticket handed off once, then re-run: the loop's own pull request is the
    // one on it now, and a hand-off further back was of a different one.
    const handedOffFirst = handOff(
      ticket({ state: "failed", delivery: opened(12, "hand_off") }),
      { pull_request_url: "https://github.com/o/r/pull/12" },
      `pull/12 — ${HAND_OFF_NOTE}`,
      at,
    );
    expect(pullRequestWasHandedOff(handedOffFirst)).toBe(true);

    const rerun = resumeAtPullRequest(
      TicketSchema.parse({
        ...handedOffFirst,
        state: "failed",
        delivery: opened(9),
        history: [
          ...handedOffFirst.history,
          { at: at.toISOString(), from: "pr_open", to: "failed", note: "a later run failed" },
        ],
      }),
      { pull_request_url: "https://github.com/o/r/pull/9" },
      "the loop opened pull/9 on an earlier round",
      at,
    );
    expect(rerun.history.filter((entry) => entry.handed_off === true)).toHaveLength(1);
    expect(pullRequestWasHandedOff(rerun)).toBe(false);
  });

  it("is false for a ticket that has never reached pr_open", () => {
    expect(pullRequestWasHandedOff(ticket({ state: "failed" }))).toBe(false);
  });

  it("is not inferred from the failed -> pr_open edge", () => {
    const resumed = resumeAtPullRequest(
      ticket({ state: "failed", delivery: opened(9) }),
      { pull_request_url: "https://github.com/o/r/pull/9" },
      "the loop opened it",
      new Date("2026-08-29T00:00:00.000Z"),
    );
    expect(resumed.history.at(-1)).toMatchObject({ from: "failed", to: "pr_open" });
    expect(pullRequestWasHandedOff(resumed)).toBe(false);
  });
});

describe("SCP-176: a record with no opened_by is attributed from history, never a bare default", () => {
  const noOpenedBy = (pull_request_number: number): Ticket["delivery"] =>
    delivery({
      branch: "ayo/fixture/x",
      pull_request_url: `https://github.com/o/r/pull/${pull_request_number}`,
      pull_request_number,
      state: "open",
      observed_at: "2026-09-03T00:00:00.000Z",
      opened_by: null,
    });

  const admitted: Ticket["history"] = [
    { at: "2026-09-01T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" },
    { at: "2026-09-01T00:05:00.000Z", from: "plan_review", to: "ready", note: "contract approved" },
    { at: "2026-09-01T00:10:00.000Z", from: "ready", to: "provisioning", note: "run started" },
    { at: "2026-09-01T00:20:00.000Z", from: "provisioning", to: "executing", note: "1 attempt executed" },
    { at: "2026-09-01T00:30:00.000Z", from: "executing", to: "verifying", note: "6 deterministic checks ran" },
  ];

  // Modelled on AYO-3 in the live store: an ordinary loop round, published at
  // `independent_review`. Written before `handed_off` existed, so this row
  // has no flag at all — only `independent_review` says it was the loop's.
  const loopOpenedHistory: Ticket["history"] = [
    ...admitted,
    { at: "2026-09-01T00:31:00.000Z", from: "verifying", to: "independent_review", note: "reviewed independently" },
    { at: "2026-09-01T00:32:00.000Z", from: "independent_review", to: "pr_open", note: "opened pull/9" },
  ];

  // Modelled on AYO-6/AYO-13/AYO-14: a failed ticket a person finished by
  // hand, reconciled after the fact — written before `handed_off` existed, so
  // the row says so only in its note.
  const handOffHistory: Ticket["history"] = [
    ...admitted,
    { at: "2026-09-01T00:31:00.000Z", from: "verifying", to: "failed", note: "the attempt did not complete: terminated" },
    {
      at: "2026-09-02T00:00:00.000Z",
      from: "failed",
      to: "pr_open",
      note: `reconciled after the fact by \`perbo sync\` from \`gh\`: pull/9 exists on ayo/fixture/x — ${HAND_OFF_NOTE}`,
    },
  ];

  // A `failed -> pr_open` row this version wrote, marked explicitly as the
  // loop's own pull request surviving a re-run — `resumeAtPullRequest`'s shape.
  const resumedHistory: Ticket["history"] = [
    ...handOffHistory.slice(0, -1),
    {
      at: "2026-09-02T00:00:00.000Z",
      from: "failed",
      to: "pr_open",
      note: "the loop opened pull/9 on an earlier round",
      handed_off: false,
    },
  ];

  // A `failed -> pr_open` row with neither a flag nor a matching note — the
  // one case nothing here has the means to attribute.
  const unattributedHistory: Ticket["history"] = [
    ...handOffHistory.slice(0, -1),
    {
      at: "2026-09-02T00:00:00.000Z",
      from: "failed",
      to: "pr_open",
      note: "reconciled after the fact by `perbo sync` from `gh`: pull/9 exists on ayo/fixture/x",
    },
  ];

  it("attributes to the loop from a pr_open row the loop's own path reached, modelled on AYO-3", () => {
    const loopTicket = ticket({ delivery: noOpenedBy(9), history: loopOpenedHistory });
    expect(attributePullRequest(loopTicket, { pull_request_number: 9 })).toBe("loop");
    expect(pullRequestAttribution(loopTicket)).toBe("loop");
  });

  it("attributes to a hand-off from a pr_open row only the note records, modelled on AYO-6, AYO-13 and AYO-14", () => {
    const handedOffTicket = ticket({ state: "failed", delivery: noOpenedBy(9), history: handOffHistory });
    expect(attributePullRequest(handedOffTicket, { pull_request_number: 9 })).toBe("hand_off");
    expect(pullRequestAttribution(handedOffTicket)).toBe("hand_off");
  });

  it("attributes to the loop from a failed -> pr_open row explicitly marked no hand-off", () => {
    const resumedTicket = ticket({ state: "failed", delivery: noOpenedBy(9), history: resumedHistory });
    expect(attributePullRequest(resumedTicket, { pull_request_number: 9 })).toBe("loop");
    expect(pullRequestAttribution(resumedTicket)).toBe("loop");
  });

  it("attributes nothing where the row itself carries no evidence either way", () => {
    const unattributedTicket = ticket({ state: "failed", delivery: noOpenedBy(9), history: unattributedHistory });
    expect(attributePullRequest(unattributedTicket, { pull_request_number: 9 })).toBeNull();
    expect(pullRequestAttribution(unattributedTicket)).toBeNull();
  });

  it("attributes nothing where the delivery record has a number but history never reached pr_open", () => {
    expect(attributePullRequest(ticket({ delivery: noOpenedBy(9) }), { pull_request_number: 9 })).toBeNull();
  });

  it("decides attributionOnRecord the same way, so a legacy record learns its answer from history too", () => {
    const handedOffTicket = ticket({ state: "failed", delivery: noOpenedBy(9), history: handOffHistory });
    expect(attributionOnRecord(handedOffTicket, { pull_request_number: 9 }, { midRun: false })).toBe("hand_off");

    const loopTicket = ticket({ delivery: noOpenedBy(9), history: loopOpenedHistory });
    expect(attributionOnRecord(loopTicket, { pull_request_number: 9 }, { midRun: false })).toBe("loop");

    const unattributedTicket = ticket({ state: "failed", delivery: noOpenedBy(9), history: unattributedHistory });
    expect(attributionOnRecord(unattributedTicket, { pull_request_number: 9 }, { midRun: false })).toBeNull();
  });
});

describe("SCP-176: sync walks a failed ticket to pr_open without choosing an opener it cannot name", () => {
  it("moves the ticket and writes no handed_off flag on the row", () => {
    const at = new Date("2026-09-02T00:00:00.000Z");
    const failed = ticket({
      state: "failed",
      delivery: delivery({
        branch: "ayo/fixture/x",
        pull_request_url: "https://github.com/o/r/pull/9",
        pull_request_number: 9,
        state: "open",
        observed_at: "2026-09-01T00:00:00.000Z",
        opened_by: null,
      }),
    });
    const resumed = resumeWithUnrecordedOpener(
      failed,
      { pull_request_url: "https://github.com/o/r/pull/9" },
      `reconciled after the fact by \`perbo sync\`: pull/9 exists — ${OPENER_UNKNOWN_NOTE}`,
      at,
    );
    expect(resumed.state).toBe("pr_open");
    const row = resumed.history.at(-1)!;
    expect(row).not.toHaveProperty("handed_off");
    expect(row.note).toContain(OPENER_UNKNOWN_NOTE);
    expect(isHandOff(row)).toBe(false);
    expect(pullRequestWasHandedOff(resumed)).toBe(false);
    expect(pullRequestAttribution(resumed)).toBeNull();
  });

  it("holds the same two guards as a hand-off", () => {
    const failed = ticket({ state: "failed" });
    expect(() => resumeWithUnrecordedOpener(failed, { pull_request_url: null }, "note")).toThrow(
      HandOffEvidenceError,
    );
    expect(() =>
      resumeWithUnrecordedOpener(
        ticket({ state: "pr_open" }),
        { pull_request_url: "https://github.com/o/r/pull/9" },
        "note",
      ),
    ).toThrow(IllegalTransitionError);
  });
});

describe("SCP-173: what the delivery record is allowed to claim about who opened it", () => {
  const settled = { midRun: false };
  const recorded = (pull_request_number: number | null, opened_by: Ticket["delivery"]["opened_by"]): Ticket =>
    ticket({
      state: "failed",
      delivery: delivery({
        branch: "ayo/fixture/x",
        pull_request_url: pull_request_number === null ? null : `https://github.com/o/r/pull/${pull_request_number}`,
        pull_request_number,
        state: pull_request_number === null ? "none" : "open",
        observed_at: "2026-08-29T00:00:00.000Z",
        opened_by,
      }),
    });

  it("keeps the attribution already on the record for the number already on it", () => {
    expect(attributionOnRecord(recorded(9, "loop"), { pull_request_number: 9 }, settled)).toBe("loop");
    expect(attributionOnRecord(recorded(9, "hand_off"), { pull_request_number: 9 }, settled)).toBe("hand_off");
    expect(attributionOnRecord(recorded(9, null), { pull_request_number: 9 }, settled)).toBeNull();
    // Including for the ticket whose own run might still have opened it: the
    // record is not asked again about a number it has already answered for.
    expect(attributionOnRecord(recorded(9, "loop"), { pull_request_number: 9 }, { midRun: true })).toBe("loop");
  });

  it("calls a number the record has never held somebody else's", () => {
    // Every pull request a run opens is recorded by that run, so a new number
    // arriving from `gh` on a ticket no run is inside was opened by nobody here.
    expect(attributionOnRecord(recorded(9, "loop"), { pull_request_number: 12 }, settled)).toBe("hand_off");
    expect(attributionOnRecord(recorded(null, null), { pull_request_number: 12 }, settled)).toBe("hand_off");
  });

  it("claims nothing where nothing decided it", () => {
    // A stranded ticket's branch may carry a pull request its dead run opened
    // or one a person did; the record says neither.
    expect(attributionOnRecord(recorded(null, null), { pull_request_number: 12 }, { midRun: true })).toBeNull();
    // And `gh` giving no number identifies nothing to attribute.
    expect(attributionOnRecord(recorded(9, "loop"), { pull_request_number: null }, settled)).toBeNull();
  });
});

/**
 * SCP-206: the one transition that reads the record's arm.
 *
 * The registered comparison arm reaches a pull request with no independent
 * review of its own — that absence is the property under measurement — so its
 * record has to be able to reach `pr_open` without one. The row is guarded on
 * the record's own `delivery.arm` rather than on the evidence, so the
 * reconciler's refusal for a loop ticket whose evidence disagrees with itself
 * stands exactly where it stood.
 */
describe("executing to pr_open is the direct arm's row and nobody else's", () => {
  const at = new Date("2026-09-04T10:00:00.000Z");
  const executing = (arm: "loop" | "direct"): Ticket =>
    ticket({
      state: "executing",
      delivery: delivery({
        branch: arm === "direct" ? "direct/perbo-1/activation" : "ayo/AYO-1/activation",
        pull_request_url: "https://github.com/o/r/pull/1",
        pull_request_number: 1,
        state: "open",
        observed_at: "2026-09-04T09:00:00.000Z",
        opened_by: arm === "direct" ? "direct" : "loop",
        arm,
      }),
    });

  it("moves a direct-arm record, whose arm has no review to pass through", () => {
    const moved = transition(executing("direct"), "pr_open", "the agent opened it", at);
    expect(moved.state).toBe("pr_open");
    expect(moved.history.at(-1)?.to).toBe("pr_open");
  });

  it("refuses a loop record on the same states, so the reconciler's refusal stands", () => {
    expect(() => transition(executing("loop"), "pr_open", "no", at)).toThrow(IllegalTransitionError);
  });

  it("does not offer the guarded route in the refusal it prints", () => {
    // A message that listed `pr_open` would send a person to a route their
    // ticket cannot take.
    try {
      transition(executing("loop"), "pr_open", "no", at);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as Error).message).not.toContain("may go to: verifying, failed, pr_open");
    }
  });
});

/**
 * D-083: a pull request closed without merging is a terminal answer for the
 * record and a re-runnable one for the work.
 *
 * `closed` sits beside `merged` as the other thing a pull request can become,
 * and both rows out of `pr_open` that reach it are guarded on the record
 * itself: a ticket whose delivery still reports the pull request open has no
 * route to either, because what they record is a pull request that closed.
 * Where the closed pull request carries a D-073 CHANGES REQUESTED verdict the
 * ticket goes to `changes_requested` instead — the verdict is the fact about
 * the review, and mergeability a fact about a branch a closed pull request no
 * longer has.
 */
describe("SCP-252: a pull request closed without merging leaves pr_open", () => {
  const at = new Date("2026-09-06T10:00:00.000Z");
  const published = (pullRequest: "open" | "closed"): Ticket =>
    ticket({
      state: "pr_open",
      delivery: delivery({
        branch: "ayo/AYO-1/activation",
        pull_request_url: "https://github.com/o/r/pull/1",
        pull_request_number: 1,
        state: pullRequest,
        observed_at: "2026-09-06T09:00:00.000Z",
        opened_by: "loop",
      }),
    });

  it("names closed a state, and one Stage 3 reaches", () => {
    expect(TICKET_STATES).toContain("closed");
    expect(TICKET_STATES_REACHABLE).toContain("closed");
  });

  it("admits both rows out of pr_open the closed pull request needs", () => {
    const out = TICKET_TRANSITIONS.filter((row) => row.from === "pr_open").map((row) => row.to);
    expect(out).toContain("closed");
    expect(out).toContain("changes_requested");
  });

  it("walks a pr_open ticket whose record says the pull request closed", () => {
    const moved = transition(published("closed"), "closed", "#1 closed without merging", at);
    expect(moved.state).toBe("closed");
    expect(moved.history.at(-1)).toEqual({
      at: at.toISOString(),
      from: "pr_open",
      to: "closed",
      note: "#1 closed without merging",
    });
  });

  it("walks it to changes_requested instead, on the same record", () => {
    const moved = transition(published("closed"), "changes_requested", "a verdict closed it", at);
    expect(moved.state).toBe("changes_requested");
  });

  it("refuses both rows while the record still says the pull request is open", () => {
    expect(() => transition(published("open"), "closed", "no", at)).toThrow(IllegalTransitionError);
    expect(() => transition(published("open"), "changes_requested", "no", at)).toThrow(
      IllegalTransitionError,
    );
  });

  it("offers neither guarded route in the refusal it prints", () => {
    try {
      transition(published("open"), "closed", "no", at);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as Error).message).toContain("may go to: merged");
      expect((error as Error).message).not.toContain("changes_requested");
    }
  });

  it("leaves closed re-runnable, and nothing else", () => {
    const closed = transition(published("closed"), "closed", "#1 closed without merging", at);
    expect(transition(closed, "ready", "a new attempt", at).state).toBe("ready");
    expect(TICKET_TRANSITIONS.filter((row) => row.from === "closed").map((row) => row.to)).toEqual([
      "ready",
    ]);
  });

  it("counts a closed ticket as still moving, the way a failed one is", () => {
    expect(isActive(ticket({ state: "closed" }))).toBe(true);
  });
});

describe("a delivery a person's decisions took (D-NEW-a-person-s-answer-closes-a-routed-finding)", () => {
  it("moves provisioning to pr_open on the note that run writes, and on no other", () => {
    const provisioning = ticket({ state: "provisioning" });
    const moved = transition(provisioning, "pr_open", `${DECIDED_DELIVERY_NOTE} (111111111111)`);
    expect(moved.state).toBe("pr_open");
    expect(moved.history.at(-1)).toMatchObject({ from: "provisioning", to: "pr_open" });
    expect(() => transition(provisioning, "pr_open", "a pull request is open")).toThrow(IllegalTransitionError);
    // The row is from provisioning only: nothing else reaches pr_open on that note.
    expect(() => transition(ticket({ state: "executing" }), "pr_open", DECIDED_DELIVERY_NOTE)).toThrow(
      IllegalTransitionError,
    );
  });
});
