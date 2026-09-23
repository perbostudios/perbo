import { join, resolve } from "node:path";
import { z } from "zod";
import {
  assertProviderEnabled,
  attemptsFileName,
  hasAcceptanceCriteria,
  isRefusal,
  type MaterializationManifest,
  type PlanContract,
  type PlanContractWithCriteria,
} from "@perbo/contracts";
import { diagnose, isGreenfieldVerify, signableCommit, validateManifest } from "@perbo/workspace";
import {
  lastAttemptBranch,
  lastAttemptId,
  lastExecutorAccount,
  parkedWait,
  readAttemptsRecord,
  rootAttemptId as mintRootAttemptId,
  runsOnRecord,
  type AttemptsRecord,
} from "../../attempts.js";
import { BundleStore } from "../../bundle.js";
import type { HeldRunLock } from "../../lock.js";
import { restoreAny } from "../../quarantine.js";
import { RunRefusedError } from "../../refusal.js";
import { resolveResumeSource, type ResumeSource } from "../../resume.js";
import type { TicketRunConfig } from "./config.js";
import type { RunLimits } from "./context.js";

/**
 * Everything a run settles before it provisions anything.
 */

/** What the ticket's attempts record says before this run adds to it. */
export interface PriorRecord {
  attemptsPath: string;
  prior: AttemptsRecord | null;
  /**
   * The number this run records its attempts under: the larger of what the
   * caller counted and what the record holds, then the first number whose root
   * is not already on the record.
   */
  runNumber: number;
  rootAttemptId: string;
  /**
   * The previous run's last attempt, which this run's first attempt continues
   * from — the same relation a remediation round has to the round before it.
   */
  continuesPreviousRun: string | null;
  /**
   * D-092: and its account, for a remediation round this run opens with — a
   * re-run of a ticket whose last review left findings open starts one, and
   * its predecessor is on the record rather than in `attempts`.
   */
  previousRunAccount: string | null;
  /**
   * Every attempt id and root id the record already names, which a re-level
   * reads to tell the loop's own commits on the branch from a person's.
   */
  onRecord: ReadonlySet<string>;
  /**
   * The branch this ticket already has, which every worktree this run
   * provisions keeps: its delivery record's, then its latest attempt's (D-098).
   */
  branchesOnRecord: { delivery: string | null; attempt: string | null };
}

/** What a run holds once nothing is left that could refuse it for free. */
export interface StartedRun {
  contract: PlanContractWithCriteria;
  bundles: BundleStore;
  record: PriorRecord;
  resumeSource: ResumeSource | null;
  manifest: MaterializationManifest;
  /**
   * Whether the manifest's verify command measures anything. `git status
   * --porcelain` passes on any checkout Git can read, so what it says of a base
   * is no measurement: the base is left unmeasured, the review is told nothing
   * about it, no attempt records an answer, and no answer on record is read
   * back while the verification measures nothing.
   */
  verifyMeasures: boolean;
}

/**
 * Settle everything a run can be refused for before it has cost anything: the
 * plan, the providers, a quarantine an earlier crash left, the ticket's record
 * and this run's number, a park still in force, the cut attempt a resume
 * names, and whether this repository can be materialized at all.
 *
 * Nothing here provisions a worktree, so a refusal from any of it cuts no
 * branch and leaves nothing to clean up.
 */
