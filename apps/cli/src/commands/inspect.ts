import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CheckResultsFileSchema,
  CostBasisSchema,
  EXIT_CODES,
  NodeReviewsSchema,
  ReviewArtifactSchema,
  RunBundleSchema,
  addRolls,
  attemptsPath,
  bundleManifestsDir,
  bundleObjectPath,
  bundleRoot,
  costLabel,
  costOf,
  costPhrase,
  formatUsd,
  limitFor,
  limitsForCredential,
  parseUnifiedDiff,
  planNodes,
  planSizeCounts,
  pullRequestAttribution,
  rollCosts,
  rollLabel,
  sizeEstimate,
  stateDir,
  ticketFilePath,
  ticketIdOfAttemptsFile,
  ticketSourceLabel,
  wholeChangeChecks,
  type ArtifactRef,
  type AttemptWait,
  type CheckResult,
  type Cost,
  type CostRoll,
  type DeliveredCheck,
  type DeliveryChecksState,
  type ExecutionAttempt,
  type Finding,
  type LimitedResource,
  type LimitsTable,
  type GraphEdge,
  type NodeReview,
  type PlanNode,
  type ReviewArtifact,
  type RunBundle,
  type RunBundleKind,
  type SizeCount,
  type SizeEstimate,
  type TicketSource,
} from "@perbo/contracts";
import { BundleStore, parseDeclines, runNumbers, type Decline } from "@perbo/runner";
import { formatDuration, formatHumanElapsed } from "../duration.js";
import { QUEUE_HOLDING_STATES, queueOrder } from "../scheduling.js";
import { UsageError } from "../usage-error.js";
import {
  BASE_SOURCE_LABEL,
  ceilingResourceFor,
  effectiveLimits,
  limitAtBreach,
  readAttemptsFile,
  readRepoConfig,
  reachedAtBreach,
  runsStartedBy,
  usageOf,
} from "./run/index.js";
import {
  listLocalRuns,
  readLocalRunRecord,
  type LocalRunRecord,
  type RunBase,
} from "./run/local.js";
import { WIDTH, clip, fitted, labelled, pad, painter, spread, wrap, type Paint } from "../text.js";
import { specStaleness } from "../spec/staleness.js";

