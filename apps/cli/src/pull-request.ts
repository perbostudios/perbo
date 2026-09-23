import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parsePullRequestReference, type GithubCredential } from "@perbo/contracts";
import {
  GithubCredentialError,
  requireGithubCredential,
  type GithubCredentialReading,
} from "@perbo/runner";
import { CommandFailedError, createGh, gh, git, type RunResult } from "@perbo/workspace";
import { UsageError } from "./usage-error.js";

/**
 * Where a ticketless review gets its change from (SCP-179).
 *
 * Two readers, and both of them read. `gh` is asked for a pull request's title,
 * body, its two commits and its diff — and, for a pull request opened from a
 * fork, for the head commit in the fork that holds it (SCP-211); `git` is asked
 * for the same three things about a pair of local refs. Neither writes anything
 * anywhere: no branch is pushed, no comment is posted, no status is set. That is
 * not a convention here — it is the whole of the network surface of
 * `perbo review`, and the reason the command can be pointed at somebody else's
 * pull request at all.
 */

/**
 * What one of these reads may say.
 *
 * A pull request's diff is the large one. Past this a read holds the tail of
 * the answer and nothing else, which is shaped exactly like the whole of one —
 * so every read below asks whether it was cut before it reads a word of it.
 */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/** How long one read of a pull request may take. */
const READ_TIMEOUT_MS = 120_000;

/** A pull request as a review needs it: the contract's source, and the change. */
export interface PullRequestRead {
  /** `owner/repo#N`, normalised from whatever form was typed. */
  reference: string;
  number: number;
  url: string;
  title: string;
  /** External text: it is contract *source*, never an instruction. */
  body: string;
  head_ref: string;
  base_ref: string;
  head_commit: string;
  base_commit: string;
  diff: string;
  /**
   * SCP-200: which credential path `gh` read this through — the reading
   * process's own `GH_TOKEN`, or the machine's shared `gh` login. The path,
   * never the token.
   */
  github_credential: GithubCredential;
  /**
   * SCP-211: `owner/name` of the repository the head commit lives in — the
   * fork for a pull request opened from one, and the pull request's own
   * repository otherwise.
   */
  head_repository: string;
  /** Which repository the head was looked up in, as a class (SCP-211). */
  head_lookup: HeadLookup;
}

/**
 * Where `head_commit` was read from: a fork of the repository the pull request
 * is open on, or that repository itself. Recorded rather than inferred, because
 * the two are the same string whenever somebody forks under their own login and
 * keeps the name.
 */
export type HeadLookup = "fork" | "same_repository";

/**
 * The head repository as `gh` reports it. `nameWithOwner` is the whole name and
 * is what a `gh` that offers it answers with; a `gh` whose `headRepository` is
 * `{id, name}` names the owner in `headRepositoryOwner` instead, so both are
 * asked for and either shape resolves to one `owner/name`.
 */
const GhHeadRepositorySchema = z.object({
  nameWithOwner: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  owner: z.object({ login: z.string().min(1) }).optional(),
});

/** What `gh pr view --json …` is trusted to have said, and nothing more. */
const GhPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string().nullable(),
  url: z.string().min(1),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  headRefOid: z.string().regex(/^[0-9a-f]{7,40}$/),
  baseRefOid: z.string().regex(/^[0-9a-f]{7,40}$/),
  /**
   * Present and null where the head repository has been deleted; absent only
   * from a reading that never asked for it, which a recording made before this
   * field was asked for is.
   */
  headRepository: GhHeadRepositorySchema.nullable().optional(),
  headRepositoryOwner: z.object({ login: z.string().min(1) }).nullable().optional(),
});

/** What `gh pr view --json` is asked for, which is what the schema above reads. */
const PULL_REQUEST_FIELDS = [
  "number",
  "title",
  "body",
  "url",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "baseRefOid",
  "headRepository",
  "headRepositoryOwner",
] as const;

/**
 * `owner/name` of the head repository, and whether `gh` reported one at all.
 *
 * `deleted` is the case GitHub answers with a null `headRepository`: the fork a
 * pull request was opened from is gone, and with it the only place its head
 * commit could be fetched. `repository: null` with `deleted: false` is a `gh`
 * that answered nothing this can read — an older one, or a recording made
 * before the field was asked for — and there the pull request's own repository
 * is the head, which is what this command assumed before SCP-211.
 */
