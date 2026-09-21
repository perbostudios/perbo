import type { AttemptWait, ExecutionAttempt, TerminationReason } from "@perbo/contracts";
import { TRANSPORT_RETRY_DELAY_MS, type ProviderReset } from "../transport.js";
import type { Retry, Stop } from "./state.js";

/**
 * Where an attempt that did not finish the work sends the run.
 */

/** What an attempt that ended short of `completed` is routed against. */
export interface StoppedFacts {
  termination: { reason: TerminationReason; detail: string };
  /** The attempt that ended, carried on `superseded` where the round buys another. */
  attempt: ExecutionAttempt;
  transportRetry: number;
  /** The reset the provider named in its own error text, where it named one. */
  reset: ProviderReset | null;
  /** The park that reset earns, null where it is beyond the bound or already past. */
  park: AttemptWait | null;
  /** How far away the reset is, whether or not it is within the bound. */
  parkMs: number;
  waitBoundMs: number;
  /** Whether the attempt sealed commits of its own, rather than carrying an earlier attempt's. */
  sealedItsOwn: boolean;
  /** What the ticket has spent, and the budget a continuation is allowed against. */
  spend: { micros: number; priced: number; unpriced: number };
  budget: number | null;
  /** D-065: findings this attempt's executor declared no-determinable-practice for. */
  declines: number;
  ticketKey: string;
  branch: string;
  runNumber: number;
  /** Attempts this run has recorded, so the continuation line numbers the next one. */
  attemptsSoFar: number;
  /** The repository's limits file, so a stop names where its bound is raised. */
  configPath: string;
}

/**
 * What an attempt that stopped short of the work comes to: a stop, or the one
 * more attempt of the same round a transport outage or a ceiling buys.
 *
 * A round that stops here leaves a record; one that buys another attempt has
 * not been answered yet, and the attempt it is replacing travels on
 * `superseded` until the round has a record to name it on.
 */
