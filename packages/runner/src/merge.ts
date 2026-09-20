import { createHash } from "node:crypto";
import {
  loopMergeDecision,
  matchesAny,
  mergeSwitchStop,
  readD073Verdicts,
  reReadStillMerges,
  type CarriedApproval,
  type LoopMergeCheck,
  type LoopMergeObservation,
  type LoopMergeStop,
  type MergeMode,
} from "@perbo/contracts";
import { createGit, gh, git as repositoryGit } from "@perbo/workspace";
import { MergeLockedError, acquireMergeLock } from "./lock.js";
import { requireGithubCredential } from "./github-credential.js";

/**
 * The loop merging its own pull request (SCP-202, D-077).
 *
 * It lives here, beside the push and the pull-request creation, for the reason
 * those do: **the runner holds the credential and performs the GitHub-side
 * step itself.** The executor's environment never contains a token, `gh` is on
 * its deny list, and `self_merge` stays on its prohibited-action list — none of
 * that changed. What changed is that a step of the runner's, behind a switch a
 * person sets, may now do what a person's click did.
 *
 * D-041 said never. D-077 supersedes it for the integration branch only, once
 * the loop has cleared D-076's bar, and the switch defaults to a person until
 * the founder flips it. Everything in `loopMergeDecision` fails closed, and
 * every refusal is a stop with its own rule id, because "it did not merge" is
 * not a sentence a person can act on.
 */

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * What one `gh` answer may say, past which only its tail arrives.
 *
 * Every read here is parsed, and a pull request with a long conversation is a
 * large answer: a cut one is JSON that will not parse, which this would read as
 * "GitHub said nothing" — so the ceiling is the size of an answer rather than
 * the size of output nobody reads.
 */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/**
 * What a head's diff against its base may be, past which no approval carries.
 *
 * The whole diff is hashed, so a capture that kept only its tail would make two
 * heads differing before that tail hash the same — an approval carried to
 * content nobody reviewed. Past this the answer is that nothing is known about
 * the head, which is the reading that fails closed.
 */
const MAX_DIFF_BYTES = 64 * 1024 * 1024;

export interface LoopMergeRequest {
  /** The repository configuration's switch. `person` refuses before anything is read. */
  mode: MergeMode;
  /** Where `gh` is run: the checkout the pull request belongs to. */
  repository_root: string;
  branch: string;
  pull_request_number: number | null;
  /**
   * The base the merge is into, where the caller knows it — the run
   * configuration's `base_ref`. Null takes GitHub's own answer, which is what
   * `perbo sync` has: it holds a ticket, not a run configuration.
   */
  base_ref: string | null;
  /** Where the merge lock goes, beside the ticket's run lock. */
  state_root: string;
  ticket_key: string;
  /**
   * The contract's `paths_allowed`, for reading whether an approval of an
   * earlier head carries across a re-level (SCP-227). Absent, every base
   * change between the two heads counts as touching the scope, which is the
   * reading that fails closed.
   */
  paths_allowed?: readonly string[];
  /** The loop's attempt, carried into the merge commit as a trailer. */
  attempt_id: string;
  now: Date;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface LoopMergeOutcome {
  merged: boolean;
  /** Which condition stopped it, or null where it merged. */
  stop: LoopMergeStop | null;
  /** The head that merged, or that the decision was taken on. */
  head_sha: string | null;
  /** One line for a person: what happened, in the words the stop states it in. */
  detail: string;
}

interface GhPullRequest {
  number?: number;
  url?: string;
  state?: string;
  headRefOid?: string;
  baseRefName?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    status?: string;
    state?: string;
    conclusion?: string;
  }>;
  comments?: Array<{ body?: string }>;
  commits?: Array<{ oid?: string; messageHeadline?: string; messageBody?: string }>;
}

/** One commit's signature, as the commits API reports it. */
interface GhApiCommit {
  sha?: string;
  commit?: { verification?: { verified?: boolean } };
}

