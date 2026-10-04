import { closureVerifySchema, type ClosureVerification } from "@perbo/review";
import { ZERO_USAGE, createModel, type Model } from "@perbo/model";
import { formatUsd } from "@perbo/contracts";
import type {
  CheckResult,
  Finding,
  PlanContractWithCriteria,
  SecretIndex,
} from "@perbo/contracts";
import type { BundleStore } from "../../bundle.js";
import type { Decline } from "../../declines.js";
import type { SealResult } from "../../seal.js";
import { allowedPathsSentence } from "../../shell/index.js";
import type { TicketRunConfig } from "./config.js";
import type { LoopPorts } from "./context.js";
import type { Ledger } from "./ledger.js";
import type { RoundRecord, RoundState, Step, Stop } from "./state.js";
import { restoreJudgedCommit } from "./continuation.js";

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
    effort: config.reviewer_effort,
  });
}

/**
 * SCP-194: a scope round that widened the change set is refused before
 * anything is paid to verify it.
 *
 * Nothing is lost — the refused commit and its diff stay on the record, the
 * branch goes back to the commit last judged (`restoreJudgedCommit`), and the
 * finding stays open — and the stop says which paths arrived and what the
 * contract admits.
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
        `${facts.widened.slice(0, 5).join(", ")}` +
        `${facts.widened.length > 5 ? ` and ${facts.widened.length - 5} more` : ""} were not in ` +
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
  /**
   * The findings a person handed to the executor
   * (D-132): one still open when a
   * round stalls or exhausts its attempts goes back to that person.
   */
  handed: ReadonlySet<string>;
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
  // A round that stalls or exhausts its attempts with a finding a person
  // handed to the executor still open gives it back to them
  // (D-132).
  const backToPerson = (stop: Stop): Stop =>
    stillOpen.some((finding) => facts.handed.has(finding.key))
      ? {
          next: "stop",
          end: {
            outcome: "escalated",
            detail: `${stop.end.detail}; a finding a person handed to the executor is still open, so it is theirs to decide again`,
          },
        }
      : stop;
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
    return backToPerson({
      next: "stop",
      end: {
        outcome: "remediation_stalled",
        detail:
          `remediation round ${remediationRound} closed none of the ${toVerify.length} ` +
          `finding(s) it was given, so the next round would be the same brief against the ` +
          `same evidence. Still open: ${openKeys.join(", ")}` +
          declinedNote,
      },
    });
  }
  const closedAndRemaining =
    `remediation round ${remediationRound} closed ${closedHere} finding(s) and ` +
    `${stillOpen.length} remain, but `;
  if (remediationRound >= maxRounds) {
    return backToPerson({
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
    });
  }
  if (facts.budget !== null && facts.spend.priced > 0 && facts.spend.micros >= facts.budget) {
    return backToPerson({
      next: "stop",
      end: {
        outcome: "remediation_exhausted",
        detail:
          closedAndRemaining +
          `the ticket has spent ` +
          `${formatUsd(facts.spend.micros, 2)} of the ` +
          `${formatUsd(facts.budget, 2)} in ` +
          `limits.limits.ticket_cost_micros (${configPath}). Still open: ` +
          `${openKeys.join(", ")}` +
          declinedNote,
      },
    });
  }
  return {
    next: "advance",
    kind: "remediate",
    remediation: true,
    carry: { openFindings: stillOpen },
  };
}

/**
 * Verify the closures a remediation round was asked for, and route what the
 * verification says.
 *
 * A scope round that widened is refused before anything is paid to verify it,
 * and a declined finding skips the model half and stays open: what the
 * verifier is asked is only what the executor said it closed.
 */
export async function verifyRound(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  state: RoundState;
  ledger: Ledger;
  bundles: BundleStore;
  attemptId: string;
  sealed: SealResult;
  /** The whole-change check results the verification is gated on. */
  gating: CheckResult[];
  declines: Decline[];
  /** The findings this round was asked to close. */
  toClose: Finding[];
  widened: string[];
  scopeGiven: Finding[];
  pathsAllowed: string[];
  /** The round's record before its verification judged it: its attempt, checks and declines. */
  record: RoundRecord;
  maxRounds: number;
  /** The ticket's budget for this attempt's credential, null where it has none. */
  budget: number | null;
  configPath: string;
  secrets: SecretIndex;
  verify: LoopPorts["verify"];
  clock: () => Date;
  progress: (message: string) => void;
}): Promise<Step> {
  const { config, state, ledger, sealed, progress } = args;
  // D-065: declined findings are the person's now — they skip the model
  // half of verification and leave the executor's open set. The
  // deterministic half still applies to the round's tree: verifyClosures
  // consults the pinned checks and the scope computation before asking
  // anything, and with zero findings left it gates on those alone.
  // SCP-194: a scope round that widened is refused before anything is
  // paid to verify it. Nothing is lost — the refused commit and its diff stay
  // on the record and the finding stays open — and the stop says which paths
  // arrived and what the contract admits. The refusal is recorded as the
  // round's verification, a scope failure that moves the round to
  // `independent_review` as a closure verification does (D-061), so a person
  // reads what it was judged on. It judged no tree a later round can build
  // on, so the branch goes back to the commit last judged.
  const declinedKeys = new Set(args.declines.map((decline) => decline.finding_key));
  const toVerify = args.toClose.filter((finding) => !declinedKeys.has(finding.key));
  const widenedStep = refuseWidening({
    widened: args.widened,
    scopeGiven: args.scopeGiven,
    remediationRound: state.remediationRound,
    pathsAllowed: args.pathsAllowed,
  });
  if (widenedStep !== null) {
    recordVerification(args, toVerify, widenedVerification(toVerify, widenedStep.end.detail), "refusal");
    // The refused commit stays on the record; the branch goes back to the
    // commit last judged, where a person's answers to that judgement act.
    const back = await restoreJudgedCommit({
      worktree: state.workspace.path,
      branch: state.workspace.branch,
      bundles: args.bundles,
      ticket_id: args.contract.ticket_id,
    });
    if (back !== null) {
      progress(
        `the branch is back at ${back}, the commit last judged; the refused round's commit ` +
          `${sealed.head_commit ?? "(none)"} and its diff stay on the record`,
      );
    }
    return widenedStep;
  }
  progress(`verifying closures, round ${state.round}`);
  const verification = await args.verify({
    findings: toVerify,
    diff: sealed.diff ?? "",
    checks: args.gating,
    scope: args.contract.scope,
    changeset: sealed.changeset!,
    model: verifierModel(
      config,
      toVerify.map((finding) => finding.key),
    ),
    onProgress: progress,
  });
  recordVerification(args, toVerify, verification, "verifier");

  return routeVerification({
    verification,
    toVerify,
    openFindings: state.openFindings,
    declines: ledger.declines.length,
    handed: new Set(state.directions.map((direction) => direction.finding_key)),
    remediationRound: state.remediationRound,
    maxRounds: args.maxRounds,
    spend: ledger.spend(),
    budget: args.budget,
    configPath: args.configPath,
  });
}