function reportedHeadRepository(view: z.infer<typeof GhPullRequestSchema>): {
  repository: string | null;
  deleted: boolean;
} {
  if (view.headRepository === null) return { repository: null, deleted: true };
  const head = view.headRepository;
  if (head === undefined) return { repository: null, deleted: false };
  if (head.nameWithOwner) return { repository: head.nameWithOwner, deleted: false };
  const owner = head.owner?.login ?? view.headRepositoryOwner?.login ?? null;
  return {
    repository: owner && head.name ? `${owner}/${head.name}` : null,
    deleted: false,
  };
}

/** GitHub's owner and repository names differ in case and not in identity. */
function sameRepository(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

const PR_URL = /^https?:\/\/[^/]+\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/;

/**
 * `owner/repo#412` or the URL a person copies out of the address bar, which is
 * the form they have in hand when they want this command.
 */
export function normalisePullRequestReference(reference: string): {
  reference: string;
  owner: string;
  repo: string;
  number: number;
} {
  const direct = parsePullRequestReference(reference);
  if (direct) return { reference, ...direct };
  const url = PR_URL.exec(reference.trim());
  if (url) {
    const [, owner, repo, number] = url;
    return {
      reference: `${owner}/${repo}#${number}`,
      owner: owner!,
      repo: repo!,
      number: Number(number),
    };
  }
  throw new UsageError(
    `--pr must name a pull request as owner/repo#412 or its URL. Got '${reference}'`,
  );
}

/** A missing binary, which `describeFailure` prints with its install line. */
function isMissingBinary(error: unknown): boolean {
  const failure = error as { code?: unknown; syscall?: unknown };
  return failure.code === "ENOENT" && typeof failure.syscall === "string";
}

/** The one line of a `gh` that never started worth putting in front of a person. */
function ghReason(error: unknown): string {
  const failure = error as { message?: string };
  return (failure.message ?? String(error)).split("\n")[0] || "unknown failure";
}

/** The same for a `gh` that ran and refused, which says why on its own stderr. */
function ghSaid(result: RunResult): string {
  return (
    result.stderr.trim().split("\n")[0] ||
    new CommandFailedError(result).message.split("\n")[0] ||
    "unknown failure"
  );
}

function ghFailure(reference: string, what: string, reason: string): Error {
  return new UsageError(
    `gh could not read ${what} of ${reference}: ${reason}. ` +
      "Run `gh auth login` if it is a credential, or check the reference.",
  );
}

/**
 * What `gh` said, where it said all of it.
 *
 * An answer past the ceiling arrives as its own tail: the pull request's JSON
 * would fail to parse for a reason that is not the one, and a diff would be
 * reviewed as though the hunks cut out of it were never in the change. Neither
 * is a reading anything may act on, so both are refused here rather than read.
 */
function whole(result: RunResult, reference: string, what: string): string {
  if (result.truncated) {
    throw new UsageError(
      `gh said more about ${what} of ${reference} than this read holds ` +
        `(${MAX_ANSWER_BYTES} bytes), and only the tail of it arrived. Nothing was reviewed.`,
    );
  }
  if (result.code !== 0) throw ghFailure(reference, what, ghSaid(result));
  return result.stdout;
}

export interface GhOptions {
  binary?: string | undefined;
  timeoutMs?: number | undefined;
  /** Where `gh` runs. Irrelevant to the read — the repository is an argument. */
  cwd?: string | undefined;
}

/**
 * Read one pull request through the locally installed `gh`, with the user's own
 * credential (D-009: Perbo never holds one). Argv only, and both calls are
 * `view` and `diff` — there is no `gh` subcommand here that changes anything.
 */
export async function readPullRequest(
  reference: string,
  options: GhOptions = {},
): Promise<PullRequestRead> {
  const target = normalisePullRequestReference(reference);
  const binary = options.binary ?? "gh";
  const repo = `${target.owner}/${target.repo}`;

  // SCP-200: which credential this read goes through, decided before it goes.
  // The whole network surface of `perbo review` is the two reads below, so a
  // machine with neither a token nor a login is told so in those words rather
  // than through whatever `gh pr view` prints about it on the day.
  let credential: GithubCredentialReading;
  try {
    credential = requireGithubCredential({
      binary,
      what: `there is no credential to read ${target.reference} through`,
    });
  } catch (error) {
    if (!(error instanceof GithubCredentialError)) throw error;
    throw new UsageError(error.message, { cause: error });
  }
  const reader = createGh({ binary });
  const cwd = options.cwd ?? process.cwd();
  const call = {
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    maxOutputBytes: MAX_ANSWER_BYTES,
  };

  let view: RunResult;
  try {
    view = await reader.viewPullRequest(cwd, String(target.number), PULL_REQUEST_FIELDS, {
      repo,
      ...call,
    });
  } catch (error) {
    // A missing binary is described by `describeFailure` with its install
    // line; it reaches there as itself rather than wrapped in a message.
    if (isMissingBinary(error)) throw error as Error;
    throw ghFailure(target.reference, "the pull request", ghReason(error));
  }
  const viewed = whole(view, target.reference, "the pull request");

  let raw: unknown;
  try {
    raw = JSON.parse(viewed);
  } catch (error) {
    throw new UsageError(`gh did not return JSON for ${target.reference}`, { cause: error });
  }
  const parsed = GhPullRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `gh returned something that is not a pull request for ${target.reference}: ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
    );
  }

  // SCP-211: a pull request from a fork has its head commit in the fork, and
  // the base repository is not where it can be asked for. The head repository
  // `gh` named is where it is fetched from, and a fork that cannot answer for
  // it is named here — before the diff is read and long before a reviewer is
  // paid — rather than leaving a review pinned to a commit nobody can get.
  const reported = reportedHeadRepository(parsed.data);
  if (reported.deleted) {
    throw new UsageError(
      `the head of ${target.reference} is in a fork that no longer exists: gh reports no head ` +
        `repository for it, so commit ${parsed.data.headRefOid} cannot be fetched from anywhere. ` +
        "Nothing was reviewed.",
    );
  }
  const head_repository = reported.repository ?? repo;
  const head_lookup: HeadLookup = sameRepository(head_repository, repo)
    ? "same_repository"
    : "fork";
  if (head_lookup === "fork") {
    const unreachable = (said: string): UsageError =>
      new UsageError(
        `${target.reference} is opened from the fork ${head_repository}, and gh could not fetch ` +
          `its head commit ${parsed.data.headRefOid} from ${head_repository}: ${said}. ` +
          "The fork may be private or deleted, or its branch force-pushed past this commit. " +
          "Nothing was reviewed.",
      );
    // A GET: the exit status is the answer, so the commit's own JSON — which
    // carries every file it touched — is never read into this process.
    let fetched: RunResult;
    try {
      fetched = await reader.api(cwd, `repos/${head_repository}/commits/${parsed.data.headRefOid}`, {
        silent: true,
        ...call,
      });
    } catch (error) {
      if (isMissingBinary(error)) throw error as Error;
      throw unreachable(ghReason(error));
    }
    if (fetched.code !== 0) throw unreachable(ghSaid(fetched));
  }

  let read: RunResult;
  try {
    read = await reader.run(cwd, ["pr", "diff", String(target.number), "--repo", repo], call);
  } catch (error) {
    if (isMissingBinary(error)) throw error as Error;
    throw ghFailure(target.reference, "the diff", ghReason(error));
  }
  const diff = whole(read, target.reference, "the diff");

  return {
    reference: target.reference,
    number: parsed.data.number,
    url: parsed.data.url,
    title: parsed.data.title,
    body: parsed.data.body ?? "",
    head_ref: parsed.data.headRefName,
    base_ref: parsed.data.baseRefName,
    head_commit: parsed.data.headRefOid,
    base_commit: parsed.data.baseRefOid,
    diff,
    github_credential: credential.credential,
    head_repository,
    head_lookup,
  };
}

export interface RefRangeRead {
  head_ref: string;
  base_ref: string;
  head_commit: string;
  base_commit: string;
  /** Whether `base_commit` is the merge base rather than the base ref itself. */
  merge_base: boolean;
  diff: string;
}

function resolveCommit(ref: string, repo: string): string {
  let found: string | null = null;
  try {
    found = git.resolveCommitSync(repo, ref);
  } catch {
    // A ref git would read as an option, a read that did not finish, or no
    // git here at all. None of those is this ref resolving, and the line below
    // is the one a person can act on.
  }
  if (found !== null) return found;
  throw new UsageError(
    `'${ref}' does not name a commit in ${repo}. Fetch it first, or name a ref that is there.`,
  );
}

/**
 * The change between two local refs, as the pull request would show it: from
 * where the branches diverged, not from wherever `base` has since moved to.
 * Unrelated histories have no merge base, and there the two-dot range is the
 * only defined answer — the read says which one it took rather than quietly
 * comparing something else.
 */
export function readRefRange(input: { repo: string; head: string; base: string }): RefRangeRead {
  const head_commit = resolveCommit(input.head, input.repo);
  const baseRefCommit = resolveCommit(input.base, input.repo);

  let base_commit = baseRefCommit;
  let merge_base = false;
  try {
    const found = git.mergeBaseSync(input.repo, baseRefCommit, head_commit);
    if (found !== null) {
      base_commit = found;
      merge_base = true;
    }
  } catch {
    // No common ancestor, or a read that did not finish. `base_commit` stays
    // the base ref's own commit and the range below is the two-dot one.
  }

  const change = git.runSync(input.repo, ["diff", "--no-color", base_commit, head_commit], {
    maxOutputBytes: MAX_ANSWER_BYTES,
  });
  // A diff past the ceiling arrives as its own tail, which is a change set
  // missing whatever came before the cut — and a review of it would judge a
  // contract against hunks nobody chose.
  if (change.truncated) {
    throw new UsageError(
      `the change between ${input.base} and ${input.head} in ${input.repo} is larger than this ` +
        `read holds (${MAX_ANSWER_BYTES} bytes), and only the tail of it arrived. Nothing was ` +
        "reviewed.",
    );
  }
  if (change.code !== 0) throw new CommandFailedError(change);

  return {
    head_ref: input.head,
    base_ref: input.base,
    head_commit,
    base_commit,
    merge_base,
    diff: change.stdout,
  };
}

/**
 * What a GitHub Actions workflow file says it triggers on (SCP-279).
 *
 * Only the top-level `on:` key is read, and only the event names under it. This
 * is not a YAML parser and does not pretend to be one: this workspace's
 * lockfile carries no YAML library, and the question here is answerable from
 * the one key whose three legal spellings are written down below. Anything this
 * cannot read comes back as `null` — "this file did not say" — which every
 * caller must treat as *unknown* rather than as "no". A repository is only ever
 * reported as running nothing on pull requests from files this could read.
 *
 * The three spellings, all of which occur in the wild:
 *
 * ```yaml
 * on: pull_request                 # one event
 * on: [push, pull_request]         # a flow sequence
 * "on":                            # a block, quoted because YAML 1.1 reads a
 *   pull_request:                  # bare `on` as a boolean and linters say so
 *     branches: [main]
 * ```
 */

/** The events GitHub raises for a pull request, both of them. */
export const PULL_REQUEST_EVENTS = ["pull_request", "pull_request_target"] as const;

/** The top-level key, in each spelling a workflow file may use for it. */
const ON_KEY = /^(?:on|"on"|'on')\s*:(.*)$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A scalar as the block wrote it: without its quotes, lowercased, trimmed. */
const eventName = (value: string): string =>
  value.trim().replace(/^(['"])(.*)\1$/, "$2").trim().toLowerCase();

/**
 * One line without its comment.
 *
 * YAML begins a comment at a `#` that starts the line or follows whitespace,
 * and never inside a quoted scalar — so the quotes are tracked rather than the
 * `#` alone, which would truncate `on: ["push"] # a "#" here` at the wrong one.
 */
function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (at === 0 || /\s/.test(line[at - 1]!))) return line.slice(0, at);
  }
  return line;
}

