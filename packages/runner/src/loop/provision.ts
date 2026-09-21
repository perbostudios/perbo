import {
  assertWithinLimits,
  type ExecutionAttempt,
  type PermissionProfile,
  type PlanContractWithCriteria,
  type SecretIndex,
  type VerifiedCommit,
} from "@perbo/contracts";
import {
  cleanup,
  materialize,
  provision,
  type MaterializedWorkspace,
  type Workspace,
} from "@perbo/workspace";
import { recordedBaseVerification, specCommitOnRecord } from "../attempts.js";
import { sweepWorktree } from "../orphans.js";
import { readPrinciples, readPrinciplesFile } from "../principles.js";
import { buildPermissionProfile } from "../profile.js";
import { RETAINED_DIFF_ARTIFACT, ResumeRefusedError, sameCommit } from "../resume.js";
import { headCommit } from "../seal.js";
import { commitSpec } from "../spec-commit.js";
import type { TicketRunConfig } from "./config.js";
import { resetToPullRequest } from "./relevel.js";
import type { StartedRun } from "./start.js";
import type { Ledger } from "./ledger.js";
import { attemptIdFor, type RoundState } from "./state.js";

/**
 * Provisioning the worktree a round's attempt runs in.
 */

/** What a round has as it starts, before anything is briefed or run. */
export interface RoundEntry {
  /** The state the round runs with: a round after the first has its own worktree. */
  state: RoundState;
  attemptId: string;
  /** When the attempt started; its record and its bundles are stamped with it. */
  at: Date;
  /**
   * The attempt this one continues: the last one this run recorded, whether
   * that is the previous round's or the transport failure this one answers.
   * Read from the attempts themselves rather than from the round records,
   * which hold one entry per round and so cannot name a retried attempt.
   */
  previous: ExecutionAttempt | undefined;
}

/**
 * Start a round: check the run's ceilings, mint the attempt's id, and give the
 * round its own worktree.
 *
 * A worktree per round after the first this run runs, counted in attempts
 * rather than rounds because a run that continues a remediation starts at
 * round 1 in the worktree already provisioned for it. A retry and a ceiling
 * continuation run in the round's own worktree, where the diff is already
 * applied.
 */
export async function provisionRound(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  ledger: Ledger;
  state: RoundState;
  rootAttemptId: string;
  /** The branches the ticket's record already names, so provisioning reuses them. */
  branchesOnRecord: { delivery: string | null; attempt: string | null };
  clock: () => Date;
}): Promise<RoundEntry> {
  const { config, contract, ledger, state } = args;
  // Every attempt the run starts passes the run's ceilings — the retry
  // included, so a kill switch flipped or a budget spent between the
  // failure and the retry stops it as it would stop a round.
  assertWithinLimits(config.limits, "remediation_rounds", state.remediationRound);
  const at = args.clock();
  const attemptId = attemptIdFor({
    root: args.rootAttemptId,
    round: state.round,
    transport_retry: state.transportRetry,
    ceiling_continuation: state.ceilingContinuation,
  });
  const previous = ledger.last();
  if (ledger.attempts.length === 0 || state.transportRetry > 0 || state.ceilingContinuation > 0) {
    return { state, attemptId, at, previous };
  }
  const provisioned = await provision({
    repository_root: config.repository_root,
    repository_id: contract.scope.repository_id,
    ticket_key: config.ticket_key,
    ticket_id: contract.ticket_id,
    outcome: contract.outcome,
    recorded: args.branchesOnRecord,
    base_commit: contract.base.base_commit,
    attempt_id: attemptId,
    root: config.worktree_root,
    limits: config.limits,
    continues: { root_attempt_id: args.rootAttemptId },
    now: at,
  });
  return { state: { ...state, workspace: provisioned }, attemptId, at, previous };
}

