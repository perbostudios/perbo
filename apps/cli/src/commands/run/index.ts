import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  DEFAULT_LIMITS,
  EXIT_CODES,
  ExecutionAttemptSchema,
  InstallStrategySchema,
  LIMITED_RESOURCES,
  LimitsTableSchema,
  PER_TOKEN_COST_LIMITS,
  PlanContractSchema,
  UNCHECKED,
  failedChecks,
  limitFor,
  type DefaultedResource,
  type DiagnosticResult,
  type ExecutionAttempt,
  type LimitedResource,
  type LimitsTable,
  type MaterializationManifest,
  type PerTokenCostLimit,
  type PlanContract,
  type TerminationReason,
} from "@perbo/contracts";
import {
  GREENFIELD_VERIFY,
  declaredVerifyCommand,
  detectPackageManager,
  diagnose,
  gh,
  git,
  pinInstallCommand,
  proposedInstall,
  proposedInstallStep,
  verificationServiceNeed,
  workspaceMembership,
  type DiagnoseRequest,
  type RunResult,
} from "@perbo/workspace";
import {
  DEFAULT_DELIVERED_CHECKS_BOUND_MS,
  ResumeRefusedError,
  RunRefusedError,
  TURBO_FORCE_FLAG,
  TicketRunConfigSchema,
  preflight,
  readDeliveredChecks,
  renderPreflight,
  resolveResumeSource,
  resumeNote,
  runTicket,
  runsTurboWithoutForce,
  type BaseSource,
  type DeliveredChecksReading,
  type PreflightRequest,
  type PreflightResult,
  type TicketRunResult,
  type MergedTicketContext,
} from "@perbo/runner";
import {
  TICKET_TRANSITIONS,
  TicketSchema,
  admittedSpecFiles,
  transition,
  type SpecFile,
  type StandingProhibitedEntry,
  type Ticket,
  type TicketSource,
  type TicketState,
} from "@perbo/contracts";
import {
  applyObservedPath,
  loadAdmitted,
  readTicket,
  statesObserved,
  writeTicket,
} from "../admit.js";
import { COMMAND_NAMES } from "../../command-line/names.js";
import { UsageError } from "../../usage-error.js";
import {
  LOCAL_RUN_SCHEMA_VERSION,
  assertLocalRunArgs,
  isLocalRunArgs,
  mintLocalPlan,
  readLocalRunRecord,
  recordRunPullRequest,
  recordRunRefusal,
  statesCriteria,
  writeLocalRunRecord,
  type LocalPlan,
} from "./local.js";
import {
  readPullRequestChecks,
  unaskedPullRequestChecks,
  type PullRequestChecks,
} from "../../pull-request.js";
import { describeFailure } from "../../failure.js";
import { readCorpusCache, renderCorpusCache } from "./corpus-cache.js";
import {
  configuredReviewer,
  probeReviewer,
  renderProviderProbe,
  reviewerDependency,
} from "./internal/probe.js";
import { mergedTicketContext } from "./internal/relevel.js";
import { judgingPaths, standingProhibited, storeDir, type JudgingPath } from "../../store/index.js";
import type { Streams } from "../../streams.js";
import { derivedBranch, recordDelivery } from "../sync.js";
import { specStaleness } from "../../spec/staleness.js";
import { listTickets, readApproachRecord } from "../../store/tickets.js";

/**
 * `perbo run` and `perbo doctor` (SCP-016 through SCP-020, SCP-094).
 *
 * Two commands, and the split is deliberate. `doctor` answers "can this
 * repository be materialized at all", which ADR-0025 requires to fail **before**
 * an attempt rather than in the middle of one. `run` takes a contract and a run
 * configuration and drives the whole loop.
 *
 * Both keep the Stage 1 stream contract: the record goes to stdout, everything
 * a person reads while waiting goes to stderr.
 *
 * What an *admitted ticket* adds to a run — the contract it owns, the states it
 * moves through, the key a ceiling hit is reported under — is {@link TICKET_RUNS},
 * the one place here that reads and writes the ticket store.
 */

/**
 * The spec's No-Gos, from the ticket's approach record (D-100).
 *
 * Empty where the ticket has no approach record, which is every ticket whose
 * spec stated none and every plan with no graph. A record that cannot be read,
 * or that belongs to another ticket or plan, is the same answer with a line on
 * stderr: `perbo inspect` reports it as the problem it is, and it is not this
 * run's to refuse over.
 */