/** The events of an `on:` written on its own line: one scalar or a flow sequence. */
function inlineEvents(value: string): string[] {
  const flow = /^\[(.*)\]$/.exec(value);
  const items = flow ? flow[1]!.split(",") : [value];
  return items.map(eventName).filter((event) => event.length > 0);
}

/**
 * The events of an `on:` block, which is either a sequence of names or a
 * mapping from a name to its filters.
 *
 * The block ends at the next key of the document — the next non-empty line
 * indented no further than `on:` itself was. Inside it, only the lines at the
 * block's own indentation are events; anything deeper is one event's `branches`,
 * `paths` or `types`, and reading those as events is how a workflow that runs
 * only on a push to a branch called `pull_request` would be misread.
 */
function blockEvents(lines: readonly string[], under: number): string[] {
  const block: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (indentOf(line) <= under) break;
    block.push(line);
  }
  if (block.length === 0) return [];
  const base = Math.min(...block.map(indentOf));
  const events: string[] = [];
  for (const line of block) {
    if (indentOf(line) !== base) continue;
    const item = /^-\s*(.*)$/.exec(line.trim());
    if (item) {
      // A sequence entry: `- pull_request`, or `- pull_request:` where the
      // entry carries filters of its own.
      const named = item[1]!.replace(/:.*$/, "");
      if (named.trim() !== "") events.push(eventName(named));
      continue;
    }
    const key = /^([^:]+):/.exec(line.trim());
    if (key) events.push(eventName(key[1]!));
  }
  return events.filter((event) => event.length > 0);
}