/** What a run has once its worktree exists and the repository is in it. */
export interface ProvisionedRun {
  workspace: Workspace;
  materialized: MaterializedWorkspace;
  secrets: SecretIndex;
  /** D-103: the commit the spec was put on the branch as, where there was one. */
  specCommit: string | null;
  /** The spec's paths, which every seal after it leaves out. */
  sealExclusions: { spec_paths?: string[] };
  /** What the manifest's verify command said of the commit this worktree was cut at. */
  provisioningVerify: VerifiedCommit | null;
  /** What it said of the contract's own base commit, which the review is told. */
  baseVerification: VerifiedCommit | null;
  profile: PermissionProfile;
  /** D-065 option 3: the product principles the person has recorded. */
  principles: string | null;
}

/**
 * Provision the run's worktree and put the repository into it: the branch, a
 * re-level's reset, the spec commit, the materialization and what measured the
 * base.
 *
 * Every refusal from here sweeps the worktree and cleans it up before it
 * throws, because from here on there is something to leave behind.
 */
export async function provisionRun(args: {
  config: TicketRunConfig;
  started: StartedRun;
  /** The attempt that sealed a commit, for a re-level reading its own branch. */
  sealedBy: (sha: string) => string | null;
  clock: () => Date;
  progress: (message: string) => void;
}): Promise<ProvisionedRun> {
  const { config, started, clock, progress } = args;
  const { contract, resumeSource } = started;
  const workspace = await provision({
    repository_root: config.repository_root,
    repository_id: contract.scope.repository_id,
    ticket_key: config.ticket_key,
    ticket_id: contract.ticket_id,
    outcome: contract.outcome,
    recorded: started.record.branchesOnRecord,
    base_commit: contract.base.base_commit,
    attempt_id: started.record.rootAttemptId,
    root: config.worktree_root,
    limits: config.limits,
    now: clock(),
  });
  progress(`worktree ${workspace.path} on ${workspace.branch} at ${workspace.base_commit}`);
  if (config.relevel) {
    await resetToPullRequest({
      config,
      workspace,
      onRecord: started.record.onRecord,
      sealedBy: args.sealedBy,
      progress,
    });
  }
  // The base the contract pins may be abbreviated; this is the commit the
  // worktree is actually on, and it is what the retained diff has to match.
  if (resumeSource !== null && !sameCommit(resumeSource.base_commit, workspace.base_commit)) {
    await sweepWorktree({ worktree: workspace.path, onProgress: progress });
    await cleanup({ workspace, root: config.worktree_root, outcome: "failure" }).catch(() => undefined);
    throw new ResumeRefusedError(
      resumeSource.bundle_id,
      `${resumeSource.bundle_id}'s ${RETAINED_DIFF_ARTIFACT} was made against ` +
        `${resumeSource.base_commit} and this attempt's worktree is at ${workspace.base_commit}: ` +
        "the base commit has moved, so the diff no longer describes this tree",
    );
  }

  /**
   * D-103: the spec the change is judged against, put on the branch before
   * anything else — before the materialization, before the base is merged up
   * and before the executor is invoked, so it is the branch's first commit
   * past the contract's base and every later step measures a branch that
   * already carries it.
   *
   * A refusal here leaves the worktree swept and removed, as every refusal
   * after provisioning does: nothing has been materialized, nothing has been
   * executed and nothing has been paid for.
   */
  let specCommit: string | null;
  let specPaths: string[];
  try {
    const sealed = await commitSpec({
      worktree: workspace.path,
      repository_root: config.repository_root,
      base_commit: workspace.base_commit,
      ticket_key: config.ticket_key,
      attempt_id: started.record.rootAttemptId,
      files: config.spec_files,
      recorded: specCommitOnRecord(started.record.prior),
      onProgress: progress,
    });
    specCommit = sealed.commit;
    specPaths = sealed.paths;
  } catch (error) {
    await sweepWorktree({ worktree: workspace.path, onProgress: progress });
    await cleanup({ workspace, root: config.worktree_root, outcome: "failure" }).catch(() => undefined);
    throw error;
  }
  /** What the change set never lists, whichever round it is (SCP-314). */
  const sealExclusions = specPaths.length === 0 ? {} : { spec_paths: specPaths };

  let materialized: MaterializedWorkspace;
  try {
    materialized = await materialize({
      workspace,
      manifest: started.manifest,
      limits: config.limits,
      warm: false,
      leaseRoot: config.worktree_root,
      onProgress: progress,
    });
  } catch (error) {
    await sweepWorktree({ worktree: workspace.path, onProgress: progress });
    // A cleanup that cannot finish must not replace the failure it is cleaning
    // up after. `cleanup` throws `cleanup_failed` where the worktree survives —
    // a tree neither Git nor a direct removal can delete is one way — and thrown from
    // here it became the only error a person saw, while the reason the run
    // actually stopped was discarded on the line below. The leftover still
    // matters, so it is reported rather than swallowed; it is a second fact
    // about a run that has already failed, not the failure itself.
    await cleanup({ workspace, root: config.worktree_root, outcome: "failure" }).catch(
      (cleanupError: unknown) => {
        progress(
          `warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      },
    );
    throw error;
  }
  const secrets: SecretIndex = materialized.secrets;

  /**
   * The verify this run's own provisioning ran, and the commit it ran at.
   *
   * The worktree starts at the contract's base only when this run created the
   * branch. A run continuing a ticket takes over a branch that already carries
   * commits, so its worktree starts on the ticket's own sealed head and the
   * verify measures that — which is a fact about the ticket's earlier work, not
   * about the base.
   */
  const provisioningHead = await headCommit({ worktree: workspace.path });
  const provisioningVerify: VerifiedCommit | null =
    materialized.verify === null || provisioningHead === null || !started.verifyMeasures
      ? null
      : { commit: provisioningHead, verified: materialized.verify.code === 0 };

  /**
   * Whether the contract's base commit passes the manifest's verify command:
   * the ticket's answer, and the one the review is told.
   *
   * Measured once, by the attempt that provisions at the base, and read back
   * from the ticket's attempts record by every attempt after it. Where nothing
   * has measured it — a record written before the field existed, a ticket
   * whose branch already carried commits the first time this ran, or a
   * manifest whose verify command measures nothing — the review is told
   * nothing rather than told the base is broken or sound.
   *
   * The base a merge-up moves to mid-run is not re-verified: this answers the
   * commit the contract pins, which is what `caused_by_change` is about.
   */
  const baseVerification: VerifiedCommit | null = !started.verifyMeasures
    ? null
    : (recordedBaseVerification(started.record.prior, workspace.base_commit) ??
      (provisioningVerify !== null && sameCommit(provisioningVerify.commit, workspace.base_commit)
        ? provisioningVerify
        : null));
  progress(
    baseVerification === null
      ? `nothing has verified ${workspace.base_commit.slice(0, 12)}, so a failing check is ` +
          "attributed to neither the base nor the change"
      : `${workspace.base_commit.slice(0, 12)} ` +
          `${baseVerification.verified ? "passes" : "fails"} the manifest's verify` +
          (provisioningVerify !== null &&
          !sameCommit(provisioningVerify.commit, baseVerification.commit)
            ? `; this attempt provisioned on ${provisioningVerify.commit.slice(0, 12)}, which ` +
              `${provisioningVerify.verified ? "passes" : "fails"} it`
            : ""),
  );

  const profile = buildPermissionProfile({
    worktree: workspace.path,
    provider: config.agent_provider,
    lifecycle_scripts: started.manifest.install.lifecycle_scripts.policy,
  });

  // The product principles the person has recorded (D-065 option 3). Read from
  // the repository root — the agent cannot write there (.perbo/** is
  // prohibited) — and handed to every brief as data.
  const principles = config.principles_path
    ? readPrinciplesFile(config.principles_path)
    : readPrinciples(config.repository_root);

  return {
    workspace,
    materialized,
    secrets,
    specCommit,
    sealExclusions,
    provisioningVerify,
    baseVerification,
    profile,
    principles,
  };
}
