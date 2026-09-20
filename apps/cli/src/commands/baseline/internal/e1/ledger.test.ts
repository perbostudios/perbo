import { describe, expect, it } from "vitest";
import {
  E1PoolingError,
  E1StateError,
  E1_BASELINE_SIZE,
  E1_DEFAULT_THRESHOLDS,
  EMPTY_E1_LEDGER,
  E1LedgerSchema,
  agreeE1Thresholds,
  e1BaselineTicket,
  e1Cohort,
  e1RatioRead,
  e1Report,
  e1Result,
  e1SealIntact,
  e1Subject,
  openE1Subject,
  recordE1BaselineTicket,
  recordE1ProductRun,
  recordE1Routing,
  sealE1Baseline,
  type E1Ledger,
  type E1ProductRun,
  type E1Thresholds,
} from "./ledger.js";

/**
 * The E1 ledger (D-038, SCP-080).
 *
 * Every test here is one of the four things that make the number honest: ten
 * readings and no fewer, a seal that predates the first product run and cannot
 * be walked back, a ratio computed over those ten identifiers and nothing else,
 * and an arm that is never pooled with a partner's. The confounders are
 * asserted by the one question that matters about them — whether they can move
 * the ratio — rather than by reading their field names back.
 */

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const AGREED = new Date(Date.parse("2026-08-25T00:00:00.000Z"));

const thresholds = (overrides: Partial<E1Thresholds> = {}): E1Thresholds => ({
  agreed_at: AGREED.toISOString(),
  agreed_with: "Rae Okonkwo, engineering lead at Acme",
  record: "https://example.invalid/agreements/acme-e1.pdf",
  ...E1_DEFAULT_THRESHOLDS,
  ...overrides,
});

const opened = (
  subject_id = "acme",
  arm: "partner" | "agent_direct" = "partner",
  overrides: Partial<E1Thresholds> = {},
): E1Ledger =>
  openE1Subject(EMPTY_E1_LEDGER, {
    subject_id,
    arm,
    thresholds: thresholds(overrides),
    now: at(0),
  });

/** The nth of the ten, timed for `minutes` with `interrupted` minutes of it not work. */
const timed = (index: number, minutes: number, interrupted = 0) =>
  e1BaselineTicket({
    work_item_id: `ACME-${400 + index}`,
    title: `Ticket ${index}`,
    work_started_at: at(index * 1_000),
    pull_request_opened_at: at(index * 1_000 + minutes),
    interruption_ms: interrupted * 60_000,
    recorded_at: at(index * 1_000 + minutes),
  });

/** A ledger whose subject has all ten readings, each an hour with none paused. */
function tenTimed(ledger: E1Ledger, subject_id = "acme", minutes = 60): E1Ledger {
  let next = ledger;
  for (let index = 0; index < E1_BASELINE_SIZE; index += 1) {
    next = recordE1BaselineTicket(next, subject_id, timed(index, minutes));
  }
  return next;
}

const run = (
  index: number,
  minutes: number,
  overrides: Partial<E1ProductRun> = {},
): E1ProductRun => {
  const started = at(100_000 + index * 1_000);
  const base = {
    work_item_id: `ACME-${400 + index}`,
    work_started_at: started.toISOString(),
    pull_request_opened_at: new Date(started.getTime() + minutes * 60_000).toISOString(),
    interruption_ms: 0,
    wall_clock_ms: minutes * 60_000,
    elapsed_ms: minutes * 60_000,
    admission_friction_ms: 0,
    abandoned_mid_flow: false,
    abandonment_reason: null,
    defects_caught: [],
    recorded_at: started.toISOString(),
  } satisfies E1ProductRun;
  return { ...base, ...overrides };
};