/**
 * Every event the workflow's top-level `on:` names, or `null` where the file
 * carries no `on:` key this can read.
 */
export function workflowEvents(source: string): string[] | null {
  const lines = source.split(/\r?\n/).map(withoutComment);
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.trim() === "" || indentOf(line) !== 0) continue;
    const key = ON_KEY.exec(line);
    if (key === null) continue;
    const inline = key[1]!.trim();
    return inline === "" ? blockEvents(lines.slice(at + 1), 0) : inlineEvents(inline);
  }
  return null;
}

/**
 * Whether this workflow runs on a pull request. `null` where the file did not
 * say, which is not the same answer as `false`.
 */
export function triggersOnPullRequest(source: string): boolean | null {
  const events = workflowEvents(source);
  if (events === null) return null;
  return events.some((event) => (PULL_REQUEST_EVENTS as readonly string[]).includes(event));
}

/**
 * Whether a repository runs anything on a pull request at all (SCP-279).
 *
 * Three sources, because GitHub has three: a workflow file **on the ref the
 * pull request will carry** whose `on:` names a pull request, a workflow GitHub
 * has registered for this repository, and a status check the base branch
 * requires — through classic branch protection or through a ruleset. A
 * repository with none of them runs nothing on a pull request, and a delivery
 * read that waits fifteen minutes for its checks is waiting for something that
 * was never going to arrive.
 *
 * The ref matters and the working tree does not. GitHub runs the `pull_request`
 * workflows that are **in the branch under test**, so the question is what the
 * head will hold — and the head is the base ref plus the run's own commits,
 * which the seal refuses to let touch `.github/**` at all (`POLICY_PATTERNS`).
 * Reading the person's working tree instead would answer for whatever they have
 * checked out and edited today, which is not the branch anything will run on.
 *
 * Everything here is read — through `gh` and through `git ls-tree`, both in the
 * caller's own working directory — and nothing here writes: the same posture as
 * the two reads above. The one property every caller depends on: this answers
 * `runs_checks: false` **only** when `gh` answered both of its questions. A `gh`
 * that is missing, unauthenticated, rate-limited or refused leaves
 * `answered: false`, and a caller that could not tell that from "no checks"
 * would turn an outage into a green-looking delivery.
 */

