import { z } from "zod";
import { TicketIdSchema } from "./ids.js";
import { TicketKeySchema } from "./ticket.js";
import { wilsonInterval, type WilsonInterval } from "./wilson.js";

/**
 * Stop verdicts: precision of stopping measured live from pull requests
 * ([D-060](../../../docs/11-open-decisions.md), founder decision 2026-09-02).
 *
 * Every stop the pull-request body lists carries two task-list boxes a person
 * ticks in the GitHub UI — *I wanted to be asked before this was fixed* and
 * *the agent should have fixed this on its own* — and `perbo sync` reads the
 * ticks back through `gh`. One of these files exists per ticket, written whole
 * on every sync from what `gh` reported, so the record is idempotent for the
 * same reason the ticket's delivery record is.
 *
 * Labels only: an answer and the times it was seen. The body the answer was
 * read from is never recorded.
 */

/**
 * The person-facing stops. `blocks` and `escalates` are the review's; `declined`
 * is D-065's third — a remediable finding the executor declared no determinable
 * practice for, which stops for a person just as the other two do.
 */
export const STOP_ROUTINGS = ["blocks", "escalates", "declined"] as const;
export const StopRoutingSchema = z.enum(STOP_ROUTINGS);
export type StopRouting = (typeof STOP_ROUTINGS)[number];

/**
 * `endorse` — the person wanted to be asked; `override` — the agent should
 * have fixed it alone; `conflict` — both boxes are ticked, which is a question
 * back to the person rather than an answer. Unanswered is `null`.
 */
export const STOP_ANSWERS = ["endorse", "override", "conflict"] as const;
export const StopAnswerSchema = z.enum(STOP_ANSWERS);
export type StopAnswer = (typeof STOP_ANSWERS)[number];

/**
 * Who answered a stop: a person, or the AI stand-in acting as the founder's
 * partner ([D-058](../../../docs/11-open-decisions.md#d-058--partner-recruitment-is-blocked-on-the-false-block-rate-not-on-time)).
 *
 * The distinction is the whole of D-058's rule that *an AI's endorsement of a
 * stop is not a person wanting to be asked*: a stand-in's answer is a
 * **dogfood** answer, reported as such and never pooled with a partner's. It is
 * a label on the answer rather than on the change, because one pull request can
 * carry both — the stand-in answering one stop and a person the next.
 */
export const STOP_ANSWERERS = ["person", "stand_in"] as const;
export const StopAnswererSchema = z.enum(STOP_ANSWERERS);
export type StopAnswerer = (typeof STOP_ANSWERERS)[number];

/** The answerer whose answers are dogfood, named once so no reader spells it. */
export const DOGFOOD_ANSWERER: StopAnswerer = "stand_in";

/**
 * What the label can and cannot do, said in the same breath as every number it
 * qualifies.
 *
 * The label is self-declared, and it can be wrong in both directions:
 *
 * - **Overstating the partner population.** A stop is dogfood because the
 *   answer says it is — a signed tick on the pull request, or `perbo verdict
 *   --stand-in` at the command line. Nothing here can tell a stand-in that
 *   ticks a box through the GitHub UI, or forgets to sign, from a person, so
 *   such an answer is counted as a person's, and the partner `n` is an upper
 *   bound on the answers a person actually gave rather than a guarantee.
 * - **Understating it.** The signature is read off a pull-request body, which
 *   is text anyone with write access to the pull request can edit — the loop
 *   included. Signing ticks as the stand-in's takes them out of the partner
 *   population: sign enough and a reading that would have failed the bar cannot
 *   resolve, sign the overriding ones and what is left passes it. Nothing a
 *   body says can put a stop **into** a partner number; what it can do is
 *   remove them, and a removal that goes unnoticed is a verdict about whichever
 *   answers survived, read as one about all of them.
 *
 * Neither direction is closable by reading the body harder, so both are
 * disclosed instead, and the count of what was excluded is printed beside every
 * partner number so that either can be seen in the numbers themselves. Every
 * surface that reports a partner number prints this beside it.
 */
