import { formatUsd } from "@perbo/contracts";
import type { AttemptWait, ExecutionAttempt, TerminationReason } from "@perbo/contracts";
import { TRANSPORT_RETRY_DELAY_MS, type ProviderReset } from "../../transport.js";
import type { Advance, Retry, RoundKind, Stop } from "./state.js";
import { mergeFailedDetail } from "./level.js";

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
          `continues over it — ${formatUsd(spend.micros, 2)} of the ` +
          `${formatUsd(budget ?? 0, 2)} ticket budget is spent`,
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
              : `The ticket has spent ${formatUsd(spend.micros, 2)} of the ` +
                `${formatUsd(budget, 2)} in ` +
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

/** What a round whose change set the base will not merge into is routed against. */
export interface ConflictFacts {
  /** The base tip that will not merge, and the paths git named as unmerged. */
  conflict: { tip: string; paths: string[]; detail: string };
  /** What this round was for, which decides whether a resolution is still owed one. */
  kind: RoundKind;
  baseRef: string;
  branch: string;
}

/**
 * What a round the base will not merge into comes to: a stop, or the round
 * whose only task is the resolution.
 *
 * Nothing judges such a round — a review of a branch that cannot reach its
 * base is a review of a change nobody can take — and the round it buys is a
 * round like any other, sealed, checked and judged (SCP-192).
 */
export function routeConflict(facts: ConflictFacts): Stop | Advance {
  const { conflict, baseRef, branch } = facts;
  // A merge that stopped without naming an unmerged path did not stop on
  // a conflict, and there is nothing for a round to resolve. One
  // resolution attempt per real conflict, too: a round that *was* the
  // resolution and came back to the same conflict has answered the
  // question, and asking the same model the same thing again is not a
  // second answer, it is the same one paid for twice.
  if (conflict.paths.length === 0) {
    return {
      next: "stop",
      end: {
        outcome: "base_conflict",
        detail: mergeFailedDetail(baseRef, conflict.tip, branch, conflict.detail),
      },
    };
  }
  // SCP-194: only a resolution that came back to the same conflict stops
  // here. The remediation cap is not consulted, because a conflict round
  // is not remediation and refusing one on the strength of the rounds
  // spent answering findings would leave a branch nobody can merge.
  if (facts.kind === "resolve_conflict") {
    return {
      next: "stop",
      end: {
        outcome: "base_conflict",
        detail:
          `${baseRef} at ${conflict.tip} will not merge into ` +
          `${branch}: ${conflict.paths.join(", ")}. ` +
          "The round given the conflict did not resolve it, so a person reconciles those files.",
      },
    };
  }
  return {
    next: "advance",
    kind: "resolve_conflict",
    remediation: false,
    carry: {
      conflict: {
        tip: conflict.tip,
        paths: conflict.paths,
        before_executor: false,
        resume_kind: facts.kind,
      },
    },
  };
}

/** What a round given a base conflict left behind, once it has been sealed. */
export interface ResolutionFacts {
  /**
   * Paths of the resolution's own change set still holding a conflict marker.
   * Read from the worktree, because a round that committed the markers rather
   * than resolving them leaves a branch that merges cleanly and builds
   * nothing, and `git` cannot tell.
   */
  markers: string[];
  /** How many files the resolution changed, which is what the loop reports. */
  changedPaths: number;
  /** Whether the conflict was found before the executor, so the round's own brief is still owed. */
  beforeExecutor: boolean;
  /** What the round was for before the conflict took it over (SCP-194). */
  resumeKind: RoundKind;
  relevel: boolean;
  round: number;
}

/** Where a resolution round goes, and what the loop says on the way. */
export interface ResolutionRouting {
  /** What the loop tells the person, and null where the resolution did not land. */
  say: string | null;
  /**
   * The step, and null where what follows is the judgement the interrupted
   * round was heading for — over this round's change set, which is that work
   * merged with the base.
   */
  step: Stop | Advance | null;
}

/**
 * SCP-192: the resolution landed and the branch is level with the base again,
 * so what follows is whatever the conflict interrupted.
 */
export function routeResolution(facts: ResolutionFacts): ResolutionRouting {
  if (facts.markers.length > 0) {
    return {
      say: null,
      step: {
        next: "stop",
        end: {
          outcome: "base_conflict",
          detail:
            `the round given the base conflict left a conflict marker in ${facts.markers.join(", ")}, ` +
            "so the merge is not resolved whatever git reports; a person reconciles those files",
        },
      },
    };
  }
  const say = `the base conflict is resolved on ${facts.changedPaths} file(s)`;
  // SCP-227: a re-level has no brief of its own to return to. The
  // resolution changed the change set, so what follows is the fresh
  // review, and its verdict is the run's.
  if (!facts.beforeExecutor || facts.relevel) return { say, step: null };
  // The round's own brief has not run yet: it is the next round's, and
  // it is whichever brief the conflict interrupted (SCP-194).
  return {
    say,
    step: {
      next: "advance",
      kind: facts.resumeKind,
      remediation: false,
      carry: {
        conflict: null,
        ...(facts.resumeKind === "execute" ? { executeRound: facts.round + 1 } : {}),
      },
    },
  };
}