/** The default ceiling on one `gh` call here. */
const CHECKS_TIMEOUT_MS = 30_000;

/**
 * What one read of what a repository runs may say.
 *
 * Every one of them is a list or a JSON body that is parsed, so an answer past
 * this is refused rather than read: a reading is only allowed to say "nothing
 * runs on a pull request here" when `gh` answered both of its questions whole.
 */
const MAX_CHECKS_BYTES = 512 * 1024;

/** One workflow this repository would run on a pull request. */
export interface PullRequestWorkflow {
  /** The workflow's name, as `gh` lists it. */
  name: string;
  /** Its file, relative to the repository root. */
  path: string;
  /** Every event its top-level `on:` names, not only the pull-request ones. */
  events: string[];
}

/** What this repository runs on a pull request, as `gh` reports it. */
export interface PullRequestChecks {
  /**
   * Whether `gh` answered both questions. False leaves every other field a
   * partial reading: it is what was learned, not what is true.
   */
  answered: boolean;
  /**
   * Whether anything runs on a pull request here. Only meaningful where
   * {@link PullRequestChecks.answered} is true.
   */
  runs_checks: boolean;
  /** The workflows that trigger on a pull request. */
  workflows: PullRequestWorkflow[];
  /** How many workflows this reading considered, pull-request or not. */
  workflows_seen: number;
  /**
   * The ref the workflow files were read at, where one could be read. Null is a
   * reading taken from the checkout's working tree, which is what a directory
   * that is not a repository — or one where the ref is not there — leaves.
   */
  workflows_ref: string | null;
  /** The status checks the base branch requires, by context. */
  required_checks: string[];
  /** The base branch the required checks were read against, where one was named. */
  base_ref: string | null;
  /** Why `gh` could not answer, where it could not. Empty otherwise. */
  detail: string;
}

