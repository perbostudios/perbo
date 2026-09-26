import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AuthoredAttemptSchema,
  DeliveredCheckSchema,
  DeliveryChecksStateSchema,
  DiagnosticFindingSchema,
  GithubCredentialSchema,
  PlanContractSchema,
  SourceContractSchema,
  issueAuthoredAttempts,
  planContractFromSource,
  redactCredentials,
  sourceContractFromArguments,
  sourceContractFromPullRequest,
  sourceIdentity,
  statesCriteria,
  type AuthoredAttempt,
  type PlanContractWithCriteria,
  type SourceContract,
} from "@perbo/contracts";
import { BaseSourceSchema } from "@perbo/runner";
import { replaceFile } from "@perbo/workspace";
import { UsageError } from "../../usage-error.js";
import { readPullRequest } from "../../pull-request.js";
import { headCommit, repositoryId } from "../../store/index.js";
import type { ExecuteArgs } from "./index.js";

/**
 * `perbo run` with nothing admitted behind it (SCP-180).
 *
 * `perbo run --ticket PRB-1` takes its contract from a ticket a person
 * approved, and that is the path the product is built around. This is the same
 * loop with no admission step in front of it: the contract is typed on the
 * command line, or read out of the pull request that already describes the
 * work, and everything after it — the worktree, the executor, the write guard,
 * the seal, the pinned checks, the one independent review, the ceilings — is
 * the ticket path's own code, reached with a contract minted here instead of
 * one loaded from a file somebody approved.
 *
 * Three properties are the point, and each is a decision rather than an
 * accident of reuse:
 *
 * 1. **The contract is minted, never invented.** `planContractFromSource` is
 *    SCP-179's reading, unchanged: what the source stated is what the plan
 *    carries, an outcome with no criteria under it is judged against its
 *    outcome alone, and the allowed globs are the ones typed — `**` where
 *    nobody said, because a scope derived from what the executor happened to
 *    touch would pass by construction.
 * 2. **The run is labelled by where its contract came from.** There is no
 *    ticket key, so nothing invents one: the branch, the seal's commit message
 *    and the attempt-id seed carry `local_<digest>` or `gh_owner_repo_N`, which
 *    is the same identity the plan and every record of the run are keyed by.
 * 3. **The whole record stays in this repository's `.perbo/`.** The attempts,
 *    the bundles, the checks and the review go exactly where a ticket run's go
 *    — the same store, through the same merge of the same repository config —
 *    and the run record below is written beside them so `perbo inspect` can
 *    name a run no ticket file describes. Nothing is sent anywhere.
 */

export const LOCAL_RUN_SCHEMA_VERSION = 1;

/**
 * Why a run stopped before it started, on the record that describes it.
 *
 * The refusal is printed once, as the command ends, and then the terminal is
 * gone. This is the same fact where `inspect` can find it a day later: the
 * diagnostic's findings carried whole, in the words the person was shown,
 * rather than a summary of them.
 */
export const RunRefusalSchema = z.strictObject({
  refused_at: z.iso.datetime(),
  /** The refusal's own sentence: what could not be done, and that nothing ran. */
  reason: z.string().min(1),
  /** The repository the findings are about, which is what `doctor --repo` takes. */
  repository_root: z.string().min(1),
  findings: z.array(DiagnosticFindingSchema),
});
export type RunRefusal = z.infer<typeof RunRefusalSchema>;

/**
 * The pull request a local run opened, on the record that describes it.
 *
 * A ticketed run keeps this on the ticket file, which a run with no ticket does
 * not have; without it the URL exists only in the terminal the run printed it
 * to, and `inspect` — the command that answers what became of a run — cannot
 * name the thing a person now has to act on.
 */