describe("a baseline is ten readings, each with the interruptions taken out", () => {
  it("subtracts self-reported interruptions from the recorded wall clock and keeps all three", () => {
    const ticket = timed(0, 90, 20);
    expect(ticket.wall_clock_ms).toBe(90 * 60_000);
    expect(ticket.interruption_ms).toBe(20 * 60_000);
    expect(ticket.elapsed_ms).toBe(70 * 60_000);
  });

  it("refuses a reading whose pull request is not after the work, or whose pauses do not fit", () => {
    expect(() =>
      e1BaselineTicket({
        work_item_id: "ACME-400",
        title: "Backwards",
        work_started_at: at(60),
        pull_request_opened_at: at(10),
        interruption_ms: 0,
        recorded_at: at(60),
      }),
    ).toThrow(/opened at or before work started/);
    expect(() => timed(0, 30, 45)).toThrow(/do not fit in a 1800000ms wall clock/);
  });

  it("is complete at exactly ten, and takes neither a ninth-and-a-half nor an eleventh", () => {
    const nine = tenTimed(opened(), "acme").subjects[0]!.tickets.slice(0, 9);
    let ledger = opened();
    for (const ticket of nine) ledger = recordE1BaselineTicket(ledger, "acme", ticket);
    expect(() => sealE1Baseline(ledger, "acme", at(2_000))).toThrow(
      /holds 9 of 10 tickets; a baseline is complete at ten/,
    );

    const ten = tenTimed(opened(), "acme");
    expect(() => recordE1BaselineTicket(ten, "acme", timed(99, 30))).toThrow(
      /already holds its 10 tickets/,
    );
    // And the same work item is not timed twice into the ten.
    expect(() => recordE1BaselineTicket(ledger, "acme", nine[0]!)).toThrow(/is already timed/);
  });

  it("refuses a reading that started before the thresholds were agreed", () => {
    const ledger = openE1Subject(EMPTY_E1_LEDGER, {
      subject_id: "acme",
      arm: "partner",
      thresholds: thresholds({ agreed_at: at(1_500).toISOString() }),
      now: at(2_000),
    });
    // `timed(0, …)` starts at at(0), which is before the agreement above.
    expect(() => recordE1BaselineTicket(ledger, "acme", timed(0, 60))).toThrow(
      /before the thresholds acme agreed at 2026-09-02T10:00:00.000Z/,
    );
  });

  it("lets thresholds be re-agreed before the first reading and never after it", () => {
    const before = agreeE1Thresholds(opened(), "acme", thresholds({ ratio_by_ticket_10: 0.9 }));
    expect(e1Subject(before, "acme")!.thresholds.ratio_by_ticket_10).toBe(0.9);
    const measured = recordE1BaselineTicket(before, "acme", timed(0, 60));
    expect(() => agreeE1Thresholds(measured, "acme", thresholds({ ratio_by_ticket_10: 3 }))).toThrow(
      /has 1 ticket\(s\) timed against the thresholds/,
    );
  });
});

describe("the seal", () => {
  it("refuses a product run until the baseline is sealed", () => {
    const ledger = tenTimed(opened(), "acme");
    expect(() => recordE1ProductRun(ledger, "acme", run(0, 30))).toThrow(
      /is not sealed \(10 of 10 tickets\), and a product run recorded before it is sealed/,
    );
    const sealed = sealE1Baseline(ledger, "acme", at(2_000));
    expect(recordE1ProductRun(sealed, "acme", run(0, 30)).subjects[0]!.runs).toHaveLength(1);
  });

  it("cannot be added to, edited or sealed again once it is sealed", () => {
    const sealed = sealE1Baseline(tenTimed(opened(), "acme"), "acme", at(2_000));
    expect(() => recordE1BaselineTicket(sealed, "acme", timed(99, 20))).toThrow(
      /sealed at 2026-09-02T18:20:00.000Z and cannot take another ticket/,
    );
    expect(() => sealE1Baseline(sealed, "acme", at(3_000))).toThrow(/cannot be sealed again/);
    expect(() => agreeE1Thresholds(sealed, "acme", thresholds())).toThrow(
      /cannot have its thresholds re-agreed/,
    );
  });

  it("says so when the sealed readings are edited underneath it, and the result is not evidence", () => {
    const sealed = sealE1Baseline(tenTimed(opened(), "acme"), "acme", at(2_000));
    expect(e1SealIntact(sealed.subjects[0]!)).toBe(true);

    // Exactly the reconstruction the seal exists to catch: a reading made
    // longer after the fact, which flatters every ratio computed from it.
    const subject = sealed.subjects[0]!;
    const edited = {
      ...sealed,
      subjects: [
        {
          ...subject,
          tickets: subject.tickets.map((ticket, index) =>
            index === 0 ? { ...ticket, elapsed_ms: ticket.elapsed_ms * 4 } : ticket,
          ),
        },
      ],
    };
    expect(e1SealIntact(edited.subjects[0]!)).toBe(false);
    expect(e1Result(edited.subjects[0]!).verdict).toBe("void");
    expect(e1Result(edited.subjects[0]!).reasons[0]).toMatch(/no longer match the digest/);

    // And the harsher edit: a reading taken away entirely. The sealed id has
    // nothing behind it, which is reported rather than thrown at the reader.
    const removed = { ...subject, tickets: subject.tickets.slice(1) };
    expect(e1RatioRead(removed).missing_work_item_ids).toContain(subject.tickets[0]!.work_item_id);
    expect(e1Result(removed).verdict).toBe("void");
  });
});