export const PARTNER_READING_CAVEAT =
  "an answer is dogfood only where it says so — a signed tick, or `perbo verdict --stand-in` — " +
  "so a stand-in that ticks a box unsigned is counted here as a person: n is an upper bound on " +
  "the answers a person gave, not a guarantee. It reads low as readily as high: a signature is " +
  "text in a pull-request body, so whoever can edit the body can sign ticks out of the partner " +
  "population, leaving a reading that cannot resolve where one would have failed, or one that " +
  "passes on the answers that remain. The excluded count beside n is what makes either direction " +
  "visible (D-058).";

export const StopFindingKeySchema = z.string().regex(/^[0-9a-f]{64}$/);

export const StopVerdictSchema = z.strictObject({
  finding_key: StopFindingKeySchema,
  rule_id: z.string().min(1),
  routing: StopRoutingSchema,
  answer: StopAnswerSchema.nullable(),
  /** The observation that first saw this answer; kept while the answer is unchanged. */
  answered_at: z.iso.datetime().nullable(),
  /**
   * Who gave that answer, and `null` where there is no answer to attribute.
   *
   * Defaulted rather than required, so every record written before this field
   * existed still parses: it reads back as `null`, which is what such a record
   * says — it does not say a person answered, and it does not say a stand-in
   * did. Only an answer explicitly signed by the stand-in is dogfood, which is
   * the conservative direction: the label can take a stop **out** of the
   * partner reading and can never put one in.
   */
  answered_by: StopAnswererSchema.nullable().default(null),
  first_seen_at: z.iso.datetime(),
});
export type StopVerdict = z.infer<typeof StopVerdictSchema>;

/**
 * Whether a stop's answer is a dogfood one — the stand-in's, and so outside
 * every partner reading (D-058).
 *
 * An unanswered stop is not dogfood: there is nothing to exclude, and counting
 * it as dogfood would make the excluded count read as larger than the answers
 * it is about.
 */
export const isDogfoodStop = (stop: Pick<StopVerdict, "answer" | "answered_by">): boolean =>
  stop.answer !== null && stop.answered_by === DOGFOOD_ANSWERER;

export const STOP_VERDICTS_SCHEMA_VERSION = 1;

export const StopVerdictsSchema = z.strictObject({
  schema_version: z.literal(STOP_VERDICTS_SCHEMA_VERSION),
  ticket_id: TicketIdSchema,
  ticket_key: TicketKeySchema,
  pull_request_url: z.string().min(1).nullable(),
  stops: z.array(StopVerdictSchema),
  /**
   * Whether the pull request put anything in front of a person — a `blocks` or
   * `escalates` finding, or a decline. The companion number D-060 requires
   * beside precision is the share of changes where this is true.
   */
  shown_to_person: z.boolean(),
  /** The first sync that wrote this file; kept across rewrites so `--since` can bucket a change. */
  first_seen_at: z.iso.datetime(),
  observed_at: z.iso.datetime(),
});
export type StopVerdicts = z.infer<typeof StopVerdictsSchema>;

/** One stop as the pull-request body reports it: the marker's fields and the tick state. */
export interface ObservedStop {
  finding_key: string;
  rule_id: string;
  routing: StopRouting;
  answer: StopAnswer | null;
  /**
   * Who the body says ticked the box, where the tick was signed. Absent — and
   * `null`, which a record written by an older reader may carry — is an
   * unsigned tick, which is what the GitHub UI produces when a person clicks
   * one, and so reads as a person's answer below.
   *
   * `| undefined` is spelled out because the workspace compiles under
   * `exactOptionalPropertyTypes`: a record read back through a schema that
   * makes the field optional carries the property with no value, and that is
   * the same statement as leaving it off.
   */
  answered_by?: StopAnswerer | null | undefined;
}

