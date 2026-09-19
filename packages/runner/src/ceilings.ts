import {
  LimitExceededError,
  assertWithinLimits,
  limitFor,
  limitsForCredential,
  type CredentialClass,
  type LimitedResource,
  type LimitsTable,
  type TerminationReason,
} from "@perbo/contracts";

/**
 * Per-attempt ceilings and the stall detector, enforced in the runner rather
 * than by the model (SCP-087, docs/08).
 *
 * "By the runner" is the whole content of the requirement. A prompt that asks
 * an agent to stop when it is getting nowhere is a request; a timer that kills
 * the process is a stop. Every one of these terminates the attempt with a typed
 * reason and an audit entry, so a run that stopped is distinguishable from a
 * run that finished.
 *
 * Cost, wall clock, fresh tokens, iterations and commands are counted here and
 * bound nothing unless the repository set a ceiling for them (D-096): the
 * record says what a run did either way. What stops an attempt nobody asked to
 * stop is `attempt_stall_ms` — no tool activity for the window — and, where the
 * executor is billed per token, the two cost caps.
 */

const REASON_FOR: Record<LimitedResource, TerminationReason> = {
  attempt_stall_ms: "stalled",
  attempt_wall_clock_ms: "wall_clock_exceeded",
  attempt_commands: "command_ceiling_exceeded",
  attempt_iterations: "iteration_ceiling_exceeded",
  round_iterations: "round_iteration_ceiling_exceeded",
  attempt_tokens: "token_ceiling_exceeded",
  attempt_cost_micros: "cost_ceiling_exceeded",
  concurrent_local_attempts: "workspace_error",
  local_workspace_bytes: "workspace_error",
  remediation_rounds: "workspace_error",
  // Neither of these is a per-attempt counter and `AttemptCeilings` never
  // tests either: `ticket_cost_micros` bounds how many attempts a ticket gets
  // and `wait_for_provider_ms` bounds a wait between them, both decided in the
  // loop where the run rather than the attempt is in view (SCP-193). The rows
  // exist because the map is total over the resource set, and the reason they
  // carry is the one an unreachable breach would deserve.
  ticket_cost_micros: "workspace_error",
  wait_for_provider_ms: "workspace_error",
};

export interface CeilingBreach {
  reason: TerminationReason;
  resource: LimitedResource;
  /** Null where a kill switch stopped an attempt on a resource nothing bounds. */
  limit: number | null;
  reached: number;
  detail: string;
}

export interface CeilingOptions {
  /**
   * Resources this attempt is not bounded by (SCP-230).
   *
   * Counted as they always were — the record says what a run did — and never
   * stopped on. It is a list rather than a very large number because those are
   * different facts: a reader can tell a bound nobody meant from one somebody
   * chose, and a number can be reached by a long enough run either way.
   *
   * The registered direct-agent arm is the caller: it is bounded by its
   * ticket's dollar budget and by a hang guard, and the loop spends that same
   * budget across as many attempts as it needs, so a per-attempt count applied
   * to the arm's one invocation would make it lose a large ticket by
   * construction.
   */
  unbounded?: readonly LimitedResource[];
  /**
   * Which iteration ceiling bounds this invocation, where the repository set
   * one (D-092, D-096).
   *
   * `attempt_iterations`, the default, is an initial attempt: it is building
   * the ticket. `round_iterations` is a remediation round, which closes
   * findings that already name a file and a line and is briefed with the
   * previous attempt's own account. One counter either way — what changes is
   * the ceiling it is tested against and the reason a breach terminates with.
   * Neither is set by default, so unless the repository names one the counter
   * runs on.
   */
  iterations?: Extract<LimitedResource, "attempt_iterations" | "round_iterations">;
}