describe("the ratio, and everything kept out of it", () => {
  /** Ten one-hour baseline readings, sealed, with the product runs given per ticket. */
  function measured(minutesPerRun: readonly number[], overrides: Partial<E1ProductRun>[] = []) {
    let ledger = sealE1Baseline(tenTimed(opened(), "acme"), "acme", at(2_000));
    minutesPerRun.forEach((minutes, index) => {
      ledger = recordE1ProductRun(ledger, "acme", run(index, minutes, overrides[index] ?? {}));
    });
    return ledger;
  }

  it("compares the same ten identifiers, and reports which of them have not run yet", () => {
    const ledger = measured([30, 30, 30]);
    const read = e1RatioRead(e1Subject(ledger, "acme")!);
    expect(read.matched).toBe(3);
    expect(read.missing_work_item_ids).toHaveLength(7);
    expect(read.ratio).toBe(0.5);
    expect(e1Result(e1Subject(ledger, "acme")!).verdict).toBe("incomplete");
  });

  it("excludes a product run for work that is not one of the ten, however long it took", () => {
    let ledger = measured(Array.from({ length: 10 }, () => 30));
    const clean = e1RatioRead(e1Subject(ledger, "acme")!);
    expect(clean.ratio).toBe(0.5);

    ledger = recordE1ProductRun(
      ledger,
      "acme",
      run(0, 600, { work_item_id: "ACME-999" }),
    );
    const withStranger = e1RatioRead(e1Subject(ledger, "acme")!);
    expect(withStranger.ratio).toBe(0.5);
    expect(withStranger.matched).toBe(10);
    expect(withStranger.excluded_work_item_ids).toEqual(["ACME-999"]);
  });

  it("does not let admission friction, abandonment or defects move the number", () => {
    const plain = measured(Array.from({ length: 10 }, () => 30));
    const confounded = measured(Array.from({ length: 10 }, () => 30), [
      {
        admission_friction_ms: 45 * 60_000,
        defects_caught: [
          {
            work_item_id: "ACME-400",
            summary: "the reset token was still valid after use",
            evidence: "https://example.invalid/pull/12#discussion_r1",
            recorded_at: at(200_000).toISOString(),
          },
        ],
      },
      { abandonment_reason: "the partner reworked the plan and carried on" },
    ]);
    expect(e1RatioRead(e1Subject(confounded, "acme")!).ratio).toBe(
      e1RatioRead(e1Subject(plain, "acme")!).ratio,
    );

    const result = e1Result(e1Subject(confounded, "acme")!);
    expect(result.confounders.admission_friction_total_ms).toBe(45 * 60_000);
    expect(result.confounders.defects_caught).toHaveLength(1);
    expect(result.confounders.abandonment_reasons).toEqual([
      { work_item_id: "ACME-401", reason: "the partner reworked the plan and carried on" },
    ]);
    // The friction is a field of the result and no part of any elapsed time.
    expect(result.ratio.pairs[0]!.product_elapsed_ms).toBe(30 * 60_000);
  });

  it("takes a mid-flow abandonment out of the medians and counts it as abandonment", () => {
    const ledger = measured(Array.from({ length: 10 }, () => 30), [
      {},
      {
        pull_request_opened_at: null,
        wall_clock_ms: null,
        elapsed_ms: null,
        abandoned_mid_flow: true,
        abandonment_reason: "gave up on the loop and finished it by hand",
      },
    ]);
    const result = e1Result(e1Subject(ledger, "acme")!);
    expect(result.ratio.matched).toBe(9);
    expect(result.ratio.abandoned).toBe(1);
    expect(result.ratio.ratio).toBe(0.5);
    expect(result.confounders.mid_flow_abandonment_rate).toBeCloseTo(0.1, 10);
  });

  it("reads the learning curve over the first five pull requests the product opened", () => {
    // The first five runs are slow and the last five are quick: the overall
    // ratio passes at 1.0× while the early one has to be read against 1.25×.
    const ledger = measured([70, 70, 70, 70, 70, 20, 20, 20, 20, 20]);
    const read = e1RatioRead(e1Subject(ledger, "acme")!);
    expect(read.through_ticket_5).toEqual({ matched: 5, ratio: 70 / 60 });
    expect(read.ratio).toBe(0.75);
  });

  it("passes only when every agreed threshold is met, and names the ones that are not", () => {
    let ledger = measured(Array.from({ length: 10 }, () => 30), [
      {
        defects_caught: [
          {
            work_item_id: "ACME-400",
            summary: "an unbounded query the direct path would have merged",
            evidence: null,
            recorded_at: at(200_000).toISOString(),
          },
        ],
      },
    ]);
    // Routing is unmeasured, which is not the same as failed.
    let result = e1Result(e1Subject(ledger, "acme")!);
    expect(result.verdict).toBe("incomplete");
    expect(result.reasons).toContain("voluntary routing has not been observed");

    ledger = recordE1Routing(ledger, "acme", {
      period: "weeks 3-4",
      eligible: 20,
      routed_voluntarily: 13,
      routed_on_request: 2,
      observed_at: at(300_000).toISOString(),
    });
    result = e1Result(e1Subject(ledger, "acme")!);
    expect(result.verdict).toBe("pass");
    expect(result.confounders.voluntary_routing_rate).toBe(0.65);

    const slow = e1Result(
      e1Subject(
        recordE1Routing(measured(Array.from({ length: 10 }, () => 90)), "acme", {
          period: "weeks 3-4",
          eligible: 20,
          routed_voluntarily: 4,
          routed_on_request: 0,
          observed_at: at(300_000).toISOString(),
        }),
        "acme",
      )!,
    );
    expect(slow.verdict).toBe("fail");
    expect(slow.reasons.join("\n")).toMatch(/the ratio is 1.50×, over the agreed 1×/);
    expect(slow.reasons.join("\n")).toMatch(/voluntary routing is 20%, under the agreed 50%/);
    expect(slow.reasons.join("\n")).toMatch(/0 defect\(s\) recorded/);
  });
});

