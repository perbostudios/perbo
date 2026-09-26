/**
 * The spend ceiling, as an enforced control rather than a sentence: the
 * arithmetic of the ceiling, and the ledger the harness consults before it
 * launches each review.
 *
 * Everything here is in micro-dollars, the unit every review artifact reports
 * its cost in, so no conversion happens between the transport's number and the
 * ceiling it is checked against.
 */

import { formatUsd, MICROS_PER_DOLLAR } from "@perbo/contracts";

/** A written amount: `2`, `2.50`, `1,600.00`. Thousands separators optional. */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

/**
 * A dollar amount as a person writes one — `2.50`, `$2.50`, `$1,600.00` — in
 * micro-dollars, or null when the text is not one. Rounded rather than
 * truncated, so `$0.0000005` is a tenth of a cent rather than free.
 */
export function parseUsd(text: string): number | null {
  const match = new RegExp(`^\\s*\\$?\\s*(${AMOUNT})\\s*(?:USD)?\\s*$`, "i").exec(text);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * MICROS_PER_DOLLAR);
}

/**
 * What a review that was launched contributes to the ledger.
 *
 * `cost_basis` is the artifact's own — `transport_reported`,
 * `provider_list_estimate`, `unavailable` — or {@link NO_ARTIFACT} for a review
 * that was spawned and produced nothing to price at all. Only the first two are
 * dollar figures; everything else is spend that happened and cannot be seen,
 * and a total that silently skipped it would not be a bound on anything.
 */
export interface SpendObservation {
  label: string;
  cost_micros: number;
  cost_basis: string;
}

/** The basis of a review that ran and left no artifact: there is no figure. */
export const NO_ARTIFACT = "no_artifact";

/**
 * The bases that carry a dollar figure the ledger may add up.
 *
 * A default-deny set rather than a list of the bad ones: a basis this module
 * has never heard of — a newer transport, a provider that reports differently —
 * is spend it cannot vouch for, and counting it as zero would turn an unknown
 * into free.
 */
const PRICED_BASES: ReadonlySet<string> = new Set(["transport_reported", "provider_list_estimate"]);

/** Why a review's spend could not be observed, in a sentence a person reads. */
function unobservedReason(cost_basis: string): string {
  if (cost_basis === NO_ARTIFACT) return "the reviewer produced no artifact to price";
  if (cost_basis === "unavailable") return "the transport reported no dollar cost";
  return `its cost basis '${cost_basis}' carries no dollar figure`;
}

/**
 * What the ceiling says about launching one more review at this instant.
 *
 * Three answers rather than two, because "not now" and "not ever" are different
 * facts about a run and only one of them truncates it. A `wait` is a review the
 * ledger could not price *yet* and expects to be able to price the moment
 * something in flight reports; a `stop` is the ceiling, and it makes the run
 * partial. Collapsing the two would mean a run whose first review has not
 * reported yet stops at one review and calls the corpus truncated.
 */
export type Admission =
  | { verdict: "admit" }
  | { verdict: "wait"; reason: string }
  | { verdict: "stop"; reason: string };

/** The answer when nothing is bounding the run. */
export const ADMIT: Admission = { verdict: "admit" };

/**
 * The running total, and the one question the harness asks it: may the next
 * review be launched?
 *
 * The projection reserves for the reviews that are already running. It is the
 * settled total plus `in-flight + 1` reviews at the last price observed — the
 * best evidence available about what a review costs — so a worker that is
 * deciding cannot spend money another worker's review has already committed.
 * Without the reservation the arithmetic sees only what has settled, and at
 * `--concurrency N` the run launches N reviews against a total that none of
 * them has contributed to yet; the ceiling then bounds nothing but the last
 * launch, and the run overshoots by up to N reviews.
 *
 * With the reservation the overshoot is at most one review at the price the run
 * has observed: everything launched was covered by the projection at the moment
 * it was admitted. What is unreserved is, for each review in flight, the
 * difference between what it actually costs and what it was reserved at — zero
 * at a steady price, and at `--concurrency N` the sum of up to N such
 * differences when the price rises mid-run. The first dearer review to report
 * re-prices every later reservation, so a rise costs the reviews already
 * running and not the rest of the population.
 *
 * The first review always launches: nothing has been observed, nothing is in
 * flight and nothing has been spent, so its projection is zero. A ceiling below
 * the price of a single review therefore buys one review and then stops, which
 * is the honest outcome; the alternative is refusing to start without ever
 * having measured anything.
 *
 * Until some review reports, there is no price to reserve at. The ledger then
 * holds the second review rather than guessing at zero — a `wait`, not a stop.
 */
export class SpendLedger {
  #total = 0;
  /** The most recent priced review, or null while none has reported. */
  #observed: number | null = null;
  #priced = 0;
  #inFlight = 0;
  readonly #unobserved: string[] = [];