export const RunPullRequestSchema = z.strictObject({
  url: z.url(),
  /** `gh` names it on create; null where its answer carried no number to read. */
  number: z.number().int().positive().nullable(),
  opened_at: z.iso.datetime(),
  /**
   * The checks on the head, as the run read them after opening this. Empty
   * until the read finishes, which is why it is written a second time: the URL
   * goes down the moment the pull request opens, and the checks when they have
   * been read.
   */
  checks: z.array(DeliveredCheckSchema).default([]),
  /** What they add up to. Null while nothing has read them. */
  checks_state: DeliveryChecksStateSchema.nullable().default(null),
  /**
   * SCP-284: what `perbo sync` last read back off this pull request — where
   * a ticketed run keeps the same facts on the ticket's `delivery` record.
   *
   * `null` is "nothing has read it back": a run whose pull request has never
   * been synced, and every record written before these fields existed. It is
   * never the poller's `none` — a `gh` that answers "there is no pull request
   * on that branch" leaves this record alone rather than writing an absence
   * over the URL the run itself published, for the reason `recordDelivery`
   * gives on the ticket path.
   */
  state: z.enum(["open", "merged", "closed"]).nullable().default(null),
  /** When that read happened. Beside the values it dates, never `opened_at`. */
  observed_at: z.iso.datetime().nullable().default(null),
  /** SCP-192: whether GitHub can still merge it, as `gh` last reported. */
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]).nullable().default(null),
  /** SCP-196: whether a commit on it was authored outside the loop. */
  commits_outside_loop: z.boolean().nullable().default(null),
  /** SCP-200: the credential path the read went through. Never the token. */
  github_credential: GithubCredentialSchema.nullable().default(null),
  /**
   * SCP-252: the D-073 review verdicts the pull request's comments carry, as
   * labels — the model, its verdict and the head it named. The comment bodies
   * they were read from are not recorded and never leave, the same rule the
   * ticket path's poller follows.
   *
   * A close is not the whole story about a pull request: one closed over a
   * CHANGES REQUESTED verdict was rejected on its content, and one closed with
   * no verdict on it was simply closed. Both readings need this list.
   */
  review_verdicts: z
    .array(
      z.strictObject({
        model: z.string().min(1),
        verdict: z.string().min(1),
        head: z.string().min(1),
      }),
    )
    .default([]),
});
export type RunPullRequest = z.infer<typeof RunPullRequestSchema>;
/**
 * The same record as the publish writes it: what a run is first-hand about,
 * with everything a later `perbo sync` reads back left to its defaults. The
 * publish knows the URL, the number and the checks it waited for; it does not
 * know what GitHub will say about the pull request afterwards, and this is the
 * shape that lets it say so by omission rather than by writing a guess.
 */
export type RunPullRequestPublished = z.input<typeof RunPullRequestSchema>;

/**
 * The branch a run publishes against, and which source named it, as that run
 * resolved it (SCP-265).
 *
 * On the record because it is a fact about the run and not about the checkout
 * as it stands now: `origin/HEAD` moves, `base_ref` gets edited, and a report
 * read a week later or from another clone would otherwise name a branch this
 * run never published against while sitting beside the pull request it opened.
 */
export const RunBaseSchema = z.strictObject({
  ref: z.string().min(1),
  from: BaseSourceSchema,
});
export type RunBase = z.infer<typeof RunBaseSchema>;

/**
 * What a local run is, on disk: the contract as its source stated it, and the
 * plan minted from it. Written before the loop starts, for the same reason the
 * ticket path moves a ticket to `provisioning` before the attempt — a run that
 * never returns has to leave behind what it was.
 */