export function routeStopped(facts: StoppedFacts): Stop | Retry {
  const { termination, reset, park, spend, budget, configPath } = facts;
  /**
   * A transport that was overloaded is not a ticket that failed
   * (SCP-172). The attempt is on the ticket's attempts record with the
   * status and the error text that ended it; the loop waits for the
   * weather and starts one more attempt from the same base, in the same
   * worktree, against the same brief. One, and only where the attempt
   * before it was not already that retry — two of these in a row is the
   * provider telling the run to stop rather than an outage to sit out.
   */
  if (termination.reason === "transport_unavailable" && facts.transportRetry === 0) {
    // SCP-193: the provider named a reset this run may not wait for.
    // Stopping says which instant and which key, so raising the bound is
    // a decision a person makes with the number in front of them.
    if (reset !== null && park === null) {
      return {
        next: "stop",
        end: {
          outcome: "terminated",
          detail:
            `${termination.reason}: ${termination.detail} The provider resets at ` +
            `${reset.until.toISOString()} (${reset.zone}), which is ${Math.round(facts.parkMs / 60_000)} ` +
            `minute(s) away and past limits.limits.wait_for_provider_ms in ${configPath} ` +
            `(currently ${facts.waitBoundMs} ms). Waiting less would spend an attempt against a limit ` +
            "still in force, so the run stops rather than waking early.",
        },
      };
    }
    return {
      next: "retry",
      counter: "transport",
      superseded: facts.attempt,
      wait: { ms: park === null ? TRANSPORT_RETRY_DELAY_MS : park.waited_ms, park },
      say:
        park !== null
          ? `the provider resets at ${park.until} (${park.zone}); parking ` +
            `${facts.ticketKey} for ${Math.round(park.waited_ms / 60_000)} minute(s) and ` +
            "resuming the same attempt then."
          : `${termination.detail} Waiting ${Math.round(TRANSPORT_RETRY_DELAY_MS / 1000)}s and ` +
            "starting one more attempt from the same base.",
    };
  }

  /**
   * SCP-193: an attempt a ceiling cut left its work sealed on the branch,
   * and the next attempt of the same round starts over those commits.
   *
   * This is SCP-164's re-run path, inside one run: the branch carries the
   * commits, `prior_commits` attributes them, and the executor gets the
   * ticket's own brief again. What bounds it is the ticket budget rather
   * than a retry count, because the ceiling it is answering is a spend
   * ceiling and the honest bound on spend is more spend.
   *
   * Only the two ceilings a continuation can make progress against. A
   * wall clock or a command ceiling ends attempts the same way each time,
   * and a token ceiling is the same spend under another name; those still
   * stop the run, and so does a stall, which is a hang rather than
   * progress. The two iteration ceilings reach this path only where the
   * repository configured them (D-096).
   *
   * And only where there is a ticket budget to measure the continuation
   * against, which means an executor billed per token (D-096). On a
   * subscription the dollar figure an attempt reports is a measure of
   * work rather than a bill, so no number of them adds up to a budget,
   * and the run ends here saying so.
   *
   * And only where the cut attempt sealed something of its own. There is
   * no "sealed work" to continue over otherwise, and an attempt that
   * reached a ceiling having added nothing to the branch is one the next
   * attempt would repeat under the same ceiling for the same money.
   */
  if (
    facts.sealedItsOwn &&
    (termination.reason === "cost_ceiling_exceeded" ||
      termination.reason === "iteration_ceiling_exceeded" ||
      // D-092: the round ceiling ends a round the way the attempt
      // ceiling ends an attempt, this path included.
      termination.reason === "round_iteration_ceiling_exceeded")
  ) {
    const room = (budget ?? 0) - spend.micros;
    if (budget !== null && spend.priced > 0 && room > 0) {
      return {
        next: "retry",
        counter: "ceiling",
        superseded: facts.attempt,
        wait: null,
        say:
          `${termination.reason} on ${facts.attempt.attempt_id}; its work is sealed on ` +
          `${facts.branch}, and run ${facts.runNumber} attempt ${facts.attemptsSoFar + 1} ` +
          `continues over it — $${(spend.micros / 1_000_000).toFixed(2)} of the ` +
          `$${((budget ?? 0) / 1_000_000).toFixed(2)} ticket budget is spent`,
      };
    }
    return {
      next: "stop",
      end: {
        outcome: "terminated",
        detail:
          `${termination.reason}: ${termination.detail} ` +
          (budget === null
            ? // D-096: on a subscription the dollar figure an attempt reports
              // is a measure of work rather than a bill, so no number of them
              // adds up to a budget a continuation could be allowed against.
              `${facts.ticketKey} is running on a credential nothing bills per token, so ` +
              "limits.limits.ticket_cost_micros measures nothing and the run does not start " +
              "another attempt over the sealed work."
            : spend.priced === 0
              ? `No attempt of ${facts.ticketKey} carries a dollar figure, so the ` +
                "limits.limits.ticket_cost_micros budget cannot be measured and the run does not " +
                "start another attempt."
              : `The ticket has spent $${(spend.micros / 1_000_000).toFixed(2)} of the ` +
                `$${(budget / 1_000_000).toFixed(2)} in ` +
                `limits.limits.ticket_cost_micros (${configPath}), so no further attempt ` +
                `continues it` +
                (spend.unpriced > 0
                  ? `; ${spend.unpriced} attempt(s) carry no dollar figure and are not in that sum`
                  : "") +
                "."),
      },
    };
  }

  if (termination.reason === "transport_unavailable") {
    return {
      next: "stop",
      end: {
        outcome: "terminated",
        detail:
          `${termination.reason}: ${termination.detail} The attempt before it ended the same ` +
          "way, so the run stops rather than starting a third.",
      },
    };
  }
  // Both no-change endings are the same fact to the run: nothing reached
  // the branch. Why they differ is on the attempt's termination reason,
  // which travels with the record either way.
  const nothingChanged =
    termination.reason === "no_changes" || termination.reason === "no_changes_after_denials";
  if (nothingChanged && facts.declines > 0) {
    return {
      next: "stop",
      end: {
        outcome: "escalated",
        detail:
          `${facts.declines} finding(s) declared no-determinable-practice and nothing else ` +
          "was changed; a person decides",
      },
    };
  }
  return {
    next: "stop",
    end: {
      outcome: nothingChanged ? "no_changes" : "terminated",
      detail: `${termination.reason}: ${termination.detail}`,
    },
  };
}