/**
 * The next file from the previous one and what `gh` reported. The stops are
 * whatever the body carries now; `answered_at` survives from the previous file
 * only while the answer is the same, so it stays the moment the person
 * answered rather than the moment somebody last ran `sync`.
 *
 * `answered_by` is written the same way it is read: an answer the body signs as
 * the stand-in's is recorded as the stand-in's, and an unsigned answer is a
 * person's, because an unsigned tick is exactly what the GitHub UI writes when
 * somebody clicks the box. An answer that has not changed keeps the answerer
 * recorded with it, so a stand-in's signature is not lost by a later `sync`
 * reading a body somebody has since edited the marker out of.
 *
 * That stickiness is one-way and it is not a trap. Silence cannot clear a
 * signature — otherwise deleting a comment would erase who answered — but a
 * person who did answer a stop the stand-in is recorded against says so the way
 * the stand-in did, by signing the line: `<!-- perbo:answered-by who=person -->`
 * on the ticked box, which is read here as a person's answer and puts the stop
 * back into the partner population without the answer itself having to change.
 * `perbo verdict --endorse|--override` with no `--stand-in` is the same
 * statement made at the command line. So the label is a claim somebody made
 * rather than a verdict nobody can revise, and the only thing that cannot
 * revise it is nobody saying anything.
 */
export function reconcileStopVerdicts(args: {
  previous: StopVerdicts | null;
  ticket: { ticket_id: string; key: string };
  pull_request_url: string | null;
  observed: readonly ObservedStop[];
  observed_at: string;
}): StopVerdicts {
  const before = new Map((args.previous?.stops ?? []).map((stop) => [stop.finding_key, stop]));
  const stops: StopVerdict[] = args.observed.map((stop) => {
    const prior = before.get(stop.finding_key);
    const unchanged = prior !== undefined && prior.answer === stop.answer && prior.answered_at !== null;
    return {
      finding_key: stop.finding_key,
      rule_id: stop.rule_id,
      routing: stop.routing,
      answer: stop.answer,
      answered_at: stop.answer === null ? null : unchanged ? prior.answered_at : args.observed_at,
      answered_by:
        stop.answer === null
          ? null
          : (stop.answered_by ?? (unchanged ? prior.answered_by : null) ?? "person"),
      first_seen_at: prior?.first_seen_at ?? args.observed_at,
    };
  });
  return StopVerdictsSchema.parse({
    schema_version: STOP_VERDICTS_SCHEMA_VERSION,
    ticket_id: args.ticket.ticket_id,
    ticket_key: args.ticket.key,
    pull_request_url: args.pull_request_url,
    stops,
    shown_to_person: stops.length > 0,
    first_seen_at: args.previous?.first_seen_at ?? args.observed_at,
    observed_at: args.observed_at,
  });
}

export interface StopsSummary {
  /** Every stops file read. */
  changes: number;
  with_pull_request: number;
  endorsed: number;
  overridden: number;
  /** endorsed / (endorsed + overridden), over changes with at least one answer. */
  precision: WilsonInterval;
  /** Of the changes that reached a person either way, those they were shown something on. */
  shown: number;
  /** shown / changes that reached a person — the companion D-060 requires beside precision. */
  companion: WilsonInterval;
  stops: number;
  unanswered_stops: number;
  conflicts: number;
  /**
   * Stops the stand-in answered, and so the answers precision above is read
   * **without** (D-058). Reported rather than folded away: a denominator that
   * shrinks with no count beside it reads as a rising share.
   */
  dogfood_stops: number;
  /**
   * Changes that would have been in precision's population had those answers
   * counted, and are not. Zero where the stand-in only answered stops on
   * changes a person had also answered.
   */
  dogfood_changes: number;
  /**
   * **Not a partner reading, and never to be quoted as one**: precision as it
   * would read if the stand-in's answers were pooled with the person's.
   *
   * It exists for one purpose — to say what the exclusion did. The label is
   * self-declared and comes off a pull-request body, and all it can do is
   * remove answers: remove enough of them and a reading that would have failed
   * the bar cannot resolve, remove the overriding ones and what is left passes
   * it. A command that printed only the partner number could not tell a verdict
   * the answers earned from one the exclusion produced; comparing this against
   * {@link precision} is how that is said out loud. It equals `precision`
   * exactly when nothing was excluded.
   */
  pooled_precision: WilsonInterval;
}