export const LocalRunRecordSchema = z.strictObject({
  schema_version: z.literal(LOCAL_RUN_SCHEMA_VERSION),
  /** The plan's `ticket_id`: what the attempts record and every bundle are keyed by. */
  run_id: z.string().min(1),
  /** The label the branch, the commit message and the attempt ids carry. */
  label: z.string().min(1),
  created_at: z.iso.datetime(),
  /** `criteria: []` means the source stated none, and none were invented. */
  source: SourceContractSchema,
  contract: PlanContractSchema,
  /**
   * Lines of the pull request's own text that claim the work is done or address
   * whoever is reading it. On this path a body somebody else wrote becomes the
   * plan, so what it tried is recorded beside the plan it may have aimed at.
   */
  external_text_attempts: z.array(AuthoredAttemptSchema).default([]),
  /**
   * Where this run publishes, resolved before it started. `null` on a record
   * written before runs recorded it, which is read as "this record does not
   * say" — never as a base, because a report that guessed one would be the
   * thing {@link RunBaseSchema} exists to prevent.
   */
  base: RunBaseSchema.nullable().default(null),
  /**
   * Why the run stopped before an attempt existed, where it did. `null` on a
   * record written by a run that started — which is every record at the moment
   * it is first written, because this is filled in by the refusal itself.
   */
  refusal: RunRefusalSchema.nullable().default(null),
  /**
   * The pull request this run opened, written the moment it opened rather than
   * when the run ended — so a run that fell over after publishing still names
   * the pull request somebody has to act on. `null` on a run that published
   * nothing, and on every record at the moment it is first written.
   */
  pull_request: RunPullRequestSchema.nullable().default(null),
});
export type LocalRunRecord = z.infer<typeof LocalRunRecordSchema>;

/** `<store>/runs` — where a run with no ticket describes itself. */
export const runsDir = (storeDirectory: string): string => join(storeDirectory, "runs");

export const localRunPath = (storeDirectory: string, run_id: string): string =>
  join(runsDir(storeDirectory), `${run_id}.run.json`);

/**
 * Write the run record. Redacted as text like every other document minted from
 * repository content (D-063): a pull request body has held a credential before.
 */
export function writeLocalRunRecord(
  storeDirectory: string,
  record: LocalRunRecord,
): { path: string; redactions: number } {
  mkdirSync(runsDir(storeDirectory), { recursive: true });
  const path = localRunPath(storeDirectory, record.run_id);
  const redacted = redactCredentials(JSON.stringify(LocalRunRecordSchema.parse(record), null, 2));
  replaceFile(path, `${redacted.text}\n`);
  return { path, redactions: redacted.count };
}

