import { describe, expect, it } from "vitest";
import {
  D060_BAR,
  STOP_VERDICTS_SCHEMA_VERSION,
  StopVerdictsSchema,
  isDogfoodStop,
  judgeAgainstD060,
  reconcileStopVerdicts,
  smallestResolvingSample,
  summariseStops,
  widenedByHiding,
  type StopAnswer,
  type StopVerdict,
  type StopVerdicts,
} from "../src/stops.js";
import { wilsonInterval } from "../src/wilson.js";

/**
 * D-060, measured live: what one `perbo sync` writes per ticket, and what
 * `perbo stops` computes over those files. The semantics under test mirror
 * `precisionOfStopping` in packages/evaluation/src/stopping.ts — a change is
 * endorsed when any of its stops is — so the live number and the corpus number
 * answer the same question.
 */

const key = (c: string) => c.repeat(64);
const AT = "2026-09-02T10:00:00.000Z";
const LATER = "2026-09-03T10:00:00.000Z";

const file = (over: Partial<StopVerdicts> & { ticket_key: string }): StopVerdicts =>
  StopVerdictsSchema.parse({
    schema_version: STOP_VERDICTS_SCHEMA_VERSION,
    ticket_id: `ticket_${over.ticket_key.toLowerCase().replace("-", "")}`,
    pull_request_url: `https://github.com/o/r/pull/${over.ticket_key.slice(-1)}`,
    stops: [],
    shown_to_person: false,
    first_seen_at: AT,
    observed_at: AT,
    ...over,
  });

/** A stop as a sync writes it, where the tick carries no signature: a person's. */
const stop = (c: string, answer: StopAnswer | null): StopVerdict => ({
  finding_key: key(c),
  rule_id: `rule.${c}`,
  routing: "blocks",
  answer,
  answered_at: answer === null ? null : AT,
  answered_by: answer === null ? null : "person",
  first_seen_at: AT,
});

describe("reconciling what gh reported with the previous file", () => {
  const ticket = { ticket_id: "ticket_a1", key: "AYO-1" };

  it("stamps answered_at with the observation time the first time an answer appears", () => {
    const verdicts = reconcileStopVerdicts({
      previous: null,
      ticket,
      pull_request_url: "https://github.com/o/r/pull/1",
      observed: [{ finding_key: key("a"), rule_id: "rule.a", routing: "blocks", answer: "endorse" }],
      observed_at: AT,
    });
    expect(verdicts.stops[0]?.answered_at).toBe(AT);
    expect(verdicts.stops[0]?.first_seen_at).toBe(AT);
    expect(verdicts.shown_to_person).toBe(true);
    expect(verdicts.first_seen_at).toBe(AT);
  });

  it("keeps answered_at and first_seen_at across a re-sync where the answer did not change", () => {
    const previous = file({
      ticket_key: "AYO-1",
      stops: [stop("a", "endorse"), stop("b", null)],
      shown_to_person: true,
    });
    const verdicts = reconcileStopVerdicts({
      previous,
      ticket,
      pull_request_url: "https://github.com/o/r/pull/1",
      observed: [
        { finding_key: key("a"), rule_id: "rule.a", routing: "blocks", answer: "endorse" },
        { finding_key: key("b"), rule_id: "rule.b", routing: "blocks", answer: "override" },
      ],
      observed_at: LATER,
    });
    expect(verdicts.stops[0]?.answered_at).toBe(AT);
    expect(verdicts.stops[0]?.first_seen_at).toBe(AT);
    expect(verdicts.stops[1]?.answered_at).toBe(LATER);
    expect(verdicts.first_seen_at).toBe(AT);
    expect(verdicts.observed_at).toBe(LATER);
  });

  it("re-stamps answered_at when the answer itself changed", () => {
    const previous = file({ ticket_key: "AYO-1", stops: [stop("a", "endorse")], shown_to_person: true });
    const verdicts = reconcileStopVerdicts({
      previous,
      ticket,
      pull_request_url: "https://github.com/o/r/pull/1",
      observed: [{ finding_key: key("a"), rule_id: "rule.a", routing: "blocks", answer: "override" }],
      observed_at: LATER,
    });
    expect(verdicts.stops[0]?.answered_at).toBe(LATER);
  });

  it("clears answered_at when a tick was removed", () => {
    const previous = file({ ticket_key: "AYO-1", stops: [stop("a", "endorse")], shown_to_person: true });
    const verdicts = reconcileStopVerdicts({
      previous,
      ticket,
      pull_request_url: "https://github.com/o/r/pull/1",
      observed: [{ finding_key: key("a"), rule_id: "rule.a", routing: "blocks", answer: null }],
      observed_at: LATER,
    });
    expect(verdicts.stops[0]?.answer).toBeNull();
    expect(verdicts.stops[0]?.answered_at).toBeNull();
  });
});