describe("the stand-in's arm", () => {
  it("is reported as its own result and never pooled with a partner's", () => {
    let ledger = opened("acme", "partner");
    ledger = openE1Subject(ledger, {
      subject_id: "stand-in",
      arm: "agent_direct",
      thresholds: thresholds(),
      now: at(0),
    });
    ledger = sealE1Baseline(tenTimed(ledger, "stand-in"), "stand-in", at(2_000));

    const report = e1Report(ledger);
    expect(report.partners.map((result) => result.subject_id)).toEqual(["acme"]);
    expect(report.agent_direct.map((result) => result.subject_id)).toEqual(["stand-in"]);
    expect(report.agent_direct[0]!.counts_toward_e1).toBe(false);

    expect(() => e1Cohort([...report.partners, ...report.agent_direct])).toThrow(E1PoolingError);
    expect(() => e1Cohort(report.agent_direct)).toThrow(/is an agent-direct baseline/);
    expect(e1Cohort(report.partners)).toEqual({
      partners: 1,
      passing: 0,
      routing_at_threshold: 0,
    });
  });
});

describe("the ledger on disk", () => {
  it("round-trips through its schema and refuses a hand-edited reading that does not add up", () => {
    const ledger = sealE1Baseline(tenTimed(opened(), "acme"), "acme", at(2_000));
    expect(E1LedgerSchema.parse(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);

    const raw = JSON.parse(JSON.stringify(ledger)) as {
      subjects: [{ tickets: [{ elapsed_ms: number }] }];
    };
    raw.subjects[0].tickets[0].elapsed_ms = 60;
    const parsed = E1LedgerSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.message).toMatch(/not the wall clock with the interruptions/);
  });

  it("names the subject it does not have rather than inventing one", () => {
    expect(() => recordE1BaselineTicket(opened(), "beta", timed(0, 30))).toThrow(E1StateError);
    expect(() => recordE1BaselineTicket(opened(), "beta", timed(0, 30))).toThrow(
      /no baseline is open for beta; this ledger holds acme/,
    );
    expect(() => openE1Subject(opened(), { subject_id: "acme", arm: "partner", thresholds: thresholds(), now: at(0) })).toThrow(
      /already has a baseline/,
    );
    expect(() =>
      openE1Subject(EMPTY_E1_LEDGER, {
        subject_id: "acme",
        arm: "partner",
        thresholds: thresholds({ agreed_at: at(5_000).toISOString() }),
        now: at(0),
      }),
    ).toThrow(/which is in the future/);
  });
});