function parseLocalRunRecord(path: string): LocalRunRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = LocalRunRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${path} is not a readable local run record:\n  ` +
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  ") +
        (parsed.error.issues.length > 5 ? `\n  and ${parsed.error.issues.length - 5} more` : ""),
    );
  }
  return parsed.data;
}

/** The record of a local run, or null when the store holds none under that id. */
export function readLocalRunRecord(storeDirectory: string, run_id: string): LocalRunRecord | null {
  const path = localRunPath(storeDirectory, run_id);
  return existsSync(path) ? parseLocalRunRecord(path) : null;
}

/**
 * Put the refusal on the record the run already wrote about itself, and say
 * where it went. `null` where there is no such record to put it on — a run
 * against an admitted ticket keeps its history in the ticket file, and a
 * refusal is not a reason to mint a second kind of record beside it.
 */
export function recordRunRefusal(
  storeDirectory: string,
  run_id: string,
  refusal: RunRefusal,
): string | null {
  const record = readLocalRunRecord(storeDirectory, run_id);
  if (record === null) return null;
  return writeLocalRunRecord(storeDirectory, { ...record, refusal }).path;
}

/**
 * Put the pull request on the record the run already wrote about itself, and
 * say where it went. `null` where there is no such record — a run against an
 * admitted ticket keeps its delivery on the ticket file.
 */
export function recordRunPullRequest(
  storeDirectory: string,
  run_id: string,
  pull_request: RunPullRequestPublished,
): string | null {
  const record = readLocalRunRecord(storeDirectory, run_id);
  if (record === null) return null;
  return writeLocalRunRecord(storeDirectory, {
    ...record,
    pull_request: RunPullRequestSchema.parse(pull_request),
  }).path;
}

/**
 * Every local run this store holds a record for, oldest first. A file that is
 * not one is stepped over rather than taking the listing with it — the same
 * rule the ticket store reads by.
 */
export function listLocalRuns(storeDirectory: string): LocalRunRecord[] {
  const dir = runsDir(storeDirectory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".run.json"))
    .flatMap((name) => {
      try {
        return [parseLocalRunRecord(join(dir, name))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Whether these arguments ask for a run with no ticket and no contract file. */
export const isLocalRunArgs = (args: ExecuteArgs): boolean =>
  args.pr !== null || args.outcome !== null || args.criteria.length > 0 || args.paths.length > 0;

/**
 * Refuse the combinations that would run against a contract nobody wrote.
 *
 * A contract comes from exactly one source. `--criterion` typed beside a pull
 * request that states its own would be neither the author's nor yours, and an
 * `--outcome` typed beside one would run, under that pull request's name,
 * something it does not describe.
 */
export function assertLocalRunArgs(args: ExecuteArgs): void {
  for (const [flag, value] of [
    ["--ticket", args.ticket],
    ["--contract", args.contract],
  ] as const) {
    if (value !== null) {
      throw new UsageError(
        `${flag} already owns its contract; --outcome, --criterion, --path and --pr mint one ` +
          "for a run with nothing admitted behind it. Use one or the other",
      );
    }
  }
  if (args.pr !== null && args.outcome !== null) {
    throw new UsageError(
      "--pr and --outcome are alternatives: a contract comes from one source, and an outcome " +
        "typed beside a pull request would run under its name something it does not describe",
    );
  }
  if (args.outcome === null && args.criteria.length > 0) {
    throw new UsageError(
      "--criterion needs --outcome: a contract comes from one source, so criteria typed beside " +
        "a pull request that states its own would be neither the author's nor yours",
    );
  }
  if (args.outcome === null && args.pr === null) {
    throw new UsageError(
      "--path says what a change may touch; it does not say what the change is. Add " +
        '--outcome "..." , or --pr <owner/repo#N> to take the plan from a pull request',
    );
  }
}

export interface LocalPlan {
  /** What the source stated, with its provenance. Never widened. */
  source: SourceContract;
  /** The plan the loop runs on, minted from it. */
  contract: PlanContractWithCriteria;
  /** `local_<digest>` or `gh_owner_repo_N`: what labels the run. */
  label: string;
  external_text_attempts: AuthoredAttempt[];
}

export interface MintInput {
  args: ExecuteArgs;
  /** The resolved checkout the run executes in. */
  repositoryRoot: string;
  now: Date;
  /** The `gh` a `--pr` is read with. Production leaves it unset. */
  gh?: { binary?: string | undefined } | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * The contract this run is bound to, from whichever source was named.
 *
 * The base commit is this checkout's HEAD, not the pull request's: `--pr`
 * supplies the *plan*, and the work is done here. Reading it the other way
 * would provision a worktree at a commit this repository may not even hold.
 */
export async function mintLocalPlan(input: MintInput): Promise<LocalPlan> {
  const { args } = input;
  const pull = args.pr
    ? await readPullRequest(args.pr, {
        ...(input.gh?.binary ? { binary: input.gh.binary } : {}),
        cwd: input.repositoryRoot,
      })
    : null;
  if (pull) input.onProgress?.(`read ${pull.reference}: ${pull.title}`);

  const source = pull
    ? sourceContractFromPullRequest({
        reference: pull.reference,
        title: pull.title,
        body: pull.body,
        url: pull.url,
      })
    : sourceContractFromArguments({ outcome: args.outcome!, criteria: args.criteria });

  const contract = planContractFromSource({
    contract: source,
    base_commit: headCommit(input.repositoryRoot),
    repository_id: repositoryId(input.repositoryRoot),
    paths_allowed: args.paths.length > 0 ? args.paths : ["**"],
    captured_at: input.now,
  });

  // The pull request's text is the one place external prose becomes the plan.
  // What in it addressed the reader is reported, never removed: the executor
  // still works to the contract, and a person reading the record sees what the
  // text tried.
  const external = pull
    ? issueAuthoredAttempts([
        { text: pull.title, firstLine: 1 },
        { text: pull.body, firstLine: 2 },
      ])
    : { attempts: [], found: 0 };

  return {
    source,
    contract,
    label: sourceIdentity(source),
    external_text_attempts: external.attempts,
  };
}

export { statesCriteria };