function approachNoGos(
  dir: string,
  key: string,
  contract: Pick<PlanContract, "ticket_id" | "plan_id">,
): string[] {
  try {
    return readApproachRecord(dir, key, contract)?.no_gos ?? [];
  } catch (error) {
    process.stderr.write(
      `warning: the executor's brief carries no No-Gos, because ${key}.approach.json ` +
        `is not this plan's usable record: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return [];
  }
}

/**
 * An approved piece of work a run was pointed at with `--ticket`, as the
 * commands here need it: where its store is, what it is called, and the
 * contract the attempt binds to. The ticket itself stays behind the interface.
 */
export interface AdmittedWork {
  /** The store the ticket lives in — its config, bundles and state root. */
  dir: string;
  /** The key a person typed, for the messages that name it. */
  key: string;
  contract: PlanContract;
}

/** The ticket store, as `run` uses it. {@link TICKET_RUNS} is the one implementation. */
export interface TicketRuns {
  /**
   * The admitted ticket and its approved contract. Throws where there is none to
   * run: the ticket store's own error for a key it does not hold, or for a
   * contract that does not match its ticket; a {@link UsageError} for a contract
   * not yet approved, or one that disagrees with its draft record.
   */
  load(input: { cwd: string; repo: string; store: string | null; key: string }): AdmittedWork;
  /**
   * The run configuration the ticket derives, under an explicit `--config`.
   * `publish` is the flag as typed: the base derivation may ask GitHub which
   * branch is the default, and only a run that publishes has earned that call.
   */
  runConfig(work: AdmittedWork, override: unknown, publish: boolean): unknown;
  /**
   * SCP-227: the approved contracts of what merged into the base under this
   * ticket's branch, for a re-level's conflict brief.
   */
  relevelContext(work: AdmittedWork, base_ref: string): Promise<MergedTicketContext[]>;
  /**
   * Record that this run has begun — before the attempt, so a run that never
   * returns does not leave a ticket saying `ready` — and answer which run of
   * the ticket this is, counting from 1.
   *
   * `relevel`: the ticket is at `pr_open` and stays there; nothing is reopened,
   * and the answer is null — the loop then counts the runs on the attempts
   * record itself, so a re-level's attempt ids are minted after every run's
   * and a clean re-level, which records none, does not spend one.
   */
  starting(work: AdmittedWork, relevel: boolean): number | null;
  /** Record what the run did to the ticket, and answer the state it left it in. */
  finished(work: AdmittedWork, result: TicketRunResult, at: Date, relevel: boolean): string;
}

export interface ExecuteArgs {
  /** An admitted ticket key. Supplies the contract, and is moved by the run. */
  ticket: string | null;
  store: string | null;
  contract: string | null;
  config: string | null;
  repo: string;
  /** Where worktrees would go. `doctor` says what a package manager makes of it. */
  worktreeRoot: string | null;
  publish: boolean;
  json: boolean;
  quiet: boolean;
  /** `doctor` only: write the proposed `.perbo/config.json` when none exists. */
  writeConfig: boolean;
  /**
   * `doctor` only: make one minimal call at the configured reviewer model and
   * say whether the provider answers this machine, before an attempt has spent
   * anything. Off by default, because a diagnostic that calls a provider
   * without being asked is one nobody can run offline.
   */
  probe: boolean;
  /**
   * The execution bundle of an attempt a ceiling cut, whose retained
   * `change.diff` this run starts from (SCP-154). `run` only.
   */
  resumeFrom: string | null;
  /**
   * The contract as typed, for a run with nothing admitted behind it
   * (SCP-180). Its presence is what makes the contract's source `arguments`.
   */
  outcome: string | null;
  criteria: string[];
  /** What the change may touch. Nothing typed means `**`: no scope was stated. */
  paths: string[];
  /** `owner/repo#N` or its URL: take the plan from that pull request's own text. */
  pr: string | null;
  /**
   * SCP-227: re-level an admitted ticket's open branch with its base rather
   * than run the ticket. `run` with `--ticket` only.
   */
  relevel: boolean;
}

const TAKES_VALUE = new Set([
  "--ticket",
  "--store",
  "--contract",
  "--config",
  "--repo",
  "--worktree-root",
  "--resume-from",
  "--outcome",
  "--criterion",
  "--path",
  "--pr",
]);
const FLAGS = new Set(["--publish", "--json", "--quiet", "--write-config", "--probe", "--relevel"]);

export function parseExecuteArgs(argv: string[]): ExecuteArgs {
  const args: ExecuteArgs = {
    ticket: null,
    store: null,
    contract: null,
    config: null,
    repo: ".",
    worktreeRoot: null,
    publish: false,
    json: false,
    quiet: false,
    writeConfig: false,
    probe: false,
    resumeFrom: null,
    outcome: null,
    criteria: [],
    paths: [],
    pr: null,
    relevel: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument '${token}'`);
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`${name} does not take a value`);
      if (name === "--publish") args.publish = true;
      if (name === "--json") args.json = true;
      if (name === "--quiet") args.quiet = true;
      if (name === "--write-config") args.writeConfig = true;
      if (name === "--probe") args.probe = true;
      if (name === "--relevel") args.relevel = true;
      continue;
    }
    if (!TAKES_VALUE.has(name)) throw new UsageError(`unknown flag '${name}'`);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined) throw new UsageError(`${name} requires a value`);
    if (name === "--ticket") args.ticket = value;
    if (name === "--store") args.store = value;
    if (name === "--contract") args.contract = value;
    if (name === "--config") args.config = value;
    if (name === "--repo") args.repo = value;
    if (name === "--worktree-root") args.worktreeRoot = value;
    if (name === "--resume-from") args.resumeFrom = value;
    if (name === "--outcome") args.outcome = value;
    if (name === "--criterion") args.criteria.push(value);
    if (name === "--path") args.paths.push(value);
    if (name === "--pr") args.pr = value;
  }
  return args;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `could not read ${label} from ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** Exit codes match the review contract's meaning, one layer out. */
export function exitCodeForRun(outcome: TicketRunResult["outcome"]): number {
  switch (outcome) {
    // `level` and `relevelled` are a re-level that left the branch level, or
    // found it so (SCP-227): the same answer as an approval, one layer out.
    case "approved":
    case "level":
    case "relevelled":
      return 0;
    // SCP-194: a stalled remediation is a verdict on the change — findings the
    // executor could not close — so it sits with the other twos rather than
    // with the run-did-not-complete threes.
    case "changes_requested":
    case "escalated":
    case "remediation_exhausted":
    case "remediation_stalled":
      return 2;
    // `3` is "the run did not complete", not a verdict on the change.
    // `base_conflict` is here rather than at `2` for that reason: the branch
    // could not reach its base, so nothing judged it (SCP-192).
    case "no_changes":
    case "terminated":
    case "base_conflict":
    case "review_failed":
      return 3;
  }
}

/**
 * One dollar figure, and what it is. `micros` is null where the basis carries
 * no dollars at all — `$0.00` and "nobody measured this" are different facts,
 * and a terminated attempt used to be printed as the first when it was the
 * second. `partial` says the component was stopped before its transport wrote a
 * final accounting line, so the figure covers only what was read by the stop.
 */
export interface AttemptCost {
  micros: number | null;
  basis: ExecutionAttempt["usage"]["cost_basis"];
  partial: boolean;
}

/**
 * Costs added up: a round's components, a run's, or a ticket's. A component
 * with no dollars is counted rather than dropped, so a subtotal never reads as
 * complete when part of it is missing, and the partial ones are named for the
 * same reason.
 */
export interface CostRoll {
  /** Micro-dollars from the components that carry a figure. */
  micros: number;
  /** Components that could carry one; `not_incurred` is not among them. */
  components: number;
  priced: number;
  /** Priced by the transport's own dollar total. */
  reported: number;
  /** Priced from token usage at the provider's recorded list rates. */
  estimated: number;
  unavailable: number;
  /** Of the priced ones, how many are a charge up to a stop rather than a total. */
  partial: number;
}

export function rollCosts(components: readonly AttemptCost[]): CostRoll {
  const counted = components.filter((cost) => cost.basis !== "not_incurred");
  const priced = counted.filter((cost) => cost.micros !== null);
  return {
    micros: priced.reduce((total, cost) => total + (cost.micros ?? 0), 0),
    components: counted.length,
    priced: priced.length,
    reported: priced.filter((cost) => cost.basis === "transport_reported").length,
    estimated: priced.filter((cost) => cost.basis === "provider_list_estimate").length,
    unavailable: counted.length - priced.length,
    partial: priced.filter((cost) => cost.partial).length,
  };
}

export function addRolls(a: CostRoll, b: CostRoll): CostRoll {
  return {
    micros: a.micros + b.micros,
    components: a.components + b.components,
    priced: a.priced + b.priced,
    reported: a.reported + b.reported,
    estimated: a.estimated + b.estimated,
    unavailable: a.unavailable + b.unavailable,
    partial: a.partial + b.partial,
  };
}

/** A basis that carries no dollars carries no figure either. */
export function dollars(
  micros: number,
  basis: ExecutionAttempt["usage"]["cost_basis"],
  partial = false,
): AttemptCost {
  return {
    micros: basis === "unavailable" || basis === "not_incurred" ? null : micros,
    basis,
    partial,
  };
}

/**
 * What the run in front of you cost: every attempt it made — the ones a
 * transport failure superseded included, because they were paid for — plus the
 * one independent review and each round's closure verification.
 *
 * Reported on completion whatever the outcome, and that is the point: an
 * attempt a ceiling cut spent money on the way to being cut, and a run whose
 * total is only readable by opening the store afterwards is a run whose cost
 * nobody sees.
 */
export function runCost(result: TicketRunResult): CostRoll {
  return result.rounds
    .map((round) =>
      rollCosts([
        ...[round.attempt, ...(round.superseded_attempts ?? [])].map((attempt) =>
          dollars(
            attempt.usage.cost_micros,
            attempt.usage.cost_basis,
            attempt.usage.cost_partial === true,
          ),
        ),
        ...(round.review ? [dollars(round.review.cost_micros, round.review.model.cost_basis)] : []),
        ...(round.verification
          ? [dollars(round.verification.cost_micros, round.verification.cost_basis)]
          : []),
      ]),
    )
    .reduce(addRolls, rollCosts([]));
}

/** A roll as a person reads it: what it adds up to, and what is missing from it. */
export function renderCostRoll(roll: CostRoll): string {
  if (roll.components === 0) return "not incurred";
  if (roll.priced === 0) return `unavailable — ${roll.unavailable} component(s) unpriced`;
  const notes = [`${roll.priced} of ${roll.components} priced`];
  if (roll.estimated > 0) {
    notes.push(`${roll.reported} reported`, `${roll.estimated} estimated`);
  }
  if (roll.partial > 0) notes.push(`${roll.partial} partial`);
  if (roll.unavailable > 0) notes.push(`${roll.unavailable} unavailable`);
  return `$${(roll.micros / 1_000_000).toFixed(4)} — ${notes.join(", ")}`;
}

export function renderRun(
  result: TicketRunResult,
  run?: {
    local?: boolean;
    /** What this repository runs on a pull request, where it was asked (SCP-279). */
    repository_checks?: PullRequestChecksReading | null;
  },
): string {
  const lines: string[] = [];
  const renderCost = (
    micros: number,
    basis: "transport_reported" | "provider_list_estimate" | "unavailable",
  ): string =>
    basis === "unavailable"
      ? "cost unavailable"
      : `$${(micros / 1_000_000).toFixed(4)} ` +
        (basis === "transport_reported" ? "reported" : "estimated");
  lines.push(`${run?.local ? "RUN      " : "TICKET   "} ${result.ticket_id}`);
  lines.push(`BRANCH    ${result.workspace.branch}`);
  lines.push("");
  for (const round of result.rounds) {
    const review = round.review;
    const label = round.round === 0 ? "attempt" : `remediation ${round.round}`;
    lines.push(
      `  ${label.padEnd(16)} ${round.attempt.termination.reason.padEnd(24)} ` +
        `${review ? review.decision : "(no review)"}`,
    );
    for (const decline of round.declines ?? []) {
      lines.push(`    no determinable practice — ${decline.finding_key.slice(0, 12)}: ${decline.reason}`);
    }
    if (review) {
      lines.push(
        `  ${"".padEnd(16)} ${String(round.remediable_findings).padStart(2)} to the executor · ` +
          `${round.directly_verified}/${review.coverage.length} directly verified · ` +
          `${renderCost(review.cost_micros, review.model?.cost_basis ?? "provider_list_estimate")}`,
      );
    }
  }
  lines.push("");
  lines.push(`OUTCOME   ${result.outcome} — ${result.detail}`);
  // What it cost, on every outcome including the ones a ceiling ended: a run
  // that stopped still spent, and the figure belongs beside the reason.
  lines.push(`COST      ${renderCostRoll(runCost(result))}`);
  if (result.pull_request) lines.push(`PR        ${result.pull_request.url}`);
  // What GitHub said about the head, beside the pull request it is on. A red
  // check is not a judgement of the change — the review already made that —
  // but it is the difference between a pull request somebody can merge and one
  // they cannot, and it is named here rather than found on GitHub later.
  if (result.delivery_checks) {
    const read = result.delivery_checks;
    const repository = run?.repository_checks ?? null;
    // The state, then what reported or why nothing did, then the sentence that
    // says what to do about it. Three endings arrive here as the same empty
    // rollup and they are not the same news: a repository that runs no check on
    // a pull request has something to configure, a head whose checks had not
    // reported when the run stopped waiting may be green ten minutes from now,
    // and a `gh` that would not answer is neither. All three are `unchecked`,
    // which is why the line has to say which one it is.
    lines.push(
      `CHECKS    ${read.state} — ` +
        (read.checks.length === 0
          ? deliveryChecksReason(read, repository)
          : read.checks.map((check) => `${check.name} ${check.conclusion}`).join(", ")),
    );
    lines.push(`          ${deliveryChecksMessage(read, repository)}`);
  }
  return lines.join("\n");
}

export interface ExecuteOptions {
  args: ExecuteArgs;
  streams: Streams;
  cwd: string;
  /** When the contract was minted, for a run that mints one. */
  now?: Date;
  /**
   * Injected by the tests, the way `runDoctorCommand` takes its own. Production
   * checks the real machine, which means spawning the agent binary, `git` and
   * `gh` to ask each for its version.
   */
  preflight?: (request: PreflightRequest) => PreflightResult;
  /**
   * The `gh` a `--pr` reads a pull request's plan with. Production leaves it
   * unset and the one on PATH is used; a test names a binary instead, so that
   * pointing this command at a different `gh` does not mean editing the
   * environment of the whole process.
   */
  gh?: { binary?: string | undefined } | undefined;
  /**
   * The agent, the reviewer, the verifier and the checks, as the loop takes
   * them. Injected by the tests so the two steps that cost money can be driven
   * without paying a provider; everything between them stays the real thing.
   */
  hooks?: NonNullable<Parameters<typeof runTicket>[0]["hooks"]>;
  /**
   * Whether this repository runs anything on a pull request (SCP-279). The
   * reader that asks `gh` is the default; a test names its own so that what a
   * run does with the answer can be driven without a repository that has one.
   */
  pullRequestChecks?: PullRequestChecksReader;
}

/**
 * What a repository runs on a pull request, as `gh` reports it. The reader is
 * `readPullRequestChecks` in `pull-request.ts`, which is what both commands use
 * where a test does not name its own.
 */
export type PullRequestChecksReading = PullRequestChecks;

export type PullRequestChecksReader = (request: {
  worktree: string;
  base_ref: string | null;
  /** The ref whose `.github/workflows` a pull request here would carry. */
  ref: string | null;
}) => Promise<PullRequestChecks>;

/**
 * Whether the reading is a positive "this repository runs nothing on a pull
 * request". Null is every other state — no reading, or no answer — and every
 * caller here treats null as "wait for them", because an unauthenticated `gh`
 * must not be able to turn into a repository with no CI.
 */
export const runsChecksOnPullRequests = (
  reading: PullRequestChecks | null,
): boolean | null => (reading !== null && reading.answered ? reading.runs_checks : null);

/**
 * How long a read of this repository's checks may wait: nothing at all where
 * the repository demonstrably runs none, and the bound the caller configured
 * everywhere else.
 *
 * Zero only on a positive answer. A `gh` that could not be asked, could not
 * authenticate or could not read the base branch's protection leaves
 * `answered: false`, and that reading gets the full bound — an outage must not
 * be able to turn into "this repository has no CI".
 */
export function deliveryChecksBoundMs(
  repository: PullRequestChecks | null,
  configuredMs: number,
): number {
  return runsChecksOnPullRequests(repository) === false ? 0 : configuredMs;
}

/**
 * Why a delivery read ended, in the words the record and the person both get.
 *
 * `unchecked` alone does not say, and the two ways of arriving at it are not
 * the same news: a repository that runs no check on a pull request has nothing
 * to wait for and something to configure, and a head whose checks had not
 * reported when the run stopped waiting may well be green ten minutes later.
 */
export const DELIVERY_CHECKS_REASONS = [
  /** Every check on the head concluded, green or red. */
  "concluded",
  /** The repository runs no check on a pull request, so nothing reported. */
  "none reported",
  /** The bound ended the read with checks still unconcluded, or none reported yet. */
  "not reported in time",
  /** `gh` would not say what the head's checks were. */
  "unreadable",
] as const;
export type DeliveryChecksReason = (typeof DELIVERY_CHECKS_REASONS)[number];

/**
 * Why the read that produced `reading` ended, given what this repository was
 * read as running on a pull request.
 */
export function deliveryChecksReason(
  reading: Pick<DeliveredChecksReading, "checks" | "bounded">,
  repository: PullRequestChecks | null,
): DeliveryChecksReason {
  if (reading.checks.length === 0) {
    // The runner's read returns an empty reading two ways: `gh` would not
    // answer, which it does not wait for, and a head that reported nothing
    // before the bound was spent. Only the second is a reading of the head.
    if (!reading.bounded) return "unreadable";
    return runsChecksOnPullRequests(repository) === false ? "none reported" : "not reported in time";
  }
  return reading.checks.some((check) => check.conclusion === UNCHECKED)
    ? "not reported in time"
    : "concluded";
}

/**
 * The same reading for a person, in a sentence that says what to do about it.
 *
 * The `none reported` sentence names the repository, because that is what has
 * to change; the `not reported in time` one names the wait, because the pull
 * request may well be green ten minutes from now; and the third names `gh`,
 * because an outage is neither of those.
 */
export function deliveryChecksMessage(
  reading: DeliveredChecksReading,
  repository: PullRequestChecks | null,
): string {
  const seconds = Math.round(reading.waited_ms / 1000);
  switch (deliveryChecksReason(reading, repository)) {
    case "none reported": {
      const base = repository?.base_ref ?? null;
      return (
        "this repository runs no checks on pull requests: no workflow here triggers on a " +
        `pull request${base === null ? "" : ` and ${base} requires no status check`}. ` +
        "Nothing ran on this head, so there was nothing to wait for and the run did not wait"
      );
    }
    case "not reported in time":
      return (
        `the checks on this head had not concluded after ${seconds}s, so the run stopped ` +
        "waiting. They may still be running; nothing here is evidence that any of them passed"
      );
    case "unreadable":
      return (
        "`gh` would not report the checks on this head, so what they said is unknown — which " +
        "is not evidence that any of them passed"
      );
    case "concluded": {
      const failed = failedChecks(reading.checks);
      return failed.length === 0
        ? "every check on this head concluded green"
        : `the head's checks failed: ${failed
            .map((check) => `${check.name} ${check.conclusion}`)
            .join(", ")} — nothing here has been fixed`;
    }
  }
}

/** A ticket key per ticket id, for the ceiling hits `doctor` reports. */
const ticketKeys = (store: string): Map<string, string> =>
  new Map(listTickets(store).map((ticket) => [ticket.ticket_id, ticket.key]));

/**
 * The ticket store as a run uses it. The ticket each method reads is re-read
 * from the store at every step: the file on disk is what the next command will
 * read, so it is what this must act on.
 */
export const TICKET_RUNS: TicketRuns = {
  load(input) {
    const admitted = loadAdmitted(input.cwd, input.repo, input.store, input.key);
    return { dir: admitted.dir, key: admitted.ticket.key, contract: admitted.contract };
  },

  runConfig(work: AdmittedWork, override: unknown, publish: boolean) {
    const ticket = readTicket(work.dir, work.key);
    return mergeRunConfig(
      {
        dir: work.dir,
        key: ticket.key,
        repository_root: ticket.repository_root,
        source: ticket.source ?? null,
        branch: ticket.delivery.branch,
        publish,
        // D-096: the spec's No-Gos, which the brief a compaction gives back
        // states. Read here rather than in the merge, which reads no ticket;
        // a record that cannot be read, or is another plan's, is reported and
        // leaves them empty, because a run must not stop over the half of the
        // approach that gates nothing.
        no_gos: approachNoGos(work.dir, work.key, work.contract),
        // D-103: the spec files the loop commits first on the branch. A ticket
        // admitted before the list existed records the spec alone, which is
        // what its branch carries.
        spec_files: ticket.admission.spec === null ? [] : admittedSpecFiles(ticket.admission.spec),
      },
      override,
    );
  },

  async relevelContext(work: AdmittedWork, base_ref: string) {
    const ticket = readTicket(work.dir, work.key);
    return mergedTicketContext({
      dir: work.dir,
      repository_root: ticket.repository_root,
      base_ref,
      branch: ticket.delivery.branch ?? derivedBranch(work.dir, work.key, ticket),
      except: ticket.key,
    });
  },

  starting(work: AdmittedWork, relevel: boolean) {
    if (relevel) {
      // SCP-227: a re-level is not a new attempt at the ticket. The branch is
      // at `pr_open` and stays there, and the run moves nothing. The loop
      // counts the runs on the attempts record itself (null here), so a
      // re-level's attempt ids are minted after every recorded run's rather
      // than colliding with the last one's root.
      const open = readTicket(work.dir, work.key);
      if (open.state !== "pr_open") {
        throw new UsageError(
          `${work.key} is ${open.state}; --relevel merges the base into an open pull request's ` +
            "branch, and only a ticket at pr_open has one",
        );
      }
      // Only the loop's own pull request: a direct arm's or a person's hand-off
      // is not the loop's to re-level, and recording a re-level on it would
      // read as the loop's work in the measurement.
      if (open.delivery.arm !== "loop" || open.delivery.opened_by === "hand_off") {
        throw new UsageError(
          `${work.key}'s pull request is ${open.delivery.opened_by === "hand_off" ? "a person's hand-off" : `the ${open.delivery.arm} arm's`}; ` +
            "--relevel is for the loop's own",
        );
      }
      return null;
    }
    // D-103: the spec the contract was drafted from, before anything is moved
    // and before any worktree exists. A ticket the run is about to start is a
    // ticket that has not started, whatever it did on an earlier attempt, so
    // this is where the stale one stops — and a run already in flight is past
    // here, which is why nothing interrupts one.
    let ticket = readTicket(work.dir, work.key);
    const staleness = specStaleness({
      repositoryRoot: ticket.repository_root,
      // A run only ever starts an approved ticket: `plan_review -> ready` is
      // the one row into the runnable side from an unapproved state, and it is
      // `perbo approve`. So the reading here is always against approval, and
      // the sentences it prints say so. `inspect` is the caller that asks the
      // record, because it is the one that renders a ticket in `plan_review`.
      approved: ticket.approved_at !== null,
      spec: ticket.admission.spec,
    });
    for (const unjudged of staleness?.unjudged ?? []) {
      // Said and not acted on: a name nothing could judge is not evidence that
      // the spec has moved, and refusing over one would stop a run for a
      // reading this repository has not been asked to take.
      process.stderr.write(`warning: ${work.key}'s spec is not fully checked: ${unjudged}\n`);
    }
    if (staleness !== null && staleness.stale.length > 0) {
      // Through `ready` where the ticket is somewhere else, because that is the
      // one state the row out of leads here, and a ticket reopened for an
      // attempt it never got is what happened.
      const reopened = ticket.state === "ready" ? ticket : reopen(ticket, `new attempt after ${ticket.state}`);
      writeTicket(work.dir, transition(reopened, "plan_invalid", staleness.stale.join("; ")));
      throw new UsageError(
        `${work.key} was drafted from ${staleness.path}, which is no longer that spec, so the run ` +
          `does not start and the ticket is now plan_invalid: ${staleness.stale.join("; ")}. An ` +
          "approved contract is immutable (ADR-0016), so this work is admitted again rather than " +
          "approved again (D-103)",
      );
    }

    // A ticket that already ran comes back through `ready`, because that is
    // what the lifecycle calls a new attempt.
    //
    // Every state that is not `ready` is rescued, not the two that were easy to
    // name. A ticket interrupted mid-run — the process killed during
    // provisioning, or left `executing` by a defect — had no row to
    // `provisioning` and threw `IllegalTransitionError` at the user as
    // "the review did not complete" with a stack trace, permanently, with no
    // command able to recover it. A ticket is re-runnable or it is a dead
    // record; there is no third thing.
    if (ticket.state !== "ready") {
      ticket = reopen(ticket, `new attempt after ${ticket.state}`);
    }
    // Recorded before the attempt, not after: a run that never returns has to
    // leave the ticket saying so rather than saying `ready`.
    const started = transition(
      ticket,
      "provisioning",
      `run started against ${work.contract.plan_id}`,
    );
    writeTicket(work.dir, started);
    // The ticket own count of the runs it has begun, this one included. The
    // runner mints the root attempt id from it, so a re-run of the same
    // immutable contract appends a distinct attempt chain rather than colliding
    // with the last one.
    return runsStartedBy(started);
  },

  finished(work: AdmittedWork, result: TicketRunResult, at: Date, relevel: boolean) {
    if (relevel) {
      // SCP-227: the ticket stays at `pr_open` whatever the re-level did — a
      // branch that is level, one that is not yet, and one a person now has
      // to reconcile are all still an open pull request. The delivery record
      // is the same pull request's and keeps who opened it and which arm; only
      // the checks the run read are written over it. `sync` reads the rest.
      const open = readTicket(work.dir, work.key);
      const read = result.delivery_checks;
      const kept =
        read === null
          ? open
          : TicketSchema.parse({
              ...open,
              delivery: { ...open.delivery, checks: [...read.checks], checks_state: read.state, observed_at: at.toISOString() },
            });
      if (kept !== open) writeTicket(work.dir, kept);
      return kept.state;
    }
    const moved = applyObservedPath(
      recordDelivery(readTicket(work.dir, work.key), result, at),
      statesObserved(result),
      at,
    );
    writeTicket(work.dir, moved);
    return moved.state;
  },
};

export async function runExecuteCommand(options: ExecuteOptions): Promise<number> {
  const { args, streams } = options;
  const now = options.now ?? new Date();
  const progress = args.quiet ? undefined : (message: string) => streams.stderr(`  ${message}\n`);
  // SCP-180: a run with nothing admitted behind it mints its contract here,
  // from the flags or from the pull request that already describes the work.
  // Read before anything is spent, so a reference that does not resolve — or a
  // combination of flags that would produce a contract nobody wrote — costs
  // nothing.
  const local = isLocalRunArgs(args) ? await mintLocal(options, now) : null;

  if (local === null && args.ticket === null && args.contract === null) {
    throw new UsageError(
      "--ticket, --contract or --outcome is required (or --pr, to take the plan from a pull " +
        "request)",
    );
  }
  if (args.ticket !== null && args.contract !== null) {
    throw new UsageError(
      "--ticket and --contract are alternatives: an admitted ticket already owns its contract",
    );
  }
  if (args.relevel && args.ticket === null) {
    throw new UsageError(
      "--relevel takes --ticket: it merges the base into an admitted ticket's open branch, and " +
        "only a ticket names one",
    );
  }

  // An admitted ticket supplies the contract, the repository and the run
  // configuration this repository has already agreed once, so the only thing
  // the command needs is the key.
  const admitted =
    args.ticket === null
      ? null
      : TICKET_RUNS.load({
          cwd: options.cwd,
          repo: args.repo,
          store: args.store,
          key: args.ticket,
        });

  let contract: PlanContract;
  if (admitted) {
    contract = admitted.contract;
  } else if (local) {
    contract = local.plan.contract;
  } else {
    const parsedContract = PlanContractSchema.safeParse(
      readJson(resolve(options.cwd, args.contract!), "the plan contract"),
    );
    if (!parsedContract.success) {
      throw new UsageError(
        `${args.contract} is not a valid PlanContract:\n  ` +
          parsedContract.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n  "),
      );
    }
    contract = parsedContract.data;
  }

  if (admitted === null && local === null && args.config === null) {
    throw new UsageError("--config is required");
  }
  // The same merge on the ticket path and the local one, so a run with no
  // ticket behind it is judged by the same D-045 artifacts as one with a
  // ticket: the pinned checks and the definitions they are pinned from, the
  // protected tests and protected paths, and the limits this repository agreed
  // once in `<store>/config.json`.
  const override = args.config
    ? readJson(resolve(options.cwd, args.config), "the run configuration")
    : null;
  const configInput =
    admitted !== null
      ? TICKET_RUNS.runConfig(admitted, override, args.publish)
      : local !== null
        ? mergeRunConfig(
            {
              dir: local.store,
              key: local.plan.label,
              repository_root: local.repositoryRoot,
              source: null,
              publish: args.publish,
            },
            override,
          )
        : withoutDeliveryBranch(
            readJson(resolve(options.cwd, args.config!), "the run configuration"),
            args.config!,
            (line) => streams.stderr(line),
          );

  const parsedConfig = TicketRunConfigSchema.safeParse(configInput);
  if (!parsedConfig.success) {
    // The file that failed, not the flag. On the `--ticket` path `args.config`
    // is null, so this read `null is not a valid run configuration` and named
    // nothing the user could open.
    const store = admitted?.dir ?? local?.store ?? null;
    const source = args.config ?? (store ? join(store, "config.json") : "the run configuration");
    throw new UsageError(
      `${source} is not a valid run configuration:\n  ` +
        parsedConfig.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  const config = {
    ...parsedConfig.data,
    publish: args.publish || parsedConfig.data.publish,
    resume_from: args.resumeFrom ?? parsedConfig.data.resume_from,
  };

  // SCP-154: a `--resume-from` that cannot be honoured stops the command here —
  // before the machine is checked, before the ticket is moved and before a
  // worktree exists — so a bundle that does not match this run costs nothing.
  // The loop checks the same thing again against the base commit it actually
  // provisioned; this only moves the refusal earlier.
  if (config.resume_from !== null) {
    try {
      const source = resolveResumeSource({
        bundle_root: config.bundle_root,
        bundle_id: config.resume_from,
        ticket_id: contract.ticket_id,
        base_commit: contract.base.base_commit,
      });
      // Stated in the future tense: the diff goes into the worktree the loop
      // provisions, which does not exist yet at this line. Indented like the
      // loop's own progress lines, because that is the sequence it opens.
      streams.stderr(`  ${resumeNote(source, "planned")}\n`);
    } catch (error) {
      if (!(error instanceof ResumeRefusedError)) throw error;
      streams.stderr(
        `error: the run did not start because it could not resume from ` +
          `${args.resumeFrom ?? config.resume_from} — ${error.message}\n`,
      );
      return EXIT_CODES.did_not_complete;
    }
  }

  // What a run installs a worktree with, resolved before the machine is checked
  // because the binary that runs it is one of the things the machine can lack.
  const install = config.materialization_manifest?.install ?? proposedInstall(config.repository_root);

  // What this machine lacks is found here, before a worktree exists and before
  // the ticket is moved. A missing binary used to surface as an ENOENT stack
  // trace with the ticket left in `provisioning`.
  const machine = (options.preflight ?? preflight)({
    agentBinary: config.agent_binary,
    agentProvider: config.agent_provider,
    reviewerProvider: config.reviewer_provider,
    needsGh: config.publish,
    // An install of kind `none` is never spawned, so it names no binary to ask for.
    installBinary: install.kind === "none" ? null : (install.command[0] ?? null),
  });
  if (!machine.ok) {
    streams.stderr(`${renderPreflight(machine)}\n\n`);
    streams.stderr(
      `${admitted ? `${admitted.key} was not touched: ` : ""}the run did not start ` +
        "because this machine is missing something it needs\n",
    );
    return EXIT_CODES.did_not_complete;
  }
  streams.stderr(`  ceilings  ${renderCeilingsLine(config.limits)}\n`);

  // What is judging this attempt, where nobody has said (SCP-259). A repository
  // with no `.perbo/config.json` is run against the checks its own package
  // scripts imply, and the line names them, says where they came from, and
  // names the command that writes them down. Printed only where every pinned
  // check is one of those: a config on disk, or an explicit `--config` naming
  // its own checks, is somebody's agreement and needs no explanation.
  const runStore = admitted?.dir ?? local?.store ?? null;
  const proposed = config.checks.filter((check) => check.origin === "proposed");
  if (
    runStore !== null &&
    proposed.length === config.checks.length &&
    readRepoConfig(runStore) === null
  ) {
    streams.stderr(
      `  checks    ${proposed.length === 0 ? "none" : proposed.map((check) => check.name).join(", ")}` +
        ` — proposed from this package's own scripts because ${join(runStore, "config.json")} does` +
        ` not exist; pin them with: perbo doctor --repo ${args.repo} --write-config\n`,
    );
  }

  // And what it installs with, where nothing pins it. A checkout with no
  // lockfile is installed from its manifest, which resolves versions rather
  // than reproducing them, so the line says so and names what writes the
  // lockfile. Read from the configured manifest where there is one and from the
  // checkout otherwise — the same derivation the diagnostic proposes from, so
  // this line and the install that runs cannot disagree. A pinned install
  // prints nothing.
  if (!install.pinned) {
    const pin = pinInstallCommand(install.package_manager);
    streams.stderr(
      `  install   ${install.command.join(" ")} — unpinned, this repository has no lockfile` +
        (pin === null ? "" : `; pin it with ${pin.join(" ")}`) +
        "\n",
    );
  }

  // And where it lands (SCP-265). Beside the checks, because they are the two
  // things a run on an unconfigured repository decides for itself — and said
  // for all three sources, including a configured one: which branch a run
  // publishes against is not a fact to discover from the pull request it
  // opened, and on a detached checkout it is the one a person cannot guess.
  //
  // A configuration built here carries the source that named its base. A whole
  // one handed to the command as a file — `--contract` with a `--config` —
  // carries none, so it is resolved here by the same rule: the `base_ref` that
  // file names, and where it names none, the checkout and then the remote. Not
  // the schema's literal `HEAD`, which is not a branch and which GitHub refuses
  // as a base once the whole loop has been paid for.
  const handed = configInput as Record<string, unknown> | null;
  const base = requireBase(
    config.base_ref_origin !== null
      ? { base_ref: config.base_ref, from: config.base_ref_origin }
      : resolveBase(config.repository_root, handed?.["base_ref"], { publish: config.publish }),
    {
      repository_root: config.repository_root,
      configPath: runStore === null ? resolve(options.cwd, args.config!) : join(runStore, "config.json"),
    },
  );
  streams.stderr(`  base      ${describeBase(base)}\n`);

  // The configuration the loop is given, base and source together: a run that
  // reported one branch and merged up from another would be worse than one that
  // reported nothing.
  const runConfig = {
    ...config,
    base_ref: base.base_ref,
    base_ref_origin: base.from,
    // SCP-227: a re-level, and what merged under the branch, read from the
    // store against the base this run publishes to.
    relevel: args.relevel,
    relevel_context: admitted !== null && args.relevel ? await TICKET_RUNS.relevelContext(admitted, base.base_ref) : [],
  };

  /** Null on the `--contract` path: no ticket, so no history to count runs in. */
  const runsStarted = admitted === null ? null : TICKET_RUNS.starting(admitted, args.relevel);

  // Written before the loop starts, for the reason the ticket path moves a
  // ticket to `provisioning` before the attempt: a run that never returns has
  // to leave behind what it was. It goes to this repository's own store, beside
  // the attempts, the bundles and the review, and nowhere else.
  if (local) {
    const written = writeLocalRunRecord(local.store, {
      schema_version: LOCAL_RUN_SCHEMA_VERSION,
      run_id: contract.ticket_id,
      label: local.plan.label,
      created_at: now.toISOString(),
      source: local.plan.source,
      contract,
      external_text_attempts: local.plan.external_text_attempts,
      // Where this run publishes, as it resolved it a moment ago. Written with
      // the record rather than read back off the checkout later: `origin/HEAD`
      // and `base_ref` both move, and what `inspect` has to be able to say is
      // the branch this run's pull request went to.
      base: { ref: base.base_ref, from: base.from },
      // Nothing has run yet, so there is nothing to refuse it for and nothing
      // has been published. A refusal below, and the publish, come back and
      // fill these in.
      refusal: null,
      pull_request: null,
    });
    if (written.redactions > 0) {
      streams.stderr(
        `  redacted ${written.redactions} credential-shaped value(s) from the run record\n`,
      );
    }
    streams.stderr(`  run recorded in ${written.path}\n`);
  }

  // SCP-279: what this repository runs on a pull request, asked once here
  // rather than discovered by waiting for it. A repository with no
  // pull-request workflow and no required status check on the base reports
  // nothing because nothing runs, and the read that waits fifteen minutes for
  // it is waiting for a certainty — so the bound it is given is none.
  //
  // Asked about the base ref rather than about the checkout: the head this run
  // will push is that ref plus its own commits, and the seal refuses an attempt
  // that writes `.github/**` — so the workflows on the head are the workflows
  // on the base, whatever the person has checked out or edited here today.
  //
  // Only on a run that publishes: a run that opens no pull request has no
  // checks to wait for, and nothing is asked of GitHub about it.
  const repositoryChecks = runConfig.publish
    ? await (options.pullRequestChecks ?? readPullRequestChecks)({
        worktree: runConfig.repository_root,
        base_ref: base.base_ref,
        ref: base.base_ref,
      })
    : null;
  const deliveryBoundMs = deliveryChecksBoundMs(
    repositoryChecks,
    runConfig.delivery_checks_bound_ms,
  );
  if (runsChecksOnPullRequests(repositoryChecks) === false) {
    streams.stderr(
      `  checks    none on pull requests here (${repositoryChecks!.workflows_seen} workflow(s), ` +
        `none on a pull request; ${base.base_ref} requires none), so the run will not wait for any\n`,
    );
  }

  let result: TicketRunResult;
  try {
    result = await runTicket({
      config: {
        ...(runsStarted === null ? runConfig : { ...runConfig, runs_started: runsStarted }),
        // The bound the loop reads its checks under, as the reading above
        // decided it: the configured one, and none where this repository was
        // read as running nothing. The loop still reads the head once, so a
        // check that reports anyway is still recorded — and waited for, below.
        delivery_checks_bound_ms: deliveryBoundMs,
      },
      contract,
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(progress ? { onProgress: progress } : {}),
      // A run with no ticket has nowhere else to put the pull request: the
      // ticket file a `--ticket` run's delivery goes on does not exist. It is
      // written as the pull request opens rather than from the result below,
      // so anything that ends the run after the publish still leaves the URL
      // where `inspect` reads it.
      ...(local
        ? {
            onPullRequest: (pull_request: { url: string; number: number | null }) => {
              recordRunPullRequest(local.store, contract.ticket_id, {
                ...pull_request,
                opened_at: new Date().toISOString(),
                // Nothing has read the head's checks yet; the run writes them
                // over this record once it has.
                checks: [],
                checks_state: null,
              });
            },
          }
        : {}),
    });
  } catch (error) {
    // A refusal is the repository's own answer, and it is caught here for the
    // one thing the top level cannot do: put it on the record this run already
    // wrote about itself, so it is still readable when the terminal is gone.
    // What is printed is `describeFailure`'s own line — the same words an
    // escape past this point would produce, rather than a second wording of
    // them. Anything else goes up with its stack, which is where an error
    // nobody expected belongs.
    if (!(error instanceof RunRefusedError)) throw error;
    if (local) {
      const at = recordRunRefusal(local.store, contract.ticket_id, {
        refused_at: new Date().toISOString(),
        reason: error.message,
        repository_root: error.repository_root,
        findings: [...error.findings],
      });
      if (at !== null) streams.stderr(`  refusal recorded in ${at}\n`);
    }
    const failure = describeFailure("run", error);
    streams.stderr(`error: ${failure.message}\n`);
    return failure.code;
  }

  // The head reported a check the reading above said this repository would not
  // run — a check posted by an app, or a status pushed straight through the
  // API, neither of which is a workflow file or a required context. A run that
  // recorded it `unchecked` a second after the push would be calling a check
  // that is still going one that never came, so it gets the bound it was
  // configured with after all, before anything records what the delivery said.
  if (
    deliveryBoundMs === 0 &&
    result.delivery_checks !== null &&
    result.delivery_checks.checks.some((check) => check.conclusion === UNCHECKED)
  ) {
    result = {
      ...result,
      delivery_checks: await waitForUnexpectedChecks({
        // The worktree the run read from is swept when the run ends; the
        // checkout it was provisioned from is the same repository, which is all
        // `gh pr view <branch>` needs.
        worktree: runConfig.repository_root,
        branch: result.workspace.branch,
        boundMs: runConfig.delivery_checks_bound_ms,
        already: result.delivery_checks,
        ...(progress ? { onProgress: progress } : {}),
      }),
    };
  }

  if (admitted) {
    const state = TICKET_RUNS.finished(admitted, result, new Date(), args.relevel);
    streams.stderr(`\n${admitted.key} is now ${state}\n`);
  }

  // The checks are read after the pull request opens, so the record written at
  // the moment it opened does not have them. A run with no ticket keeps its
  // delivery here; a ticketed run keeps it on the ticket, written above.
  if (local && result.pull_request && result.delivery_checks) {
    recordRunPullRequest(local.store, result.ticket_id, {
      url: result.pull_request.url,
      number: result.pull_request.number,
      opened_at: readLocalRunRecord(local.store, result.ticket_id)?.pull_request?.opened_at
        ?? new Date().toISOString(),
      checks: [...result.delivery_checks.checks],
      checks_state: result.delivery_checks.state,
    });
  }

  // What the run cost, on stderr and on every outcome — a ceiling that ended it
  // spent money on the way to being reached — so the figure is read where the
  // run ends rather than by opening the store afterwards.
  const cost = runCost(result);
  streams.stderr(`\ncost      ${renderCostRoll(cost)}\n`);
  if (local) {
    streams.stderr(
      `read it back with: perbo inspect ${result.ticket_id}` +
        (args.store ? ` --store ${args.store}` : args.repo === "." ? "" : ` --repo ${args.repo}`) +
        "\n",
    );
  }

  if (args.json || !streams.isTTY) {
    streams.stdout(
      `${JSON.stringify(
        {
          ticket_id: result.ticket_id,
          outcome: result.outcome,
          detail: result.detail,
          branch: result.workspace.branch,
          pull_request: result.pull_request,
          // Why the read ended, beside what it read: `unchecked` alone does not
          // say whether the repository ran nothing, whether its checks were
          // late, or whether `gh` would not answer — and the difference has to
          // survive into the machine-readable record too, not only the printed
          // one.
          delivery_checks:
            result.delivery_checks === null
              ? null
              : {
                  ...result.delivery_checks,
                  reason: deliveryChecksReason(result.delivery_checks, repositoryChecks),
                },
          // And what this repository runs on a pull request, where it was asked.
          repository_checks: repositoryChecks,
          total_cost: cost,
          rounds: result.rounds.map((round) => ({
            round: round.round,
            attempt: round.attempt,
            review: round.review,
            checks: round.checks,
            // D-065: the person's decisions and the executor's reasons must
            // survive into every machine-readable record of the run.
            declines: round.declines,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    streams.stdout(
      `${renderRun(result, { local: local !== null, repository_checks: repositoryChecks })}\n`,
    );
  }
  return exitCodeForRun(result.outcome);
}

/**
 * Wait for a check the repository was not seen to run.
 *
 * The reading this returns is what the run records and prints. The pull
 * request itself is left exactly as the loop published it: it already carries
 * the section the loop wrote, and rewriting a body that has been public since
 * the push would discard whatever a person has added under that heading in the
 * meantime. Where the two differ, the progress line below says so.
 *
 * Nothing here throws. The pull request is open and the run has a reading of
 * its head already; losing that record because one more `gh` call failed would
 * be the worse outcome, so every failure comes back as the reading the loop
 * had, and the progress line says what could not be done.
 */
async function waitForUnexpectedChecks(request: {
  worktree: string;
  branch: string;
  /** The bound this run was configured with, before the reading zeroed it. */
  boundMs: number;
  /** What the loop's own read found, and how long it spent finding it. */
  already: DeliveredChecksReading;
  onProgress?: (message: string) => void;
}): Promise<DeliveredChecksReading> {
  request.onProgress?.(
    `${request.branch} reported a check this repository was not seen to run; waiting for it`,
  );
  let read: DeliveredChecksReading;
  try {
    read = await readDeliveredChecks({
      worktree: request.worktree,
      branch: request.branch,
      boundMs: Math.max(request.boundMs - request.already.waited_ms, 0),
      now: () => new Date(),
      sleep: (ms) => sleep(ms),
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
  } catch (error) {
    request.onProgress?.(
      `the checks on the head could not be read again: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return request.already;
  }
  // The whole wait, both halves of it: what a person reads as "it waited this
  // long" is the run's own clock, not the second read's.
  const waited = { ...read, waited_ms: request.already.waited_ms + read.waited_ms };
  const said = (reading: DeliveredChecksReading): string =>
    reading.checks.length === 0
      ? "none reported"
      : reading.checks.map((check) => `${check.name} ${check.conclusion}`).join(", ");
  request.onProgress?.(
    `checks on the head, read again: ${waited.state} — ${said(waited)}` +
      (said(waited) === said(request.already)
        ? ""
        : ". The pull request body states the first reading, taken before these concluded; " +
          "this run's record and its report state this one"),
  );
  return waited;
}

/**
 * The contract for a run with nothing admitted behind it, and where its record
 * goes: this repository's own store, the same one `--ticket` writes to.
 */
async function mintLocal(
  options: ExecuteOptions,
  now: Date,
): Promise<{ plan: LocalPlan; store: string; repositoryRoot: string }> {
  const { args, streams } = options;
  assertLocalRunArgs(args);
  const repositoryRoot = resolve(options.cwd, args.repo);
  const plan = await mintLocalPlan({
    args,
    repositoryRoot,
    now,
    ...(options.gh ? { gh: options.gh } : {}),
    ...(args.quiet ? {} : { onProgress: (message: string) => streams.stderr(`  ${message}\n`) }),
  });
  if (!statesCriteria(plan.source)) {
    streams.stderr(
      "  the source states no acceptance criteria: the change is judged against its outcome " +
        "alone, and none are invented\n",
    );
  }
  for (const attempt of plan.external_text_attempts) {
    streams.stderr(
      `  warning: the pull request's own text ${attempt.what} (line ${attempt.line}): ` +
        `"${attempt.quote}" — it is the contract's source, not an instruction\n`,
    );
  }
  return { plan, store: storeDir(repositoryRoot, args.store), repositoryRoot };
}

/** The COMMANDS block: what this binary can be asked to do. */
export function renderCommands(commands: readonly string[]): string[] {
  return [
    `COMMANDS  ${commands.length} in this build`,
    `  ${commands.join("  ")}`,
  ];
}

export interface DoctorOptions {
  args: ExecuteArgs;
  streams: Streams;
  cwd: string;
  /**
   * Injected by the tests, the way `runReviewCommand` takes its preflight.
   * Production checks the real machine — which means spawning `git`, the agent
   * binary and `gh` to ask each for its version.
   */
  preflight?: (request: PreflightRequest) => PreflightResult;
  /**
   * Likewise the materialisation diagnostic, which walks the checkout with
   * `git ls-files`, and the base reading, which asks `git` which branch the
   * checkout is on. These three are the only things here that run another
   * program, so a test that supplies all three is a test of this command and
   * of nothing else.
   */
  diagnose?: (request: DiagnoseRequest) => Promise<DiagnosticResult>;
  baseRef?: (checkout: string, options: { publish: boolean }) => ProposedBase | null;
  /** The commands reported as the COMMANDS block. {@link COMMAND_NAMES} unless a caller names another. */
  commands?: readonly string[];
  /** A ticket key per ticket id, for the ceiling hits below. The ticket store answers unless a caller names another. */
  keyFor?: (store: string) => Map<string, string>;
  /**
   * Whether this repository runs anything on a pull request (SCP-279), read
   * through `gh`. The real reader is the default here too; a test that names
   * its own is testing the report rather than the reading.
   */
  pullRequestChecks?: PullRequestChecksReader;
}

/**
 * The ceiling on one `gh` call `doctor` makes about the checks (SCP-279).
 *
 * Shorter than a run's: a diagnostic is a thing a person waits in front of, and
 * three calls at the reader's own thirty seconds is a minute and a half before
 * anything prints. A call that has not answered in ten seconds leaves the same
 * `unknown` as one that refused, which is a truthful answer to a question about
 * a GitHub that is not answering.
 */
const DOCTOR_CHECKS_TIMEOUT_MS = 10_000;

export async function runDoctorCommand(options: DoctorOptions): Promise<number> {
  const commands = options.commands ?? COMMAND_NAMES;
  const checkMachine = options.preflight ?? preflight;
  const materialise = options.diagnose ?? diagnose;
  const readBase = options.baseRef ?? proposedBase;
  const checkout = resolve(options.cwd, options.args.repo);
  // Given a worktree root, the diagnostic also says what the package manager
  // will make of that location. Omitted, it says nothing about it — a location
  // it was not told about is not one it can vouch for.
  const worktreeRoot = options.args.worktreeRoot
    ? resolve(options.cwd, options.args.worktreeRoot)
    : null;
  const store = storeDir(checkout, options.args.store);
  const configPath = join(store, "config.json");
  const storedConfig = readRepoConfig(store);
  const overridePath = options.args.config ? resolve(options.cwd, options.args.config) : null;
  let override: Record<string, unknown> | null = null;
  if (overridePath !== null) {
    const parsed = readJson(overridePath, "the explicit run configuration");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UsageError(`${overridePath} is not a JSON object`);
    }
    override = withoutComments(parsed as Record<string, unknown>);
  }
  // Match a run's explicit configuration layer without treating it as the
  // stored repository agreement. A first-run proposal still needs the checks
  // and manifest doctor derives from this checkout.
  const repoConfig = storedConfig === null && override === null
    ? null
    : { ...storedConfig, ...override };
  const configSource = overridePath === null
    ? configPath
    : storedConfig === null
      ? overridePath
      : `${configPath} with overrides from ${overridePath}`;
  // The two roots a run here has: the package it was pointed at, and the
  // workspace whose manager installs it. The same directory for a checkout that
  // is its own workspace, and two directories for one package of a monorepo —
  // where the second is where the install runs, and a report that named only
  // the first left a person reading it with no way to see that.
  const membership = workspaceMembership(checkout);
  const installStep = proposedInstallStep(checkout, membership);
  const inWorkspace = membership.workspace_root !== membership.package_root;

  // The machine first: the agent binary and reviewer transport this repository
  // has agreed on, or the defaults it will get, and `gh` only when a pull
  // request is going to be opened.
  const configuredBinary = repoConfig?.["agent_binary"];
  const agentBinary =
    typeof configuredBinary === "string" ? configuredBinary : RUN_CONFIG_DEFAULTS.agent_binary;
  // The transport that binary is, read the same way — never guessed from
  // agentBinary's own spelling, which a repository is free to configure as
  // any path.
  const configuredProvider = repoConfig?.["agent_provider"];
  const agentProvider =
    configuredProvider === "claude-cli" || configuredProvider === "codex-cli"
      ? configuredProvider
      : RUN_CONFIG_DEFAULTS.agent_provider;
  // The reviewer this repository has agreed on, transport and model both, and
  // the keys each was read from. The model is `reviewer_model` where one is
  // pinned and the run's own `model` otherwise, which is the fallback the loop
  // itself applies.
  const reviewer = configuredReviewer(repoConfig, {
    provider: RUN_CONFIG_DEFAULTS.reviewer_provider,
    model: RUN_CONFIG_DEFAULTS.model,
  });
  const reviewerProvider = reviewer.provider;
  const reviewerModel = reviewer.model;
  const publishes = options.args.publish || repoConfig?.["publish"] === true;
  // The manifest's install where this repository pins one, and what the
  // checkout implies otherwise — the same order a run resolves it in, so the
  // diagnostic checks the binary the run will actually spawn, and none for an
  // install of kind `none`, which is never spawned.
  const pinnedInstall = InstallStrategySchema.safeParse(
    (repoConfig?.["materialization_manifest"] as Record<string, unknown> | undefined)?.["install"],
  );
  const install = pinnedInstall.success
    ? pinnedInstall.data
    : proposedInstall(checkout, detectPackageManager(checkout, membership));
  const machine = checkMachine({
    agentBinary,
    agentProvider,
    reviewerProvider,
    needsGh: publishes,
    installBinary: install.kind === "none" ? null : (install.command[0] ?? null),
    // SCP-200: a diagnostic asks whether GitHub answers whether or not this
    // repository publishes. Which credential path it answers on is the thing
    // a person is here to find out.
    probeGithub: true,
  });

  // One call, at that model, and only when asked. Everything else `doctor`
  // checks is local and free; this is the one question that can only be
  // answered by the provider, and it is the one whose answer is otherwise
  // found halfway through a paid attempt.
  const probe = options.args.probe
    ? await probeReviewer({ provider: reviewerProvider, model: reviewerModel })
    : null;

  const result = await materialise({
    checkout,
    repository_id: "repo_local",
    ...(worktreeRoot ? { worktree_root: worktreeRoot } : {}),
  });

  // The ceilings the runner will actually enforce here, and every attempt on
  // record that already ran into one — with the key that raises it, because
  // that is the question a person has when they read `iteration_ceiling_exceeded`.
  const limits = effectiveLimits(repoConfig, configSource);
  const keyFor = (options.keyFor ?? ticketKeys)(store);
  const hits = ceilingTerminations(join(store, "state"), (id) => keyFor.get(id) ?? id);

  // What judges an attempt here, from the same reader approval refuses a
  // scope with — so the list can be read before a scope is written against it
  // rather than at the refusal.
  const judging = judgingPaths(store);

  // The standing prohibited list (D-105), which is not a judging path: a scope
  // may name one of these, and it is the write that is refused. Reported beside
  // JUDGING because a person reading one is asking the same question.
  const standing = standingProhibited(store);

  // The corpus this checkout would score the reviewer against, and whether it
  // is the one the recorded score was measured on. A warning either way: it
  // never reaches the exit code below.
  const corpusCache = readCorpusCache(checkout);

  // The base a run here would land on, read once and used for both the answer
  // reported and the file `--write-config` writes (SCP-265). A configuration
  // that names one is the answer; where it does not, the checkout is.
  const resolvedBase = resolveBase(checkout, repoConfig?.["base_ref"], {
    publish: publishes,
    derive: readBase,
  });
  // A `base_ref` that is not a branch name is reported here and not resolved
  // over: this is the command a person runs to find out what a run would do,
  // and what a run would do with that file is refuse. `invalid` carries what
  // the key holds, so the report shows it back rather than saying only that
  // something is wrong with it.
  const invalidBase = resolvedBase?.from === "invalid" ? resolvedBase : null;
  const namedBase = resolvedBase !== null && resolvedBase.from !== "invalid" ? resolvedBase : null;
  const base: { ref: string | null; from: BaseSource | null; invalid?: unknown } = {
    ref: namedBase?.base_ref ?? null,
    from: namedBase?.from ?? null,
    ...(invalidBase ? { invalid: invalidBase.configured } : {}),
  };
  // An explicitly configured base is retained by the override below; only a
  // derived base needs to be added to the proposal.
  const derivedBase = namedBase?.from === "config" ? null : namedBase;

  // A partner's first hour: no config yet means a proposed one, written only
  // on request and never over a file that exists.
  const proposal =
    storedConfig === null
      ? { ...proposeRepoConfig(checkout, result.proposed, derivedBase), ...override }
      : null;

  // Read from whichever set would judge a run here — the configuration on disk,
  // or the one this command is proposing — so the diagnostic cannot advise
  // against a check it proposed in the same report.
  const advisories = turboCacheAdvisories((proposal ?? repoConfig)?.["checks"]);

  // And whether this repository runs anything on a pull request (SCP-279),
  // beside the checks that would judge a run here. The two belong together:
  // pinned checks are what this machine runs before it publishes, and this is
  // what GitHub runs afterwards — a repository with none is a repository whose
  // pull requests are never green, and the first place to find that out is
  // here rather than fifteen minutes into a run's delivery read.
  //
  // Asked only where the credential probe above already found a `gh` that
  // answers. Everything else `doctor` reports is local, and a diagnostic that
  // sat on a socket for a minute and a half before printing anything — on a
  // machine with no credential, in a repository that never publishes — would
  // be a worse diagnostic. Where it is not asked the answer is `unknown`,
  // which is what a `gh` that refused would have left anyway, and the report
  // says which of the two it is. The ceiling is a third of the reader's own,
  // for the same reason.
  const askGithub: PullRequestChecksReader =
    machine.github?.answers === true
      ? (request) => readPullRequestChecks({ ...request, timeoutMs: DOCTOR_CHECKS_TIMEOUT_MS })
      : () =>
          Promise.resolve(
            unaskedPullRequestChecks(
              base.ref,
              machine.github == null
                ? "`gh` reported no credential here, so GitHub was not asked"
                : "`gh auth status` does not answer here, so GitHub was not asked",
            ),
          );
  const pullRequestChecks = await (options.pullRequestChecks ?? askGithub)({
    worktree: checkout,
    base_ref: base.ref,
    // What a run here would branch from, and so what its head would carry.
    ref: base.ref,
  });
  // What a run here would wait for its checks: the configured bound, or the
  // loop's own where this repository has agreed none — and none at all where
  // the reading above says nothing will report.
  const deliveryBoundMs = deliveryChecksBoundMs(
    pullRequestChecks,
    typeof repoConfig?.["delivery_checks_bound_ms"] === "number"
      ? (repoConfig["delivery_checks_bound_ms"] as number)
      : DEFAULT_DELIVERED_CHECKS_BOUND_MS,
  );
  const pinned = pinnedCheckNames((proposal ?? repoConfig)?.["checks"]);

  // And what the file on disk installs with, beside what the checkout implies
  // today (SCP-285). Only for a configuration that exists: the one proposed
  // below was derived from this same checkout a line ago and cannot disagree
  // with it.
  const installed = configuredInstall(repoConfig, checkout, configSource);

  let written = false;
  if (options.args.writeConfig) {
    if (storedConfig !== null) {
      throw new UsageError(`${configPath} already exists; doctor never overwrites it — edit it instead`);
    }
    mkdirSync(store, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx" });
    written = true;
  }

  // What a failed probe means here, decided after the write above: a command
  // that has just configured this checkout has made a `run` on it depend on
  // the provider, whatever was true when the call went out. The keys come from
  // whichever file a run would now read — the one that was there, or the one
  // this command has just written — so the reason states what that file holds
  // rather than what a configured checkout usually holds.
  const probeDependency = reviewerDependency({
    publish: publishes,
    configured: repoConfig !== null || written,
    configPath: written ? configPath : configSource,
    reviewerKeys: configuredReviewer(written ? proposal : repoConfig, {
      provider: reviewerProvider,
      model: reviewerModel,
    }).keys,
    provider: reviewerProvider,
  });
  const probeBlocking = probe !== null && !probe.ok && probeDependency.blocking;

  if (options.args.json || !options.streams.isTTY) {
    options.streams.stdout(
      `${JSON.stringify(
        {
          ...result,
          roots: {
            package: membership.package_root,
            workspace: membership.workspace_root,
            // Null where the checkout is its own workspace, and null where a
            // member declares no name: both mean the install narrows to
            // nothing, which is what `install.cwd` and the command say.
            package_name: membership.package_name,
          },
          install: installStep,
          preflight: machine,
          limits: {
            effective: Object.fromEntries(
              LIMITED_RESOURCES.map((resource) => [resource, limitFor(limits, resource)]),
            ),
            overrides: limits.limits,
            ceiling_terminations: hits.hits,
            unreadable_attempt_files: hits.unreadable,
          },
          judging_paths: judging,
          standing_prohibited: standing,
          check_advisories: advisories,
          // SCP-279: the pinned checks a run here is judged by, whether this
          // repository runs anything on the pull request afterwards, and how
          // long a run would wait for what it runs.
          checks: {
            pinned,
            pull_requests: pullRequestChecks,
            delivery_checks_bound_ms: deliveryBoundMs,
          },
          base,
          corpus_cache: corpusCache,
          provider: {
            transport: reviewerProvider,
            model: reviewerModel,
            // Whether the call was made at all, named rather than inferred from
            // a null: this stream is read by scripts, and "not asked" and
            // "asked and it did not answer" must not be one state here either.
            probed: options.args.probe,
            probe,
            dependency: probeDependency,
            blocking: probeBlocking,
          },
          commands: [...commands],
          config: {
            path: configPath,
            present: storedConfig !== null,
            override_path: overridePath,
            proposed: proposal,
            written,
            install: installed,
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    // Whether anything is installed at all: an install of kind `none` runs
    // nowhere, so no directory or member filter is named for it.
    const installs = result.proposed !== null && result.proposed.install.kind !== "none";
    // The base beside the checkout it was read from, in the human reading too
    // and not only in the JSON: a person running the diagnostic to find out
    // what a run here would do is asking this as much as they are asking about
    // the machine. A checkout no source names one for says so and names the key.
    const lines = [
      `CHECKOUT  ${checkout}`,
      // Two lines where there are two roots, one where the checkout is its own
      // workspace. The second names what it is for, because "there is another
      // directory above this one" is not the point — the point is that the
      // install runs there.
      ...(inWorkspace
        ? [
            `WORKSPACE ${membership.workspace_root}  (the workspace this package belongs to; ` +
              (installs
                ? `its install runs there${
                    membership.package_name === null ? "" : `, filtered to ${membership.package_name}`
                  })`
                : "nothing is installed)"),
          ]
        : []),
      `BASE      ${
        invalidBase
          ? `none — base_ref in ${configSource} is ${JSON.stringify(invalidBase.configured) ?? String(invalidBase.configured)}, which is not a branch name; a run here is refused until it is one`
          : namedBase === null
            ? `none — this checkout is on no branch and its remote declares no default; set base_ref in ${configPath}`
            : describeBase(namedBase)
      }`,
      "",
      "PREFLIGHT",
      renderPreflight(machine),
      "",
    ];
    lines.push(
      "PROVIDER",
      ...renderProviderProbe({
        provider: reviewerProvider,
        model: reviewerModel,
        result: probe,
        dependency: probeDependency,
      }),
      "",
    );
    lines.push("MATERIALISATION");
    if (result.proposed) {
      lines.push(`  package manager   ${result.proposed.install.package_manager}`);
      // The lockfile named rather than "no lockfile": what a person does next
      // is commit that file, and the advisory that says how is further down
      // the report than the line that says the install is unpinned.
      const missing = result.proposed.install.pinned
        ? null
        : (detectPackageManager(checkout)?.lockfile ?? null);
      lines.push(
        `  install           ${result.proposed.install.command.join(" ")}` +
          (inWorkspace && installs ? `  (in ${installStep.cwd})` : "") +
          (result.proposed.install.pinned ? "" : `  (unpinned: no ${missing ?? "lockfile"})`),
      );
      lines.push(`  lifecycle scripts ${result.proposed.install.lifecycle_scripts.policy}`);
      lines.push(`  verify            ${result.proposed.verify.command.join(" ")}`);
      lines.push(
        `  materialize       ${
          result.proposed.entries.length === 0
            ? "(nothing: this repository runs from a clean checkout)"
            : result.proposed.entries.map((entry) => entry.path).join(", ")
        }`,
      );
    }
    if (worktreeRoot) lines.push(`  worktree root     ${worktreeRoot}`);
    for (const finding of result.findings) {
      lines.push("", `  ${finding.severity}  ${finding.reason}: ${finding.detail}`);
    }
    lines.push("", ...renderLimitsTable(limits, configSource), ...renderCeilingHits(hits, limits, configSource));
    lines.push("", ...renderJudgingPaths(judging, configPath));
    lines.push("", ...renderStandingProhibited(standing, configPath));
    lines.push(
      "",
      ...renderPullRequestChecks(
        pinned,
        pullRequestChecks,
        proposal === null ? "configured" : "proposed",
        deliveryBoundMs,
      ),
      ...renderCheckAdvisories(advisories, configSource),
    );
    lines.push("", renderCorpusCache(corpusCache));
    lines.push("", ...renderCommands(commands));
    lines.push("");
    if (written) {
      lines.push(`CONFIG    wrote ${configPath}`);
    } else if (proposal) {
      lines.push(`CONFIG    ${configPath} does not exist. Proposed:`, "");
      lines.push(...JSON.stringify(proposal, null, 2).split("\n").map((line) => `  ${line}`));
      const writeCommand = [
        "perbo", "doctor", "--repo", options.args.repo,
        ...(overridePath === null ? [] : ["--config", overridePath]),
        "--write-config",
      ].map((arg) => /^[\w./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
      lines.push("", `  write it with: ${writeCommand}`);
    } else {
      lines.push(`CONFIG    ${configPath}`);
    }
    if (overridePath !== null) lines.push(`OVERRIDE  ${overridePath}`);
    if (installed) lines.push(...renderConfiguredInstall(installed));
    const blocking = machine.findings.filter((finding) => finding.severity === "blocking").length;
    lines.push(
      "",
      `VERDICT   ${result.materializable ? "materializable" : "NOT materializable"} · ` +
        (machine.ok ? "machine ready" : `machine NOT ready (${blocking} blocking)`) +
        // The probe's own segment, so the verdict line names every reason the
        // exit code has. A probe that failed where nothing depends on it says
        // so here too, rather than being visible only further up.
        (probe === null
          ? ""
          : probe.ok
            ? " · provider answers"
            : probeBlocking
              ? ` · provider NOT reachable (${probe.failure}, blocking)`
              : ` · provider NOT reachable (${probe.failure}, advisory)`),
    );
    options.streams.stdout(`${lines.join("\n")}\n`);
  }
  return result.materializable && machine.ok && !probeBlocking ? 0 : 1;
}

/**
 * Drop keys beginning with `_`.
 *
 * JSON has no comment syntax and this file is maintained by hand, so `_comment`
 * is the convention. Stripping it here rather than widening the schema keeps
 * `TicketRunConfigSchema` strict, which is what makes a typo in a real key an
 * error instead of a silently ignored setting.
 */
function withoutComments(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_")));
}

/**
 * How many runs a ticket's own history says it has started.
 *
 * One row per run: `ready -> provisioning` is the only route into
 * `provisioning`, and `run` records it before the attempt rather than after, so
 * the count during a run is that run's number. It is what the root attempt id
 * is minted from, and what `inspect` reports as `runs_started`.
 */
export function runsStartedBy(ticket: Pick<Ticket, "history">): number {
  return ticket.history.filter((entry) => entry.to === "provisioning").length;
}

/**
 * Bring a ticket back to `ready` so it can run again, through legal rows only.
 *
 * The lifecycle already says how work re-enters — `failed -> ready` and
 * `changes_requested -> ready` are both labelled *new attempt* — but a ticket
 * stopped part-way through has neither of those rows. This walks the shortest
 * legal route to `ready` and records each step, so a re-run is a recorded
 * decision rather than an edit to the JSON by hand.
 *
 * Unlike an observed path, these states are not claimed as things that
 * happened: each carries a note saying the ticket was reopened through them.
 *
 * A guarded row is only a route for the record that satisfies its guard, and
 * the search skips the rest: every guard reads `delivery`, which a transition
 * carries across unchanged, so a row this ticket cannot take at the start is a
 * row it cannot take at any step of the walk. Searching without that found
 * routes `transition` then refused, which reached a person as a stack trace
 * rather than as the refusal below.
 */
export function reopen(ticket: Ticket, note: string): Ticket {
  const queue: Array<{ at: TicketState; via: TicketState[] }> = [{ at: ticket.state, via: [] }];
  const seen = new Set<TicketState>([ticket.state]);
  while (queue.length > 0) {
    const { at, via } = queue.shift()!;
    for (const row of TICKET_TRANSITIONS) {
      if (row.from !== at || seen.has(row.to) || !(row.when?.(ticket) ?? true)) continue;
      const route = [...via, row.to];
      if (row.to === "ready") {
        let current = ticket;
        for (const to of route) {
          current = transition(
            current,
            to,
            to === "ready" ? note : `reopened through ${to} to start a new attempt`,
          );
        }
        return current;
      }
      seen.add(row.to);
      queue.push({ at: row.to, via: route });
    }
  }
  throw new UsageError(
    `${ticket.key} is ${ticket.state}, which the lifecycle has no route out of. It cannot be ` +
      "run again, and that is a property of the state rather than of this command",
  );
}

/** The comment-stripped `.perbo/config.json`, or null when the store has none. */
export function readRepoConfig(dir: string): Record<string, unknown> | null {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return null;
  const parsed = readJson(path, "the repository run configuration");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`${path} is not a JSON object`);
  }
  return withoutComments(parsed as Record<string, unknown>);
}

/**
 * The run configuration's own defaults, read from the schema rather than
 * restated: a proposed config that named a different model from the one a
 * run would use without it would be a second source of truth.
 */
const RUN_CONFIG_DEFAULTS = TicketRunConfigSchema.parse({
  ticket_key: "X",
  repository_root: "/",
  worktree_root: "/",
  bundle_root: "/",
  quarantine_root: "/",
  state_root: "/",
});

/**
 * `DEFAULT_LIMITS` overlaid by the repository's `limits` block — the table the
 * runner enforces, through the same schema `mergeRunConfig` hands it.
 */
export function effectiveLimits(repoConfig: Record<string, unknown> | null, source: string): LimitsTable {
  const parsed = LimitsTableSchema.safeParse(repoConfig?.["limits"] ?? { organisation: "local" });
  if (!parsed.success) {
    throw new UsageError(
      `${source} has an invalid 'limits' block:\n  ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

const CEILING_RESOURCE_FOR: Partial<Record<TerminationReason, LimitedResource>> = {
  stalled: "attempt_stall_ms",
  wall_clock_exceeded: "attempt_wall_clock_ms",
  command_ceiling_exceeded: "attempt_commands",
  iteration_ceiling_exceeded: "attempt_iterations",
  round_iteration_ceiling_exceeded: "round_iterations",
  token_ceiling_exceeded: "attempt_tokens",
  cost_ceiling_exceeded: "attempt_cost_micros",
};

/** The ceiling a termination reason names, or null when it was not a ceiling. */
export function ceilingResourceFor(reason: TerminationReason): LimitedResource | null {
  return CEILING_RESOURCE_FOR[reason] ?? null;
}

/** What an attempt used of one countable resource, as its record states it. */
export function usageOf(attempt: ExecutionAttempt, resource: LimitedResource): number | null {
  switch (resource) {
    // D-092: one counter, two ceilings — a remediation round is tested against
    // `round_iterations` and an attempt against `attempt_iterations`, and the
    // record counts the turns either way.
    case "attempt_iterations":
    case "round_iterations":
      return attempt.usage.iterations;
    case "attempt_commands":
      return attempt.usage.commands;
    case "attempt_wall_clock_ms":
      return attempt.usage.wall_clock_ms;
    case "attempt_tokens":
      // What the ceiling counts: fresh input plus output. A cached read is the
      // same prompt arriving again and is deliberately not counted against a
      // runaway ceiling (adapter.ts), so it is not counted here either. New
      // records carry the counter itself because billed usage deduplicates
      // repeated assistant envelopes; the expression preserves old records.
      return (
        attempt.usage.token_ceiling_tokens ??
        attempt.usage.input_tokens - attempt.usage.cache_read_input_tokens + attempt.usage.output_tokens
      );
    case "attempt_cost_micros":
      return attempt.usage.cost_basis === "unavailable" ? null : attempt.usage.cost_micros;
    default:
      return null;
  }
}

/**
 * The ceiling in force when a breach was recorded, read from the refusal's own
 * message (`… above the limit of 60`). The config may have been raised since —
 * that is the usual reason anyone reads this — so the current table is the
 * wrong number for a past attempt.
 */
export function limitAtBreach(attempt: ExecutionAttempt): number | null {
  const match = /above the limit of (\d+)/.exec(attempt.termination.detail);
  return match ? Number(match[1]) : null;
}

/** Likewise the value the counter reached, which the record may round down. */
export function reachedAtBreach(attempt: ExecutionAttempt): number | null {
  const match = /would reach (\d+)/.exec(attempt.termination.detail);
  return match ? Number(match[1]) : null;
}

/** `<state_root>/<ticket_id>.attempts.json`, as the loop writes it. */
export const AttemptsFileSchema = z.object({
  ticket_id: z.string().min(1),
  attempts: z.array(ExecutionAttemptSchema),
});
export type AttemptsFile = z.infer<typeof AttemptsFileSchema>;

export function readAttemptsFile(path: string): AttemptsFile {
  const parsed = AttemptsFileSchema.safeParse(readJson(path, "the attempts record"));
  if (!parsed.success) {
    throw new UsageError(
      `${path} is not a readable attempts record:\n  ` +
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

export interface CeilingTermination {
  ticket: string;
  ticket_id: string;
  attempt_id: string;
  resource: LimitedResource;
  reached: number | null;
  limit: number | null;
  config_key: string;
}

/**
 * Every attempt on record that ended on a ceiling, across every ticket's
 * attempts file under the state root. An unreadable file is named rather than
 * skipped silently — a store that shrank must never look like a small one.
 */
export function ceilingTerminations(
  stateRoot: string,
  keyFor: (ticketId: string) => string,
): { hits: CeilingTermination[]; unreadable: string[] } {
  const hits: CeilingTermination[] = [];
  const unreadable: string[] = [];
  if (!existsSync(stateRoot)) return { hits, unreadable };
  for (const name of readdirSync(stateRoot).filter((entry) => entry.endsWith(".attempts.json")).sort()) {
    let file: AttemptsFile;
    try {
      file = readAttemptsFile(join(stateRoot, name));
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      unreadable.push(name);
      continue;
    }
    for (const attempt of file.attempts) {
      const resource = ceilingResourceFor(attempt.termination.reason);
      if (!resource) continue;
      hits.push({
        ticket: keyFor(file.ticket_id),
        ticket_id: file.ticket_id,
        attempt_id: attempt.attempt_id,
        resource,
        reached: reachedAtBreach(attempt) ?? usageOf(attempt, resource),
        limit: limitAtBreach(attempt),
        config_key: `limits.limits.${resource}`,
      });
    }
  }
  return { hits, unreadable };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/**
 * A dollar figure only where there is one. `unavailable` means the transport
 * exposes no dollar measure, and printing that as $0 is the lie the field
 * exists to prevent; `not_incurred` means no model was called.
 */
export function formatCost(
  micros: number,
  basis: "transport_reported" | "provider_list_estimate" | "unavailable" | "not_incurred",
): string {
  if (basis === "unavailable") return "cost unavailable";
  if (basis === "not_incurred") return "not incurred";
  return `$${(micros / 1_000_000).toFixed(4)} ${basis === "transport_reported" ? "reported" : "estimated"}`;
}

const withThousands = (n: number) => n.toLocaleString("en-US");

/** A resource's value in the unit a person thinks in, beside the raw number. */
function humanLimit(resource: LimitedResource, value: number): string {
  switch (resource) {
    case "attempt_stall_ms":
    case "attempt_wall_clock_ms":
    case "wait_for_provider_ms":
      return formatDuration(value);
    case "attempt_cost_micros":
    case "ticket_cost_micros":
      return `$${(value / 1_000_000).toFixed(2)}`;
    case "local_workspace_bytes":
      return `${(value / (1024 * 1024 * 1024)).toFixed(value % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GiB`;
    default:
      return withThousands(value);
  }
}

/** The resources a repository may set that nothing defaults, and their labels. */
const CONFIGURED_ONLY_LABEL = [
  ["attempt_wall_clock_ms", "wall clock"],
  ["attempt_tokens", "tokens"],
  ["attempt_iterations", "iterations"],
  ["round_iterations", "round iterations"],
  ["attempt_commands", "commands"],
] as const;

/**
 * One line, for the start of a run: what can stop it.
 *
 * The stall window leads because it is the only thing that stops an attempt
 * nobody asked to stop (D-096). The next two bound the ticket the attempts
 * belong to (SCP-193) — how many remediation rounds it gets, and the longest
 * the loop will sit out a provider that named its own reset. The two cost
 * numbers come after them, marked per-token, because whether they bound
 * anything depends on what the executor authenticates with and that is not
 * known until it has started. Nothing counted in time, tokens, messages or tool
 * calls appears unless the repository set a ceiling for it, and then it comes
 * last, so a reader can tell the bounds every run has from the ones this
 * repository added.
 */
export function renderCeilingsLine(limits: LimitsTable): string {
  const at = (resource: DefaultedResource) => humanLimit(resource, limitFor(limits, resource));
  const perToken = (resource: PerTokenCostLimit) =>
    humanLimit(resource, limits.limits[resource] ?? PER_TOKEN_COST_LIMITS[resource]);
  const parts = [
    `stall ${at("attempt_stall_ms")}`,
    `remediation rounds ${at("remediation_rounds")}`,
    `provider wait ${at("wait_for_provider_ms")}`,
    `per-token cost ${perToken("attempt_cost_micros")}`,
    `per-token ticket budget ${perToken("ticket_cost_micros")}`,
  ];
  for (const [resource, label] of CONFIGURED_ONLY_LABEL) {
    const value = limitFor(limits, resource);
    if (value !== null) parts.push(`${label} ${humanLimit(resource, value)}`);
  }
  return parts.join(" · ");
}

export function renderLimitsTable(limits: LimitsTable, configPath: string): string[] {
  const lines = [
    `CEILINGS  DEFAULT_LIMITS overlaid by ${configPath}`,
    "          each key is raised as limits.limits.<name>",
    "          the two cost keys bind only where the executor is billed per token",
  ];
  const perTokenDefaults: Partial<Record<LimitedResource, number>> = PER_TOKEN_COST_LIMITS;
  for (const resource of LIMITED_RESOURCES) {
    const configured = limits.limits[resource];
    const perToken = perTokenDefaults[resource];
    const fallback = DEFAULT_LIMITS[resource] ?? perToken;
    const value = configured ?? fallback ?? null;
    const defaultWord = perToken === undefined ? "default" : "per-token default";
    // Four states: a default every run has, a default that waits on an API key,
    // a ceiling the repository set where nothing defaults one, and the absence
    // that is no ceiling at all (D-096).
    const note =
      configured === undefined
        ? fallback === undefined
          ? "not set"
          : defaultWord
        : fallback === undefined
          ? "config (no default)"
          : configured !== fallback
            ? `config (${defaultWord} ${humanLimit(resource, fallback)})`
            : defaultWord;
    lines.push(
      `  ${resource.padEnd(26)} ${(value === null ? "—" : String(value)).padStart(12)}  ` +
        `${(value === null ? "no ceiling" : humanLimit(resource, value)).padEnd(10)} ${note}`,
    );
  }
  return lines;
}

export function renderCeilingHits(
  hits: { hits: CeilingTermination[]; unreadable: string[] },
  limits: LimitsTable,
  configPath: string,
): string[] {
  const lines: string[] = [];
  for (const hit of hits.hits) {
    const now = limitFor(limits, hit.resource);
    const then = hit.limit ?? now;
    const show = (value: number | null) =>
      value === null ? "no ceiling" : humanLimit(hit.resource, value);
    lines.push(
      "",
      `  ceiling hit  ${hit.ticket} ${hit.attempt_id}: ${hit.resource} reached ` +
        `${hit.reached === null ? "(unrecorded)" : humanLimit(hit.resource, hit.reached)} against ${show(then)}`,
      `               raise it with ${hit.config_key} in ${configPath}` +
        (now !== then ? ` (now ${show(now)})` : ""),
    );
  }
  for (const name of hits.unreadable) {
    lines.push("", `  warning  ${name} is not a readable attempts record and was skipped`);
  }
  return lines;
}

/** What a judging entry stands for in the human block, where it has no path. */
export function judgingPathLabel(entry: JudgingPath): string {
  if (entry.path !== null) return entry.path;
  return entry.set ? "(none)" : "(unset)";
}

/**
 * The JUDGING block: every path that judges an attempt in this store, each
 * against the key it came from, and the two config keys named even when they
 * are silent — a person reading this is deciding what a scope may touch, and
 * "the key exists and you have not set it" is the answer that decision needs.
 */
export function renderJudgingPaths(entries: readonly JudgingPath[], configPath: string): string[] {
  const lines = [
    "JUDGING   what judges an attempt here; an approved scope may not overlap it",
    `          store is the store itself; the other keys are read from ${configPath}`,
  ];
  const width = Math.max(...entries.map((entry) => judgingPathLabel(entry).length));
  for (const entry of entries) {
    lines.push(`  ${judgingPathLabel(entry).padEnd(width)}  ${entry.source}`);
  }
  return lines;
}

/**
 * The PROHIBITED block: what this repository refuses a write to for every
 * ticket, each entry with what put it there. Separate from JUDGING, which is
 * what an approved scope may not overlap: a scope may name a standing path, and
 * what the guard refuses is the write.
 */
export function renderStandingProhibited(
  entries: readonly StandingProhibitedEntry[],
  configPath: string,
): string[] {
  const lines = [
    "PROHIBITED  what every ticket here refuses a write to, whatever its contract says",
    `            read from paths_prohibited in ${configPath}`,
  ];
  if (entries.length === 0) return [...lines, "  (none)"];
  const width = Math.max(...entries.map((entry) => entry.path.length));
  for (const entry of entries) lines.push(`  ${entry.path.padEnd(width)}  ${entry.source}`);
  return lines;
}

/** A pinned check that would be answered from a build tool's cache. */
export interface CheckAdvisory {
  /** The check's id, or its name, or `null` where it declares neither. */
  check_id: string | null;
  name: string | null;
  /** Its command, as the file declares it. */
  command: string;
  /** The flag that fixes it. */
  flag: string;
  reason: string;
}

/**
 * The pinned checks that run turbo without `--force`.
 *
 * turbo answers a task from its cache while the inputs the package declares are
 * unchanged, so a check that reads anything else — the committed tree, a file a
 * sibling package owns — can be reported as passed for a run that never
 * happened. The runner puts the flag on the argv and `TURBO_FORCE` in the
 * environment, which makes every check it starts uncached; this is the other
 * half, so the file a person maintains says the same thing the runner does and
 * can be fixed there.
 *
 * Advisory: it names something to change and never reaches the exit code. The
 * run is already correct without it.
 */
export function turboCacheAdvisories(checks: unknown): CheckAdvisory[] {
  if (!Array.isArray(checks)) return [];
  const advisories: CheckAdvisory[] = [];
  for (const check of checks) {
    if (check === null || typeof check !== "object") continue;
    const entry = check as Record<string, unknown>;
    const command = entry["command"];
    if (!Array.isArray(command)) continue;
    const argv = command.filter((token): token is string => typeof token === "string");
    if (argv.length !== command.length || !runsTurboWithoutForce(argv)) continue;
    const id = entry["check_id"];
    const name = entry["name"];
    advisories.push({
      check_id: typeof id === "string" && id !== "" ? id : null,
      name: typeof name === "string" && name !== "" ? name : null,
      command: argv.join(" "),
      flag: TURBO_FORCE_FLAG,
      reason: "turbo can answer it from its cache, so it would pass without running on the tree",
    });
  }
  return advisories;
}

/**
 * What each pinned check is called, in the order the file declares them: its
 * id, or its name where it declares no id.
 */
export function pinnedCheckNames(checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  return checks.map((check, at) => {
    const entry = (check ?? {}) as Record<string, unknown>;
    const id = entry["check_id"];
    const name = entry["name"];
    if (typeof id === "string" && id !== "") return id;
    if (typeof name === "string" && name !== "") return name;
    return `check ${at + 1}`;
  });
}

/**
 * The CHECKS block: what a run here is judged by before it publishes, and what
 * this repository runs on the pull request afterwards.
 *
 * The second line is the one a person is usually surprised by. A repository
 * with no pull-request workflow and nothing required on the base publishes pull
 * requests that no check ever reports on, and every delivery it makes is
 * `unchecked` — which reads like a run that gave up waiting and is not.
 */
export function renderPullRequestChecks(
  pinned: readonly string[],
  reading: PullRequestChecks,
  source: "proposed" | "configured",
  /** What a delivery read here would wait, as {@link deliveryChecksBoundMs} decides it. */
  boundMs: number,
): string[] {
  const answer = (): string => {
    if (!reading.answered) return `unknown — ${reading.detail}`;
    if (!reading.runs_checks) {
      return (
        "no — no workflow here triggers on a pull request" +
        (reading.base_ref === null ? "" : ` and ${reading.base_ref} requires no status check`) +
        "; a pull request opened here is never reported on"
      );
    }
    const says = [
      ...reading.workflows.map((workflow) => workflow.path),
      ...reading.required_checks.map((context) => `${reading.base_ref} requires ${context}`),
    ];
    return `yes — ${says.join(", ")}`;
  };
  const waits = !reading.answered
    ? null
    : boundMs === 0
      ? "a run here does not wait for them"
      : `a run here waits up to ${Math.round(boundMs / 1000)}s for them`;
  return [
    "CHECKS    what judges a run here, and what this repository runs on the pull request",
    `  pinned         ${pinned.length === 0 ? "(none)" : pinned.join(", ")} (${source})`,
    `  pull requests  ${answer()}${waits === null ? "" : `; ${waits}`}`,
  ];
}

/**
 * The advisory lines under the CHECKS block: a pinned check that would be
 * answered from a build tool's cache. Empty where there is nothing to act on.
 */
export function renderCheckAdvisories(
  advisories: readonly CheckAdvisory[],
  configPath: string,
): string[] {
  return [
    ...advisories.map(
      (advisory) =>
        `  advisory  ${advisory.check_id ?? advisory.name ?? "(unnamed)"} runs ` +
        `\`${advisory.command}\` without ${advisory.flag}: ${advisory.reason}` +
        ` — add ${advisory.flag} to its command in ${configPath}`,
    ),
  ];
}

/** What the configuration on disk installs with, read back against the checkout. */
export interface ConfiguredInstall {
  /** The install command `.perbo/config.json` pins, as it declares it. */
  command: string[];
  /** Whether that install reproduces a lockfile or resolves its own versions. */
  pinned: boolean;
  /** What this checkout implies today, from the derivation `doctor` proposes from. */
  checkout: { command: string[]; pinned: boolean };
  /** True where the configured install is still the one the checkout implies. */
  consistent: boolean;
  /**
   * `install_could_pin` where the checkout has gained the lockfile the
   * configured install predates. `install_outgrown` where the configuration
   * still holds the manifest `--write-config` pins for a checkout that named no
   * package manager this build installs with — nothing installed,
   * `git status --porcelain` as the verification — and the checkout now names
   * one, with something for it to install. `verify_outgrown` where the
   * configured verification is
   * `git status --porcelain` and the checkout declares a test script a worktree
   * can run: the manifest `--write-config` pinned before the package declared
   * one, or a person's own choice, which this cannot tell apart, so it says what
   * a run does and leaves the choice to them. It carries the unpinned install
   * the checkout could now pin, where there is one, rather than hide it. Null
   * otherwise, including where the two merely differ, which is what a
   * deliberately edited install looks like from here.
   */
  advisory: {
    reason: "install_could_pin" | "install_outgrown" | "verify_outgrown";
    detail: string;
  } | null;
}

/**
 * The configured install beside the one this checkout would propose today
 * (SCP-285).
 *
 * `doctor --write-config` on a repository with no lockfile writes the install
 * that manager can run without one. That file is then correct until the
 * repository commits a lockfile, and from that moment the run it configures
 * resolves its own versions while the repository has an answer that pins them
 * — a divergence nothing was reading, in the one file `doctor` refuses to
 * rewrite. So it is read back and reported here instead.
 *
 * The same holds for the manifest written where the checkout declared no
 * verification a worktree can run: it verifies with `git status --porcelain`,
 * and where nothing named a package manager this build installs with, it
 * installs nothing. Because a pinned manifest skips the diagnostic, a run keeps
 * using it after the checkout names such a manager or declares a test script.
 * The read-back says so.
 *
 * Null where the configuration carries no manifest, and null where the install
 * it carries is not one this build understands: a file a person has edited into
 * a shape the schema does not know is not a repository this can say anything
 * about.
 *
 * Advisory in every state — it names something to change in a file the person
 * owns, and never reaches the exit code.
 */
export function configuredInstall(
  repoConfig: Record<string, unknown> | null,
  checkout: string,
  configPath: string,
): ConfiguredInstall | null {
  const manifest = repoConfig?.["materialization_manifest"];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const parsed = InstallStrategySchema.safeParse((manifest as Record<string, unknown>)["install"]);
  if (!parsed.success) return null;
  const verify = (manifest as { verify?: { command?: unknown } }).verify?.command;

  const detected = detectPackageManager(checkout);
  const proposed = proposedInstall(checkout, detected);
  const configured = parsed.data;
  // The verification `--write-config` pins where the checkout declared none a
  // worktree could run.
  const unverified = Array.isArray(verify) && verify.join(" ") === GREENFIELD_VERIFY.join(" ");
  // The manifest it pins where nothing named a manager this build installs
  // with, and only that one: an install a person set to `none` beside a
  // verification of their own is theirs.
  const greenfield = configured.kind === "none" && unverified;
  // What the diagnostic would verify with now, where the configured manifest
  // verifies with nothing the checkout declares.
  const declared = unverified ? declaredVerifyCommand(checkout, detected) : null;
  // An unpinned install this checkout could now pin: an advisory of its own,
  // or part of the verification's where both have moved.
  const couldPin =
    configured.pinned || detected === null || !detected.pinned
      ? null
      : `${detected.named_by} now pins what ${detected.manager} installs, and the ` +
        `configured install predates it: \`${configured.command.join(" ")}\` still ` +
        "resolves its own versions, so two runs of it can differ. Set " +
        `"materialization_manifest.install.command" to ` +
        `\`${detected.pinned_install.join(" ")}\` and "…install.pinned" to true in ` +
        `${configPath}.`;
  return {
    command: configured.command,
    pinned: configured.pinned,
    checkout: { command: proposed.command, pinned: proposed.pinned },
    consistent:
      configured.pinned === proposed.pinned &&
      configured.command.join(" ") === proposed.command.join(" "),
    advisory:
      greenfield && detected?.supported && detected.manifest_present
        ? {
            reason: "install_outgrown",
            detail:
              `${detected.named_by} now names ${detected.manager}, and the configured manifest ` +
              `predates it: it installs nothing and verifies with \`${GREENFIELD_VERIFY.join(" ")}\`, ` +
              "so a run neither installs nor runs what this checkout declares. Set " +
              `"materialization_manifest.install" and "…verify" to what \`perbo doctor\` ` +
              `proposes for this checkout, or remove "materialization_manifest" from ` +
              `${configPath} so each run derives them.`,
          }
        : declared !== null
          ? {
              reason: "verify_outgrown",
              detail:
                `this checkout declares \`${declared.join(" ")}\`, and the configured manifest ` +
                `verifies with \`${GREENFIELD_VERIFY.join(" ")}\`, which any checkout Git can ` +
                "read passes, so a run never runs it. Unless that is deliberate, set " +
                `"materialization_manifest.verify.command" to \`${declared.join(" ")}\` in ` +
                `${configPath}.${couldPin === null ? "" : ` ${couldPin}`}`,
            }
          : couldPin === null
            ? null
            : { reason: "install_could_pin", detail: couldPin },
  };
}

/** The configured install, and what this checkout makes of it. */
export function renderConfiguredInstall(install: ConfiguredInstall): string[] {
  const lines = [
    `  install   ${install.command.join(" ")}` +
      (install.pinned ? "" : "  (unpinned: it resolves its own versions)"),
  ];
  if (install.advisory !== null) {
    lines.push(`  advisory  ${install.advisory.reason}: ${install.advisory.detail}`);
  } else if (install.consistent) {
    lines.push("            consistent with this checkout");
  } else {
    lines.push(`            this checkout implies ${install.checkout.command.join(" ")}`);
  }
  return lines;
}

const SCRIPT_CHECKS: Array<{ script: string; kind: "typecheck" | "lint" | "unit" }> = [
  { script: "typecheck", kind: "typecheck" },
  { script: "lint", kind: "lint" },
  { script: "test", kind: "unit" },
  { script: "test:unit", kind: "unit" },
];

/**
 * The checks a checkout's own scripts imply, and the only place they are
 * derived (SCP-259).
 *
 * `doctor` proposes these and writes them on request; a run on a repository
 * that has no `.perbo/config.json` pins these same ones for the attempt. One
 * function, because the file `doctor` offers and the set a first run is judged
 * by must not be able to disagree.
 *
 * Empty where nothing names a package manager this build installs with, and
 * empty where the package declares none of the scripts below: a check is never
 * invented. A test script that starts a service is left out, as the diagnostic
 * leaves it out of the verification: a worktree cannot be given one.
 *
 * The scripts are the given root's own, including where that root is one
 * package of a monorepo: the outcome is about that package and its suite is
 * what judges it, so `packages/web`'s `test` is the check and the workspace
 * root's `turbo run test` — which would run every package — is not. Only the
 * manager comes from the workspace, because that is who runs the script.
 */
export function proposedChecks(checkout: string): Array<Record<string, unknown>> {
  const detected = detectPackageManager(checkout);
  return detected?.supported ? checksFromScripts(checkout, detected.manager) : [];
}

/**
 * Pinned checks from the scripts `package.json` already declares — never
 * invented. `test` and `test:unit` are the same check; the first present wins.
 */
function checksFromScripts(checkout: string, manager: string): Array<Record<string, unknown>> {
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }
  const checks: Array<Record<string, unknown>> = [];
  const kinds = new Set<string>();
  for (const { script, kind } of SCRIPT_CHECKS) {
    if (typeof scripts[script] !== "string" || kinds.has(kind)) continue;
    const command = [manager, "run", script];
    // A test script that starts a service is not the suite, as it is not the
    // verification; a lint or typecheck script is judged as it is.
    if (
      kind === "unit" &&
      verificationServiceNeed(checkout, command)?.reason === "verification_requires_service"
    ) {
      continue;
    }
    kinds.add(kind);
    checks.push({
      check_id: `check_${kind}`,
      name: script,
      kind,
      command,
      timeout_ms: 900_000,
      definition_path: "package.json",
    });
  }
  return checks;
}

/**
 * The three places a run's base branch can come from, in the order they are
 * read and reported: the branch this checkout is on, a `base_ref` somebody
 * configured, the remote's declared default branch. Defined with the run
 * configuration that carries it, and re-exported here beside the resolution.
 */
export type { BaseSource };

/** The base a run lands on, and which of the three sources named it. */
export interface ProposedBase {
  base_ref: string;
  from: BaseSource;
}

/**
 * A `base_ref` a configuration holds that is not a branch name: blank, padded
 * with whitespace, or not a string at all.
 *
 * It is kept apart from "nothing configured one" because the two get different
 * answers. A key nobody set is derived from the checkout; a key somebody set to
 * something unusable is a mistyped branch name, and deriving over it would
 * publish somewhere else without saying so. Every caller reports it and names
 * the key, so the value is shown back to whoever wrote it.
 */
export interface InvalidBase {
  from: "invalid";
  /** Exactly what the configuration held, so a message can quote it. */
  configured: unknown;
}

/** What a base resolves to: a base and its source, an unusable one, or nothing. */
export type BaseResolution = ProposedBase | InvalidBase | null;

/**
 * Whether a configured value names a branch.
 *
 * A branch name is a non-empty string that is what it looks like: `" main "`
 * resolves to no ref and GitHub refuses it as a base, so it is a mistake to
 * report rather than one to trim silently on somebody's behalf.
 */
const namesBranch = (configured: unknown): configured is string =>
  typeof configured === "string" && configured.length > 0 && configured.trim() === configured;

/**
 * How each source reads in a line a person sees — the label first, so `inspect`
 * and the run's own progress name the source with the same three words the
 * README's section on where a run publishes lists.
 */
export const BASE_SOURCE_LABEL: Record<BaseSource, string> = {
  branch: "branch",
  config: "config",
  remote_default: "remote default",
};

/** The label, and why that source answered. */
export const BASE_SOURCE_DETAIL: Record<BaseSource, string> = {
  branch: "branch: the branch this checkout is on",
  config: "config: the base_ref this run's configuration names",
  remote_default:
    "remote default: the remote's default branch, because this checkout is not on one",
};

/**
 * How long either binary may take to name a branch. `doctor` prints this
 * answer beside a dozen others, so a read that has to be waited on is a read
 * that did not answer.
 */
const BASE_READ = { timeoutMs: 30_000 } as const;

/**
 * The one line a read named, or null where it did not name one — the binary is
 * not installed, the command exited non-zero, the wait ran out, or the answer
 * arrived cut. Every one of them is "this source cannot say", and the next
 * source is asked.
 */
function named(read: () => RunResult): string | null {
  let result: RunResult;
  try {
    result = read();
  } catch {
    return null;
  }
  if (result.code !== 0 || result.timed_out || result.truncated) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

/**
 * The branch a change lands on, where nothing configured one, and the only
 * place it is derived (SCP-265).
 *
 * `doctor` proposes it and writes it on request; a run whose configuration
 * names no `base_ref` uses this same answer, both for the merge-up that keeps
 * the branch level with its base and for the `--base` the pull request opens
 * against. One function, because the file `doctor` offers and the base a first
 * run publishes against must not be able to disagree.
 *
 * The checkout's own branch first: that is what a person on `main` means, and
 * it needs nothing but the local repository. A detached checkout has no branch
 * to read, so the remote's declared default stands in — from
 * `refs/remotes/origin/HEAD` where the clone has it, and from GitHub itself
 * where the run is going to reach GitHub anyway. Null where neither can be
 * named, which is a refusal at the caller rather than a guess here.
 */
export function proposedBase(
  checkout: string,
  options: { publish: boolean },
): ProposedBase | null {
  const branch = named(() => git.runSync(checkout, ["symbolic-ref", "--short", "HEAD"], BASE_READ));
  if (branch !== null) return { base_ref: branch, from: "branch" };

  const remoteHead = named(() =>
    git.runSync(checkout, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], BASE_READ),
  );
  const declared = remoteHead?.startsWith("origin/") ? remoteHead.slice("origin/".length) : null;
  if (declared) return { base_ref: declared, from: "remote_default" };

  // Asked of GitHub only where the run is publishing: a `gh` process on a
  // diagnostic that publishes nothing would be a network call nobody asked for.
  if (options.publish) {
    const viewed = named(() =>
      gh.runSync(
        checkout,
        ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        BASE_READ,
      ),
    );
    if (viewed) return { base_ref: viewed, from: "remote_default" };
  }
  return null;
}

/** How a base and its source read on one line a person sees. */
export const describeBase = (base: ProposedBase): string =>
  `${base.base_ref} — ${BASE_SOURCE_DETAIL[base.from]}`;

/**
 * The base a run here lands on, from all three sources, and the only place the
 * precedence between them lives.
 *
 * A `base_ref` somebody wrote down wins: it is an agreement about this
 * repository, and a checkout — on a branch or detached — cannot outvote it.
 * `undefined` is the only thing that means nobody wrote one down; anything else
 * that is not a branch name is {@link InvalidBase} and is reported rather than
 * derived over. Everything else is {@link proposedBase}'s derivation from the
 * checkout. Null where no source answers, which every caller turns into a
 * refusal naming `base_ref` rather than a guess.
 *
 * `derive` is the derivation to use, so `doctor` can be given one in a test
 * without a second copy of the precedence above it.
 */
export function resolveBase(
  checkout: string,
  configured: unknown,
  options: {
    publish: boolean;
    derive?: (checkout: string, options: { publish: boolean }) => ProposedBase | null;
  },
): BaseResolution {
  if (configured !== undefined) {
    return namesBranch(configured) ? { base_ref: configured, from: "config" } : { from: "invalid", configured };
  }
  return (options.derive ?? proposedBase)(checkout, { publish: options.publish });
}

/**
 * The base a run uses, or the one message that stops it before anything is
 * provisioned: nothing publishes against a branch nobody named, and nothing
 * publishes against a `base_ref` that is not a branch name either.
 *
 * One place, so a run refuses in the same words with the same key named
 * whichever way its configuration was built. The two failures are different
 * kinds and read as such: a checkout that names no branch is a refusal about
 * this repository, which `doctor` will report the same way, while a `base_ref`
 * holding something that is not a branch name is a mistake in a file somebody
 * wrote — the strict configuration schema refuses every other mistyped key
 * that way, and a run must not quietly derive a different base over one.
 */
export function requireBase(
  resolution: BaseResolution,
  where: {
    repository_root: string;
    /** The file `base_ref` was read from, and the one to set it in. */
    configPath: string;
  },
): ProposedBase {
  if (resolution !== null && resolution.from !== "invalid") return resolution;
  if (resolution !== null) {
    throw new UsageError(
      `${where.configPath} sets "base_ref" to ` +
        `${JSON.stringify(resolution.configured) ?? String(resolution.configured)}, which is not ` +
        "a branch name. Set it to the branch this work lands on, or remove it and let the " +
        "checkout name one.",
    );
  }
  throw new RunRefusedError({
    message: "the branch this change would land on could not be named",
    findings: [
      {
        reason: "base_ref_unknown",
        severity: "refusal",
        detail:
          `${where.repository_root} is not on a branch, and its remote declares no default ` +
          "branch, so there is nothing to merge the base up from and nothing to open a pull " +
          `request against. Set "base_ref" in ${where.configPath} to the branch this work lands ` +
          "on, or check that branch out.",
        path: null,
      },
    ],
    repository_root: where.repository_root,
  });
}

/**
 * The `.perbo/config.json` a checkout with none would get: the checks its
 * own scripts declare, the base its checkout names, the manifest the diagnostic
 * proposed with a portable `source_checkout`, and every default limit spelled
 * out so each ceiling has a key to raise when an attempt hits it.
 *
 * `base` is passed in rather than derived here so that `doctor` reads the
 * checkout once and reports and writes the same answer.
 */
export function proposeRepoConfig(
  checkout: string,
  manifest: MaterializationManifest | null,
  base: ProposedBase | null,
): Record<string, unknown> {
  return {
    _comment: [
      "Proposed by `perbo doctor`. The checks come from package.json scripts, the base branch",
      "from the checkout, the materialisation manifest from what the checkout needs that Git",
      "does not carry, and the limits are the laptop defaults written out so each ceiling has",
      "a key to raise. Keys beginning with `_` are ignored.",
    ],
    checks: proposedChecks(checkout),
    // Omitted rather than guessed where the checkout names no branch: a run
    // against such a repository refuses and says to set this key.
    ...(base ? { base_ref: base.base_ref } : {}),
    protected_tests: [],
    agent_binary: RUN_CONFIG_DEFAULTS.agent_binary,
    model: RUN_CONFIG_DEFAULTS.model,
    reviewer_provider: RUN_CONFIG_DEFAULTS.reviewer_provider,
    max_remediation_rounds: RUN_CONFIG_DEFAULTS.max_remediation_rounds,
    publish: false,
    // SCP-202/D-077: written out at its default so the switch is visible in
    // the file a person maintains rather than only in the schema.
    merge: RUN_CONFIG_DEFAULTS.merge,
    materialization_manifest: manifest ? { ...manifest, source_checkout: "." } : null,
    limits: { organisation: "local", limits: { ...DEFAULT_LIMITS } },
  };
}

/**
 * `layer` without `delivery_branch`, and a warning naming `source` where it set
 * one.
 *
 * A ticket keeps the branch it already has (D-098), and only its delivery
 * record names that branch. The loop provisions on it, pushes to it and writes
 * it back onto the ticket, so no configuration file sets it: neither the
 * repository's `config.json` nor an explicit `--config`.
 */
function withoutDeliveryBranch<T>(layer: T, source: string, warn: (line: string) => void): T {
  if (typeof layer !== "object" || layer === null || !("delivery_branch" in layer)) return layer;
  warn(`warning: ${source} sets 'delivery_branch', which only a ticket's delivery record sets. Ignoring it.\n`);
  return Object.fromEntries(Object.entries(layer).filter(([key]) => key !== "delivery_branch")) as T;
}

/**
 * The run configuration for one run of the loop.
 *
 * Three layers, narrowest last: what the run already knows (its repository,
 * where its worktrees and bundles go), then `.perbo/config.json` — the things
 * a repository agrees **once** rather than per ticket, which is what the checks
 * and the materialisation manifest are — then an explicit `--config` for the
 * run in front of you.
 *
 * The split is the friction this removes. Checks and a materialisation manifest
 * are properties of a repository, and copying them into every ticket run file
 * was the largest part of the JSON a person had to write by hand.
 *
 * None of it reads a ticket: it reads the store's own `config.json`, which is
 * working state of one machine, and the run's identity is passed in. A run with
 * a ticket passes the admitted ticket's; one with nothing admitted behind it
 * passes the identity of its contract's source (SCP-180), so both are judged by
 * the same repository agreement.
 */
export function mergeRunConfig(
  run: {
    /** The store: `<repo>/.perbo` unless `--store` moved it. */
    dir: string;
    /**
     * What labels the run — the branch, the seal's commit message, the seed the
     * attempt ids are minted from. A ticket's key, or, with nothing admitted,
     * the identity of the contract's own source (`local_…`, `gh_owner_repo_N`).
     */
    key: string;
    repository_root: string;
    source?: TicketSource | null;
    /**
     * The branch the ticket's delivery record names, which the run keeps
     * rather than deriving a new one (D-098). A local run has no delivery
     * record; the loop reads its attempts record instead.
     */
    branch?: string | null;
    /**
     * Whether `--publish` was typed. Only the base derivation reads it, and
     * only where the checkout names no branch: a run that is going to reach
     * GitHub anyway may ask it which branch is the default.
     */
    publish?: boolean;
    /**
     * The spec's No-Gos, from the ticket's approach record (D-096, D-100).
     * Passed in rather than read here, because nothing in this file reads a
     * ticket. Empty for a run with nothing admitted behind it.
     */
    no_gos?: readonly string[];
    /**
     * The files the loop commits first on the ticket's branch, from its
     * admission record (D-103). Passed in for the same reason as the No-Gos,
     * and empty for a ticket admitted without a spec.
     */
    spec_files?: readonly SpecFile[];
  },
  override: unknown,
): unknown {
  const warn = (line: string) => process.stderr.write(line);
  const stored = readRepoConfig(run.dir);
  const repoConfig = withoutDeliveryBranch(stored ?? {}, join(run.dir, "config.json"), warn);
  const explicit = withoutDeliveryBranch(override, "the run configuration passed with --config", warn);
  // A relative `source_checkout` is resolved against the repository the run
  // names, so the file a person maintains can say "." and mean it. An absolute
  // one is left alone.
  const manifest = repoConfig["materialization_manifest"];
  if (manifest && typeof manifest === "object") {
    const record = manifest as Record<string, unknown>;
    if (typeof record["source_checkout"] === "string") {
      record["source_checkout"] = resolve(run.repository_root, record["source_checkout"]);
    }
  }
  const derived = {
    ticket_key: run.key,
    // Carried into the run so the pull request names where the work came from.
    // Derived like the key: a config file that set it would be describing a
    // provenance the ticket already records.
    ticket_source: run.source ?? null,
    repository_root: run.repository_root,
    // Outside the repository, and that is not a preference.
    //
    // pnpm resolves its workspace root by walking **up**, so a worktree under
    // `<repo>/.perbo/worktrees` inherits the repository's own
    // `pnpm-workspace.yaml` and every install and every `pnpm exec` inside it
    // fails, naming neither directory. `perbo doctor` reports exactly this as
    // `nested_package_manager_workspace`, and it reported it against this
    // default — the diagnostic caught a defect in the command it exists to
    // protect.
    //
    // Bundles, quarantine and resume state stay in the store: they are records,
    // they are small, and nothing runs a package manager in them.
    worktree_root: join(
      homedir(),
      ".perbo",
      "worktrees",
      // The basename alone collides: ~/work/api and ~/clients/api share a
      // directory, and `reclaimStaleWorktrees` iterates every lease under the
      // root it is given — so one repository's cleanup deletes the other's
      // lease file, and the other's next attempt fails on a worktree that is
      // still on disk. The path digest makes the directory identify the
      // checkout rather than its name.
      `${basename(run.repository_root)}-${createHash("sha256")
        .update(run.repository_root)
        .digest("hex")
        .slice(0, 12)}`,
    ),
    bundle_root: join(run.dir, "bundles"),
    quarantine_root: join(run.dir, "quarantine"),
    state_root: join(run.dir, "state"),
    // The store the ticket was admitted into is where `perbo principle add`
    // writes, so it is where the loop must read (D-065) — a --store user's
    // principles would otherwise never reach a brief.
    principles_path: join(run.dir, "principles.md"),
    // Approach, not contract: it briefs the executor and gates nothing, so a
    // configuration file that set it would be stating the spec's intent
    // somewhere the spec cannot correct.
    no_gos: [...(run.no_gos ?? [])],
    // D-103: what the loop commits first on the branch. Derived from the
    // ticket's admission record, because a configuration file naming other
    // files would put a spec on the branch the contract was not drafted from.
    spec_files: [...(run.spec_files ?? [])],
  };
  // The derived keys win over the repository config, and lose only to an
  // explicit `--config`. Letting `.perbo/config.json` set `worktree_root`
  // would silently reproduce the nested-workspace failure the derived default
  // exists to prevent; letting it set `ticket_key` would run every ticket under
  // one name.
  const derivedKeys = new Set(Object.keys(derived));
  for (const key of Object.keys(repoConfig)) {
    if (!derivedKeys.has(key)) continue;
    process.stderr.write(
      `warning: ${join(run.dir, "config.json")} sets '${key}', which the run derives. ` +
        "Ignoring it — pass --config to override deliberately.\n",
    );
  }
  const repoWithoutDerived = Object.fromEntries(
    Object.entries(repoConfig).filter(([key]) => !derivedKeys.has(key)),
  );

  // The base the loop merges up from and the pull request opens against
  // (SCP-265). A `base_ref` somebody configured; failing that, the branch this
  // checkout is on; failing that — a detached checkout has no branch to read —
  // the branch the remote declares as its default. Read from the same function
  // `doctor` proposes and writes it from, so the run, the record and the file
  // cannot disagree. The schema's own default is the literal `HEAD`, which
  // GitHub refuses as a base after the whole loop has been paid for.
  // Null unless an explicit `--config` really handed one over: this is read by
  // key presence below, and `undefined in {}` is a crash rather than an answer.
  const asked =
    typeof override === "object" && override !== null ? (override as Record<string, unknown>) : null;
  // The narrowest configuration that names one, so `--config` beats the file on
  // disk here exactly as it does for every other key below. Which layer set it
  // is read by presence and not by truthiness: a `base_ref` an explicit
  // `--config` holds is that layer's answer whatever it holds, including the
  // mistyped answers `requireBase` refuses rather than derives over.
  const setByOverride = asked !== null && "base_ref" in asked;
  const configured = setByOverride ? asked["base_ref"] : repoConfig["base_ref"];
  const base = requireBase(
    resolveBase(run.repository_root, configured, {
      publish: run.publish === true || repoConfig["publish"] === true || asked?.["publish"] === true,
    }),
    {
      repository_root: run.repository_root,
      configPath: setByOverride
        ? "the run configuration passed with --config"
        : join(run.dir, "config.json"),
    },
  );

  return {
    ...derived,
    // A repository that has agreed nothing is still judged by its own suite
    // (SCP-259): the checks its package scripts imply — the set `doctor`
    // proposes, from the same derivation — pinned for this run and marked as
    // derived rather than agreed. Nothing is written; `doctor --write-config`
    // is still the only thing that turns the proposal into a file. An explicit
    // `--config` naming its own checks wins, as it does over a stored file.
    ...(stored === null
      ? {
          checks: proposedChecks(run.repository_root).map((check) => ({
            ...check,
            origin: "proposed",
          })),
        }
      : {}),
    ...repoWithoutDerived,
    ...(explicit as Record<string, unknown> | null),
    // Last, because the base and the source that named it are one answer: a
    // layer that set one of them without the other would leave the run
    // reporting a source for a base it is not using. `base_ref` here is the
    // configured one wherever a layer above named it, so this overrides
    // nothing but its own agreement.
    base_ref: base.base_ref,
    base_ref_origin: base.from,
    // After both files, which cannot name it: the branch the ticket's delivery
    // record names, or none.
    delivery_branch: run.branch ?? null,
  };
}
