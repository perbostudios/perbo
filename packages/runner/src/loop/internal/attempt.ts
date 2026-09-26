import { join } from "node:path";
import {
  configPath,
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  ExecutionAttemptSchema,
  limitFor,
  STORE_DIRNAME,
  type AttemptWait,
  type CheckResult,
  type ExecutionAttempt,
  type Finding,
  type LimitedResource,
  type MaterializationManifest,
  type PermissionProfile,
  type PlanContractWithCriteria,
  type SecretIndex,
  type VerifiedCommit,
  type TerminationReason,
} from "@perbo/contracts";
import type { MaterializedWorkspace } from "@perbo/workspace";
import type { AgentResult } from "../../adapter.js";
import { executorAccount } from "../../account.js";
import type { BundleStore } from "../../bundle.js";
import type { AttemptCeilings } from "../../ceilings.js";
import { parseDeclines, type Decline } from "../../declines.js";
import type { SweptProcess } from "./orphans.js";
import type { buildAgentEnvironment } from "../../profile.js";
import {
  EXECUTOR_PROMPT_VERSION,
  RESUMED_EXECUTOR_PROMPT_VERSION,
  conflictPromptVersion,
} from "../../prompt.js";
import { resumedFromRecord } from "../../resume.js";
import type { SealResult } from "../../seal.js";
import { allowedPathsSentence } from "../../shell/index.js";
import { resetInText, type ProviderReset } from "../../transport.js";
import type { Brief } from "./brief.js";
import type { TicketRunConfig } from "./config.js";
import type { Ledger } from "./ledger.js";
import type { RoundState } from "./state.js";

/**
 * What one attempt ended as, and what the record says about it.
 */

/** The limits-table key behind each ceiling termination, so the stop names its setting. */
const CEILING_RESOURCE: Partial<Record<TerminationReason, LimitedResource>> = {
  stalled: "attempt_stall_ms",
  wall_clock_exceeded: "attempt_wall_clock_ms",
  command_ceiling_exceeded: "attempt_commands",
  iteration_ceiling_exceeded: "attempt_iterations",
  round_iteration_ceiling_exceeded: "round_iterations",
  token_ceiling_exceeded: "attempt_tokens",
  cost_ceiling_exceeded: "attempt_cost_micros",
};

/**
 * A ceiling is configuration, and a partner meeting one should see the key
 * and the file that raise it rather than a bare number.
 */
export function withCeilingGuidance(
  termination: { reason: TerminationReason; detail: string },
  config: TicketRunConfig,
): { reason: TerminationReason; detail: string } {
  const resource = CEILING_RESOURCE[termination.reason];
  if (!resource) return termination;
  const current = limitFor(config.limits, resource);
  return {
    reason: termination.reason,
    detail:
      `${termination.detail} — raise limits.limits.${resource} in ` +
      `${join(config.repository_root, STORE_DIRNAME, ...configPath())}` +
      (current === null ? "" : ` (currently ${current})`),
  };
}

/** Which executor prompt a round was briefed with, as the bundle records it. */
export function executorPromptVersion(
  config: TicketRunConfig,
  kind: RoundState["kind"],
  resumed: boolean,
): string {
  if (kind === "resolve_conflict") return conflictPromptVersion(config.relevel_context);
  if (kind !== "execute") return "executor_remediation_v8";
  return resumed ? RESUMED_EXECUTOR_PROMPT_VERSION : EXECUTOR_PROMPT_VERSION;
}

/**
 * What the attempt ended as, once what it wrote has been judged.
 *
 * The executor's own reason wins where it is not `completed`; past that the
 * seal decides, and the precedence is prohibited action, a write the guard
 * should have refused, nothing changed, and a change set carried forward.
 */
