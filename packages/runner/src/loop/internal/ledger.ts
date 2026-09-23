import { z } from "zod";
import type { Decline } from "../../declines.js";
import { CostBasisSchema, costOf, rollCosts } from "@perbo/contracts";
import type { Cost, ExecutionAttempt } from "@perbo/contracts";
import { appendAttempts, sealedByAttempt, type AttemptsRecord } from "../../attempts.js";
import type { RoundRecord } from "./state.js";

/**
 * What one run appends to a ticket's record, and what the ticket has spent.
 *
 * The record on disk is appended to and never replaced, so a run reads what
 * earlier runs left, adds its own, and writes only the part nothing has
 * written yet. That arithmetic is here rather than in the sequencer because
 * three separate things depend on getting it right: the budget, the park that
 * flushes before sleeping, and the single append at the end.
 */

/** What one ticket has spent, in micro-dollars, as far as anything priced it. */
export interface TicketSpend {
  micros: number;
  priced: number;
  unpriced: number;
}

export interface LedgerRecord {
  /** The ticket's attempts record on disk. */
  path: string;
  /** What that record already held when the run started. */
  prior: AttemptsRecord | null;
  ticketId: string;
}

const USAGE = z.looseObject({
  attempt_id: z.string().optional(),
  agent: z.looseObject({ credential_class: z.string() }).optional(),
  usage: z.looseObject({
    cost_micros: z.number().int().min(0),
    cost_basis: z.string(),
  }),
});

/**
 * The refusal for a record naming a cost basis this version does not know, or
 * null. Such a record may carry dollars this cannot tell from none, and
 * counted as unpriced a real figure would drop out of the sum the budget is
 * held to. A subscription attempt is none of the budget's business (D-096),
 * whatever its basis.
 */
function unknownBasis(record: unknown, path: string): Error | null {
  const parsed = USAGE.safeParse(record);
  if (!parsed.success || parsed.data.agent?.credential_class === "subscription") return null;
  if (CostBasisSchema.safeParse(parsed.data.usage.cost_basis).success) return null;
  return new Error(
    `${parsed.data.attempt_id ?? "an attempt"} in ${path} names a cost basis this version ` +
      `does not know (${JSON.stringify(parsed.data.usage.cost_basis)}), so what the ticket has ` +
      "spent cannot be added up",
  );
}

export class Ledger {
  /** The ticket's attempts record on disk. */
  readonly path: string;
  private readonly prior: AttemptsRecord | null;
  private readonly ticketId: string;
  private readonly mine: ExecutionAttempt[] = [];
  private readonly roundRecords: RoundRecord[] = [];
  private readonly allDeclines: Decline[] = [];
  private readonly sealed: Map<string, string>;
  /**
   * How many of this run's attempts the ticket's record already holds.
   *
   * The record is written once, when the run ends — except when the run parks
   * on a provider's reset, which is exactly the moment it may not survive to
   * write anything. So a park flushes what the run has made so far and moves
   * this mark, and the write at the end appends only what came after it.
   */
  private recordedThrough = 0;

  /**
   * Refuses a record naming a cost basis this version does not know here,
   * before the run provisions or spends anything, rather than when the budget
   * is first checked.
   */
  constructor(record: LedgerRecord) {
    this.path = record.path;
    this.prior = record.prior;
    this.ticketId = record.ticketId;
    this.sealed = sealedByAttempt(record.prior);
    for (const attempt of record.prior?.attempts ?? []) {
      const refused = unknownBasis(attempt, record.path);
      if (refused !== null) throw refused;
    }
  }

  get attempts(): readonly ExecutionAttempt[] {
    return this.mine;
  }

  get rounds(): readonly RoundRecord[] {
    return this.roundRecords;
  }

  get declines(): readonly Decline[] {
    return this.allDeclines;
  }

  /**
   * Which attempt sealed a commit, this run's or any earlier run's, or null
   * where nothing on record claims it.
   */
  sealedBy(sha: string): string | null {
    return this.sealed.get(sha) ?? null;
  }

  /**
   * One attempt, with the commit it sealed itself where it sealed one. A
   * commit an attempt carried forward is not its own, so the next round can
   * still name the attempt that made it.
   */
  addAttempt(attempt: ExecutionAttempt, sealedOwnHead: string | null): void {
    this.mine.push(attempt);
    if (sealedOwnHead !== null) this.sealed.set(sealedOwnHead, attempt.attempt_id);
  }

  addRound(record: RoundRecord): void {
    this.roundRecords.push(record);
  }

  /** D-065: every decline across rounds, for the notification and the record. */
  addDeclines(declines: readonly Decline[]): void {
    this.allDeclines.push(...declines);
  }

  last(): ExecutionAttempt | undefined {
    return this.mine[this.mine.length - 1];
  }

  /**
   * What this ticket has spent, in micro-dollars, as far as anything priced it:
   * every attempt already on its record plus every attempt this run has made.
   *
   * Only priced components are added. A model with no applicable rate card and
   * no transport-reported figure contributes nothing and is counted
   * separately, because a budget that read "unmeasured" as `$0` would never be
   * reached — which is the one way a ticket budget can fail open.
   *
   * An attempt on a subscription is left out (D-096): the dollar figure it
   * reports is a measure of work and not a bill, and the budget is a bill.
   *
   * A record naming a cost basis this version does not know is refused
   * (`unknownBasis`).
   */
  spend(): TicketSpend {
    const components: Cost[] = [];
    for (const record of [...(this.prior?.attempts ?? []), ...this.mine]) {
      const parsed = USAGE.safeParse(record);
      // A record this cannot read priced nothing it can defend.
      if (!parsed.success) {
        components.push(costOf({ micros: 0, basis: "unavailable" }));
        continue;
      }
      if (parsed.data.agent?.credential_class === "subscription") continue;
      const refused = unknownBasis(record, this.path);
      if (refused !== null) throw refused;
      components.push(
        costOf({
          micros: parsed.data.usage.cost_micros,
          basis: CostBasisSchema.parse(parsed.data.usage.cost_basis),
        }),
      );
    }
    const roll = rollCosts(components);
    return { micros: roll.micros, priced: roll.priced, unpriced: roll.unavailable };
  }

  /** Write what the run has made so far, so a park that never wakes leaves it. */
  flush(): void {
    const pending = this.mine.slice(this.recordedThrough);
    if (pending.length === 0) return;
    appendAttempts({ path: this.path, ticket_id: this.ticketId, attempts: pending });
    this.recordedThrough = this.mine.length;
  }

  /**
   * Append what a park has not already flushed, and say what the record holds.
   *
   * An attempt appended twice collides with itself, and the refusal that
   * catches it would fail a run that had otherwise finished.
   */
  finish(): ReturnType<typeof appendAttempts> {
    return appendAttempts({
      path: this.path,
      ticket_id: this.ticketId,
      attempts: this.mine.slice(this.recordedThrough),
    });
  }
}