/**
 * One check, from either half of the rollup.
 *
 * A check run reports `status` and `conclusion`; a legacy status context
 * reports `state` alone. Both are folded into the same pair rather than being
 * judged by two rules, because "is it green" has one answer.
 */
const normaliseCheck = (check: NonNullable<GhPullRequest["statusCheckRollup"]>[number]): LoopMergeCheck => ({
  name: check.name ?? check.context ?? "check",
  status: check.status ?? check.state ?? "UNKNOWN",
  conclusion: check.conclusion ?? check.state ?? null,
});

const FIELDS = [
  "number",
  "url",
  "state",
  "headRefOid",
  "baseRefName",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
  "comments",
  "commits",
];

/**
 * One read of the pull request, and the commit signatures beside it.
 *
 * Two calls rather than one because no single `gh` answer carries both: the
 * commits a pull request lists come from `gh pr view --json commits`, and
 * whether each is signed comes from the commits API's `verification.verified`.
 * A commit the API named no verification for arrives as `null`, which
 * `loopMergeDecision` reads as unverified — the missing answer is the evidence
 * that is missing.
 */
async function observe(
  request: LoopMergeRequest,
  env: NodeJS.ProcessEnv,
): Promise<{ observed: LoopMergeObservation; number: number | null }> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = { base: env, timeoutMs, maxOutputBytes: MAX_ANSWER_BYTES };
  const reference = request.pull_request_number === null ? request.branch : String(request.pull_request_number);
  const viewed = await gh.viewPullRequest(request.repository_root, reference, FIELDS, call);
  const absent: LoopMergeObservation = {
    state: "none",
    head_sha: null,
    base_ref: request.base_ref,
    mergeable: null,
    checks: [],
    comments: [],
    commits: [],
  };
  // A cut answer is not a smaller answer: it is JSON that will not parse, and
  // reading it as "there is no pull request" would decide the merge on it.
  if (viewed.code !== 0 || viewed.truncated) return { observed: absent, number: null };

  let pr: GhPullRequest;
  try {
    pr = JSON.parse(viewed.stdout) as GhPullRequest;
  } catch {
    return { observed: absent, number: null };
  }

  const number = pr.number ?? request.pull_request_number ?? null;
  const verified = new Map<string, boolean>();
  if (number !== null) {
    // `{owner}` and `{repo}` are `gh`'s own placeholders, resolved from the
    // checkout this runs in — so nothing here has to parse a URL, and no
    // repository other than the one under change can be named.
    const api = await gh.api(
      request.repository_root,
      `repos/{owner}/{repo}/pulls/${number}/commits?per_page=100`,
      call,
    );
    if (api.code === 0 && !api.truncated) {
      try {
        for (const commit of JSON.parse(api.stdout) as GhApiCommit[]) {
          if (commit.sha) verified.set(commit.sha, commit.commit?.verification?.verified === true);
        }
      } catch {
        // Unreadable output verifies nothing, which is what the map already
        // says; every commit then reads as unverified.
      }
    }
  }

  const head = pr.headRefOid ?? null;
  const baseRef = request.base_ref ?? pr.baseRefName ?? null;
  const comments = (pr.comments ?? []).map((comment) => comment.body ?? "");
  const carried_approvals =
    head === null || baseRef === null
      ? []
      : await carriedApprovals({
          repository_root: request.repository_root,
          base_ref: baseRef,
          head,
          approved: comments
            .flatMap((body) => readD073Verdicts(body))
            .filter((one) => one.verdict === "APPROVE")
            .map((one) => one.head),
          paths_allowed: request.paths_allowed,
          env,
          timeoutMs,
        });

  return {
    number,
    observed: {
      state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.state ? "open" : "none",
      head_sha: head,
      base_ref: baseRef,
      mergeable:
        pr.mergeable === "MERGEABLE"
          ? "mergeable"
          : pr.mergeable === "CONFLICTING"
            ? "conflicting"
            : pr.mergeable === undefined
              ? null
              : "unknown",
      checks: (pr.statusCheckRollup ?? []).map(normaliseCheck),
      comments,
      commits: (pr.commits ?? []).map((commit) => ({
        sha: commit.oid ?? "",
        message: `${commit.messageHeadline ?? ""}\n${commit.messageBody ?? ""}`,
        verified: commit.oid === undefined ? null : (verified.get(commit.oid) ?? null),
      })),
      carried_approvals,
    },
  };
}