describe("precision of stopping over stops files, beside its companion", () => {
  // Three changes with a pull request. AYO-1: two stops, one endorsed and one
  // overridden — endorsed, because any endorsed stop endorses the change.
  // AYO-2: one stop, overridden. AYO-3: nothing shown to a person at all.
  const files = [
    file({ ticket_key: "AYO-1", stops: [stop("a", "endorse"), stop("b", "override")], shown_to_person: true }),
    file({ ticket_key: "AYO-2", stops: [stop("c", "override"), stop("d", null), stop("e", "conflict")], shown_to_person: true }),
    file({ ticket_key: "AYO-3" }),
  ];

  it("counts changes, not stops, and endorses a change on any endorsed stop", () => {
    const summary = summariseStops(files);
    expect(summary.changes).toBe(3);
    expect(summary.with_pull_request).toBe(3);
    expect(summary.endorsed).toBe(1);
    expect(summary.overridden).toBe(1);
    expect(summary.precision.n).toBe(2);
    expect(summary.precision.point).toBe(0.5);
    expect(summary.precision.low).toBeCloseTo(0.0945, 3);
    expect(summary.precision.high).toBeCloseTo(0.9055, 3);
  });

  it("reports the companion over the changes that reached a person", () => {
    const summary = summariseStops(files);
    expect(summary.shown).toBe(2);
    expect(summary.companion.n).toBe(3);
    expect(summary.companion.point).toBeCloseTo(2 / 3, 6);
    expect(summary.companion.low).toBeCloseTo(0.2077, 3);
    expect(summary.companion.high).toBeCloseTo(0.9385, 3);
  });

  it("counts unanswered stops and conflicts without letting either into n", () => {
    const summary = summariseStops(files);
    expect(summary.stops).toBe(5);
    expect(summary.unanswered_stops).toBe(1);
    expect(summary.conflicts).toBe(1);
  });

  it("leaves a change whose only answer is a conflict out of the precision population", () => {
    const summary = summariseStops([
      file({ ticket_key: "AYO-4", stops: [stop("f", "conflict")], shown_to_person: true }),
    ]);
    expect(summary.precision.n).toBe(0);
    expect(summary.conflicts).toBe(1);
  });

  it("excludes a change that reached nobody either way from the companion denominator", () => {
    const summary = summariseStops([file({ ticket_key: "AYO-5", pull_request_url: null })]);
    expect(summary.with_pull_request).toBe(0);
    expect(summary.companion.n).toBe(0);
  });

  it("counts a change answered here, with no pull request, in the companion population", () => {
    // Two changes with a pull request, one of them shown; and one the person
    // answered at the command line, which has no pull request and so no box
    // anybody could have ticked. All three reached a person or offered to.
    const summary = summariseStops([
      file({ ticket_key: "AYO-6", stops: [stop("a", "override")], shown_to_person: true }),
      file({ ticket_key: "AYO-7" }),
      file({
        ticket_key: "AYO-8",
        pull_request_url: null,
        stops: [stop("b", "endorse")],
        shown_to_person: true,
      }),
    ]);
    // `with_pull_request` still counts what its name says.
    expect(summary.with_pull_request).toBe(2);
    expect(summary.shown).toBe(2);
    expect(summary.companion.n).toBe(3);
    expect(summary.companion.point).toBeCloseTo(2 / 3, 6);
  });
});