import type { Diagnostics } from "../diagnostics.js";
import {
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../command-line/grammar.js";
import type { CommandContext, CommandReport, Rendered } from "../command.js";
import type { ReportCommand } from "../command-line/table.js";
import { readInput } from "../usage-error.js";
import { storeFor, StoreTargetSchema } from "../store/index.js";
import {
  activeVerdicts,
  readLocalVerdictsOrWarn,
  type LocalVerdict,
} from "./verdict/record.js";
// `admission.js` and not `tickets.js`: a leaner reading of the same file,
// which stays loose about everything the store's own writer already checked.
import type { StoredAdmission } from "../store/admission.js";
import { VERSION } from "../version.js";
import {
  TicketStoreError,
  listTickets,
  readApproachRecord,
  readContract,
  readTicketForDisplay,
  trackedFiles,
  type DisplayTicket,
} from "../store/tickets.js";
import { describeScheduling } from "./serve/waits.js";

/**
 * `perbo inspect` — read an attempt back (dogfood limitation 5).
 *
 * Every attempt writes an immutable bundle and, until this, no command read
 * one: diagnosing a run meant finding the store and opening JSON by hand. This
 * reads the attempts record the loop writes, joins each attempt to its
 * execution bundle, the one independent review and each round's closure
 * verification through the store, and renders what a person asks first —
 * how it ended, what it used against which ceiling, what the review said and
 * where every finding went.
 *
 * `--verify <attempt>` asks the other question: not what the record says, but
 * whether the store still holds the bytes it names. It recomputes the hash of
 * every object that attempt's bundles name, reports each one that does not
 * match, and exits non-zero if any did not — see {@link verifyAttemptObjects}.
 *
 * It reads only. Nothing here writes to the store, and the bundle bytes it
 * shows are the redacted ones the loop persisted.
 *
 * The record it reads is `<repo>/.perbo/`: working state of one machine. What
 * an *admitted ticket* adds — the key the record is filed under, the state it
 * is in, how it was admitted and where the work came from — {@link ticketSubject}
 * reads from the ticket file, and it answers from the attempts record for a
 * name no ticket claims.
 */

/**
 * An attempt's id as the loop mints one.
 *
 * The shape a *session* must supply through the endpoint, where an id is a
 * string a model returned and ADR-0023 §4 says what may become an action
 * parameter. A person at the terminal names an attempt they read off their
 * own store, and the store is what refuses one it does not hold.
 */
export const AttemptIdSchema = z
  .string()
  .regex(/^att_[0-9a-f]+$/, "an attempt id looks like att_0000000000000001");

export const InspectInputSchema = z
  .strictObject({
    target: StoreTargetSchema,
    /**
     * A ticket key, or the name of a run nothing admitted (SCP-284).
     *
     * Any name at all, including none: what a store holds is the store's
     * answer, and it gives it naming the name it was asked for.
     */
    key: z.string(),
    /** One attempt, for that attempt alone. */
    attempt: z.string().nullable(),
    /**
     * The attempt whose bundle objects are to be re-hashed, or null for a
     * reading rather than a check. Its own field and not a boolean beside
     * `attempt`, because the two answer different questions: `attempt`
     * narrows what is printed, `verify` prints nothing about the attempt at
     * all and returns a verdict on the bytes.
     */
    verify: z.string().nullable(),
  })
  // Refused rather than resolved in favour of one of them: `verify` names the
  // attempt it checks, so the two would be two answers to the same question
  // and a caller that gave both meant something this cannot tell.
  .superRefine((input, ctx) => {
    if (input.verify !== null && input.attempt !== null) {
      ctx.addIssue({
        code: "custom",
        message:
          "--verify names the attempt to check, so it cannot be given with --attempt: " +
          `perbo inspect ${input.key} --verify ${input.verify}`,
      });
    }
  });
export type InspectInput = z.infer<typeof InspectInputSchema>;

/** The closure verification as the loop persists it (`verification.json`). */
const ClosureVerificationFileSchema = z.object({
  prompt_version: z.string(),
  per_finding: z.array(
    z.object({
      finding_key: z.string(),
      status: z.enum(["closed", "not_closed", "cannot_tell"]),
      pointer: z.string(),
      idiomatic: z.string().optional(),
      practice: z.string().optional(),
    }),
  ),
  deterministic_failure: z.string().nullable(),
  all_closed: z.boolean(),
  open_keys: z.array(z.string()),
  cost_micros: z.number().int().min(0),
  cost_basis: CostBasisSchema,
});
type ClosureVerificationFile = z.infer<typeof ClosureVerificationFileSchema>;

export interface CeilingUse {
  resource: LimitedResource;
  used: number | null;
  /** Null where nothing bounds the resource, which is the counters' default. */
  ceiling: number | null;
  hit: boolean;
}

/**
 * One command the attempt asked for and did not get (SCP-163).
 *
 * An attempt that ended with nothing changed used to be unreadable: the record
 * said `no_changes`, and the thirteen refusals that made it inevitable were in
 * the attempt JSON nobody opened. The rule and the target are what a person can
 * act on — a path to move, or a verb to put on the allow-list.
 */
export interface DenialReport {
  tool: string;
  command: string;
  rule: string;
  target: string;
  reason: string;
  /**
   * The subagent role the refused call belongs to, and null for the
   * executor's own session (D-106). A refusal a child earned is not the
   * executor's, and which agent to brief differently is the thing a person
   * reads this section for.
   */
  agent: string | null;
  at: string;
}

/**
 * One rung of the remediation ladder (SCP-194).
 *
 * What a round was handed and what it closed — from the round's own bundles,
 * not inferred from the diff. `kind` is here because a `resolve_conflict` round
 * is a round the loop took and not a remediation round, and a reader counting
 * rungs would otherwise count it as one.
 */
export interface LadderRung {
  kind: string;
  given: string[];
  closed: string[];
  open: string[];
}

export interface AttemptReport {
  attempt_id: string;
  /**
   * Which run of the ticket made this attempt, counting from 1 in the order the
   * record holds them. Attempts sharing a root attempt id are one run, so a
   * run's remediation rounds carry its number too.
   */
  run: number;
  /**
   * Where this attempt falls in its run, counting from 1 — so a run that was
   * cut by a ceiling and continued itself, or parked on a provider and resumed,
   * reads as one sequence rather than as repeated round numbers (SCP-193).
   */
  sequence: number;
  round: number;
  started_at: string;
  /**
   * The wait the loop sat out after this attempt, or null. It is what separates
   * two attempts of one round that a provider's session limit put hours apart
   * from two the loop made back to back.
   */
  wait: AttemptWait | null;
  ended_at: string;
  outcome: string;
  termination: ExecutionAttempt["termination"];
  agent: { model: string; binary_version: string; adapter: string; credential_class: string };
  ceilings: CeilingUse[];
  tokens: { input: number; cache_read: number; output: number };
  cost: Cost;
  /** Execution, review and closure verification for this round, added up. */
  round_cost: CostRoll;
  /**
   * The pinned set this round ran, from the execution bundle, followed by the
   * checks only the reviewer computed. Null where neither record holds any —
   * a bundle whose bytes were not retained, and no review to fall back on.
   */
  checks: CheckResult[] | null;
  review: ReviewArtifact | null;
  /** `review`'s per-node artifacts (D-107), empty for a flat plan or a round the bundle holds none for. */
  node_reviews: NodeReview[];
  /** The bundle's own summary when its artifact bytes were not retained. */
  review_decision: string | null;
  verification: ClosureVerificationFile | null;
  /** SCP-194: what this round was given and what it closed. Null for round 0. */
  ladder: LadderRung | null;
  declines: Decline[];
  /** Every command the attempt was refused, once each, in the order it asked. */
  denials: DenialReport[];
  bundles: RunBundle[];
  changed_files: Array<{ path: string; change_kind: string; additions: number; deletions: number }> | null;
  /**
   * The attempt exactly as the record holds it, in its own shape.
   *
   * Everything above is this record read for a person — joined to its bundles,
   * rolled up, labelled. A script wanting the fact rather than the reading had
   * to open `<store>/state/<id>.attempts.json` itself and re-derive which
   * attempt was which; now `inspect --json` hands it over beside the reading,
   * unchanged, so it parses with the contracts' `ExecutionAttemptSchema` and
   * deep-equals what the loop wrote. Nothing here trims it to the fields this
   * renderer happens to name.
   */
  record: ExecutionAttempt;
}

/**
 * Where a ticket stands in the queue (SCP-227): its place among the tickets
 * holding one, in the order `perbo serve` starts them, and what it waits on,
 * in the queue's own words. Read from the store, never from a running queue.
 */
export interface QueueStanding {
  /** 1-based place among the tickets holding one, in queue order; null where this ticket holds none. */
  place: number | null;
  /** How many tickets hold a place. */
  holding: number;
  /** The keys that must merge first, as a person or the drafter named them. */
  depends_on: readonly string[];
  /** Why the ticket waits, or the re-level that did not level it; null where there is nothing to say. */
  waits: string | null;
}

/**
 * Whether a ticket's spec is still the one its contract was drafted from
 * (D-103), as `perbo inspect` prints it.
 *
 * `specStaleness` (`spec/staleness.ts`) builds it. `stale` empty and `unjudged`
 * empty is a spec that is still the statement the plan was approved against.
 */
export interface SpecStaleness {
  /** The spec's path relative to the repository, as admission recorded it. */
  path: string;
  /**
   * The moment the spec is measured from: `approval` for a contract that has
   * been approved, which is the statement a person signed and what D-103 makes
   * an edit stale against, and `admission` for a ticket still in `plan_review`,
   * which has no such moment yet. Every sentence below is about that moment, so
   * the reading says which one it took rather than leaving a reader to guess.
   */
  judged_against: "approval" | "admission";
  /** Why the spec is no longer that statement. One sentence each; empty where it still is. */
  stale: string[];
  /** What could not be judged at all, and what would answer it. */
  unjudged: string[];
}

/**
 * The work an attempts record belongs to, as `inspect` needs it.
 *
 * Everything a *ticket* adds to a record of attempts, behind one interface: read
 * from the ticket store where a name resolves to one, and answered from the
 * record itself otherwise, with `null` for each thing only an admission could
 * have known. A `null` here is a name with no ticket behind it, never a record
 * that failed to load.
 */
export interface InspectSubject {
  /**
   * Whether a ticket describes this work or nothing does (SCP-180). A local run
   * has no admission, no lifecycle state and no ticket key; the fields those
   * would fill read null rather than being filled with something plausible.
   */
  kind: "ticket" | "local";
  /**
   * What a person calls this work: a ticket's key; a local run's label, or the
   * name it was asked by where it has no run record; a stored review's pull
   * request where one was named, and otherwise the identity its plan was filed
   * under.
   */
  ticket: string;
  ticket_id: string;
  /**
   * What a ticket is called (D-127).
   * `null` for work no ticket describes, which has only an outcome.
   */
  title: string | null;
  /**
   * The outcome the attempts were made against: a ticket's is its contract's,
   * `null` where the contract cannot be read; a local run's is on the run
   * record `perbo run` wrote before it started.
   */
  outcome: string | null;
  /** Where a local run's contract came from: `arguments`, or a pull request. */
  contract_source: LocalRunRecord["source"] | null;
  /**
   * Why the run stopped before an attempt existed, where its record says one
   * did. `null` on work that started, and on a ticket, whose records carry no
   * refusal — a refusal printed once and then lost is the thing this exists to
   * prevent.
   */
  refusal: LocalRunRecord["refusal"];
  /** The lifecycle state, or `null` for a local run, which has none. */
  state: string | null;
  pull_request_url: string | null;
  /**
   * SCP-157: whether the ticket's own history says a person handed this pull
   * request off rather than the loop opening it. `false` when there is no pull
   * request at all, and `false` for the loop's own pull request found again on
   * a `failed` ticket's branch — that row moves between the same two states a
   * hand-off does, so this is what the row recorded and not what it looks like.
   *
   * "This pull request" and not "ever": the row read is the last one that
   * reached `pr_open`, the one that put the ticket behind the pull request
   * `pull_request_url` above names.
   *
   * SCP-176: `null` for a row `sync` walked without being able to attribute —
   * a legacy delivery record with no history to decide it either. Distinct
   * from `false`, which is an answer ("the loop"), not an absence of one.
   */
  handed_off: boolean | null;
  /**
   * Where this run published: the base branch and which of the three sources
   * named it, as the run itself recorded it before it started (SCP-265).
   *
   * Read from the record and never resolved again from the checkout. The
   * checkout answers what a run *now* would publish against, which is a
   * different question — `origin/HEAD` moves and `base_ref` gets edited — and
   * printing that answer beside this run's pull request would name a branch
   * this run never published against.
   *
   * `null` where the record does not say: a ticket, whose delivery carries no
   * base, or a run recorded before they did.
   */
  base: RunBase | null;
  /**
   * What the checks on the published head said, as the record holds them: one
   * entry per check with its conclusion, and what they add up to. Null where
   * nothing has read them — no pull request, or a record written before
   * anything did.
   *
   * A check that fails only on CI's own checkout is invisible to whoever
   * opened the pull request unless something reads it back, and this is where
   * that reading is read back from.
   */
  delivery_checks: { state: DeliveryChecksState; checks: readonly DeliveredCheck[] } | null;
  /**
   * The ticket's admission record, exactly as the ticket file carries it —
   * ADR-0027's friction instrument is only interpretable next to what the run
   * then cost, and reading it meant opening the ticket JSON by hand. `null`
   * where nothing admitted this work.
   */
  admission: StoredAdmission | null;
  /**
   * Where the work was before it was admitted, as the ticket recorded it: the
   * issue reference, or the path of the file a contract was drafted from. A
   * drafted contract cannot be read without knowing what it was drafted from,
   * and for `--from-file` that text lives at a path on this machine.
   */
  source: TicketSource | null;
  /** The ticket's standing in the queue (SCP-227). `null` where nothing admitted this work. */
  queue: QueueStanding | null;
  /**
   * Whether the spec this contract was drafted from is still that spec
   * (D-103). `null` where nothing admitted this work, and where the ticket was
   * drafted from an issue, a file or the command line rather than a spec.
   */
  spec_staleness: SpecStaleness | null;
  /**
   * Runs the ticket's own history says started, whether or not this store holds
   * their record. `null` where there is no history to count them in, so the
   * attempts record is the only thing that could say a run happened.
   */
  runs_started: number | null;
  /**
   * The plan's execution graph (D-100): its nodes, whose criteria and paths are
   * contract, and the order between them, which is approach and lives beside
   * the ticket in `<KEY>.approach.json`.
   *
   * Both `null` for a flat plan and for work nothing admitted — a plan either
   * groups its criteria or does not, and an empty list would read as a graph
   * with nothing in it.
   */
  nodes: readonly PlanNode[] | null;
  edges: readonly GraphEdge[] | null;
  /** Why the approach record could not be read as this plan's, where it could not. */
  approach_problem: string | null;
  /**
   * How big the plan is, S to XL, with the counts it came from and the ones
   * that set it (D-104). `null` where nothing admitted this work, or where the
   * contract cannot be read. It forecasts neither cost nor time.
   */
  size: SizeEstimate | null;
}

/**
 * Which work `inspect` was asked about, resolved against the store it reads.
 *
 * Throws where the store holds no work by that name, with an error that says
 * what is on record or where to see it, rather than showing an empty report:
 * {@link ticketSubject} throws the ticket store's own error,
 * {@link attemptsRecordSubject} a {@link UsageError}.
 */
export type ResolveSubject = (storeDirectory: string, name: string) => InspectSubject;

/** The ids `<store>/state` holds an attempts record for, in the order it lists them. */
export function recordedIds(storeDirectory: string): string[] {
  const state = join(storeDirectory, ...stateDir());
  if (!existsSync(state)) return [];
  return readdirSync(state)
    .map(ticketIdOfAttemptsFile)
    .filter((id): id is string => id !== null)
    .sort();
}

/**
 * The work an attempts record belongs to, read from the record itself.
 *
 * What a run with no ticket behind it can say: the id the loop filed the
 * attempts under, which is the id it was run against, and what the run record
 * `perbo run` wrote before the loop started holds — its label, its contract
 * and where that came from, a refusal, the base and the pull request. Everything
 * only a ticket would add is `null`, and a name with neither record is refused
 * with the ids that do have one rather than an empty report.
 */
export const attemptsRecordSubject: ResolveSubject = (storeDirectory, name) => {
  // The run record `perbo run` writes before the loop starts, where there is
  // one: it holds the contract the attempts were made against and where that
  // contract came from, neither of which the attempts record itself says. A
  // run whose record was removed is still readable — the id is what the
  // attempts are keyed by, and reading them back must not depend on a second
  // file being there.
  const record = readLocalRunRecord(storeDirectory, name);
  if (record === null && !existsSync(join(storeDirectory, ...attemptsPath(name)))) {
    const recorded = recordedIds(storeDirectory);
    const runs = listLocalRuns(storeDirectory).map((run) => run.run_id);
    const known = [...new Set([...recorded, ...runs])];
    throw new UsageError(
      `${storeDirectory} holds no attempts for ${name}` +
        (known.length === 0 ? ": nothing has run here yet" : ` (on record: ${known.join(", ")})`),
    );
  }
  return {
    kind: "local",
    ticket: record?.label ?? name,
    ticket_id: record?.run_id ?? name,
    title: null,
    outcome: record?.contract.outcome ?? null,
    contract_source: record?.source ?? null,
    refusal: record?.refusal ?? null,
    state: null,
    // Where a ticket would have carried the delivery, a local run carries it on
    // its own record, written when the pull request opened.
    pull_request_url: record?.pull_request?.url ?? null,
    base: record?.base ?? null,
    handed_off: false,
    delivery_checks:
      record?.pull_request?.checks_state == null
        ? null
        : { state: record.pull_request.checks_state, checks: record.pull_request.checks },
    admission: null,
    source: null,
    queue: null,
    spec_staleness: null,
    runs_started: null,
    // A run with no ticket has no plan to group and no scope to size.
    nodes: null,
    edges: null,
    approach_problem: null,
    size: null,
  };
};

export interface InspectReport extends InspectSubject {
  /** Where the attempts record was looked for. */
  attempts_path: string;
  attempts: AttemptReport[];
  /** Every round's components, added up: what the ticket has cost so far. */
  total_cost: CostRoll;
  /**
   * The decisions a person took on this ticket's findings at the command line
   * (SCP-181), in the order they were taken and including the superseded ones:
   * changing one's mind is part of what the record is for. The renderer prints
   * the one in force beside its finding.
   */
  verdicts: LocalVerdict[];
}

const scalar = (bundle: RunBundle, key: string): string | number | boolean | null =>
  bundle.inputs[key] ?? null;

function artifactBody(store: BundleStore | null, bundle: RunBundle, name: string): string | null {
  const ref = bundle.artifacts.find((artifact) => artifact.name === name);
  if (!ref || !ref.retained || !store) return null;
  return store.readObject(ref.sha256);
}

/**
 * The bundles one attempt wrote. The execution bundle is keyed by the attempt
 * id; the review by the change set it judged; a verification by the
 * `cv_<attempt>` subject the loop gives it.
 *
 * One join, read by the two things that need it: the report a person reads,
 * and `--verify`, which re-hashes what these name. A second copy of the rule
 * would be a second answer to "which bundles are this attempt's".
 */
export interface AttemptBundles {
  execution: RunBundle | undefined;
  review: RunBundle | undefined;
  verification: RunBundle | undefined;
}

export function attemptBundles(
  attempt: ExecutionAttempt,
  bundles: readonly RunBundle[],
): AttemptBundles {
  return {
    execution: bundles.find(
      (bundle) => bundle.kind === "execution" && bundle.subject_id === attempt.attempt_id,
    ),
    review:
      attempt.changeset_id === null
        ? undefined
        : bundles.find(
            (bundle) =>
              bundle.kind === "review" &&
              bundle.subject_id.startsWith("rev_") &&
              scalar(bundle, "changeset_id") === attempt.changeset_id,
          ),
    verification: bundles.find(
      (bundle) => bundle.kind === "review" && bundle.subject_id === `cv_${attempt.attempt_id}`,
    ),
  };
}

/** One attempt joined to its bundles and read for a person. */
export function reportAttempt(
  attempt: ExecutionAttempt,
  bundles: RunBundle[],
  store: BundleStore | null,
  limits: LimitsTable,
  run = 1,
  sequence = 1,
): AttemptReport {
  const {
    execution,
    review: reviewBundle,
    verification: verificationBundle,
  } = attemptBundles(attempt, bundles);

  let review: ReviewArtifact | null = null;
  let node_reviews: NodeReview[] = [];
  if (reviewBundle) {
    const body = artifactBody(store, reviewBundle, "review.json");
    if (body !== null) {
      const parsed = ReviewArtifactSchema.safeParse(JSON.parse(body));
      if (parsed.success) review = parsed.data;
    }
    // D-107: the graph's per-node artifacts, recorded beside review.json.
    // Absent on a bundle written before per-node review existed.
    const nodesBody = artifactBody(store, reviewBundle, "node-reviews.json");
    if (nodesBody !== null) {
      const parsedNodes = NodeReviewsSchema.safeParse(JSON.parse(nodesBody));
      if (parsedNodes.success) node_reviews = parsedNodes.data;
    }
  }
  let verification: ClosureVerificationFile | null = null;
  if (verificationBundle) {
    const body = artifactBody(store, verificationBundle, "verification.json");
    if (body !== null) {
      const parsed = ClosureVerificationFileSchema.safeParse(JSON.parse(body));
      if (parsed.success) verification = parsed.data;
    }
  }

  // Declines are the executor's own words in the transcript, parsed the way
  // the loop parsed them: against the keys the review actually routed.
  let declines: Decline[] = [];
  const transcript = execution ? artifactBody(store, execution, "transcript.jsonl") : null;
  if (attempt.remediation_round > 0 && transcript !== null) {
    const routed = bundles
      .filter((bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"))
      .flatMap((bundle) => {
        const body = artifactBody(store, bundle, "review.json");
        if (body === null) return [];
        const parsed = ReviewArtifactSchema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data.findings.map((finding) => finding.key) : [];
      });
    declines = parseDeclines(transcript.split("\n"), routed);
  }

  // What the pinned set measured on this round's tree, as the loop recorded it
  // beside the attempt. The reviewer echoes those results into its own artifact
  // and adds the ones it computes — scope, agent configuration, legibility — so
  // both are read and the runner's own measurement wins where they name the
  // same check. A round the reviewer never saw has only the first; a bundle
  // written before the loop recorded them has only the second.
  const measured = execution ? artifactBody(store, execution, "checks.json") : null;
  const ran = measured === null ? null : CheckResultsFileSchema.safeParse(JSON.parse(measured));
  const checks =
    ran?.success === true
      ? [
          ...ran.data,
          ...(review?.checks ?? []).filter(
            (check) => !ran.data.some((one) => one.check_id === check.check_id),
          ),
        ]
      : (review?.checks ?? null);

  const diff = execution ? artifactBody(store, execution, "change.diff") : null;
  const changed_files =
    diff === null
      ? null
      : parseUnifiedDiff(diff).map((file) => ({
          path: file.path,
          change_kind: file.change_kind,
          additions: file.additions,
          deletions: file.deletions,
        }));

  /**
   * SCP-194: the rung this round contributes.
   *
   * Both halves come from the bundles the round wrote: the execution bundle
   * says what the executor was given, and the verification says which of those
   * it closed. Read from the parsed verification where the bytes are retained
   * and from the bundle's own inputs where they are not, so a store that kept
   * only the summaries still prints a ladder.
   */
  const keys = (value: string | number | boolean | null): string[] =>
    typeof value === "string" ? value.split(",").filter((key) => key.length > 0) : [];
  const givenFromBundle = keys(scalar(execution ?? verificationBundle ?? ({ inputs: {} } as never), "findings_given"));
  const ladder: LadderRung | null =
    attempt.remediation_round === 0 && givenFromBundle.length === 0
      ? null
      : {
          kind: String(scalar(execution ?? ({ inputs: {} } as never), "round_kind") ?? "remediate"),
          given: givenFromBundle,
          closed:
            verification === null
              ? keys(scalar(verificationBundle ?? ({ inputs: {} } as never), "findings_closed"))
              : verification.per_finding
                  .filter((row) => row.status === "closed")
                  .map((row) => row.finding_key),
          open:
            verification === null
              ? keys(scalar(verificationBundle ?? ({ inputs: {} } as never), "findings_open"))
              : verification.open_keys,
        };

  const breached = ceilingResourceFor(attempt.termination.reason);
  // D-096: the cost caps applied to this attempt only if its own credential
  // billed per token, and the attempt recorded which that was.
  const appliedLimits = limitsForCredential(limits, attempt.agent.credential_class);
  const ceilings: CeilingUse[] = (
    [
      "attempt_stall_ms",
      "attempt_iterations",
      "attempt_commands",
      "attempt_wall_clock_ms",
      "attempt_tokens",
      "attempt_cost_micros",
    ] as const
  ).map((resource) => ({
    resource,
    // The stall window is the one resource the record keeps no running count
    // of; where it is what stopped the attempt, the refusal's own message says
    // how long the silence was.
    used: usageOf(attempt, resource) ?? (breached === resource ? reachedAtBreach(attempt) : null),
    // The ceiling in force when it was hit, not the one in the file today.
    ceiling:
      (breached === resource ? limitAtBreach(attempt) : null) ?? limitFor(appliedLimits, resource),
    hit: breached === resource,
  }));

  const reached =
    attempt.termination.reason !== "completed"
      ? attempt.termination.reason
      : review
        ? `review ${review.decision}`
        : verification
          ? verification.all_closed
            ? "closures verified"
            : `${verification.open_keys.length} closure(s) still open`
          : reviewBundle
            ? `review ${String(scalar(reviewBundle, "decision") ?? "(decision not recorded)")}`
            : "completed";
  // An attempt that added nothing to a change set already on the branch says so
  // first: the verdict below it is a verdict on work an earlier attempt did.
  const outcome =
    attempt.change_set_origin !== "carried_forward"
      ? reached
      : reached === "completed"
        ? "carried_forward"
        : `carried_forward · ${reached}`;

  const cost = costOf({
    micros: attempt.usage.cost_micros,
    basis: attempt.usage.cost_basis,
    partial: attempt.usage.cost_partial === true,
  });
  const round_cost = rollCosts([
    cost,
    ...(review ? [costOf({ micros: review.cost_micros, basis: review.model.cost_basis })] : []),
    ...(verification
      ? [costOf({ micros: verification.cost_micros, basis: verification.cost_basis })]
      : []),
  ]);

  const denials: DenialReport[] = attempt.commands
    .filter((command) => command.decision === "denied")
    .map((command) => ({
      tool: command.tool,
      command: command.detail,
      // Records written before the rule and the target were carried say so,
      // rather than reading as a refusal nobody could explain.
      rule: command.denial_rule ?? "not recorded",
      target: command.denial_target ?? "not recorded",
      reason: command.denial_reason ?? "not recorded",
      agent: command.agent,
      at: command.at,
    }));

  return {
    attempt_id: attempt.attempt_id,
    run,
    sequence,
    round: attempt.remediation_round,
    started_at: attempt.created_at,
    wait: attempt.wait,
    ended_at: new Date(Date.parse(attempt.created_at) + attempt.usage.wall_clock_ms).toISOString(),
    outcome,
    termination: attempt.termination,
    agent: {
      model: attempt.agent.model,
      binary_version: attempt.agent.binary_version,
      adapter: attempt.agent.adapter,
      credential_class: attempt.agent.credential_class,
    },
    ceilings,
    tokens: {
      input: attempt.usage.input_tokens,
      cache_read: attempt.usage.cache_read_input_tokens,
      output: attempt.usage.output_tokens,
    },
    cost,
    round_cost,
    checks,
    review,
    node_reviews,
    review_decision: reviewBundle ? String(scalar(reviewBundle, "decision") ?? "") || null : null,
    verification,
    ladder,
    declines,
    denials,
    bundles: [execution, reviewBundle, verificationBundle].filter(
      (bundle): bundle is RunBundle => bundle !== undefined,
    ),
    changed_files,
    record: attempt,
  };
}

/**
 * The attempts on record for one piece of work, joined to their bundles.
 *
 * The subject — what to call the work, and what admitted it, where anything
 * did — is resolved by the caller: the store this reads is `<store>/state` and
 * `<store>/bundles`, and nothing else is opened here.
 */
export function buildReportForSubject(input: {
  storeDirectory: string;
  subject: InspectSubject;
  attempt: string | null;
  /** Where an unreadable verdicts file is named; the report itself is still built. */
  streams?: Diagnostics | undefined;
}): InspectReport {
  const attemptsFile = join(input.storeDirectory, ...attemptsPath(input.subject.ticket_id));
  const head = { ...input.subject, attempts_path: attemptsFile };
  const verdicts = readLocalVerdictsOrWarn(input.storeDirectory, input.streams ?? null).verdicts.filter(
    (verdict) => verdict.review.ticket_id === input.subject.ticket_id,
  );
  const totalled = (attempts: AttemptReport[]): InspectReport => ({
    ...head,
    attempts,
    total_cost: attempts.map((one) => one.round_cost).reduce(addRolls, rollCosts([])),
    verdicts,
  });
  if (!existsSync(attemptsFile)) return totalled([]);

  const record = readAttemptsFile(attemptsFile);
  const root = join(input.storeDirectory, ...bundleRoot());
  // Constructed only where the loop already made it: the store creates its
  // directories on construction, and a read must not leave one behind.
  const store = existsSync(join(input.storeDirectory, ...bundleManifestsDir()))
    ? new BundleStore({ root, retainContext: true })
    : null;
  const bundles = store ? store.forTicket(input.subject.ticket_id) : [];
  const limits = effectiveLimits(readRepoConfig(input.storeDirectory), join(input.storeDirectory, "config.json"));

  // Numbered across the whole record before anything is filtered out, so
  // `--attempt` shows the run an attempt belongs to rather than renumbering
  // what it selected.
  const runs = runNumbers(record.attempts);
  // Counted over the whole record for the same reason the run number is: an
  // attempt's place in its run does not change because a filter selected it.
  const sequences = new Map<number, number>();
  const attempts = record.attempts
    .map((attempt, index) => {
      const run = runs[index] ?? 1;
      const sequence = (sequences.get(run) ?? 0) + 1;
      sequences.set(run, sequence);
      return { attempt, run, sequence };
    })
    .filter((entry) => input.attempt === null || entry.attempt.attempt_id === input.attempt)
    .map((entry) => reportAttempt(entry.attempt, bundles, store, limits, entry.run, entry.sequence));
  if (input.attempt !== null && attempts.length === 0) {
    throw new UsageError(
      `${input.subject.ticket} has no attempt ${input.attempt} (recorded: ${record.attempts
        .map((attempt) => attempt.attempt_id)
        .join(", ")})`,
    );
  }
  return totalled(attempts);
}

/** SCP-196: cost per merged ticket, over reports already built for each one. */
export interface MergedCostSummary {
  /** Merged tickets a report was built for. */
  tickets: number;
  /** Every attempt across every run of those tickets. */
  attempts: number;
  /** Cost components (execution, review, closure verification) with a figure. */
  priced: number;
  /** Priced components with no figure at all. */
  unavailable: number;
  /** Micro-dollars summed over priced components only. */
  micros: number;
  /**
   * Attempts with no dollar figure of their own, named — never the review or
   * verification beside them, which have no id a person can look up.
   */
  unpriced_attempts: Array<{ ticket: string; attempt_id: string }>;
}

/**
 * Cost per merged ticket (SCP-196), over `InspectReport`s already built for
 * each one — the same roll `inspect` shows for a single ticket
 * (`total_cost`), added across every report handed in.
 *
 * `micros` is a sum over priced components only: an unpriced one is counted
 * rather than treated as zero, the same rule `rollCosts` follows for a single
 * ticket, so the average this divides into is never quietly short. The named
 * list is narrower than `unavailable` on purpose — an attempt's cost is
 * nameable by its own id, where an unpriced review or verification inside a
 * round is not something a person can look up on its own.
 */
export function summariseMergedCost(reports: readonly InspectReport[]): MergedCostSummary {
  const rolled = reports.map((report) => report.total_cost).reduce(addRolls, rollCosts([]));
  const unpriced_attempts = reports.flatMap((report) =>
    report.attempts
      .filter((attempt) => attempt.cost.micros === null && attempt.cost.basis !== "not_incurred")
      .map((attempt) => ({ ticket: report.ticket, attempt_id: attempt.attempt_id })),
  );
  return {
    tickets: reports.length,
    attempts: reports.reduce((total, report) => total + report.attempts.length, 0),
    priced: rolled.priced,
    unavailable: rolled.unavailable,
    micros: rolled.micros,
    unpriced_attempts,
  };
}

const RESOURCE_LABEL: Record<string, string> = {
  attempt_stall_ms: "stall",
  attempt_iterations: "iterations",
  attempt_commands: "commands",
  attempt_wall_clock_ms: "wall clock",
  attempt_tokens: "tokens",
  attempt_cost_micros: "cost",
};

function renderUse(use: CeilingUse, cost: Cost): string {
  const show = (value: number): string => {
    switch (use.resource) {
      case "attempt_stall_ms":
      case "attempt_wall_clock_ms":
        return formatDuration(value);
      case "attempt_cost_micros":
        return formatUsd(value, 4);
      default:
        return value.toLocaleString("en-US");
    }
  };
  const used =
    use.resource === "attempt_cost_micros"
      ? costLabel(cost)
      : use.used === null
        ? "(unrecorded)"
        : show(use.used);
  // The count is kept whether or not anything bounds it (D-096), and a
  // resource with no ceiling says so rather than borrowing a number.
  const against = use.ceiling === null ? "no ceiling" : show(use.ceiling);
  return `${used} / ${against}${use.hit ? " — ceiling hit" : ""}`;
}

const FINDING_TAG: Record<string, string> = {
  blocks: "[BLOCK]",
  escalates: "(esc)",
  remediable: "[FIX]",
  advisory: "(adv)",
  waived: "(waived)",
};

const CHECK_MARK: Record<string, string> = { passed: "✓", failed: "✗", errored: "✗", skipped: "~" };

/**
 * A measurement the record does not carry. Never `0`: unrecorded and zero are
 * different facts about admission friction, and printing one as the other
 * turns "we did not measure this" into "this took no time and no edits".
 */
const NOT_RECORDED = "not recorded";

/**
 * The admission record, above the attempts: how the criteria arrived, what the
 * contract cost the person who approved it, and which level the scope derived
 * to before anyone raised it.
 */
function admissionLines(
  admission: StoredAdmission,
  source: TicketSource | null,
  paint: Paint,
): string[] {
  const or = <T>(value: T | null | undefined, render: (value: T) => string): string =>
    value === null || value === undefined ? NOT_RECORDED : render(value);

  const criteria = [
    or(admission.criteria_source, (source) => source),
    or(admission.criteria_count, (count) => `${count} criteri${count === 1 ? "on" : "a"}`),
    // Null unless a model drafted the criteria, so its absence is not a gap.
    ...(admission.drafted_at ? [`drafted at ${admission.drafted_at}`] : []),
  ].join(" · ");
  const approval = [
    or(admission.human_elapsed_ms, (ms) => `${formatHumanElapsed(ms)} from first rendering`),
    admission.edit_count === null || admission.edit_count === undefined
      ? `edits ${NOT_RECORDED}`
      : `${admission.edit_count} edit${admission.edit_count === 1 ? "" : "s"}`,
  ].join(" · ");
  // One field, reported as one: the level and where it came from are only
  // meaningful together, and a raise is only readable against the derivation.
  const derivedLevel = admission.derived_level ?? null;
  const levelSource = admission.level_source ?? null;
  const level =
    derivedLevel === null && levelSource === null
      ? NOT_RECORDED
      : derivedLevel === null
        ? `${NOT_RECORDED} (source ${levelSource})`
        : levelSource === null
          ? `${derivedLevel} (source ${NOT_RECORDED})`
          : `${derivedLevel} ${levelSource}`;

  // Never clipped: a `--from-file` reference is a path, and a clipped path names
  // nothing a person can open. One that does not fit the column goes under it,
  // broken across lines where it is wider than the column.
  // The kind leads it — `file /abs/path`, `github owner/repo#412` — so what is
  // being named is read rather than inferred from the shape of the string.
  const reference = source === null ? null : ticketSourceLabel(source);
  const label = `    ${pad("source", 10)} `;
  const sourceLines =
    reference === null
      ? []
      : label.length + reference.length <= WIDTH
        ? [label + paint(reference, "mid")]
        : [label.trimEnd(), ...wrap(reference, 6).map((line) => paint(line, "mid"))];

  return [
    paint("  ADMISSION", "sect") + paint("   how this ticket was admitted", "dim"),
    ...sourceLines,
    ...labelled(`    ${pad("criteria", 10)} `, criteria, paint, "mid"),
    ...labelled(`    ${pad("approval", 10)} `, approval, paint, "mid"),
    ...labelled(`    ${pad("level", 10)} `, level, paint, "mid"),
    // The `admit` command's own runtime, which measures the machine.
    `    ${pad("admit", 10)} ` +
      paint(or(admission.elapsed_ms, (ms) => `${formatDuration(ms)} of machine time`), "dim"),
    "",
  ];
}

/**
 * The plan's execution graph and its size (D-100, D-104).
 *
 * The nodes' criteria and paths are contract; the order is approach, and is
 * labelled so, because it is the one thing here that may still change while the
 * work runs. A flat plan has no section and one size line — the size is a
 * reading of every plan, and a graph is not.
 */
function graphLines(report: InspectReport, paint: Paint): string[] {
  const lines: string[] = [];
  if (report.nodes !== null && report.nodes.length > 0) {
    lines.push(paint("GRAPH", "sect") + paint("   criteria and paths are contract", "dim"));
    for (const node of report.nodes) {
      lines.push(`  ${paint(node.id, "hi")}  ${node.title}`);
      lines.push(paint(`          criteria  ${node.criteria.join(", ")}`, "dim"));
      lines.push(paint(`          paths     ${node.paths.join(", ")}`, "dim"));
    }
    lines.push(
      paint(
        `  order   ${
          report.approach_problem !== null
            ? `not read: ${report.approach_problem}`
            : report.edges === null || report.edges.length === 0
              ? "none suggested"
              : report.edges.map((edge) => `${edge.from} -> ${edge.to}`).join(", ")
        }  (approach: it may change while the work runs)`,
        "dim",
      ),
    );
  }
  if (report.size !== null) {
    const driving = new Set(report.size.drivers);
    const count = (name: SizeCount, [one, many]: [string, string]) => {
      const value = report.size!.counts[name];
      const written = `${value} ${value === 1 ? one : many}`;
      // The counts that set the size are the ones worth reading first, so they
      // are marked rather than left for the reader to work back to.
      return driving.has(name) ? `${written}*` : written;
    };
    lines.push(
      `  ${paint(`Size ${report.size.name}`, "hi")} · ` +
        `${count("nodes", ["node", "nodes"])} · ${count("criteria", ["criterion", "criteria"])} · ` +
        `${count("files", ["file", "files"])} · ${count("packages", ["package", "packages"])}` +
        paint("   * sets the size", "dim"),
    );
    lines.push("");
  } else if (lines.length > 0) {
    lines.push("");
  }
  return lines;
}

/**
 * Whether the spec this contract was drafted from is still that spec (D-103).
 *
 * Printed for every ticket drafted from one, stale or not: a person reading a
 * ticket is asking "is this still the statement I approved", and a section
 * that appeared only on a stale spec would leave "still the spec" and "not
 * checked" looking the same.
 */
function specLines(staleness: SpecStaleness, paint: Paint): string[] {
  const row = (label: string, value: string, tone: "mid" | "warn" | "dim"): string[] => {
    const lead = `    ${pad(label, 10)} `;
    return lead.length + value.length <= WIDTH
      ? [lead + paint(value, tone)]
      : [lead.trimEnd(), ...wrap(value, 6).map((line) => paint(line, tone))];
  };
  const current =
    staleness.stale.length === 0 && staleness.unjudged.length === 0
      ? row("current", `unedited since ${staleness.judged_against}, and every name in it is still here`, "mid")
      : [];
  return [
    paint("  SPEC", "sect") + paint("        what this contract was drafted from", "dim"),
    ...row("path", staleness.path, "mid"),
    ...current,
    ...staleness.stale.flatMap((reason) => row("stale", reason, "warn")),
    ...staleness.unjudged.flatMap((reason) => row("unjudged", reason, "dim")),
    "",
  ];
}

const ordinal = (n: number): string => {
  const rest = n % 100;
  const suffix = rest >= 11 && rest <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
};

/**
 * The ticket's standing in the queue, under the admission record: where it is
 * in the order the queue starts things, and what it waits on (SCP-227).
 */
function queueLines(queue: QueueStanding, state: string | null, paint: Paint): string[] {
  const place =
    queue.place === null
      ? `not in the queue${state === null ? "" : ` (${state})`}`
      : `${ordinal(queue.place)} of ${queue.holding} holding a place${state === null ? "" : ` · ${state}`}`;
  // Never clipped: a wait names every ticket ahead and the re-level's exit
  // code, and half of that names nothing a person can act on. One that does
  // not fit the column goes under it, as the admission's source does.
  const row = (label: string, value: string): string[] => {
    const lead = `    ${pad(label, 10)} `;
    return lead.length + value.length <= WIDTH
      ? [lead + paint(value, "mid")]
      : [lead.trimEnd(), ...wrap(value, 6).map((line) => paint(line, "mid"))];
  };
  return [
    paint("  QUEUE", "sect") + paint("       where this ticket stands", "dim"),
    ...row("place", place),
    ...(queue.waits === null ? [] : row("waits", queue.waits)),
    ...(queue.depends_on.length === 0 ? [] : row("after", queue.depends_on.join(", "))),
    "",
  ];
}

/**
 * What a blocked check finding's attribution rests on.
 *
 * "The unit check failed" reads the same whether the change broke it or the
 * base was already red, and the routing that follows is opposite: a check the
 * change broke goes back to the executor for one round, a check that was
 * already failing stops here. The answer is the verification of the contract's
 * base commit, so the report names that commit and what the verification said —
 * and says when nobody measured it, because an unattributed failure is not the
 * same as one attributed to the base.
 *
 * Empty for every other finding: nothing else is decided this way.
 */
function attributionLine(finding: Finding, record: ExecutionAttempt): string | null {
  if (!finding.blocking || finding.rule_id.split(".")[0] !== "check") return null;
  const base = record.base_verification;
  if (base === null) {
    return "no verification of the base is on record, so this failure is attributed to neither " +
      "the base nor the change";
  }
  return (
    `the base ${base.commit.slice(0, 12)} ` +
    `${base.verified ? "passed" : "failed"} the workspace's verify, which is what this ` +
    "attribution rests on"
  );
}

/**
 * A decision as it reads under its finding: what was decided, by whom, when,
 * and the reason they gave. Empty where nobody has decided this one.
 */
export function verdictLines(verdict: LocalVerdict | undefined, indent = 13): string[] {
  if (verdict === undefined) return [];
  return [
    `${" ".repeat(indent)}decision ${verdict.decision} · ${verdict.author} · ${verdict.decided_at}`,
    ...(verdict.note === null ? [] : wrap(`note: ${verdict.note}`, indent)),
  ];
}

/**
 * How `--resume-from` names the work again.
 *
 * A ticket is named by its key. A run that minted its own contract is named by
 * the outcome it minted it from, because that is the whole of what identified
 * it. A run whose plan came from a `--contract` file has neither on record
 * here, so the line says what is missing rather than printing a command that
 * would run something else.
 */
function resumeSubject(report: InspectReport): string {
  if (report.kind === "ticket") return `--ticket ${report.ticket}`;
  return report.outcome === null
    ? "--contract <the contract this run was made against>"
    : `--outcome ${JSON.stringify(report.outcome)}`;
}

/**
 * The block that stands where a ticket's ADMISSION block would (SCP-180).
 *
 * A local run was never admitted, so what a reader needs first is the contract
 * it ran against and where that contract came from — typed, or read out of a
 * pull request — and, where the source stated no criteria, that none were
 * invented for it.
 */
function localRunLines(report: InspectReport, paint: Paint): string[] {
  const source = report.contract_source;
  const from =
    source === null
      ? NOT_RECORDED
      : source.source === "pull_request"
        ? `pull request ${source.reference ?? "(unreferenced)"} · outcome from its ` +
          source.outcome_from.replace(/_/g, " ")
        : "typed on the command line";
  const criteria =
    source === null
      ? NOT_RECORDED
      : source.criteria.length === 0
        ? "none stated — judged against the outcome alone"
        : `${source.criteria.length} criteri${source.criteria.length === 1 ? "on" : "a"}`;
  const lines = [
    paint("  LOCAL RUN", "sect") + paint("   no ticket was admitted for this work", "dim"),
    ...labelled(`    ${pad("contract", 10)} `, from, paint, "mid"),
    ...labelled(`    ${pad("criteria", 10)} `, criteria, paint, "mid"),
  ];
  if (report.outcome !== null) {
    lines.push(
      `    ${pad("outcome", 10)} `.trimEnd(),
      ...wrap(report.outcome, 6).map((line) => paint(line, "mid")),
    );
  }
  if (source !== null && source.url !== null) {
    lines.push(...labelled(`    ${pad("url", 10)} `, source.url, paint, "dim"));
  }
  lines.push("");
  return lines;
}

/**
 * Why the run stopped before it started, where its record says it did.
 *
 * The findings are printed in the refusal's own words rather than in a reading
 * of them: what a person opens this for is the thing they were told at the
 * moment the command ended, and a paraphrase would be a second account of it.
 * The `doctor` invocation is repeated for the same reason — it is what the
 * refusal offered, and it is still the command that answers the whole question.
 */
function refusalLines(refusal: NonNullable<InspectReport["refusal"]>, paint: Paint): string[] {
  const lines = [
    paint("  REFUSED", "sect") + paint(`   nothing ran; refused ${refusal.refused_at}`, "dim"),
    ...wrap(refusal.reason, 4).map((line) => paint(line, "warn")),
  ];
  for (const finding of refusal.findings) {
    lines.push(`    ${paint(finding.reason, "hi")}`);
    lines.push(...wrap(finding.detail, 6).map((line) => paint(line, "mid")));
  }
  lines.push(paint(`    perbo doctor --repo ${refusal.repository_root}`, "dim"), "");
  return lines;
}

export function renderInspect(
  report: InspectReport,
  options: { color: boolean; detail: boolean; version: string },
): string {
  const paint: Paint = painter(options.color);
  const lines: string[] = [];
  // Only the decisions in force; a superseded one is on the record and in the
  // JSON, and printing it beside the live one would read as two answers. A
  // finding holds at most two: a judgement of it and a person's answer to it
  // (D-132), each in its own slot.
  const decided = new Map<string, LocalVerdict[]>();
  for (const verdict of activeVerdicts(report.verdicts)) {
    decided.set(verdict.finding_key, [...(decided.get(verdict.finding_key) ?? []), verdict]);
  }
  lines.push("");
  lines.push(
    paint(
      `perbo ${options.version}   inspect ${report.ticket}   ${report.ticket_id}` +
        // A local run has no lifecycle state to print, and an empty column
        // would read as one it failed to find.
        (report.state === null ? "" : `   ${report.state}`),
      "dim",
    ),
  );
  if (report.pull_request_url) {
    lines.push(
      paint(
        `          pull request ${report.pull_request_url}` +
          (report.handed_off === null
            ? "  (opener not recorded)"
            : report.handed_off
              ? "  (handed off — a person opened it, not the loop)"
              : ""),
        "dim",
      ),
    );
  }
  // Where this run published, beside the pull request it opened: the two read
  // together are what says whether the branch this landed on is the one it was
  // meant to. The run's own record, so it keeps saying what that run did after
  // the checkout has moved on.
  if (report.base) {
    lines.push(
      paint(`          base ${report.base.ref} (${BASE_SOURCE_LABEL[report.base.from]})`, "dim"),
    );
  }
  if (report.delivery_checks) {
    const read = report.delivery_checks;
    lines.push(
      paint(
        `          checks ${read.state}` +
          (read.checks.length === 0
            ? " — no check was reported on the head"
            : ` — ${read.checks.map((check) => `${check.name} ${check.conclusion}`).join(", ")}`),
        read.state === "checks_failed" ? "warn" : "dim",
      ),
    );
  }
  lines.push("");
  // Nothing admitted this work where there is no admission record, so there is
  // no friction to report against what the run cost. A run that minted its own
  // contract says what that contract was instead (SCP-180).
  if (report.admission !== null) {
    lines.push(...admissionLines(report.admission, report.source, paint));
  } else if (report.kind === "local" && report.contract_source !== null) {
    lines.push(...localRunLines(report, paint));
  }
  if (report.spec_staleness !== null) lines.push(...specLines(report.spec_staleness, paint));
  if (report.queue !== null) lines.push(...queueLines(report.queue, report.state, paint));
  lines.push(...graphLines(report, paint));
  // A run that was refused has no attempt under it, so this is the whole of
  // what happened and it goes first.
  if (report.refusal !== null) lines.push(...refusalLines(report.refusal, paint));

  /**
   * The decisions that have no finding printed above them — taken on a review
   * whose artifact bytes were not retained, or on a stop this store knows only
   * from the pull request. Printed rather than dropped: the decision is the
   * thing that cannot be reconstructed from anything else here.
   */
  const printed = new Set(
    report.attempts.flatMap((attempt) => (attempt.review?.findings ?? []).map((finding) => finding.key)),
  );
  const unprinted = activeVerdicts(report.verdicts).filter((verdict) => !printed.has(verdict.finding_key));
  const decisionSection = (): string[] =>
    unprinted.length === 0
      ? []
      : [
          paint("DECISIONS", "sect") + paint("   recorded here, on findings not printed above", "dim"),
          ...unprinted.flatMap((verdict) => [
            `  ${paint(verdict.finding_key.slice(0, 12), "hi")} ${paint(verdict.rule_id, "mid")}`,
            ...verdictLines(verdict, 4).map((line) => paint(line, "warn")),
          ]),
          "",
        ];

  /**
   * A run's attempts as one sequence (SCP-193).
   *
   * A run that continued itself past a ceiling, or parked on a provider's
   * session limit and resumed, makes several attempts of the same round — and
   * read one ATTEMPT block at a time they look like the same round printed
   * twice. This says the order, what ended each one, and the wait between them,
   * which is the fact a person is actually asking for: the run did not stop and
   * nobody restarted it.
   *
   * Printed only where there is a sequence. One attempt is not one.
   */
  const sequenceSection = (): string[] => {
    if (report.attempts.length < 2) return [];
    const runs = [...new Set(report.attempts.map((attempt) => attempt.run))];
    const out = [
      paint("SEQUENCE", "sect") +
        paint(
          `   ${report.attempts.length} attempt(s) across ${runs.length} run(s), in order`,
          "dim",
        ),
    ];
    for (const attempt of report.attempts) {
      out.push(
        `  ${paint(`${attempt.run}.${attempt.sequence}`.padEnd(6), "hi")}` +
          `${pad(attempt.attempt_id, 22)}` +
          paint(clip(`round ${attempt.round}  ${attempt.termination.reason}`, WIDTH - 30), "mid"),
      );
      if (attempt.wait === null) continue;
      const wait = attempt.wait;
      for (const line of wrap(
        `waited ${formatDuration(wait.waited_ms)} — ${wait.reason.replace(/_/g, " ")} ` +
          `until ${wait.until} (${wait.zone}): ${wait.quoted}`,
        8,
      )) {
        out.push(paint(line, "warn"));
      }
    }
    out.push("");
    return out;
  };
  lines.push(...sequenceSection());

  /**
   * The remediation rounds as a ladder (SCP-194).
   *
   * A run's rounds are bounded by progress now, so the question a reader has is
   * whether each round moved: what it was given, what it closed, and what was
   * left when it ended. Read one ATTEMPT block at a time that answer is spread
   * across a REVIEW and a VERIFICATION several screens apart; here it is four
   * lines. A `resolve_conflict` round is shown and marked, because it is a
   * round the loop took and not one of the remediation rounds the cap counts.
   */
  const ladderSection = (): string[] => {
    const rungs = report.attempts.filter((attempt) => attempt.ladder !== null);
    if (rungs.length === 0) return [];
    const out = [
      paint("LADDER", "sect") +
        paint("   what each remediation round was given, and what it closed", "dim"),
    ];
    for (const attempt of rungs) {
      const rung = attempt.ladder!;
      const counted = rung.kind === "resolve_conflict" ? " (conflict — not a remediation round)" : "";
      // Whole (D-NEW-nothing-shown-is-cut): beside the round where it fits, under it where it does not.
      const said =
        `given ${rung.given.length}  closed ${rung.closed.length}  ` +
        (rung.open.length === 0 ? "all closed" : `open ${rung.open.length}`) +
        counted;
      const style = rung.open.length === 0 ? "ok" : "warn";
      if (11 + said.length <= WIDTH) out.push(`  ${paint(pad(`round ${attempt.round}`, 9), "hi")}` + paint(said, style));
      else out.push(`  ${paint(`round ${attempt.round}`, "hi")}`, ...wrap(said, 11).map((line) => paint(line, style)));
      if (rung.open.length > 0) {
        for (const line of wrap(
          `still open: ${rung.open.map((key) => key.slice(0, 12)).join(", ")}`,
          6,
        )) {
          out.push(paint(line, "dim"));
        }
      }
    }
    out.push("");
    return out;
  };
  lines.push(...ladderSection());

  if (report.attempts.length === 0) {
    // A ticket record travels with the repository; the attempts record is
    // working state and does not. Its own history says which case this is —
    // where there is a history to ask.
    lines.push(
      report.runs_started === null || report.runs_started === 0
        ? `${report.ticket} has no attempts on record: nothing has run against it yet.`
        : `${report.ticket} has no attempts on record in ${report.attempts_path}, though its ` +
            `history shows ${report.runs_started} run(s) started — the record was written to ` +
            "another store or removed.",
    );
    lines.push("");
    lines.push(...decisionSection());
    return lines.join("\n");
  }

  /**
   * Each attempt leads with the three facts a person opens `inspect` for: how
   * it ended, why it stopped where it did, and what it cost. Everything else
   * about the attempt — the bundle the work is in, when it ran, what ran it —
   * follows them.
   *
   * The order is the finding: the stop reason and the charge used to sit under
   * the bundle id and the agent line, so the answer to "what happened and what
   * did it cost me" was read fourth, after two lines nobody had asked about.
   */
  for (const attempt of report.attempts) {
    const stopped = attempt.termination.reason !== "completed";
    const head = `ATTEMPT   ${attempt.attempt_id}`;
    lines.push(
      spread(
        paint("ATTEMPT", "sect") + `   ${attempt.attempt_id}`,
        // The run first: attempts are printed in the order the record holds
        // them, and which run made one is what separates a re-run's attempt
        // from the round it looks like. Where in the run each one falls is in
        // the SEQUENCE block above rather than here, because this line is
        // already at the 80-column rule and the position is only meaningful
        // for a run that made more than one attempt.
        `run ${attempt.run} · round ${attempt.round} · ${attempt.outcome}`,
        paint,
        stopped ? "bad" : "mid",
      ).replace(head, head),
    );
    // Why it stopped, and where: the reason the record names, and the detail
    // that says which ceiling, which command or which commit it stopped at. An
    // attempt that ran to the end has no stop, and its detail — where it wrote
    // one — is what it has to say for itself instead.
    if (stopped) {
      for (const line of wrap(
        `termination ${attempt.termination.reason}${attempt.termination.detail ? ` — ${attempt.termination.detail}` : ""}`,
        2,
      )) {
        lines.push(paint(line, "bad"));
      }
    } else if (attempt.termination.detail) {
      for (const line of wrap(attempt.termination.detail, 2)) lines.push(paint(line, "mid"));
    }
    // What it cost, for every attempt and not only a stopped one: a completed
    // attempt's charge was readable only off the cost ceiling's row, where it
    // is a fraction of a limit rather than a figure. An attempt nobody priced
    // says so here in a word (D-070).
    lines.push(paint(`  cost ${costLabel(attempt.cost)}`, stopped ? "bad" : "mid"));
    // The execution bundle's id, in the default view rather than only under
    // `--attempt`: it is what `--resume-from` takes, and a refusal that tells a
    // person to look here has to be telling them somewhere the id appears.
    const execution = attempt.bundles.find((bundle) => bundle.kind === "execution");
    if (execution) lines.push(paint(`  bundle  ${execution.bundle_id}`, "dim"));
    // SCP-154: an attempt that stopped short still wrote its work into a
    // retained change.diff. The command that starts the next attempt from
    // those bytes is printed beside the bundle it names, under the stop that
    // raises the question of what happened to the work.
    const retainedDiff = execution?.artifacts.some(
      (artifact) => artifact.name === "change.diff" && artifact.retained,
    );
    if (stopped && retainedDiff) {
      lines.push(
        paint(
          `  resume  perbo run ${resumeSubject(report)} --resume-from ${execution!.bundle_id}`,
          "mid",
        ),
      );
    }
    lines.push(
      paint(
        `  started ${attempt.started_at}   ended ${attempt.ended_at}   ` +
          `${formatDuration(Date.parse(attempt.ended_at) - Date.parse(attempt.started_at))}`,
        "dim",
      ),
    );
    lines.push(
      paint(
        `  agent   ${attempt.agent.model} · ${attempt.agent.adapter} ${attempt.agent.binary_version} · ` +
          `${attempt.agent.credential_class}`,
        "mid",
      ),
    );
    // D-096: the brief goes back after every compaction, the executor's own
    // session and each subagent alike. Printed only where one happened —
    // "none" is the ordinary round and says nothing a reader needs.
    if (attempt.record.brief_reinjections.length > 0) {
      lines.push(
        paint(
          `  brief   given back ${attempt.record.brief_reinjections.length} ` +
            "time(s) after a compaction",
          "mid",
        ),
      );
    }
    lines.push("");
    lines.push(paint("  CEILINGS", "sect") + paint("   used against the ceiling in force", "dim"));
    for (const use of attempt.ceilings) {
      const style = use.hit ? "bad" : "mid";
      lines.push(
        `    ${pad(RESOURCE_LABEL[use.resource] ?? use.resource, 12)} ` + paint(renderUse(use, attempt.cost), style),
      );
    }
    lines.push(
      paint(
        // These are billed-accounting totals. The ceiling row above is its
        // separate raw stream counter, which can include repeated envelopes.
        `    ${pad("tokens", 12)} ${attempt.tokens.input.toLocaleString("en-US")} in, ` +
          `${attempt.tokens.cache_read.toLocaleString("en-US")} cached · ` +
          `${attempt.tokens.output.toLocaleString("en-US")} out`,
        "dim",
      ),
    );
    lines.push("");

    if ((attempt.checks && attempt.checks.length > 0) || attempt.node_reviews.length > 0) {
      lines.push(paint("  CHECKS", "sect"));
      /**
       * One check's row and what hangs under it. `indent` is 4 for a result
       * measured over the whole change and 6 for one a node ran, which is what
       * puts a node's results under the node's own line.
       */
      const checkRows = (check: CheckResult, indent: number): void => {
        const margin = " ".repeat(indent);
        const hang = `${margin}   `;
        const commandWidth = 28 - indent;
        const mark = CHECK_MARK[check.status] ?? "?";
        // The command and the summary whole (D-NEW-nothing-shown-is-cut): the
        // summary right of the command where both fit the width, and under
        // the row, wrapped, where they do not.
        const command = (check.command ?? "").padEnd(commandWidth);
        const visible = `${margin}${mark}  ${pad(check.name, 15)} ${command}`;
        const head = `${margin}${paint(mark, check.status === "passed" ? "ok" : "bad")}  ${pad(check.name, 15)} ${command}`;
        if (visible.length + 2 + check.summary.length <= WIDTH) {
          lines.push(head + " ".repeat(Math.max(2, WIDTH - visible.length - check.summary.length)) + paint(check.summary, "mid"));
        } else {
          lines.push(head.trimEnd(), ...wrap(check.summary, hang.length).map((line) => paint(line, "mid")));
        }
        // D-107: what a node's run was aimed at, or why it could not be aimed
        // anywhere narrower than the whole change.
        if (check.node) {
          lines.push(
            ...fitted(
              `${hang}${
                check.node.scope === "files"
                  ? `narrowed to ${check.node.paths.join(", ")}`
                  : `over the whole change: ${check.node.note ?? "not narrowed"}`
              }`,
              hang.length,
            ).map((line) => paint(line, "dim")),
          );
        }
        // What the second run measured, and the tests both runs named. A
        // failing check whose record says only that a command exited is not
        // one anybody can act on.
        if (check.rerun) {
          const verdict =
            check.flaky === true ? "flaky · re-run passed" : `re-run ${check.rerun.status}`;
          lines.push(...fitted(`${hang}${verdict}  ${check.rerun.command}`, hang.length).map((line) => paint(line, "dim")));
          if (check.rerun.note) lines.push(...fitted(`${hang}${check.rerun.note}`, hang.length).map((line) => paint(line, "dim")));
        }
        for (const test of check.failing_tests ?? []) {
          lines.push(...fitted(`${hang}${test}`, hang.length).map((line) => paint(line, "mid")));
        }
        // The directory the command ran under. A check that behaves one way
        // here and another in a clean checkout is often reading this, and
        // absent means the record predates the field rather than "none".
        if (check.tmpdir !== undefined) {
          lines.push(...fitted(`${hang}tmpdir ${check.tmpdir ?? "unset"}`, hang.length).map((line) => paint(line, "dim")));
        }
      };

      for (const check of wholeChangeChecks(attempt.checks ?? [])) checkRows(check, 4);
      // Then each node's own results, under the node that ran them, so a
      // person sees which node failed what (D-107).
      const byNode = new Map<string, CheckResult[]>();
      for (const check of attempt.checks ?? []) {
        if (check.node === undefined) continue;
        byNode.set(check.node.node_id, [...(byNode.get(check.node.node_id) ?? []), check]);
      }
      // A node's own review can stand with no check of its own beside it —
      // the checks section was not retained, or none ran for this round — so
      // its line still appears here, under a node this loop would otherwise
      // never visit.
      for (const nodeReview of attempt.node_reviews) {
        if (!byNode.has(nodeReview.node_id)) byNode.set(nodeReview.node_id, []);
      }
      for (const [node_id, ran] of byNode) {
        lines.push(paint(`    ${node_id}`, "dim"));
        for (const check of ran) checkRows(check, 6);
        // D-107: that node's own review, or why it has none.
        const nodeReview = attempt.node_reviews.find((entry) => entry.node_id === node_id);
        if (nodeReview !== undefined) {
          lines.push(
            paint(
              nodeReview.review
                ? `      review ${nodeReview.review.decision} · ` +
                    `${nodeReview.review.findings.filter((finding) => finding.blocking).length} blocking`
                : "      not reviewed on its own: no file inside its paths changed",
              "dim",
            ),
          );
        }
      }
      lines.push("");
    } else if (attempt.round === 0 && attempt.termination.reason === "completed") {
      lines.push(paint("  CHECKS    not retained in the bundle", "dim"), "");
    }

    if (attempt.review) {
      const review = attempt.review;
      const right =
        `${review.findings.length} finding(s) · ` +
        `${costPhrase(costOf({ micros: review.cost_micros, basis: review.model.cost_basis }))}`;
      lines.push(spread(paint("  REVIEW", "sect") + `    ${review.review_id}   ${review.decision}`, right, paint, "dim"));
      // A verdict the plan could not accept cost the review, not the change
      // set. Its reason is what says which — so it is printed beside the round,
      // both reasons when the correction was rejected too (SCP-165).
      for (const rejected of review.rejected_verdicts) {
        for (const line of wrap(
          `verdict ${rejected.attempt} rejected (${rejected.kind}): ${rejected.reason}`,
          4,
        )) {
          lines.push(paint(line, "warn"));
        }
      }
      for (const finding of review.findings) {
        const tag = FINDING_TAG[finding.routing] ?? finding.routing;
        const at = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(no file)";
        const style = finding.blocking ? "bad" : finding.routing === "remediable" ? "warn" : "dim";
        // The location whole: beside the rule where it fits, under it where it does not.
        const row = `    ${paint(pad(tag, 8), style)} ${paint(pad(finding.rule_id, 28), "hi")} `;
        if (43 + at.length <= WIDTH) lines.push(row + paint(at, "mid"));
        else lines.push(row.trimEnd(), ...wrap(at, 13).map((line) => paint(line, "mid")));
        lines.push(
          paint(
            `             ${finding.blocking ? "blocking" : "not blocking"} · ${finding.routing} · ` +
              `key ${finding.key.slice(0, 12)}`,
            "dim",
          ),
        );
        for (const line of wrap(finding.statement, 13)) lines.push(paint(line, "mid"));
        // What decided this one's routing, where the routing turned on the
        // base rather than on the finding's own words.
        const attribution = attributionLine(finding, attempt.record);
        if (attribution !== null) {
          for (const line of wrap(attribution, 13)) lines.push(paint(line, "dim"));
        }
        // The person's own answer, where they gave one here (SCP-181). It sits
        // under the finding it answers, because a decision read anywhere else
        // is a word without the thing it was about.
        for (const verdict of decided.get(finding.key) ?? []) {
          for (const line of verdictLines(verdict)) lines.push(paint(line, "warn"));
        }
      }
      lines.push("");
    } else if (attempt.review_decision) {
      lines.push(
        paint(`  REVIEW    ${attempt.review_decision} — the artifact bytes were not retained`, "dim"),
        "",
      );
    }

    if (attempt.verification) {
      const verification = attempt.verification;
      const right = verification.deterministic_failure
        ? "failed on deterministic evidence"
        : verification.all_closed
          ? "all closed"
          : `${verification.open_keys.length} open`;
      lines.push(spread(paint("  VERIFICATION", "sect") + `   round ${attempt.round}`, right, paint, verification.all_closed ? "ok" : "warn"));
      if (verification.deterministic_failure) {
        for (const line of wrap(verification.deterministic_failure, 4)) lines.push(paint(line, "bad"));
      }
      for (const row of verification.per_finding) {
        const head = `    ${paint(pad(row.status, 11), row.status === "closed" ? "ok" : "warn")} ${paint(row.finding_key.slice(0, 12), "hi")} `;
        if (30 + row.pointer.length <= WIDTH) lines.push(head + paint(row.pointer, "dim"));
        else lines.push(head.trimEnd(), ...wrap(row.pointer, 6).map((line) => paint(line, "dim")));
      }
      lines.push(
        paint(
          `    ${costPhrase(costOf({ micros: verification.cost_micros, basis: verification.cost_basis }))}`,
          "dim",
        ),
        "",
      );
    }

    lines.push(paint(`  ROUND COST   ${rollLabel(attempt.round_cost)}`, "mid"), "");

    if (attempt.denials.length > 0) {
      lines.push(
        paint("  DENIALS", "sect") +
          paint(`   ${attempt.denials.length} command(s) the executor did not get`, "dim"),
      );
      for (const denial of attempt.denials) {
        // The refused target whole (D-NEW-nothing-shown-is-cut): beside the rule where it fits.
        const rule = `    ${paint(pad(denial.rule, 24), "warn")} `;
        if (32 + denial.target.length <= WIDTH) lines.push(rule + paint(denial.target, "hi"));
        else lines.push(rule.trimEnd(), ...wrap(denial.target, 6).map((line) => paint(line, "hi")));
        const by = denial.agent === null ? "" : `${denial.agent}  `;
        for (const line of wrap(`${by}${denial.tool}  ${denial.command}`, 6)) {
          lines.push(paint(line, "dim"));
        }
      }
      lines.push("");
    }

    if (attempt.declines.length > 0) {
      lines.push(paint("  DECLINES", "sect") + paint("  no determinable practice — for a person", "dim"));
      for (const decline of attempt.declines) {
        for (const line of wrap(`${decline.finding_key.slice(0, 12)}  ${decline.reason}`, 4)) {
          lines.push(paint(line, "warn"));
        }
      }
      lines.push("");
    }

    if (options.detail) {
      lines.push(paint("  BUNDLE OBJECTS", "sect"));
      for (const bundle of attempt.bundles) {
        lines.push(paint(`    ${bundle.bundle_id}  ${bundle.kind}  ${bundle.replayability}`, "mid"));
        for (const artifact of bundle.artifacts) {
          lines.push(
            `      ${pad(artifact.name, 28)} ${String(artifact.bytes).padStart(10)} B  ` +
              paint(`${artifact.sha256.slice(0, 12)}${artifact.retained ? "" : "  (not retained)"}`, "dim"),
          );
        }
      }
      if (attempt.bundles.length === 0) lines.push(paint("    none found in the store", "dim"));
      lines.push("");
      lines.push(paint("  CHANGE SET", "sect"));
      if (attempt.changed_files === null) {
        lines.push(paint("    no change.diff retained for this attempt", "dim"));
      } else if (attempt.changed_files.length === 0) {
        lines.push(paint("    empty", "dim"));
      } else {
        for (const file of attempt.changed_files) {
          const counts = `  +${file.additions} -${file.deletions}`;
          if (14 + file.path.length + counts.length <= WIDTH) {
            lines.push(`    ${pad(file.change_kind, 9)} ${paint(file.path, "hi")}` + paint(counts, "dim"));
          } else {
            lines.push(
              `    ${pad(file.change_kind, 9)}` + paint(counts, "dim"),
              ...wrap(file.path, 14).map((line) => paint(line, "hi")),
            );
          }
        }
      }
      lines.push("");
    }
  }
  lines.push(...decisionSection());
  lines.push(
    paint(
      `${report.kind === "ticket" ? "TICKET COST" : "RUN COST   "}  ${rollLabel(report.total_cost)}`,
      "sect",
    ),
    "",
  );
  return lines.join("\n");
}

/**
 * `inspect --verify <attempt>` — the bundle's own claim, recomputed (AYO-69).
 *
 * A run bundle is content-addressed: every artifact it names is stored under
 * `sha256(bytes)` and the manifest carries the hash. Until this, nothing ever
 * recomputed one. The record was therefore trusted exactly as far as the file
 * system was, and a truncated write, a half-restored backup or an edited object
 * read back as the bytes the loop persisted — which is the one property the
 * whole record rests on ([ADR-0026](../../../../docs/adr/0026-replay-claim-tiering.md):
 * a replay claim is a claim about *these* bytes).
 *
 * Three answers, in three different words, because they are three different
 * facts about the store:
 *
 * - **verified** — the object is there and hashes to the name it is filed
 *   under.
 * - **mismatch** — the object is there and its bytes are not what the bundle
 *   names. Something rewrote it. The expected hash and the found one are both
 *   printed, because "it changed" without them is not actionable.
 * - **missing** — the bundle's manifest names an object the store does not
 *   hold, though the manifest says it was retained. Deliberately not the same
 *   word as a mismatch: one is corruption and the other is absence, and a
 *   person acts differently on each.
 *
 * An artifact the bundle records as `retained: false` is none of the three: the
 * store never held those bytes and says so, which is honest rather than wrong.
 * It is counted and named, and it does not fail the check. A store that holds
 * no bundle for the attempt at all is the opposite case and fails it: there is
 * nothing to stand behind, and "verified" over an empty set is a green light
 * for a record nobody checked.
 *
 * This writes nothing. It reads the attempts record, the bundle manifests and
 * the object files, and it constructs no {@link BundleStore} — that class
 * creates its directories on construction, and a check that leaves a directory
 * behind is a check that changed what it was asked about.
 */
export type ObjectStatus = "verified" | "mismatch" | "missing" | "not_retained";

/** One object a bundle names, and what recomputing its hash found. */
export interface ObjectCheck {
  bundle_id: string;
  kind: RunBundleKind;
  /** The artifact's name in the bundle, e.g. `change.diff`. */
  name: string;
  /** The hash the manifest names it by. */
  expected: string;
  /** The hash of the bytes on disk, or null where there are none to hash. */
  found: string | null;
  status: ObjectStatus;
}

export interface VerifyReport {
  /** What a person calls this work, as `inspect`'s resolver named it (`InspectSubject.ticket`). */
  ticket: string;
  attempt_id: string;
  /** The bundles this attempt wrote, in the order the report lists them. */
  bundles: Array<{ bundle_id: string; kind: RunBundleKind; objects: number }>;
  objects: ObjectCheck[];
  verified: number;
  mismatched: number;
  missing: number;
  not_retained: number;
  /** Whether every object the store was supposed to hold hashed to its name. */
  ok: boolean;
}

/**
 * Every bundle in a store, read without constructing one.
 *
 * `BundleStore.list` answers the same question and makes its directories on the
 * way in; this is the read-only half of it, so `--verify` cannot create the
 * store it was asked to check.
 */
function bundlesInStore(storeDirectory: string, ticketId: string): RunBundle[] {
  const directory = join(storeDirectory, ...bundleManifestsDir());
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => RunBundleSchema.parse(JSON.parse(readFileSync(join(directory, name), "utf8"))))
    .filter((bundle) => bundle.ticket_id === ticketId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** One artifact, re-hashed against the name the manifest files it under. */
function checkObject(storeDirectory: string, bundle: RunBundle, artifact: ArtifactRef): ObjectCheck {
  const base = { bundle_id: bundle.bundle_id, kind: bundle.kind, name: artifact.name, expected: artifact.sha256 };
  if (!artifact.retained) return { ...base, found: null, status: "not_retained" };
  const path = join(storeDirectory, ...bundleObjectPath(artifact.sha256));
  if (!existsSync(path)) return { ...base, found: null, status: "missing" };
  const found = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { ...base, found, status: found === artifact.sha256 ? "verified" : "mismatch" };
}

/**
 * Re-hash every object the bundles of one attempt name.
 *
 * The attempt is looked up in the record first, so a mistyped id is refused
 * with the ids that are on record rather than verified as an empty set — a
 * check that passes because it found nothing to check is the worst answer this
 * could give.
 */
export function verifyAttemptObjects(input: {
  storeDirectory: string;
  ticket: string;
  ticket_id: string;
  attempt: string;
}): VerifyReport {
  const attemptsFile = join(input.storeDirectory, ...attemptsPath(input.ticket_id));
  if (!existsSync(attemptsFile)) {
    throw new UsageError(`${input.ticket} has no attempts on record in ${attemptsFile}`);
  }
  const record = readAttemptsFile(attemptsFile);
  const attempt = record.attempts.find((one) => one.attempt_id === input.attempt);
  if (attempt === undefined) {
    throw new UsageError(
      `${input.ticket} has no attempt ${input.attempt} (recorded: ${record.attempts
        .map((one) => one.attempt_id)
        .join(", ")})`,
    );
  }
  const joined = attemptBundles(attempt, bundlesInStore(input.storeDirectory, input.ticket_id));
  const bundles = [joined.execution, joined.review, joined.verification].filter(
    (bundle): bundle is RunBundle => bundle !== undefined,
  );
  const objects = bundles.flatMap((bundle) =>
    bundle.artifacts.map((artifact) => checkObject(input.storeDirectory, bundle, artifact)),
  );
  const count = (status: ObjectStatus): number =>
    objects.filter((object) => object.status === status).length;
  return {
    ticket: input.ticket,
    attempt_id: attempt.attempt_id,
    bundles: bundles.map((bundle) => ({
      bundle_id: bundle.bundle_id,
      kind: bundle.kind,
      objects: bundle.artifacts.length,
    })),
    objects,
    verified: count("verified"),
    mismatched: count("mismatch"),
    missing: count("missing"),
    not_retained: count("not_retained"),
    // A store holding no bundle for this attempt is not a pass. There is
    // nothing here to stand behind, and a green light over an empty set is the
    // one answer a check on a record must never give.
    ok: bundles.length > 0 && count("mismatch") === 0 && count("missing") === 0,
  };
}

/**
 * The verification as a person reads it: one line per object, then the count.
 *
 * The full hashes and not a prefix: a person comparing this against a backup,
 * a manifest or another machine needs the whole value, and the two are printed
 * on their own lines so neither is clipped by the 80-column rule.
 */
export function renderVerification(report: VerifyReport): string {
  const lines = [`verify ${report.ticket} ${report.attempt_id}`];
  if (report.bundles.length === 0) {
    return `${lines.join("\n")}\nnothing to verify: this store holds no bundle for this attempt\n`;
  }
  for (const bundle of report.bundles) {
    lines.push(`  ${bundle.bundle_id}  ${bundle.kind}  ${bundle.objects} object(s)`);
    for (const object of report.objects.filter((one) => one.bundle_id === bundle.bundle_id)) {
      switch (object.status) {
        case "verified":
          lines.push(`    ok         ${object.name}`);
          break;
        case "mismatch":
          lines.push(
            `    mismatch   ${object.name}`,
            `      expected ${object.expected}`,
            `      found    ${object.found}`,
          );
          break;
        case "missing":
          lines.push(
            `    missing    ${object.name} — the object store does not hold it`,
            `      expected ${object.expected}`,
          );
          break;
        case "not_retained":
          lines.push(`    absent     ${object.name} — the bundle records it as not retained`);
          break;
      }
    }
  }
  const total = report.objects.length - report.not_retained;
  // `objects` whatever the count: this line is the check's answer and a script
  // or a person greps for it, so it has one spelling rather than two.
  lines.push(
    report.ok ? `verified: ${report.verified} objects` : `verified: ${report.verified} of ${total} objects`,
  );
  // Only what happened: a "0 missing" beside a mismatch would put the word for
  // one fault in the report of the other.
  if (report.mismatched > 0) lines.push(`hash mismatch: ${report.mismatched} object(s)`);
  if (report.missing > 0) lines.push(`missing from the object store: ${report.missing} object(s)`);
  if (report.not_retained > 0) {
    lines.push(`not retained: ${report.not_retained} object(s) the bundle does not hold`);
  }
  return `${lines.join("\n")}\n`;
}

/** The ticket a key names, as the report needs it. */
const ticketFileSubject = (storeDirectory: string, key: string): InspectSubject => {
  const ticket = readTicketForDisplay(storeDirectory, key);
  // SCP-173: the delivery record when it already says — written the moment a
  // run opens a pull request, so it answers for a ticket still `failed` behind
  // an earlier round's pull request with no `pr_open` row in its history at
  // all. SCP-176: falling back to what the row that reached `pr_open`
  // recorded about itself, never off the shape of the transition, for a
  // legacy record with nothing decided. `from: "failed"` was once enough,
  // because a hand-off was the only thing that row could be; the loop's own
  // pull request outliving a failed re-run writes the same two states and is
  // not a hand-off, so the edge no longer answers the question. `null` when
  // neither source says — a legacy record `sync` walked without being able to
  // attribute it to either. That is a third answer, not a `false` that would
  // read as "the loop, definitely".
  const attribution = ticket.delivery.opened_by ?? pullRequestAttribution(ticket);
  return {
    kind: "ticket",
    ticket: ticket.key,
    ticket_id: ticket.ticket_id,
    title: ticket.title,
    contract_source: null,
    // A ticket's history is on the ticket file; a refusal is recorded on the
    // record a run with no ticket writes about itself, and there is none here.
    refusal: null,
    state: ticket.state,
    pull_request_url: ticket.delivery.pull_request_url,
    // The base a run resolved is recorded on the record a run with no ticket
    // writes about itself; a ticket's delivery does not carry one.
    base: null,
    // What the run that opened the pull request read on its head, and what
    // every `perbo sync` since has re-read.
    delivery_checks:
      ticket.delivery.checks_state === null
        ? null
        : { state: ticket.delivery.checks_state, checks: ticket.delivery.checks },
    handed_off: attribution === null ? null : attribution === "hand_off",
    // Carried through untouched: a reader comparing admission friction across
    // tickets is comparing what was recorded, not what this version can name.
    admission: ticket.admission,
    source: ticket.source,
    queue: queueStanding(storeDirectory, ticket),
    // D-103: whether the spec this contract was drafted from is still that
    // spec. Read for every ticket, whatever state it is in — a run in flight
    // is the case this is printed for and not acted on.
    spec_staleness: specStaleness({
      repositoryRoot: ticket.repository_root,
      // Which moment the reading is against. A ticket in `plan_review` has not
      // been approved, so its spec is measured from admission and says so —
      // telling it the spec was "edited since the contract was approved from
      // it" would name a moment that has not happened.
      approved: ticket.approved_at !== null,
      // Absent and null are one answer: a ticket admitted before specs
      // existed carries no key, and one admitted from an issue carries null.
      spec: ticket.admission.spec ?? null,
    }),
    runs_started: runsStartedBy(ticket),
    ...planOf(storeDirectory, ticket),
  };
};

/**
 * The plan's outcome, its graph and its size, read from the contract beside
 * the ticket and the approach beside that (D-100, D-104).
 *
 * The size counts over this checkout's tracked files, because that is where the
 * work would land; a contract that cannot be read leaves all of it null rather
 * than taking the report down, since everything else `inspect` answers is
 * still answerable, and an approach record that cannot be read, or names
 * another plan, is reported as the problem it is rather than as no order.
 */
function planOf(
  storeDirectory: string,
  ticket: DisplayTicket,
): {
  outcome: string | null;
  nodes: readonly PlanNode[] | null;
  edges: readonly GraphEdge[] | null;
  approach_problem: string | null;
  size: SizeEstimate | null;
} {
  let contract;
  try {
    contract = readContract(storeDirectory, ticket.key);
  } catch {
    return { outcome: null, nodes: null, edges: null, approach_problem: null, size: null };
  }
  const nodes = planNodes(contract);
  let approachProblem: string | null = null;
  const approach = (() => {
    try {
      return readApproachRecord(storeDirectory, ticket.key, contract);
    } catch (error) {
      approachProblem = error instanceof Error ? error.message : String(error);
      return null;
    }
  })();
  return {
    outcome: contract.outcome,
    nodes: nodes.length > 0 ? nodes : null,
    edges: nodes.length > 0 && approachProblem === null ? (approach?.edges ?? []) : null,
    approach_problem: approachProblem,
    size: sizeEstimate(
      planSizeCounts({
        nodes,
        criteria: contract.level === "P0" ? 0 : contract.acceptance_criteria.length,
        paths_allowed: contract.scope.paths_allowed,
        paths_prohibited: contract.scope.paths_prohibited,
        trackedFiles: trackedFiles(ticket.repository_root),
      }),
    ),
  };
}

/**
 * Where the ticket stands, read from the store as `perbo serve` reads it:
 * the whole store in queue order, then the tickets holding a place. Ordered
 * before the filter, as the queue orders it, because a settled dependency
 * still decides where its dependants fall in the order. The queue itself is
 * not asked; what it decided last is on the ticket's own scheduling record.
 */
function queueStanding(storeDirectory: string, ticket: DisplayTicket): QueueStanding {
  const holding = queueOrder(listTickets(storeDirectory)).filter((each) =>
    (QUEUE_HOLDING_STATES as readonly string[]).includes(each.state),
  );
  const index = holding.findIndex((each) => each.key === ticket.key);
  return {
    place: index === -1 ? null : index + 1,
    holding: holding.length,
    depends_on: ticket.depends_on,
    waits: describeScheduling(ticket.scheduling, ticket.state),
  };
}

/**
 * What a name on the command line stands for: the ticket, or — where no ticket
 * answers to it — the run that does (SCP-180).
 *
 * `perbo` keeps both in one store: `perbo run --outcome …` writes its
 * attempts beside an admitted ticket's, under the id its own contract is keyed
 * by and with no ticket file at all. The ticket store is asked first, so a
 * store holding both is read exactly the way it always was, and the fallback is
 * the resolver a run with nothing admitted uses — one answer to "what is this
 * id", not two.
 */
export const ticketSubject: ResolveSubject = (storeDirectory, key): InspectSubject => {
  if (existsSync(join(storeDirectory, ...ticketFilePath(key)))) {
    return ticketFileSubject(storeDirectory, key);
  }
  try {
    return attemptsRecordSubject(storeDirectory, key);
  } catch (unrecorded) {
    if (!(unrecorded instanceof UsageError)) throw unrecorded;
    // The name is neither. The ticket store's own refusal leads, because it
    // lists the tickets and a mistyped key is the common case; what has run
    // here without one is appended, because "no ticket PRB-9" is the wrong
    // whole answer in a store whose work has no tickets in it at all.
    try {
      return ticketFileSubject(storeDirectory, key);
    } catch (noTicket) {
      if (!(noTicket instanceof TicketStoreError)) throw noTicket;
      throw new TicketStoreError(`${noTicket.message}; ${unrecorded.message}`);
    }
  }
};

/** The report for one piece of work, by the key or the id a person typed. */
export function buildInspectReport(input: {
  storeDirectory: string;
  key: string;
  attempt: string | null;
  /** Where an unreadable verdicts file is named; the report itself is still built. */
  streams?: Diagnostics | undefined;
}): InspectReport {
  return buildReportForSubject({
    storeDirectory: input.storeDirectory,
    subject: ticketSubject(input.storeDirectory, input.key),
    attempt: input.attempt,
    streams: input.streams,
  });
}

/**
 * What `perbo inspect` answers: a reading of one piece of work, or a verdict
 * on the bytes of one attempt.
 */
export type InspectOutcome =
  | { kind: "report"; report: InspectReport; attempt: string | null }
  | { kind: "verification"; verification: VerifyReport };

export function inspect(input: InspectInput, context: CommandContext): InspectOutcome {
  const storeDirectory = storeFor(context.cwd, input.target);
  if (input.verify !== null) {
    const subject = ticketSubject(storeDirectory, input.key);
    return {
      kind: "verification",
      verification: verifyAttemptObjects({
        storeDirectory,
        ticket: subject.ticket,
        ticket_id: subject.ticket_id,
        attempt: input.verify,
      }),
    };
  }
  return {
    kind: "report",
    attempt: input.attempt,
    report: buildReportForSubject({
      storeDirectory,
      subject: ticketSubject(storeDirectory, input.key),
      attempt: input.attempt,
      streams: context.diagnostics,
    }),
  };
}

const FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--attempt": valueFlag(),
  "--verify": valueFlag(),
  "--json": switchFlag(),
} satisfies FlagTable;

const GRAMMAR: Grammar<typeof FLAGS> = {
  command: "inspect",
  flags: FLAGS,
  positionals: {
    min: 1,
    max: 1,
    refusal: "inspect takes exactly one ticket key, e.g. perbo inspect PRB-1",
  },
  afterDoubleDash: "positionals",
};

/**
 * One ticket in full, as its record and as the reading a person gets.
 *
 * Reached by the terminal through its line below, and by a caller in this
 * process — the queue's endpoint — over the same typed input.
 */
export const inspectReport: CommandReport<InspectInput, { json: boolean }, InspectOutcome> = {
  run: inspect,
  toJson: (outcome) =>
    outcome.kind === "verification" ? outcome.verification : outcome.report,
  render(outcome, output, target): Rendered {
    if (outcome.kind === "verification") {
      // The human rendering whenever `--json` was not asked for, where the
      // reading below switches on the terminal instead. What a check returns
      // is a verdict and an exit code, not a document to pipe into a renderer,
      // and `perbo inspect X --verify att … | tee` has to say the same thing
      // in a pipeline that it says on a terminal.
      return {
        stdout: output.json
          ? `${JSON.stringify(outcome.verification, null, 2)}\n`
          : renderVerification(outcome.verification),
        stderr: "",
        // The gate is closed on a record that does not verify: not a usage
        // error (the command did what it was asked), and not a crash (nothing
        // fell over).
        exitCode: outcome.verification.ok ? 0 : EXIT_CODES.gate_closed,
      };
    }
    return {
      stdout: target.json
        ? `${JSON.stringify(outcome.report, null, 2)}\n`
        : `${renderInspect(outcome.report, {
            color: target.color,
            detail: outcome.attempt !== null,
            version: VERSION,
          })}\n`,
      stderr: "",
      exitCode: 0,
    };
  },
};

export const inspectCommandLine: ReportCommand<
  InspectInput,
  { json: boolean },
  InspectOutcome
> = {
  kind: "report",
  name: "inspect",
  grammars: [GRAMMAR],
  jsonWhenPiped: true,
  grammarFor: () => GRAMMAR,
  read(argv) {
    const line = parseArgv(GRAMMAR, argv);
    return {
      input: readInput(InspectInputSchema, {
        target: { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null },
        key: line.positionals[0],
        attempt: line.flags["--attempt"] ?? null,
        verify: line.flags["--verify"] ?? null,
      }),
      output: { json: line.flags["--json"] === true },
    };
  },
  ...inspectReport,
};

/** Exposed for the tests, which build a store by hand and read it back. */
export function readBundleObject(storeDirectory: string, sha256: string): string | null {
  const path = join(storeDirectory, ...bundleObjectPath(sha256));
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