export interface PullRequestChecksRequest {
  /** The checkout `gh` is asked from, and whose Git objects the ref is read from. */
  worktree: string;
  /**
   * The branch a pull request here would target. Null reads the workflows and
   * leaves the reading `answered: false`: half the question is what that branch
   * requires, and a reading that never asked it cannot say "nothing runs".
   */
  base_ref?: string | null;
  /**
   * The ref whose `.github/workflows` the head will carry — `base_ref` for a
   * run that branches from it. Null, or a ref this checkout does not have,
   * falls back to the working tree.
   */
  ref?: string | null;
  timeoutMs?: number;
}

/**
 * A reading of a repository nobody asked: every field empty, `answered: false`,
 * and `detail` saying why the question was not put. It is the same shape a `gh`
 * that would not answer produces, and every caller already treats it the same
 * way — as *unknown*, never as "no".
 */
export function unaskedPullRequestChecks(
  base_ref: string | null,
  detail: string,
): PullRequestChecks {
  return {
    answered: false,
    runs_checks: false,
    workflows: [],
    workflows_seen: 0,
    workflows_ref: null,
    required_checks: [],
    base_ref,
    detail,
  };
}

/** One `gh` read. Null where it could not be started at all. */
async function ask(call: () => Promise<RunResult>): Promise<RunResult | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

/**
 * Whether a failed `gh api` call failed because the resource is not there.
 *
 * A branch with no protection answers 404, and that is an answer: nothing is
 * required. Every other failure — 403 on a repository the credential cannot
 * read protection for, a rate limit, a network error — is not.
 */
const notFound = (result: RunResult): boolean => /HTTP 404|Not Found/i.test(result.stderr);

/** How `gh workflow list --json state` spells a workflow that would run. */
const ACTIVE = "active";

interface ListedWorkflow {
  name?: string;
  path?: string;
  state?: string;
}

/**
 * Where GitHub looks for workflows: files directly under `.github/workflows`,
 * and no deeper. A `.yml` in a subdirectory of it is not a workflow.
 */
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

/**
 * Every workflow file at one ref, by path, read out of this repository's own
 * objects.
 *
 * Null where the ref could not be read at all — the directory is not a
 * repository, or it does not have that ref — which is the one case that falls
 * back to the working tree. An empty map is an answer: that ref carries no
 * workflow.
 */
function workflowsAtRef(ref: string, worktree: string): Map<string, string> | null {
  /**
   * One read of this checkout's objects, or null where it did not answer.
   *
   * A listing or a file cut at the ceiling is null too: the reading would
   * otherwise miss a workflow, or read a workflow's `on:` out of half its
   * source, and either one reports a repository as running nothing on a pull
   * request when it runs something.
   */
  const read = (args: string[]): string | null => {
    let result: RunResult;
    try {
      result = git.runSync(worktree, args, { maxOutputBytes: MAX_ANSWER_BYTES });
    } catch {
      return null;
    }
    return result.code === 0 && !result.truncated ? result.stdout : null;
  };
  // `:(top)` resolves the pathspec against the repository root rather than
  // against the directory `git` was run in — a checkout that is one package
  // of a monorepo would otherwise be asked about its own `.github`, which is
  // not where GitHub looks for a workflow.
  const listed = read([
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    `${ref}^{tree}`,
    "--",
    ":(top).github/workflows/",
  ]);
  if (listed === null) return null;
  const found = new Map<string, string>();
  for (const path of listed.split("\0")) {
    if (!WORKFLOW_FILE.test(path)) continue;
    const source = read(["show", `${ref}:${path}`]);
    // One file of the ref that will not come out of the object store. The
    // reading cannot say what that workflow triggers on, and saying "no" for
    // a file it could not read is exactly the mistake this must not make.
    if (source === null) return null;
    found.set(path, source);
  }
  return found;
}

