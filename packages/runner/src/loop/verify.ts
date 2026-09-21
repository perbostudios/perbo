import { closureVerifySchema, type ClosureVerification } from "@perbo/review";
import { createModel, type Model } from "@perbo/model";
import type { Finding } from "@perbo/contracts";
import { allowedPathsSentence } from "../shell/index.js";
import type { TicketRunConfig } from "./config.js";
import type { Step, Stop } from "./state.js";

/**
 * Verifying the closures a remediation round claims (D-061).
 */

/**
 * The verifier transport (D-061). Same providers as the reviewer, but the
 * submit schema enumerates exactly the finding keys under verification, so the
 * tool cannot invent a finding or omit one silently.
 */
export function verifierModel(config: TicketRunConfig, keys: string[]): Model {
  return createModel(config.reviewer_provider, {
    submitSchema: closureVerifySchema(keys),
    modelId: config.reviewer_model,
  });
}

/**
 * SCP-194: a scope round that widened the change set is refused before
 * anything is paid to verify it.
 *
 * Nothing is lost — the change set stays on the branch and the finding stays
 * open — and the stop says which paths arrived and what the contract admits.
 * Null where the round narrowed, or was never a scope round at all.
 */
export function refuseWidening(facts: {
  /** The paths this round added that the contract does not admit. */
  widened: string[];
  /** The scope findings the round was given. */
  scopeGiven: readonly Finding[];
  remediationRound: number;
  /** The globs the contract admits, as the stop quotes them. */
  pathsAllowed: string[];
}): Stop | null {
  if (facts.widened.length === 0) return null;
  return {
    next: "stop",
    end: {
      outcome: "changes_requested",
      detail:
        `remediation round ${facts.remediationRound} was given ${facts.scopeGiven.length} scope ` +
        `finding(s) and widened the change set instead: ` +
        `${facts.widened.slice(0, 5).join(", ")}${facts.widened.length > 5 ? ", …" : ""} were not in ` +
        `the change set it was asked to narrow. ${allowedPathsSentence(facts.pathsAllowed)}`,
    },
  };
}

/** What a round's closure verification is routed against. */
export interface VerificationFacts {
  verification: ClosureVerification;
  /** The findings the round was asked to close, declined ones already out. */
  toVerify: readonly Finding[];
  /** The routed findings still open before this verification narrowed them. */
  openFindings: readonly Finding[];
  /** D-065: findings this run's executor declared no-determinable-practice for. */
  declines: number;
  remediationRound: number;
  maxRounds: number;
  /** What the ticket has spent, and the budget it is spent against. */
  spend: { micros: number; priced: number };
  budget: number | null;
  /** The repository's limits file, so a stop at the cap or the budget names where to raise it. */
  configPath: string;
}

/**
 * What a round's closure verification comes to: a stop, or the next round of
 * the same brief against a smaller set.
 *
 * The order is the rule (D-061, SCP-194): a deterministic failure sinks the
 * round whatever it closed, everything closed ends the run, and what earns
 * another round is progress — with the cap and then the ticket budget above
 * it, because progress can keep earning rounds only while there are rounds and
 * money left.
 */
export function routeVerification(facts: VerificationFacts): Step {
  const { verification, toVerify, remediationRound, maxRounds, declines, configPath } = facts;
  const declinedNote = declines > 0 ? ` (and ${declines} declined for a person)` : "";
  if (verification.deterministic_failure !== null) {
    // A round given a failing pinned check (d069) that leaves the checks
    // failing did not regress anything: it was the once, and the stop says
    // so. A scope or legibility failure after such a round is a regression.
    const answeringAFailingCheck =
      verification.deterministic_failure_kind === "check" &&
      toVerify.some(
        (finding) => finding.source === "deterministic" && finding.rule_id.startsWith("check."),
      );
    return {
      next: "stop",
      end: {
        outcome: "changes_requested",
        detail: answeringAFailingCheck
          ? `the pinned checks still fail after remediation round ${remediationRound}: ${verification.deterministic_failure}`
          : `the fix regressed: ${verification.deterministic_failure}`,
      },
    };
  }
  // Declined findings leave the executor's open set — the person decides
  // them — so the loop continues only for findings verification left open.
  const stillOpen = facts.openFindings.filter((finding) =>
    verification.open_keys.includes(finding.key),
  );
  if (stillOpen.length === 0) {
    return {
      next: "stop",
      end:
        declines === 0
          ? {
              outcome: "approved",
              detail:
                `round 0's routed findings verified closed after ${remediationRound} ` +
                "remediation round(s)",
            }
          : {
              outcome: "escalated",
              detail:
                `${declines} finding(s) declared no-determinable-practice by the ` +
                "executor; a person decides — the reasons are on the round record, and in the " +
                "pull request when one is opened",
            },
    };
  }

  /**
   * SCP-194: what earns the next round is progress, not an unspent count.
   *
   * A round that closed at least one finding has shown that the brief is
   * one the executor can act on, and the next round is the same brief
   * against a smaller set. A round that closed none has not, and running
   * it again is the same request against the same evidence for the same
   * money — which is how AYO-34 stopped `remediation_exhausted` with one
   * finding open that its own next round would have closed.
   */
  const closedHere = verification.per_finding.filter((row) => row.status === "closed").length;
  const openKeys = stillOpen.map((finding) => finding.key);
  if (closedHere === 0) {
    return {
      next: "stop",
      end: {
        outcome: "remediation_stalled",
        detail:
          `remediation round ${remediationRound} closed none of the ${toVerify.length} ` +
          `finding(s) it was given, so the next round would be the same brief against the ` +
          `same evidence. Still open: ${openKeys.join(", ")}` +
          declinedNote,
      },
    };
  }
  const closedAndRemaining =
    `remediation round ${remediationRound} closed ${closedHere} finding(s) and ` +
    `${stillOpen.length} remain, but `;
  if (remediationRound >= maxRounds) {
    return {
      next: "stop",
      end: {
        outcome: "remediation_exhausted",
        detail:
          closedAndRemaining +
          `${maxRounds} is the cap — raise ` +
          `max_remediation_rounds or limits.limits.remediation_rounds in ${configPath}. ` +
          `Still open: ${openKeys.join(", ")}` +
          declinedNote,
      },
    };
  }
  if (facts.budget !== null && facts.spend.priced > 0 && facts.spend.micros >= facts.budget) {
    return {
      next: "stop",
      end: {
        outcome: "remediation_exhausted",
        detail:
          closedAndRemaining +
          `the ticket has spent ` +
          `$${(facts.spend.micros / 1_000_000).toFixed(2)} of the ` +
          `$${(facts.budget / 1_000_000).toFixed(2)} in ` +
          `limits.limits.ticket_cost_micros (${configPath}). Still open: ` +
          `${openKeys.join(", ")}` +
          declinedNote,
      },
    };
  }
  return {
    next: "advance",
    kind: "remediate",
    remediation: true,
    carry: { openFindings: stillOpen },
  };
}