export class AttemptCeilings {
  /** The table as configured, before the credential decides the cost caps. */
  private readonly configured: LimitsTable;
  private limits: LimitsTable;
  private readonly startedAt: number;
  private readonly clock: () => number;
  private readonly unbounded: ReadonlySet<LimitedResource>;
  private readonly iterationsResource: LimitedResource;
  private commands = 0;
  private iterations = 0;
  private tokens = 0;
  private costMicros = 0;
  /** When the executor's stream last showed a tool call or a tool result. */
  private lastActivity: number;
  private breach: CeilingBreach | null = null;

  constructor(limits: LimitsTable, clock: () => number = Date.now, options: CeilingOptions = {}) {
    this.configured = limits;
    // Until the executor says what it authenticated with, it is `unknown`, and
    // an unidentified credential is capped rather than exempted (D-096).
    this.limits = limitsForCredential(limits, "unknown");
    this.clock = clock;
    this.startedAt = clock();
    this.lastActivity = this.startedAt;
    this.unbounded = new Set(options.unbounded ?? []);
    this.iterationsResource = options.iterations ?? "attempt_iterations";
  }

  /**
   * What the executor turned out to be billed on, read from its own stream
   * (D-096). On a subscription the two cost caps stop bounding anything from
   * here on; against an API key they stand at the table's number or the
   * per-token default.
   */
  useCredential(credential: CredentialClass): void {
    this.limits = limitsForCredential(this.configured, credential);
  }

  private test(resource: LimitedResource, reached: number): CeilingBreach | null {
    if (this.breach) return this.breach;
    if (this.unbounded.has(resource)) return null;
    // A resource the table leaves unset is not tested: `assertWithinLimits`
    // says so too, and this keeps the counting free of a throw nobody catches.
    try {
      assertWithinLimits(this.limits, resource, reached);
      return null;
    } catch (error) {
      if (!(error instanceof LimitExceededError)) throw error;
      this.breach = {
        reason: REASON_FOR[resource],
        resource,
        limit: error.limit ?? limitFor(this.limits, resource),
        reached,
        detail: error.message,
      };
      return this.breach;
    }
  }

  noteCommand(): CeilingBreach | null {
    this.commands += 1;
    return this.test("attempt_commands", this.commands);
  }

  noteIteration(): CeilingBreach | null {
    this.iterations += 1;
    return this.test(this.iterationsResource, this.iterations);
  }

  noteTokens(count: number): CeilingBreach | null {
    this.tokens += count;
    return this.test("attempt_tokens", this.tokens);
  }

  noteCostMicros(micros: number): CeilingBreach | null {
    this.costMicros = micros;
    return this.test("attempt_cost_micros", this.costMicros);
  }

  /**
   * A tool call, or its result, on the executor's stream.
   *
   * This is the only thing the stall detector counts as the executor being
   * alive. A turn of text is not: an agent can narrate for as long as it likes
   * and still be working, but an agent that has neither asked for a tool nor
   * been answered by one in the whole window has stopped.
   */
  noteToolActivity(): void {
    this.lastActivity = this.clock();
  }

  /**
   * Called on a timer; these are the two nothing on the stream can reach.
   *
   * The stall window runs from the last tool activity rather than from the
   * start of the attempt, which is the difference between it and the wall clock
   * beside it: a long attempt working steadily never reaches it.
   */
  tick(): CeilingBreach | null {
    const now = this.clock();
    return (
      this.test("attempt_wall_clock_ms", now - this.startedAt) ??
      this.test("attempt_stall_ms", now - this.lastActivity)
    );
  }

  /** Null where the repository set no wall clock, which is the default (D-096). */
  get wallClockLimitMs(): number | null {
    return limitFor(this.limits, "attempt_wall_clock_ms");
  }

  get stallLimitMs(): number {
    return limitFor(this.limits, "attempt_stall_ms");
  }

  breached(): CeilingBreach | null {
    return this.breach;
  }

  counts(): { commands: number; iterations: number; tokens: number; cost_micros: number; wall_clock_ms: number } {
    return {
      commands: this.commands,
      iterations: this.iterations,
      tokens: this.tokens,
      cost_micros: this.costMicros,
      wall_clock_ms: this.clock() - this.startedAt,
    };
  }
}