/**
 * The workflow's file: from the ref the head will carry where that ref has it,
 * from the checkout's working tree where there is no such ref, and from GitHub
 * where neither has it.
 *
 * A workflow `gh` lists whose file is in neither — one an organisation added,
 * one that lives on another branch — is fetched, because "it is not in this
 * tree" is not evidence that it does not run.
 */
async function workflowSource(
  path: string,
  request: {
    worktree: string;
    timeoutMs: number;
    /** The ref's own workflow files, where the ref could be read. */
    atRef: Map<string, string> | null;
  },
): Promise<string | null> {
  const committed = request.atRef?.get(path);
  if (committed !== undefined) return committed;
  if (request.atRef === null) {
    try {
      return readFileSync(join(request.worktree, path), "utf8");
    } catch {
      // Not in this checkout either; ask GitHub for it.
    }
  }
  const fetched = await ask(() =>
    gh.api(request.worktree, `repos/{owner}/{repo}/contents/${path}`, {
      accept: "application/vnd.github.raw",
      timeoutMs: request.timeoutMs,
      maxOutputBytes: MAX_CHECKS_BYTES,
    }),
  );
  // A source cut at the ceiling declares whatever `on:` survived the cut,
  // which is the one answer this must never give.
  if (fetched === null || fetched.code !== 0 || fetched.truncated) return null;
  return fetched.stdout;
}

/** The contexts a `required_status_checks` ruleset names. */
function rulesetContexts(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const contexts: string[] = [];
  for (const rule of payload) {
    if (rule === null || typeof rule !== "object") continue;
    const entry = rule as { type?: unknown; parameters?: unknown };
    if (entry.type !== "required_status_checks") continue;
    const parameters = entry.parameters as { required_status_checks?: unknown } | undefined;
    const required = parameters?.required_status_checks;
    if (!Array.isArray(required)) continue;
    for (const check of required) {
      const context = (check as { context?: unknown })?.context;
      if (typeof context === "string" && context.length > 0) contexts.push(context);
    }
  }
  return contexts;
}

/** The contexts classic branch protection requires. */
function protectionContexts(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const entry = payload as { contexts?: unknown; checks?: unknown };
  const contexts = Array.isArray(entry.contexts)
    ? entry.contexts.filter((context): context is string => typeof context === "string")
    : [];
  const checks = Array.isArray(entry.checks)
    ? entry.checks
        .map((check) => (check as { context?: unknown })?.context)
        .filter((context): context is string => typeof context === "string")
    : [];
  return [...new Set([...contexts, ...checks])];
}

/**
 * The branch as an API path segment. A branch name may hold a `/`, which is a
 * path separator to the endpoint and not part of the name.
 */