describe("the D-060 reversal trigger", () => {
  const endorsedShown = (k: string, shown: boolean, answer: "endorse" | "override") =>
    file({ ticket_key: k, stops: shown ? [stop("a", answer)] : [], shown_to_person: shown });

  it("fires when precision rose while the share shown to a person fell", () => {
    const before = summariseStops([
      endorsedShown("AYO-1", true, "override"),
      endorsedShown("AYO-2", true, "endorse"),
    ]);
    const since = summariseStops([endorsedShown("AYO-3", true, "endorse"), endorsedShown("AYO-4", false, "endorse")]);
    expect(widenedByHiding(before, since)).toBe(true);
  });

  it("does not fire on a decision taken here, which enters both numbers rather than neither", () => {
    // The window gains one thing: a stop endorsed at the command line on a
    // change with no pull request. Precision rises. The companion has to see
    // that change too, or a decision taken here moves one number of the pair
    // while the other cannot answer — which is the silence D-060 pairs them
    // to break.
    const answeredHere = file({
      ticket_key: "AYO-9",
      pull_request_url: null,
      stops: [stop("b", "endorse")],
      shown_to_person: true,
    });
    const overriddenOnPullRequest = endorsedShown("AYO-1", true, "override");
    const before = summariseStops([overriddenOnPullRequest]);
    const since = summariseStops([overriddenOnPullRequest, answeredHere]);

    expect(since.precision.point).toBeGreaterThan(before.precision.point);
    expect(since.companion.n).toBe(2);
    expect(since.companion.point).not.toBeLessThan(before.companion.point);
    expect(widenedByHiding(before, since)).toBe(false);
  });

  it("stays quiet when both numbers moved the same way, or either window has no value", () => {
    const before = summariseStops([endorsedShown("AYO-1", true, "override")]);
    const since = summariseStops([endorsedShown("AYO-2", true, "endorse")]);
    expect(widenedByHiding(before, since)).toBe(false);
    expect(widenedByHiding(summariseStops([]), since)).toBe(false);
  });
});

describe("the bar D-060 sets, and the population that can resolve it", () => {
  it("puts the smallest resolving population at nine unanimous stops", () => {
    expect(D060_BAR).toBe(0.7);
    expect(smallestResolvingSample()).toBe(9);
    // Which is the arithmetic itself, not a number written down beside it:
    // eight unanimous stops do not reach the bar and nine do.
    expect(wilsonInterval(8, 8).low).toBeLessThan(D060_BAR);
    expect(wilsonInterval(9, 9).low).toBeGreaterThanOrEqual(D060_BAR);
    // And it follows the bar rather than having to be kept in step with it.
    expect(smallestResolvingSample(0.5)).toBe(4);
    expect(() => smallestResolvingSample(1)).toThrow(RangeError);
  });

  it("passes only an interval that sits wholly at or above the bar", () => {
    expect(judgeAgainstD060(wilsonInterval(9, 9)).verdict).toBe("pass");
    expect(judgeAgainstD060(wilsonInterval(14, 15)).verdict).toBe("pass");
  });

  it("fails a resolving population whose interval spans the bar or sits below it", () => {
    const spanning = judgeAgainstD060(wilsonInterval(8, 10));
    expect(spanning.verdict).toBe("fail");
    expect(spanning.spans_bar).toBe(true);
    const below = judgeAgainstD060(wilsonInterval(2, 12));
    expect(below.verdict).toBe("fail");
    expect(below.spans_bar).toBe(false);
  });

  it("resolves neither way below nine stops, whatever the answers were", () => {
    for (let n = 0; n < 9; n += 1) {
      for (let endorsed = 0; endorsed <= n; endorsed += 1) {
        expect(judgeAgainstD060(wilsonInterval(endorsed, n)).verdict).toBe("cannot resolve");
      }
    }
  });
});