export function classifyTermination(args: {
  config: TicketRunConfig;
  agentResult: AgentResult;
  sealed: SealResult;
  pathsAllowed: string[];
  /** The commits already on the branch before this attempt ran. */
  inherited: string[];
  carriedForward: boolean;
}): { reason: TerminationReason; detail: string } {
  const { config, agentResult, sealed, pathsAllowed, inherited, carriedForward } = args;
  /**
   * The commands the attempt asked for and did not get (SCP-163).
   *
   * An attempt that ends with nothing changed reads two ways, and the
   * difference is this list: an executor that judged the work already done
   * changed nothing by choice, and one whose clean-up and whose type-check
   * were refused changed nothing because it could not.
   */
  const denied = agentResult.commands.filter((command) => command.decision === "denied");
  // Whole commands, the first five, then how many more (D-NEW-nothing-shown-is-cut).
  const deniedSummary =
    denied
      .slice(0, 5)
      .map((command) => `${command.denial_rule ?? "unknown"} on ${command.denial_target ?? command.detail}`)
      .join("; ") + (denied.length > 5 ? `; and ${denied.length - 5} more` : "");
  if (agentResult.termination.reason !== "completed") {
    return withCeilingGuidance(agentResult.termination, config);
  }
  if (sealed.prohibited.length > 0) {
    return {
      reason: "prohibited_action",
      detail: sealed.prohibited.map((hit) => `${hit.action}: ${hit.detail}`).join("; "),
    };
  }
  // SCP-195: the guard refuses a write outside the contract's globs before it
  // happens, so a path here that is still outside them is one the guard never
  // saw. That is a hole in the runner, and the record says so rather than
  // passing the change on to a review that would spend a round finding it.
  if (sealed.outside_allowed_paths.length > 0) {
    return {
      reason: "runner_defect",
      detail:
        `the sealed change set carries ${sealed.outside_allowed_paths.length} path(s) ` +
        `outside what the contract admits a write under, which the pre-execution ` +
        `guard should have refused: ` +
        `${sealed.outside_allowed_paths.slice(0, 5).join(", ")}` +
        `${sealed.outside_allowed_paths.length > 5 ? ` and ${sealed.outside_allowed_paths.length - 5} more` : ""} — ` +
        `${allowedPathsSentence(pathsAllowed)}`,
    };
  }
  if (sealed.changeset === null) {
    if (denied.length === 0) {
      return { reason: "no_changes", detail: "the branch adds no change to its base" };
    }
    return {
      reason: "no_changes_after_denials",
      detail:
        `the branch adds no change to its base, and ${denied.length} command(s) ` +
        `the executor asked for were refused: ${deniedSummary}`,
    };
  }
  if (carriedForward) {
    return {
      reason: "completed",
      detail:
        `the executor added nothing to the ${inherited.length} commit(s) already ` +
        "on the branch; that change set is what was checked and reviewed",
    };
  }
  return { reason: "completed", detail: "" };
}

/**
 * SCP-194: a round given a scope escape that grew the change set.
 *
 * The brief quotes the contract's globs and asks for the change set to
 * come back inside them. A round that answered by adding files went the
 * other way, and the next round would be asked to undo more than the one
 * before it. Measured against the previous round's own change set rather
 * than against the globs, because a path inside the globs is still a path
 * the round was not asked to add.
 */
export function scopeWidening(args: {
  state: RoundState;
  /** The findings this round was asked to close. */
  toClose: Finding[];
  termination: { reason: TerminationReason };
  sealed: SealResult;
}): { scopeGiven: Finding[]; widened: string[] } {
  const { state, toClose, termination, sealed } = args;
  const scopeGiven = toClose.filter((finding) => finding.rule_id.startsWith("scope."));
  const widened =
    state.kind === "remediate" && scopeGiven.length > 0 && termination.reason === "completed"
      ? sealed.changed_paths.filter((path) => !state.previousChangedPaths.includes(path))
      : [];
  return { scopeGiven, widened };
}

/**
 * SCP-193: the reset a provider named on its way out, and the wait it buys.
 *
 * A 529 clears on its own in a minute and is answered by the fixed retry the
 * routing gives it. A session limit does not: `429 … resets 4:30am
 * (Europe/London)` says when the provider will serve again, and an attempt
 * started before then meets the same refusal and is paid for. So the reset is
 * read out of the sentence the runner already wrote onto the termination —
 * built from an anchored transport reading and from nothing else — and turned
 * into an instant.
 *
 * A reset further out than `wait_for_provider_ms` is not waited for at all.
 * The bound is a refusal to wait that long rather than an instruction to wait
 * less: waking before the provider's own reset spends an attempt against a
 * limit still in force, which is the thing the wait exists to avoid.
 */