/**
 * What the runner can establish, from local git alone, about an approval that
 * named an earlier head of the branch (SCP-227).
 *
 * For each approved sha that is an ancestor of the head and not the head: the
 * branch's diff against its base at that sha and at the head, hashed and
 * compared; and the paths the base advanced over between the two heads' bases
 * that lie inside the contract's scope. A sha this checkout does not hold, or
 * one that is not on the branch, yields no entry — which the decision reads
 * as an approval that does not carry.
 *
 * Nothing here is fetched: the branch was pushed from this machine or
 * re-levelled on it, and the base ref is the queue's to fetch.
 */
export async function carriedApprovals(args: {
  repository_root: string;
  base_ref: string;
  head: string;
  approved: readonly string[];
  paths_allowed?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** What a head's diff may be. Defaults to {@link MAX_DIFF_BYTES}. */
  max_diff_bytes?: number;
}): Promise<CarriedApproval[]> {
  const cwd = args.repository_root;
  const git = args.env === undefined ? repositoryGit : createGit({ environment: () => args.env! });
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = { timeoutMs };

  /** The branch's own diff against its base, as bytes: what a review judged. */
  const contentHash = async (sha: string): Promise<string | null> => {
    const base = await git.mergeBase(cwd, args.base_ref, sha, call);
    if (base === null) return null;
    const diff = await git.run(cwd, ["diff", "--no-color", "--full-index", base, sha], {
      timeoutMs,
      maxOutputBytes: args.max_diff_bytes ?? MAX_DIFF_BYTES,
    });
    // A diff too large to hold is held from its end, and two heads that differ
    // only before that end hash the same. Nothing is known about this head.
    if (diff.code !== 0 || diff.truncated) return null;
    return createHash("sha256").update(diff.stdout).digest("hex");
  };

  const head = await git.resolveCommit(cwd, args.head, call);
  if (head === null) return [];
  const headHash = await contentHash(head);
  const headBase = await git.mergeBase(cwd, args.base_ref, head, call);
  if (headHash === null || headBase === null) return [];

  const carried: CarriedApproval[] = [];
  for (const named of new Set(args.approved)) {
    const sha = await git.resolveCommit(cwd, named, call);
    if (sha === null || sha === head) continue;
    if (!(await git.isAncestor(cwd, sha, head, call))) continue;
    const shaHash = await contentHash(sha);
    const shaBase = await git.mergeBase(cwd, args.base_ref, sha, call);
    if (shaHash === null || shaBase === null) continue;
    let scope_touched: string[] = [];
    if (shaBase !== headBase) {
      const moved = await git.changedPaths(cwd, shaBase, headBase, call);
      if (moved === null) continue;
      const paths = moved.map((line) => line.trim()).filter((line) => line.length > 0);
      scope_touched =
        args.paths_allowed === undefined ? paths : paths.filter((path) => matchesAny(path, args.paths_allowed!));
    }
    carried.push({ head: sha, content_equal: shaHash === headHash, scope_touched });
  }
  return carried;
}

const stopped = (stop: LoopMergeStop, head_sha: string | null): LoopMergeOutcome => ({
  merged: false,
  stop,
  head_sha,
  detail: `${stop.rule_id}: ${stop.statement}`,
});

