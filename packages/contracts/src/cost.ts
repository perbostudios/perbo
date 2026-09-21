import { z } from "zod";

/**
 * What a model call cost, what that figure is, and the arithmetic of adding
 * several up.
 *
 * D-070: a component with no defensible dollar basis is counted and never
 * summed as zero, so a subtotal never reads as complete when part of it is
 * missing. Everything here is in micro-dollars, the unit every record reports
 * a cost in, and the only conversion is the one a person reads.
 *
 * This module imports zod alone, so a browser bundle can carry it.
 */

export const MICROS_PER_DOLLAR = 1_000_000;

/** A model call's dollar basis: the drafter's, the reviewer's, the verifier's. */
export const ReviewCostBasisSchema = z.enum([
  "transport_reported",
  "provider_list_estimate",
  "unavailable",
]);
export type ReviewCostBasis = z.infer<typeof ReviewCostBasisSchema>;

/** A cost component's basis: a model call's, or `not_incurred` where no model was called. */
export const CostBasisSchema = z.enum([
  "transport_reported",
  "provider_list_estimate",
  "unavailable",
  "not_incurred",
]);
export type CostBasis = z.infer<typeof CostBasisSchema>;

/**
 * One dollar figure, and what it is. `micros` is null where the basis carries
 * no dollars at all — `$0.00` and "nobody measured this" are different facts.
 * `partial` says the component was stopped before its transport wrote a final
 * accounting line, so the figure covers only what was read by the stop.
 */
export const CostSchema = z.object({
  micros: z.number().int().min(0).nullable(),
  basis: CostBasisSchema,
  partial: z.boolean(),
});
export type Cost = z.infer<typeof CostSchema>;

/**
 * Costs added up: a round's components, a run's, or a ticket's. A component
 * with no dollars is counted rather than dropped, and the partial ones are
 * named for the same reason.
 *
 * Parsed permissively rather than strictly: a reader of another program's
 * JSON must not break when that program adds a field.
 */
export const CostRollSchema = z.object({
  /** Micro-dollars from the components that carry a figure. */
  micros: z.number().int().min(0),
  /** Components that could carry one; `not_incurred` is not among them. */
  components: z.number().int().min(0),
  priced: z.number().int().min(0),
  /** Priced by the transport's own dollar total. */
  reported: z.number().int().min(0),
  /** Priced from token usage at the provider's recorded list rates. */
  estimated: z.number().int().min(0),
  unavailable: z.number().int().min(0),
  /** Of the priced ones, how many are a charge up to a stop rather than a total. */
  partial: z.number().int().min(0),
});
export type CostRoll = z.infer<typeof CostRollSchema>;

export interface CostInput {
  micros: number;
  basis: CostBasis;
  partial?: boolean;
}

/** A basis that carries no dollars carries no figure either. */
export function costOf(input: CostInput): Cost {
  return {
    micros: input.basis === "unavailable" || input.basis === "not_incurred" ? null : input.micros,
    basis: input.basis,
    partial: input.partial ?? false,
  };
}

export function rollCosts(components: readonly Cost[]): CostRoll {
  const counted = components.filter((cost) => cost.basis !== "not_incurred");
  const priced = counted.filter((cost) => cost.micros !== null);
  return {
    micros: priced.reduce((total, cost) => total + (cost.micros ?? 0), 0),
    components: counted.length,
    priced: priced.length,
    reported: priced.filter((cost) => cost.basis === "transport_reported").length,
    estimated: priced.filter((cost) => cost.basis === "provider_list_estimate").length,
    unavailable: counted.length - priced.length,
    partial: priced.filter((cost) => cost.partial).length,
  };
}

export function addRolls(a: CostRoll, b: CostRoll): CostRoll {
  return {
    micros: a.micros + b.micros,
    components: a.components + b.components,
    priced: a.priced + b.priced,
    reported: a.reported + b.reported,
    estimated: a.estimated + b.estimated,
    unavailable: a.unavailable + b.unavailable,
    partial: a.partial + b.partial,
  };
}

/**
 * Decimals, per surface: four for a run, an attempt and an admission, three
 * for the review card and the pull-request comment, two for a ceiling, a
 * budget and the desktop.
 */
export type UsdDigits = 2 | 3 | 4;

/** `0.0040`, for a caller that supplies its own unit. */
export function dollarAmount(micros: number, digits: UsdDigits): string {
  return (micros / MICROS_PER_DOLLAR).toFixed(digits);
}

/** `$0.0040`. */
export function formatUsd(micros: number, digits: UsdDigits): string {
  return `$${dollarAmount(micros, digits)}`;
}

export interface PhraseOptions {
  digits?: 3 | 4;
}

/**
 * A cost as a sentence of its own: `cost unavailable`, `not incurred`, or the
 * amount with the word for what priced it. `partial` replaces the basis word
 * rather than joining it: what a reader needs first is that this is not the
 * whole charge.
 *
 * D-070: a basis carrying no dollars is a word and never an amount, so no
 * reading of this ever produces `$0` for a component nobody priced.
 */
export function costPhrase(cost: Cost, options?: PhraseOptions): string {
  if (cost.micros === null) {
    return cost.basis === "not_incurred" ? "not incurred" : "cost unavailable";
  }
  const amount = formatUsd(cost.micros, options?.digits ?? 4);
  if (cost.partial) return `${amount} partial`;
  return `${amount} ${cost.basis === "transport_reported" ? "reported" : "estimated"}`;
}

/**
 * The same cost under a `cost` label, which is the word alone without
 * `costPhrase`'s own `cost ` prefix — the label on the line and the column
 * heading above it already say which quantity this is, and the prefix reads as
 * "cost cost unavailable" under them.
 */
export function costLabel(cost: Cost): string {
  if (cost.micros === null) {
    return cost.basis === "not_incurred" ? "not incurred" : "unavailable";
  }
  const amount = formatUsd(cost.micros, 4);
  if (cost.partial) return `${amount} partial`;
  return `${amount} ${cost.basis === "transport_reported" ? "reported" : "estimated"}`;
}

/** A subtotal as a person reads it: what it adds up to, and what is missing from it. */
export function rollLabel(roll: CostRoll): string {
  if (roll.components === 0) return "not incurred";
  if (roll.priced === 0) return `unavailable — ${roll.unavailable} component(s) unpriced`;
  const notes = [`${roll.priced} of ${roll.components} priced`];
  if (roll.estimated > 0) {
    notes.push(`${roll.reported} reported`, `${roll.estimated} estimated`);
  }
  if (roll.partial > 0) notes.push(`${roll.partial} partial`);
  if (roll.unavailable > 0) notes.push(`${roll.unavailable} unavailable`);
  return `${formatUsd(roll.micros, 4)} — ${notes.join(", ")}`;
}