export async function start(args: {
  config: TicketRunConfig;
  contract: PlanContract;
  lock: HeldRunLock;
  limits: RunLimits;
  clock: () => Date;
  wait: (ms: number) => Promise<void>;
  progress: (message: string) => void;
}): Promise<StartedRun> {
  const { config, clock, progress } = args;
  if (!hasAcceptanceCriteria(args.contract)) {
    throw new Error(
      `plan ${args.contract.plan_id} is ${args.contract.level}, which has no acceptance criteria: ` +
        "there is nothing for an independent review to judge",
    );
  }
  const contract: PlanContractWithCriteria = args.contract;

  assertProviderEnabled(config.limits, "claude-code", config.model);
  // The reviewer's transport is a provider too. Checked here, before any
  // attempt is paid for, so a disabled reviewer stops the run rather than
  // discovering the switch after the executor has spent its budget.
  assertProviderEnabled(
    config.limits,
    config.reviewer_provider,
    config.reviewer_model ?? config.model,
  );
  // Crash recovery before anything else: a journal on disk means some worktree
  // is currently missing the configuration this runner moved out of it.
  for (const restored of restoreAny(config.quarantine_root)) {
    progress(`restored quarantined configuration from ${restored.attempt_id}`);
  }

  const bundles = new BundleStore({ root: config.bundle_root, retainContext: config.retain_context });
  const attemptsPath = join(config.state_root, attemptsFileName(contract.ticket_id));
  /**
   * Every attempt of every earlier run, read before this one starts: what this
   * run's attempts are appended to, what attributes the commits already on the
   * branch, and — where nothing else counts the runs — how many there have been.
   */
  const priorAttempts = readAttemptsRecord(attemptsPath);
  // The larger of what the caller counted and what the record holds, then the
  // first number whose root is not on the record. A re-level records its
  // attempts under the number after the record's last run without adding to
  // the caller's count, and a counted run refused after its root was minted
  // leaves a gap the record's count does not see: either way the number the
  // count arrives at can already be taken (SCP-227). Settled before the
  // worktree, the materialization and the agent, so nothing is paid for first.
  const onRecord = new Set(
    (priorAttempts?.attempts ?? []).flatMap((attempt) => {
      const ids = z.object({ attempt_id: z.string(), root_attempt_id: z.string().optional() }).safeParse(attempt);
      return ids.success ? [ids.data.attempt_id, ...(ids.data.root_attempt_id ? [ids.data.root_attempt_id] : [])] : [];
    }),
  );
  const mintRoot = (run: number) =>
    mintRootAttemptId({
      plan_id: contract.plan_id,
      plan_version: contract.version,
      ticket_key: config.ticket_key,
      runs_started: run,
    });
  let runNumber = Math.max(config.runs_started ?? 0, runsOnRecord(priorAttempts) + 1);
  while (onRecord.has(mintRoot(runNumber))) runNumber += 1;
  const rootAttemptId = mintRoot(runNumber);
  /**
   * The previous run's last attempt, which this run's first attempt continues
   * from — the same relation a remediation round has to the round before it.
   */
  const continuesPreviousRun = lastAttemptId(priorAttempts);
  /**
   * D-092: and its account, for a remediation round this run opens with — a
   * re-run of a ticket whose last review left findings open starts one, and
   * its predecessor is on the record rather than in `attempts`.
   */
  const previousRunAccount = lastExecutorAccount(priorAttempts);
    if (priorAttempts !== null) {
    progress(
      `run ${runNumber} of ${config.ticket_key}; ${priorAttempts.attempts.length} attempt(s) ` +
        `already on record, continuing ${continuesPreviousRun}`,
    );
  }
  /**
   * SCP-193: a wait a previous process was killed in the middle of.
   *
   * The park is written to the attempts record before the run sleeps, so a
   * `run` typed after that process died reads the instant the provider named
   * and waits out what is left of it. Without this the restart is the thing the
   * park exists to prevent: an attempt started against a session limit that is
   * still in force, which the provider refuses and the run pays for.
   */
  const parked = parkedWait(priorAttempts);
  if (parked !== null) {
    const remaining = Date.parse(parked.until) - clock().getTime();
    if (remaining > args.limits.waitBoundMs) {
      // The park was recorded under a bound this run no longer has, which only
      // happens when somebody lowered it. Said out loud rather than silently
      // waiting past the new bound or silently ignoring the record.
      progress(
        `${config.ticket_key} is parked until ${parked.until} (${parked.zone}), which is beyond ` +
          `limits.limits.wait_for_provider_ms in ${args.limits.configPath}; starting now rather than waiting ` +
          "past a bound this configuration does not allow",
      );
    } else if (remaining > 0) {
      progress(
        `${config.ticket_key} was parked on ${parked.reason.replace(/_/g, " ")} until ` +
          `${parked.until} (${parked.zone}); honouring the ${Math.round(remaining / 60_000)} ` +
          "minute(s) still to run",
      );
      args.lock.parked(parked);
      await args.wait(remaining);
      args.lock.parked(null);
    }
  }

  /**
   * SCP-154: the cut attempt this run continues, read before anything is
   * provisioned. A `--resume-from` that cannot be honoured stops the run here,
   * where it has cost nothing, rather than after a worktree and an install.
   */
  const resumeSource: ResumeSource | null =
    config.resume_from === null
      ? null
      : resolveResumeSource({
          bundle_root: config.bundle_root,
          bundle_id: config.resume_from,
          ticket_id: contract.ticket_id,
          base_commit: contract.base.base_commit,
        });

  const checkout = resolve(config.repository_root);
  /**
   * ADR-0025: whether this repository can be materialized at all, answered
   * from the checkout and the contract before anything is provisioned, so a
   * refusal cuts no branch and no worktree.
   *
   * The whole diagnostic, not just the manifest it proposed: where it proposed
   * none, its findings are the only thing that says why, and they are what the
   * refusal carries out to the person.
   */
  const diagnostic =
    config.materialization_manifest === null
      ? await diagnose({ checkout, repository_id: contract.scope.repository_id })
      : null;
  /**
   * Whether the key this checkout signs its commits with can sign one, asked
   * here as well because signing is a property of the checkout rather than of
   * the manifest: a configured manifest skips the diagnostic that would
   * otherwise have asked, and the seal would then be the first thing to find out.
   */
  const signing = config.materialization_manifest === null ? null : await signableCommit(checkout);
  const manifest = config.materialization_manifest ?? diagnostic?.proposed ?? null;
  // The advisories are dropped: what stopped the run is what a person needs to
  // fix, and a report that mixes the two reads as one long complaint.
  const refused = [
    ...(diagnostic?.findings ?? []).filter(isRefusal),
    ...(signing === null ? [] : [signing]),
  ];
  if (!manifest) {
    throw new RunRefusedError({
      message: "this repository cannot be materialized, so no attempt was started",
      findings: refused,
      repository_root: checkout,
    });
  }
  // A refusal the manifest did not depend on. The diagnostic answers a wider
  // question than "is there a manifest" — a repository it refuses is one an
  // attempt cannot finish, whether or not there is something to materialize.
  if (refused.length > 0) {
    throw new RunRefusedError({
      message: "this repository was refused before an attempt started",
      findings: refused,
      repository_root: checkout,
    });
  }
  const invalid = validateManifest(manifest);
  if (invalid.length > 0) {
    throw new RunRefusedError({
      message:
        "the materialization manifest does not describe this checkout, so no attempt was started",
      findings: invalid,
      repository_root: checkout,
    });
  }

  /**
   * Whether the manifest's verify command measures anything. `git status
   * --porcelain` passes on any checkout Git can read, so what it says of a base
   * is no measurement: the base is left unmeasured, the review is told nothing
   * about it, no attempt records an answer, and no answer on record is read
   * back while the verification measures nothing.
   */
  const verifyMeasures = !isGreenfieldVerify(manifest.verify.command);

  /**
   * The branch this ticket already has, which every worktree this run
   * provisions keeps: its delivery record's, then its latest attempt's (D-098).
   */
  const branchesOnRecord = { delivery: config.delivery_branch, attempt: lastAttemptBranch(priorAttempts) };

  return {
    contract,
    bundles,
    record: {
      attemptsPath,
      prior: priorAttempts,
      runNumber,
      rootAttemptId,
      continuesPreviousRun,
      previousRunAccount,
      onRecord,
      branchesOnRecord,
    },
    resumeSource,
    manifest,
    verifyMeasures,
  };
}