/**
 * Precision of stopping over stops files, beside its companion.
 *
 * The change-level semantics mirror `precisionOfStopping` in
 * `packages/evaluation/src/stopping.ts`, so the live number and the corpus
 * number answer the same question: a change is **endorsed** when any of its
 * stops is endorsed — the change was held for a decision the person wanted to
 * make — and **overridden** when every answered stop says the agent should
 * have fixed it alone. A conflict is not an answer; a change whose only
 * answers are conflicts stays out of the population, as does one nobody has
 * answered yet.
 *
 * The companion is computed over the changes that reached a person either way,
 * whether or not anybody answered: one with a pull request, where there were
 * boxes to tick, and one somebody was shown something on without a pull
 * request — a stop answered by `perbo verdict` on a ticket that has none yet
 * (SCP-181). It is the share on which a person was shown something at all, and
 * precision improves trivially when that share falls.
 *
 * Both populations have to see the same change, which is why the denominator
 * is not simply `with_pull_request`. A decision taken at the command line
 * enters precision; if the companion could not see the change it was taken on,
 * that decision would move one number of the pair while the other stood still,
 * and standing still is what D-060 pairs them to rule out. `with_pull_request`
 * is reported unchanged: it counts what its name says.
 *
 * **Precision is a partner reading, so a stand-in's answers are not in it**
 * (D-058): an AI's endorsement of a stop is not a person wanting to be asked,
 * and a number that pooled the two would be quoted as a partner number while
 * being partly the loop's opinion of itself. The exclusion is per answer rather
 * than per change — one pull request can carry both — so a change a person
 * answered still counts, on their answers alone. What is dropped is counted in
 * `dogfood_stops` and `dogfood_changes` and printed beside the number.
 *
 * Everything the record's own diagnostics count — `stops`, `unanswered_stops`,
 * `conflicts` — stays whole. They describe the record rather than reading a
 * rate off it, and a stop that exists is a stop that exists whoever answered.
 */
export function summariseStops(files: readonly StopVerdicts[]): StopsSummary {
  let endorsed = 0;
  let overridden = 0;
  let stops = 0;
  let unanswered = 0;
  let conflicts = 0;
  let dogfoodStops = 0;
  let dogfoodChanges = 0;
  let pooledEndorsed = 0;
  let pooledOverridden = 0;
  const withPullRequest = files.filter((file) => file.pull_request_url !== null);
  const reachedAPerson = files.filter((file) => file.pull_request_url !== null || file.shown_to_person);
  const shown = reachedAPerson.filter((file) => file.shown_to_person).length;
  const says = (stops_: readonly StopVerdict[], answer: StopAnswer): boolean =>
    stops_.some((stop) => stop.answer === answer);
  for (const file of files) {
    stops += file.stops.length;
    unanswered += file.stops.filter((stop) => stop.answer === null).length;
    conflicts += file.stops.filter((stop) => stop.answer === "conflict").length;
    const dogfood = file.stops.filter(isDogfoodStop);
    const partner = file.stops.filter((stop) => !isDogfoodStop(stop));
    dogfoodStops += dogfood.length;
    if (says(partner, "endorse")) endorsed += 1;
    else if (says(partner, "override")) overridden += 1;
    // A change the exclusion took out of the population: the stand-in answered
    // one of its stops and no person answered any of them.
    else if (says(dogfood, "endorse") || says(dogfood, "override")) dogfoodChanges += 1;
    // The same reading over every answer, whoever gave it — the counterfactual
    // the exclusion is measured against, and nothing anybody may quote.
    if (says(file.stops, "endorse")) pooledEndorsed += 1;
    else if (says(file.stops, "override")) pooledOverridden += 1;
  }
  return {
    changes: files.length,
    with_pull_request: withPullRequest.length,
    endorsed,
    overridden,
    precision: wilsonInterval(endorsed, endorsed + overridden),
    shown,
    companion: wilsonInterval(shown, reachedAPerson.length),
    stops,
    unanswered_stops: unanswered,
    conflicts,
    dogfood_stops: dogfoodStops,
    dogfood_changes: dogfoodChanges,
    pooled_precision: wilsonInterval(pooledEndorsed, pooledEndorsed + pooledOverridden),
  };
}