export function providerPark(args: {
  termination: { reason: TerminationReason; detail: string };
  transportRetry: number;
  waitBoundMs: number;
  clock: () => Date;
}): { reset: ProviderReset | null; parkMs: number; park: AttemptWait | null } {
  const { termination, clock, waitBoundMs } = args;
  const reset =
    termination.reason === "transport_unavailable" && args.transportRetry === 0
      ? resetInText(termination.detail, clock())
      : null;
  const parkMs = reset === null ? 0 : reset.until.getTime() - clock().getTime();
  const park: AttemptWait | null =
    reset !== null && parkMs > 0 && parkMs <= waitBoundMs
      ? {
          reason: "provider_reset",
          started_at: clock().toISOString(),
          until: reset.until.toISOString(),
          waited_ms: parkMs,
          zone: reset.zone,
          quoted: reset.quoted,
        }
      : null;
  return { reset, parkMs, park };
}

/** What the round leaves on the ticket's record, and what its routing reads. */
export interface Recorded {
  /** The state the round goes on with: a completed round's change set is the next one's baseline. */
  state: RoundState;
  attempt: ExecutionAttempt;
  termination: { reason: TerminationReason; detail: string };
  /** D-065: the findings the executor declared no-determinable-practice for. */
  declines: Decline[];
  /** The paths a scope round added rather than removed (SCP-194). */
  widened: string[];
  /** The scope findings this round was asked to close. */
  scopeGiven: Finding[];
  reset: ProviderReset | null;
  park: AttemptWait | null;
  parkMs: number;
  /** Whether the attempt sealed commits of its own, rather than carrying an earlier attempt's. */
  sealedItsOwn: boolean;
}

/**
 * Record the attempt: what it ended as, what it wrote, and the bundle a reader
 * replays it from.
 *
 * Everything here is a statement about an attempt that is over. The routing
 * that follows reads this and nothing about the worktree.
 */