/**
 * Merge the pull request the loop opened, or stop with the condition that was
 * missing.
 *
 * The order is what a person needs told first: the switch, which costs nothing
 * to read and answers the whole question; the credential, refused before any
 * read for the reason `pollPullRequest` refuses there; then the read, the lock
 * on the base, the six conditions, and — immediately before the merge and
 * never earlier — the same read again, so a base that moved is a stop rather
 * than a conflict landed.
 *
 * Never `--squash` and never `--rebase`: both rewrite the branch's commits,
 * and the attempt trailer on each of them is what SCP-196 reads a merge as the
 * loop's by. The merge commit carries the attempt id as a trailer for the same
 * reason.
 */
export async function mergeLoopPullRequest(request: LoopMergeRequest): Promise<LoopMergeOutcome> {
  // Decided before anything is read, so a repository that merges by hand
  // spends no credential and no `gh` process being told so.
  const switched = mergeSwitchStop(request.mode);
  if (switched !== null) return stopped(switched, null);

  const env = request.env ?? process.env;
  requireGithubCredential({ env, what: "there is no credential to merge the pull request through" });

  const first = await observe(request, env);
  // Decided before the lock, and separately from the six conditions below,
  // because a branch with no open pull request has nothing to serialize: the
  // base is unknown there, so the lock would be taken on `HEAD` and would
  // serialize two branches that share no base at all. `loopMergeDecision` is
  // pure, so asking it twice costs nothing and keeps the sentence in one place.
  const early = loopMergeDecision({ mode: request.mode, observed: first.observed });
  if (!early.merge && early.rule_id === "merge.no_pull_request") {
    return stopped({ rule_id: early.rule_id, statement: early.statement }, first.observed.head_sha);
  }

  const base = first.observed.base_ref ?? "HEAD";
  let lock;
  try {
    lock = acquireMergeLock({
      state_root: request.state_root,
      base_ref: base,
      ticket_key: request.ticket_key,
      now: request.now,
    });
  } catch (error) {
    if (!(error instanceof MergeLockedError)) throw error;
    return stopped({ rule_id: "merge.in_flight", statement: error.message }, first.observed.head_sha);
  }

  try {
    const decision = loopMergeDecision({ mode: request.mode, observed: first.observed });
    if (!decision.merge) {
      return stopped({ rule_id: decision.rule_id, statement: decision.statement }, first.observed.head_sha);
    }

    const again = await observe(request, env);
    const still = reReadStillMerges({ decided: first.observed, now: again.observed });
    if (!still.merge) {
      return stopped({ rule_id: still.rule_id, statement: still.statement }, first.observed.head_sha);
    }

    const head = first.observed.head_sha ?? "";
    // The head the approval named. Where it was carried across a clean
    // re-level, that is an earlier commit than the one merging, and the body
    // says both so a reader can see the approval was carried and to what.
    const approvedHead = decision.approved_head ?? head;
    const reference = first.number === null ? request.branch : String(first.number);
    const merged = await gh.run(
      request.repository_root,
      [
        "pr",
        "merge",
        reference,
        "--merge",
        "--subject",
        `${request.ticket_key}: merge ${request.branch} into ${base}`,
        "--body",
        `Attempt: ${request.attempt_id}\nApproved-head: ${approvedHead}\n` +
          (approvedHead === head ? "" : `Carried-to: ${head}\n`),
      ],
      {
        base: env,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_ANSWER_BYTES,
      },
    );
    if (merged.code !== 0) {
      // `gh` says what it refused on a later line than the one that says it
      // refused — "Base branch was modified" arrives under "not mergeable" —
      // so the stop carries several, joined the way `mergeUp` joins git's.
      const said = (merged.stderr || merged.stdout).trim().split("\n").slice(0, 4).join("; ").slice(0, 400);
      return stopped(
        { rule_id: "merge.refused_by_github", statement: `\`gh pr merge\` failed: ${said || "no output"}` },
        head,
      );
    }

    return {
      merged: true,
      stop: null,
      head_sha: head,
      detail: `merged ${request.branch} into ${base} at ${head.slice(0, 12)} as ${request.attempt_id}`,
    };
  } finally {
    lock.release();
  }
}