/* ------------------------------------------------------------------ *
 * D-060's bar, and what a reading is allowed to say against it.
 * ------------------------------------------------------------------ */

/**
 * The bar itself: **precision of stopping ≥70%**, accepted by the Product Owner
 * on 2026-09-01 and measured live from pull requests from 2026-09-02
 * ([D-060](../../../docs/11-open-decisions.md#d-060--what-replaces-a-false-block-rate-that-cannot-be-met)).
 */
export const D060_BAR = 0.7;

/**
 * How a reading may be reported against the bar. A point estimate never passes
 * or fails it: the 95% Wilson interval has to resolve, and where the population
 * is too small for any set of answers to resolve a pass, the reading says so
 * rather than printing either verdict.
 */
export const D060_VERDICTS = ["pass", "fail", "cannot resolve"] as const;
export type D060Verdict = (typeof D060_VERDICTS)[number];

/**
 * The smallest population whose interval can clear the bar at all — nine, for
 * 70%, and computed rather than written down so that the floor follows the bar
 * instead of having to be kept in step with it by hand.
 *
 * Unanimity is the best any population of a given size can do, so this is the
 * smallest `n` whose all-endorsed lower bound reaches the bar. Below it no
 * answers resolve a pass, which is exactly what makes "cannot resolve" a
 * statement about the sample rather than about the reviewer.
 */
export function smallestResolvingSample(bar: number = D060_BAR, z?: number): number {
  if (!(bar < 1)) throw new RangeError(`no finite sample resolves a bar of ${bar}: it must be below 1`);
  for (let n = 1; n <= 10_000; n += 1) {
    if (wilsonInterval(n, n, z).low >= bar) return n;
  }
  /* c8 ignore next 2 -- unreachable for any bar below 1: the lower bound of an
     all-endorsed sample tends to 1 as n grows. */
  throw new RangeError(`no sample under 10000 resolves a bar of ${bar}`);
}

/** A reading of precision of stopping against D-060's bar. */
export interface D060Reading {
  verdict: D060Verdict;
  /** The bar, as a share, so a reader of the JSON need not know it. */
  bar: number;
  /** The smallest population that could have resolved a pass. */
  resolving_n: number;
  /** True where the interval covers the bar rather than sitting on one side. */
  spans_bar: boolean;
  interval: WilsonInterval;
}

/**
 * Judge one interval against D-060's bar.
 *
 * Two questions, in this order, because they are different questions:
 *
 * 1. **Could this population resolve at all?** Below {@link smallestResolvingSample}
 *    no set of answers clears the bar, so neither verdict is available and the
 *    reading is `cannot resolve` — the number is still printed, and it is still
 *    not a pass. Printing a failure there would read as evidence the reviewer
 *    over-stops when it is only evidence that nine people have not answered yet.
 * 2. **Does the interval sit wholly at or above the bar?** That is the pass
 *    D-060 grants. Anything else at a population that could have resolved one
 *    is a fail: an interval that spans the bar has not cleared it, and the bar
 *    is what a pass is granted against. `spans_bar` says which of the two a
 *    fail is, so a straddling reading is never reported as one that resolved
 *    wholly below.
 */
export function judgeAgainstD060(
  precision: WilsonInterval,
  bar: number = D060_BAR,
): D060Reading {
  const resolving_n = smallestResolvingSample(bar);
  const spans_bar = !Number.isNaN(precision.point) && precision.low < bar && precision.high >= bar;
  const verdict: D060Verdict =
    precision.n < resolving_n ? "cannot resolve" : precision.low >= bar ? "pass" : "fail";
  return { verdict, bar, resolving_n, spans_bar, interval: precision };
}

/**
 * D-060's reversal trigger: precision improved while the share of changes on
 * which a person was shown something fell. Reported alone, precision rewards
 * hiding findings; this is the comparison that makes the failure visible.
 * False when either window has no value for either number.
 */
export function widenedByHiding(before: StopsSummary, since: StopsSummary): boolean {
  const values = [before.precision, before.companion, since.precision, since.companion];
  if (values.some((interval) => Number.isNaN(interval.point))) return false;
  return since.precision.point > before.precision.point && since.companion.point < before.companion.point;
}