describe("a stop the stand-in answered", () => {
  const answered = (c: string, answer: "endorse" | "override", by: "person" | "stand_in") => ({
    ...stop(c, answer),
    answered_by: by,
  });

  it("is dogfood, and an unanswered or a person's stop is not", () => {
    expect(isDogfoodStop(answered("a", "endorse", "stand_in"))).toBe(true);
    expect(isDogfoodStop(answered("a", "endorse", "person"))).toBe(false);
    expect(isDogfoodStop({ answer: null, answered_by: "stand_in" })).toBe(false);
    // A record written before the label existed says nothing about who
    // answered, and nothing is what it is read as.
    expect(isDogfoodStop({ ...stop("a", "endorse"), answered_by: null })).toBe(false);
  });

  it("is read off a signed tick and kept while the answer is unchanged", () => {
    const first = reconcileStopVerdicts({
      previous: null,
      ticket: { ticket_id: "ticket_ayo1", key: "AYO-1" },
      pull_request_url: null,
      observed: [
        { finding_key: key("a"), rule_id: "r.a", routing: "blocks", answer: "endorse", answered_by: "stand_in" },
        { finding_key: key("b"), rule_id: "r.b", routing: "blocks", answer: "endorse" },
        { finding_key: key("c"), rule_id: "r.c", routing: "blocks", answer: null },
      ],
      observed_at: AT,
    });
    expect(first.stops.map((one) => one.answered_by)).toEqual(["stand_in", "person", null]);

    // The same answers, from a body somebody has since edited the signature
    // out of: the answer did not change, so neither does who gave it.
    const again = reconcileStopVerdicts({
      previous: first,
      ticket: { ticket_id: "ticket_ayo1", key: "AYO-1" },
      pull_request_url: null,
      observed: [
        { finding_key: key("a"), rule_id: "r.a", routing: "blocks", answer: "endorse" },
        { finding_key: key("b"), rule_id: "r.b", routing: "blocks", answer: "endorse" },
        { finding_key: key("c"), rule_id: "r.c", routing: "blocks", answer: null },
      ],
      observed_at: LATER,
    });
    expect(again.stops.map((one) => one.answered_by)).toEqual(["stand_in", "person", null]);
  });

  it("leaves the precision population without taking the record's counts with it", () => {
    const summary = summariseStops([
      file({ ticket_key: "AYO-1", shown_to_person: true, stops: [answered("a", "endorse", "person")] }),
      file({ ticket_key: "AYO-2", shown_to_person: true, stops: [answered("b", "endorse", "stand_in")] }),
      file({
        ticket_key: "AYO-3",
        shown_to_person: true,
        // Both answered this one; only the person's answer is read.
        stops: [answered("c", "endorse", "stand_in"), answered("d", "override", "person")],
      }),
      file({ ticket_key: "AYO-4", shown_to_person: true, stops: [stop("e", null)] }),
    ]);
    expect(summary.precision.n).toBe(2);
    expect(summary.endorsed).toBe(1);
    expect(summary.overridden).toBe(1);
    expect(summary.dogfood_stops).toBe(2);
    expect(summary.dogfood_changes).toBe(1);
    // The record's own counts are whole: five stops exist, one unanswered.
    expect(summary.stops).toBe(5);
    expect(summary.unanswered_stops).toBe(1);
    // And the companion counts what a person was shown, which no answer moves.
    expect(summary.companion.n).toBe(4);
    expect(summary.shown).toBe(4);
    // Beside it, the population the exclusion is measured against: the same
    // changes read with the stand-in's answers pooled in, which is what says
    // whether a verdict is the answers' or the exclusion's. All three answered
    // changes are endorsed there — AYO-2 because the stand-in endorsed it, and
    // AYO-3 because its stand-in endorsement outranks the person's override
    // once the two are pooled — against one endorsed of two here.
    expect(summary.pooled_precision).toMatchObject({ n: 3, successes: 3 });
  });

  it("reads the pooled counterfactual as the partner number itself where nothing was excluded", () => {
    const summary = summariseStops([
      file({ ticket_key: "AYO-1", shown_to_person: true, stops: [answered("a", "endorse", "person")] }),
      file({ ticket_key: "AYO-2", shown_to_person: true, stops: [answered("b", "override", "person")] }),
    ]);
    expect(summary.dogfood_stops).toBe(0);
    // Not merely equal in n: the same reading, so a command comparing the two
    // finds nothing to report on a store no stand-in answered anything in.
    expect(summary.pooled_precision).toEqual(summary.precision);
  });
});