export function recordAttempt(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  state: RoundState;
  brief: Brief;
  bundles: BundleStore;
  ledger: Ledger;
  attemptId: string;
  rootAttemptId: string;
  /** The attempt this one continues, where this run recorded one. */
  previous: ExecutionAttempt | undefined;
  /** The attempt the ticket's record ends on, for a run that continues it. */
  continuesPreviousRun: string | null;
  at: Date;
  agentResult: AgentResult;
  ceilings: AttemptCeilings;
  environment: ReturnType<typeof buildAgentEnvironment>;
  profile: PermissionProfile;
  materialized: MaterializedWorkspace;
  manifest: MaterializationManifest;
  secrets: SecretIndex;
  sealed: SealResult;
  carriedForward: boolean;
  mergedBase: string | null;
  specCommit: string | null;
  baseVerification: VerifiedCommit | null;
  provisioningVerify: VerifiedCommit | null;
  swept: SweptProcess[];
  /** What the pinned set measured, recorded beside the attempt (D-045). */
  checks: CheckResult[];
  waitBoundMs: number;
  clock: () => Date;
  progress: (message: string) => void;
}): Recorded {
  const { config, contract, brief, sealed, secrets, profile, clock, progress } = args;
  let state = args.state;
  const termination = classifyTermination({
    config,
    agentResult: args.agentResult,
    sealed,
    pathsAllowed: brief.pathsAllowed,
    inherited: brief.inherited,
    carriedForward: args.carriedForward,
  });
  const { scopeGiven, widened } = scopeWidening({ state, toClose: brief.toClose, termination, sealed });
  if (termination.reason === "completed") {
    state = { ...state, previousChangedPaths: [...sealed.changed_paths] };
  }
  const { reset, parkMs, park } = providerPark({
    termination,
    transportRetry: state.transportRetry,
    waitBoundMs: args.waitBoundMs,
    clock,
  });

  // D-065: declines are parsed from the model's own decoded text before any
  // termination handling — an executor that declines everything and,
  // correctly, changes nothing must end as an escalation with its reasons,
  // not as `no_changes` — and sealed on the attempt's record, which is where a
  // pull request opened later reads them (D-NEW-publish-a-retained-branch-later).
  const declines =
    state.kind === "remediate"
      ? parseDeclines(args.agentResult.transcript, brief.toClose.map((finding) => finding.key))
      : [];
  if (declines.length > 0) {
    progress(`${declines.length} finding(s) declared no-determinable-practice`);
    args.ledger.addDeclines(declines);
  }

  const attempt = ExecutionAttemptSchema.parse({
    schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
    attempt_id: args.attemptId,
    root_attempt_id: args.rootAttemptId,
    // Round 0 of a re-run continues the previous run's last attempt, so the
    // chain a reader follows crosses runs rather than restarting at each —
    // and a resumed round 0 continues the stopped attempt whose work it holds,
    // which is the more specific answer to the same question.
    continues_attempt_id:
      args.previous?.attempt_id ?? brief.resumedHere?.attempt_id ?? args.continuesPreviousRun,
    remediation_round: state.round,
    created_at: args.at.toISOString(),
    ticket_id: contract.ticket_id,
    plan_id: contract.plan_id,
    plan_version: contract.version,
    planned_risk: contract.level,
    repository_id: contract.scope.repository_id,
    base_ref: config.base_ref,
    base_commit: state.baseCommit,
    provider: "local_worktree",
    branch: state.workspace.branch,
    worktree_path: state.workspace.path,
    autonomy_class: profile.autonomy_class,
    permission_profile: profile,
    agent: args.agentResult.invocation,
    executor_skills: brief.executorSkills,
    environment: {
      manifest_hash: args.materialized.manifest_hash,
      install_pinned: args.manifest.install.pinned,
      materialized_paths: args.materialized.materialized_paths,
      secret_content_sha256: secrets.entries.map((entry) => entry.content_sha256),
      port_range_start: args.materialized.ports.start,
      port_range_end: args.materialized.ports.end,
      database_schema: args.materialized.database_schema,
      env_names_passed: args.environment.passed,
      env_names_dropped: args.environment.dropped.length,
    },
    commands: args.agentResult.commands,
    egress: args.agentResult.egress.all(),
    prohibited_action_hits: [
      ...args.agentResult.prohibited.map((hit) => ({
        action: hit.action,
        detail: hit.detail,
        at: hit.at,
      })),
      ...sealed.prohibited.map((hit) => ({
        action: hit.action,
        detail: hit.detail,
        at: args.at.toISOString(),
      })),
    ],
    user_instructions: [],
    usage: {
      input_tokens: args.agentResult.usage.input_tokens,
      cache_creation_input_tokens:
        args.agentResult.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: args.agentResult.usage.cache_read_input_tokens,
      output_tokens: args.agentResult.usage.output_tokens,
      cost_micros: args.agentResult.usage.cost_micros,
      cost_basis: args.agentResult.usage.cost_basis,
      // Written only where it is true, so a completed attempt's record is
      // shaped exactly as it always was.
      ...(args.agentResult.usage.cost_partial ? { cost_partial: true } : {}),
      // Unlike billed usage, this deliberately retains repeated stream
      // envelopes because it is the counter the existing token guard ran.
      token_ceiling_tokens: args.ceilings.counts().tokens,
      wall_clock_ms: args.ceilings.counts().wall_clock_ms,
      commands: args.agentResult.commands.length,
      iterations: args.agentResult.usage.iterations,
    },
    termination,
    changeset_id: sealed.changeset?.changeset_id ?? null,
    head_commit: sealed.head_commit,
    prior_commits: brief.prior_commits,
    change_set_origin: args.carriedForward ? "carried_forward" : "attempt",
    // D-092: the executor's own account, read from its final message and
    // already redacted by the adapter. Null where it wrote none.
    executor_account: executorAccount(args.agentResult.final_message),
    // D-096: every time this round's brief went back after a compaction,
    // as the mechanism that carried it recorded them.
    brief_reinjections: args.agentResult.reinjections ?? [],
    resumed_from:
      brief.resumedHere === null || brief.resumeOutcome === null
        ? null
        : resumedFromRecord(brief.resumedHere, brief.resumeOutcome),
    merged_base: args.mergedBase,
    spec_commit: args.specCommit,
    // What the check attribution above rests on, and — separately — what
    // this attempt's own worktree started from.
    base_verification: args.baseVerification,
    provisioning_verify: args.provisioningVerify,
    swept_processes: args.swept,
    // Written before the loop sleeps, not after: a process killed while it
    // is parked has to leave the instant behind for the next run to honour.
    wait: park,
    declines,
  } satisfies ExecutionAttempt);
  // The next round inherits this one's commit and can name the attempt
  // that sealed it.
  args.ledger.addAttempt(attempt, !args.carriedForward ? sealed.head_commit : null);

  args.bundles.write({
    kind: "execution",
    subject_id: args.attemptId,
    ticket_id: contract.ticket_id,
    inputs: {
      plan_id: contract.plan_id,
      plan_version: contract.version,
      base_commit: state.baseCommit,
      merged_base: args.mergedBase,
      round_kind: state.kind,
      branch: state.workspace.branch,
      remediation_round: state.round,
      // SCP-194: what this round was handed, so the ladder a reader builds
      // from the bundles is the executor's own brief rather than an
      // inference from what changed. Empty for a round that was given no
      // findings — an execute round, or a conflict round.
      findings_given: brief.toClose.map((finding) => finding.key).join(","),
      findings_given_count: brief.toClose.length,
      invocation_shape: attempt.agent.shape_sha256,
      binary_version: attempt.agent.binary_version,
      termination: termination.reason,
      // The stopped attempt's bundle is referenced here and left exactly as it
      // was: this is a new record beside it, never a replacement for it.
      resumed_from_bundle: brief.resumedHere?.bundle_id ?? null,
      resumed_from_attempt: brief.resumedHere?.attempt_id ?? null,
      resumed_diff_sha256: brief.resumedHere?.diff_sha256 ?? null,
      // What the resume did with that diff: `applied`, `held` (the branch
      // already held the commit that attempt sealed, so it was not applied
      // again) or `dropped` (it did not apply); null where there was none.
      resumed_diff: brief.resumeOutcome?.state ?? null,
      // The commit the branch held, or the one the executor started from
      // where the diff was dropped; null where it was applied or there was none.
      resumed_diff_at:
        brief.resumeOutcome === null || brief.resumeOutcome.state === "applied"
          ? null
          : brief.resumeOutcome.at,
    },
    context_manifest: [],
    versions: {
      code: "stage-2",
      prompt: executorPromptVersion(
        config,
        state.kind,
        brief.resumedHere !== null &&
          brief.resumeOutcome !== null &&
          brief.resumeOutcome.state !== "dropped",
      ),
      policy: profile.autonomy_class,
      model: attempt.agent.model,
      tool: attempt.agent.binary_version,
    },
    usage: {
      input_tokens: attempt.usage.input_tokens,
      output_tokens: attempt.usage.output_tokens,
      cost_micros: attempt.usage.cost_micros,
      cost_basis: attempt.usage.cost_basis,
      ...(attempt.usage.cost_partial ? { cost_partial: true } : {}),
      wall_clock_ms: attempt.usage.wall_clock_ms,
    },
    artifacts: [
      { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt, null, 2) },
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: args.agentResult.transcript.join("\n") },
      { name: "prompt.txt", media_type: "text/plain", body: brief.prompt },
      // The deterministic half of the judgement, beside the attempt it
      // judged (D-045). The reviewer echoes the same results into its own
      // artifact, but only for the round it reviews and only when it is
      // reached: a remediation round is verified rather than reviewed, and
      // an attempt a ceiling cut has no review at all — so without this the
      // measurement that outranks the reviewer existed nowhere on disk.
      // Written even when it is empty, because "nothing was measured"
      // is a fact about the round and not an absence of one.
      {
        name: "checks.json",
        media_type: "application/json",
        body: JSON.stringify(args.checks, null, 2),
      },
      // Taken with `--binary`, so a resume applies every file the attempt
      // wrote, a binary one included (SCP-154).
      ...(sealed.retained_diff
        ? [{ name: "change.diff", media_type: "text/x-diff", body: sealed.retained_diff }]
        : []),
    ],
    errors: termination.reason === "completed" ? [] : [{ kind: termination.reason, message: termination.detail }],
    transitions: [
      { at: args.at.toISOString(), from: "PROVISIONING", to: "EXECUTING", reason: "worktree materialized" },
      { at: clock().toISOString(), from: "EXECUTING", to: "VERIFYING", reason: termination.reason },
    ],
    retention: { class: "raw_transcript", expires_at: null },
    secrets,
    excluded_paths: sealed.excluded_paths,
    deterministic: false,
    model_version_pinned: true,
    now: clock(),
  });

  return {
    state,
    attempt,
    termination,
    declines,
    widened,
    scopeGiven,
    reset,
    park,
    parkMs,
    // An attempt that carried an earlier one's commits forward sealed
    // nothing of its own to continue over.
    sealedItsOwn: !args.carriedForward && sealed.head_commit !== null,
  };
}
