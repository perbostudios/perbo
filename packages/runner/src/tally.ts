import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  costOf,
  parseUnifiedDiff,
  rollCosts,
  tallyLine,
  type Cost,
  type CostBasis,
  type ExecutionAttempt,
  type RunBundle,
} from "@perbo/contracts";
import { attemptBundles, type BundleStore } from "./bundle.js";

/**
 * What one attempt's executor has done so far, as its adapter counts it and its
 * provider reports it (D-104). The adapter hands it over whenever any of it may
 * have moved; nothing in it is read from what the agent said (ADR-0023).
 */
export interface AttemptTally {
  /** The commands the attempt's record holds so far: the count it keeps once the attempt ends. */
  commands: number;
  /** Input tokens as the provider has reported them so far. */
  input_tokens: number;
  /** Output tokens as the provider has reported them so far. */
  output_tokens: number;
  /** Dollars as the provider has reported or the list rates have priced them so far, on `cost_basis`. */
  cost_micros: number;
  cost_basis: CostBasis;
  /**
   * The worktree-relative paths a file tool was let write, the scratch
   * directory apart. A shell command's writes are counted from the change set
   * once the attempt is sealed.
   */
  written: readonly string[];
}

/**
 * Where a path a file tool was handed lands, relative to the worktree and with
 * `/` between its parts; null where it lands outside the worktree, on its
 * root, or in the attempt's scratch directory, none of which a change set holds.
 */
export function worktreePath(worktree: string, scratch: string | null, path: string): string | null {
  const absolute = resolve(worktree, path);
  const within = (root: string): string | null => {
    const inside = relative(root, absolute);
    return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? null : inside;
  };
  if (scratch !== null && within(scratch) !== null) return null;
  const inside = within(worktree);
  return inside === null || inside === "" ? null : inside.split(sep).join("/");
}

/** What the attempts on record add up to. */
interface Recorded {
  commands: number;
  paths: ReadonlySet<string>;
  input_tokens: number;
  output_tokens: number;
  costs: Cost[];
}

const NOTHING: Recorded = { commands: 0, paths: new Set(), input_tokens: 0, output_tokens: 0, costs: [] };

/**
 * A run's figures so far, printed as one `tally:` progress line whenever one of
 * them moves (`tallyLine` in `@perbo/contracts`, docs/15).
 *
 * An attempt of this run that is on record counts as the ticket's record counts
 * it: its commands from the attempt, its tokens and dollars from the bundles
 * `attemptBundles` joins to it — the executor's, the review's and the closure
 * verification's — and its paths from the change set its execution bundle
 * retained, less every path an attempt before the run changed. So once the run
 * ends, the ticket's record less what it held before the run comes to the last
 * line printed. The attempt still running adds what its adapter has counted.
 */
export class RunTally {
  private readonly bundles: BundleStore;
  private readonly ticketId: string;
  private readonly progress: (line: string) => void;
  /** Every path an attempt on record before this run changed. */
  private readonly before: ReadonlySet<string>;
  private recorded: Recorded = NOTHING;
  private running: AttemptTally | null = null;
  private said: string | null = null;

  constructor(args: {
    bundles: BundleStore;
    ticketId: string;
    /** The attempts the ticket's record held when the run started, as the record holds them. */
    before: readonly { attempt_id: string; [field: string]: unknown }[];
    progress: (line: string) => void;
  }) {
    this.bundles = args.bundles;
    this.ticketId = args.ticketId;
    this.progress = args.progress;
    const bundles = this.bundles.forTicket(this.ticketId);
    this.before = new Set(
      args.before.flatMap((attempt) =>
        this.changed(
          {
            attempt_id: attempt.attempt_id,
            changeset_id: typeof attempt["changeset_id"] === "string" ? attempt["changeset_id"] : null,
          },
          bundles,
        ),
      ),
    );
  }

  /** The attempt now running, as its adapter has counted it so far. */
  attempt(tally: AttemptTally): void {
    this.running = tally;
    this.say();
  }

  /**
   * This run's attempts as they stand on record now, with whatever bundles have
   * since been written for them. The attempt that was running is among them.
   */
  recount(attempts: readonly ExecutionAttempt[]): void {
    this.recorded = this.add(attempts, this.bundles.forTicket(this.ticketId));
    this.running = null;
    this.say();
  }

  private add(attempts: readonly ExecutionAttempt[], bundles: readonly RunBundle[]): Recorded {
    const paths = new Set<string>();
    let commands = 0;
    let input_tokens = 0;
    let output_tokens = 0;
    const costs: Cost[] = [];
    for (const attempt of attempts) {
      commands += attempt.usage.commands;
      const joined = attemptBundles(attempt, bundles);
      for (const bundle of [joined.execution, joined.review, joined.verification]) {
        if (bundle === undefined) continue;
        input_tokens += bundle.usage.input_tokens;
        output_tokens += bundle.usage.output_tokens;
        costs.push(
          costOf({
            micros: bundle.usage.cost_micros,
            basis: bundle.usage.cost_basis,
            partial: bundle.usage.cost_partial === true,
          }),
        );
      }
      for (const path of this.changed(attempt, bundles)) paths.add(path);
    }
    return { commands, paths, input_tokens, output_tokens, costs };
  }

  /** The paths an attempt's change set holds, as its execution bundle retained it; none where it retained none. */
  private changed(
    attempt: Pick<ExecutionAttempt, "attempt_id" | "changeset_id">,
    bundles: readonly RunBundle[],
  ): string[] {
    const { execution } = attemptBundles(attempt, bundles);
    const diff = execution === undefined ? null : this.bundles.artifact(execution, "change.diff");
    return diff === null ? [] : parseUnifiedDiff(diff).map((file) => file.path);
  }

  private say(): void {
    const running = this.running;
    const changed = new Set([...this.recorded.paths, ...(running?.written ?? [])]);
    const roll = rollCosts([
      ...this.recorded.costs,
      ...(running === null ? [] : [costOf({ micros: running.cost_micros, basis: running.cost_basis })]),
    ]);
    const line = tallyLine({
      commands: this.recorded.commands + (running?.commands ?? 0),
      files: [...changed].filter((path) => !this.before.has(path)).length,
      input_tokens: this.recorded.input_tokens + (running?.input_tokens ?? 0),
      output_tokens: this.recorded.output_tokens + (running?.output_tokens ?? 0),
      micros: roll.micros,
      unpriced: roll.unavailable,
      partial: roll.partial,
    });
    if (line === this.said) return;
    this.said = line;
    this.progress(line);
  }
}