  readonly ceilingMicros: number;

  constructor(ceilingMicros: number) {
    if (!Number.isFinite(ceilingMicros) || ceilingMicros < 0) {
      throw new Error("a spend ceiling must be a non-negative dollar amount");
    }
    this.ceilingMicros = ceilingMicros;
  }

  /** Reviews whose transport reported a defensible dollar value. */
  get pricedReviews(): number {
    return this.#priced;
  }

  /** Launched reviews whose spend could not be seen, labelled with why. */
  get unobservedReviews(): readonly string[] {
    return this.#unobserved;
  }

  get totalMicros(): number {
    return this.#total;
  }

  /** Reviews launched and not yet settled — the ones the projection reserves for. */
  get inFlightReviews(): number {
    return this.#inFlight;
  }

  /** What one review is reserved at: the last observed price, or null while none has reported. */
  get reviewPriceMicros(): number | null {
    return this.#observed;
  }

  /**
   * The settled total plus every review that would be outstanding once one more
   * is launched, priced at {@link reviewPriceMicros}.
   *
   * With no price at all this is the settled total: the reservation is the part
   * that cannot be computed, and {@link admit} holds the launch rather than
   * letting an uncomputable reservation read as a free one.
   */
  get projectedMicros(): number {
    return this.#total + (this.#inFlight + 1) * (this.reviewPriceMicros ?? 0);
  }

  /**
   * Reserve for a review that is about to be spawned.
   *
   * Called in the same synchronous step as the admission that allowed it, so no
   * other worker can decide against a total that does not yet count this one.
   */
  launch(): void {
    this.#inFlight += 1;
  }

  /**
   * Release a launched review's reservation and record what it cost.
   *
   * A null observation is a task that reached no process at all — an unprepared
   * fixture — and it costs nothing; the reservation is still released, because
   * a reservation that outlived its review would bound the run at a review that
   * never ran.
   */
  settle(observation: SpendObservation | null): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (observation === null) return;
    if (!PRICED_BASES.has(observation.cost_basis)) {
      this.#unobserved.push(`${observation.label} (${unobservedReason(observation.cost_basis)})`);
      return;
    }
    this.#priced += 1;
    this.#total += observation.cost_micros;
    this.#observed = observation.cost_micros;
  }

  /**
   * Whether one more review may be launched right now, and why not when it may
   * not.
   *
   * Spend the ledger cannot see stops the run, and one rule covers every way
   * that happens: a transport that reported no dollars, a basis this version
   * does not recognise, and a review that was spawned and crashed, timed out or
   * wrote nothing parseable — the transport may well have charged for that last
   * one, and nothing in the artifact says. The ceiling is a control, and a
   * control that cannot see what it is bounding is not one: continuing would
   * spend without limit under a flag whose entire purpose is the limit. Only a
   * review that was never spawned is silent here, because it cannot have cost
   * anything.
   *
   * A run that has no price yet and something in flight waits. That review will
   * report a price, and a price is what the reservation needs; treating the
   * unknown as zero would admit the whole of `--concurrency N` before any of it
   * had reported, which is the overshoot the reservation exists to remove.
   */
  admit(): Admission {
    if (this.#unobserved.length > 0) {
      return {
        verdict: "stop",
        reason:
          `the ${formatUsd(this.ceilingMicros, 2)} spend ceiling cannot be enforced: ` +
          `${this.#unobserved.length} launched review(s) reported no usable dollar cost ` +
          `(${this.#unobserved.slice(0, 3).join(", ")}` +
          `${this.#unobserved.length > 3 ? ` and ${this.#unobserved.length - 3} more` : ""}), ` +
          `so the ${formatUsd(this.#total, 2)} total is not a bound on what this run has spent`,
      };
    }
    if (this.reviewPriceMicros === null && this.#inFlight > 0) {
      return {
        verdict: "wait",
        reason:
          `no review has reported a price yet, so the ${formatUsd(this.ceilingMicros, 2)} spend ` +
          `ceiling has nothing to reserve the ${this.#inFlight} review(s) in flight at; ` +
          "waiting for the first of them to report",
      };
    }
    if (this.projectedMicros > this.ceilingMicros) {
      return {
        verdict: "stop",
        reason:
          `the ${formatUsd(this.ceilingMicros, 2)} spend ceiling was reached: ` +
          `${formatUsd(this.#total, 2)} settled across ${this.#priced} review(s) with ` +
          `${this.#inFlight} in flight, and one more projects ` +
          `${formatUsd(this.projectedMicros, 2)} at the most recent review's ` +
          `${formatUsd(this.reviewPriceMicros ?? 0, 2)}`,
      };
    }
    return ADMIT;
  }
}