/**
 * What judged a refused round, as its bundle records it: the runner's scope
 * rule (SCP-194), with no prompt and no model, because none was asked.
 */
const REFUSAL_VERSIONS = {
  code: "stage-3",
  prompt: "none",
  policy: "scope-widening-refusal",
  model: "none",
  tool: "runner",
} as const;

/**
 * A widened round's verification: the scope failure the refusal states,
 * whole, and every finding the round was given still open, since nothing
 * was asked whether any of them closed.
 */
function widenedVerification(toVerify: readonly Finding[], refusal: string): ClosureVerification {
  return {
    prompt_version: REFUSAL_VERSIONS.prompt,
    per_finding: toVerify.map((finding) => ({
      finding_key: finding.key,
      status: "cannot_tell",
      pointer: "",
      idiomatic: "cannot_tell",
      practice: "",
    })),
    deterministic_failure: refusal,
    deterministic_failure_kind: "scope",
    all_closed: false,
    open_keys: toVerify.map((finding) => finding.key),
    usage: ZERO_USAGE,
    cost_micros: 0,
    cost_basis: "not_incurred",
  };
}

/**
 * A round's verification on the record: its review bundle, which moves the
 * round from `VERIFYING` to `INDEPENDENT_REVIEW` as every closure
 * verification does (D-061), and the round beside it on the ledger.
 *
 * The verifier's bundle names the commit it judged as `head_commit`, which is
 * what a later run continues from. A refusal judged no tree, so it names the
 * commit it refused as `refused_head_commit` instead and anchors nothing: the
 * runner resets the branch to the commit last judged (`restoreJudgedCommit`),
 * and a later run continues from there.
 */
function recordVerification(
  args: Pick<
    Parameters<typeof verifyRound>[0],
    "config" | "contract" | "state" | "ledger" | "bundles" | "attemptId" | "sealed" | "declines" | "record" | "secrets" | "clock"
  >,
  toVerify: readonly Finding[],
  verification: ClosureVerification,
  judge: "verifier" | "refusal",
): void {
  const { config, state, sealed, clock } = args;
  const refused = judge === "refusal";
  args.bundles.write({
    kind: "review",
    subject_id: `cv_${args.attemptId}`,
    ticket_id: args.contract.ticket_id,
    inputs: {
      changeset_id: sealed.changeset?.changeset_id ?? null,
      base_commit: state.baseCommit,
      ...(refused ? { refused_head_commit: sealed.head_commit } : { head_commit: sealed.head_commit }),
      remediation_round: state.round,
      round_kind: state.kind,
      verification: true,
      all_closed: verification.all_closed,
      deterministic_failure: verification.deterministic_failure,
      // SCP-194: the other half of the round's record — what it was
      // given, above, and which of those it closed. The ladder needs
      // both, and a `per_finding` row is not readable without knowing
      // the set it was drawn from.
      findings_given: toVerify.map((finding) => finding.key).join(","),
      findings_closed: verification.per_finding
        .filter((row) => row.status === "closed")
        .map((row) => row.finding_key)
        .join(","),
      findings_open: verification.open_keys.join(","),
    },
    context_manifest: [],
    versions: refused
      ? { ...REFUSAL_VERSIONS }
      : {
          code: "stage-3",
          prompt: verification.prompt_version,
          policy: "closure-verification",
          model: config.reviewer_model ?? config.model,
          tool: config.reviewer_provider,
        },
    usage: {
      input_tokens: verification.usage.input_tokens,
      output_tokens: verification.usage.output_tokens,
      cost_micros: verification.cost_micros,
      cost_basis: verification.cost_basis,
      wall_clock_ms: 0,
    },
    artifacts: [
      {
        name: "verification.json",
        media_type: "application/json",
        body: JSON.stringify(verification, null, 2),
      },
    ],
    errors: [],
    transitions: [
      {
        at: clock().toISOString(),
        from: "VERIFYING",
        to: "INDEPENDENT_REVIEW",
        reason: verification.all_closed ? "closures verified" : "closures still open",
      },
    ],
    retention: { class: "replay_retained", expires_at: null },
    secrets: args.secrets,
    excluded_paths: sealed.excluded_paths,
    deterministic: refused,
    model_version_pinned: true,
    now: clock(),
  });

  args.ledger.addRound({
    ...args.record,
    verification,
    // Open after verification plus declined: everything a person still
    // has in front of them at the end of this round.
    remediable_findings: verification.open_keys.length + args.declines.length,
  });
}