const segment = (ref: string): string => encodeURIComponent(ref.replace(/^refs\/heads\//, ""));

/**
 * What this repository runs on a pull request against `base_ref`.
 *
 * Three network reads at most: the workflow list, any listed workflow whose
 * file is in neither the ref nor the checkout (usually none), and the base
 * branch's required checks from both the ruleset and the classic-protection
 * endpoint. The workflow files themselves come out of this repository's own
 * objects at {@link PullRequestChecksRequest.ref}, which costs no call at all.
 */
export async function readPullRequestChecks(
  request: PullRequestChecksRequest,
): Promise<PullRequestChecks> {
  const base = request.base_ref ?? null;
  const ref = request.ref ?? null;
  // The workflows the head will carry, out of the object store. Null where
  // there is no such ref here, and there the working tree is the fallback.
  const atRef = ref === null ? null : workflowsAtRef(ref, request.worktree);
  const options = {
    worktree: request.worktree,
    timeoutMs: request.timeoutMs ?? CHECKS_TIMEOUT_MS,
    atRef,
  };
  const call = { timeoutMs: options.timeoutMs, maxOutputBytes: MAX_CHECKS_BYTES };
  const unanswered = (detail: string): PullRequestChecks => ({
    ...unaskedPullRequestChecks(base, detail),
    workflows_ref: atRef === null ? null : ref,
  });

  const listed = await ask(() =>
    gh.run(options.worktree, ["workflow", "list", "--all", "--json", "name,path,state"], call),
  );
  if (listed === null) return unanswered("`gh` could not be run in this checkout");
  if (listed.code !== 0) {
    return unanswered(
      `\`gh workflow list\` failed: ${(listed.stderr || listed.stdout).trim().slice(-200)}`,
    );
  }
  // A listing past what this read holds arrives as its own tail, which is
  // JSON that will not parse — and what went wrong is the size of the answer
  // rather than anything `gh` wrote.
  if (listed.truncated) {
    return unanswered("`gh workflow list` said more than this read holds, and only the tail arrived");
  }
  let workflows: ListedWorkflow[];
  // `gh workflow list --all` prints nothing where there is nothing to list,
  // rather than the `[]` it prints without `--all`. Empty stdout at exit 0 is
  // an answer — this repository has no workflow — and not a read that failed.
  if (listed.stdout.trim() === "") {
    workflows = [];
  } else {
    try {
      const parsed: unknown = JSON.parse(listed.stdout);
      if (!Array.isArray(parsed)) return unanswered("`gh workflow list` did not answer with a list");
      workflows = parsed as ListedWorkflow[];
    } catch {
      return unanswered("`gh workflow list` did not answer with JSON");
    }
  }

  const active = workflows.filter(
    (workflow) =>
      typeof workflow.path === "string" &&
      workflow.path.length > 0 &&
      (workflow.state ?? ACTIVE).toLowerCase() === ACTIVE,
  );
  // Every workflow either source knows about. The ref's own files are in it
  // whether or not GitHub has registered them: a branch that carries the
  // repository's first `pull_request` workflow runs it on the pull request
  // that introduces it, and `gh workflow list` has never heard of it.
  const named = new Map<string, string>();
  for (const path of atRef?.keys() ?? []) named.set(path, path);
  for (const workflow of active) named.set(workflow.path!, workflow.name ?? workflow.path!);

  const triggered: PullRequestWorkflow[] = [];
  for (const [path, name] of named) {
    const source = await workflowSource(path, options);
    if (source === null) return unanswered(`the definition of ${path} could not be read`);
    const triggers = triggersOnPullRequest(source);
    if (triggers === null) return unanswered(`${path} declares no \`on:\` this could read`);
    if (triggers) {
      triggered.push({ name, path, events: workflowEvents(source) ?? [] });
    }
  }

  const required: string[] = [];
  if (base !== null) {
    // Both mechanisms, because either alone can be the only one in force: a
    // repository governed by rulesets answers 404 on the protection endpoint,
    // and one governed by classic protection carries no ruleset.
    const rules = await ask(() =>
      gh.api(options.worktree, `repos/{owner}/{repo}/rules/branches/${segment(base)}`, call),
    );
    if (rules === null) return unanswered("`gh` could not be run in this checkout");
    if (rules.truncated) {
      return unanswered(`the rules on ${base} said more than this read holds, and only the tail arrived`);
    }
    if (rules.code === 0) {
      try {
        required.push(...rulesetContexts(JSON.parse(rules.stdout)));
      } catch {
        return unanswered("the branch's rules did not answer with JSON");
      }
    } else if (!notFound(rules)) {
      return unanswered(`the rules on ${base} could not be read: ${rules.stderr.trim().slice(-200)}`);
    }

    const protection = await ask(() =>
      gh.api(
        options.worktree,
        `repos/{owner}/{repo}/branches/${segment(base)}/protection/required_status_checks`,
        call,
      ),
    );
    if (protection === null) return unanswered("`gh` could not be run in this checkout");
    if (protection.truncated) {
      return unanswered(
        `the protection on ${base} said more than this read holds, and only the tail arrived`,
      );
    }
    if (protection.code === 0) {
      try {
        required.push(...protectionContexts(JSON.parse(protection.stdout)));
      } catch {
        return unanswered("the branch's protection did not answer with JSON");
      }
    } else if (!notFound(protection)) {
      return unanswered(
        `the protection on ${base} could not be read: ${protection.stderr.trim().slice(-200)}`,
      );
    }
  }

  const required_checks = [...new Set(required)];
  // A reading taken without a base branch has asked one of the two questions.
  // Whatever the workflows say, the contexts that branch requires were never
  // read, so this is not a reading anything may act on as "nothing runs".
  const asked = base !== null;
  return {
    answered: asked,
    runs_checks: triggered.length > 0 || required_checks.length > 0,
    workflows: triggered,
    workflows_seen: named.size,
    workflows_ref: atRef === null ? null : ref,
    required_checks,
    base_ref: base,
    detail: asked ? "" : "no base branch was named, so the checks it requires were not read",
  };
}
