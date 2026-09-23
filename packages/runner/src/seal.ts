import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_REVIEWABLE_DIFF_BYTES,
  changeSetFromNameStatus,
  insideAllowedPaths,
  isSecretPath,
  parseNameStatus,
} from "@perbo/contracts";
import type { ChangeSet, SecretIndex } from "@perbo/contracts";
import { git } from "@perbo/workspace";
import { inspectPaths, type JudgingArtifacts, type ProhibitedHit } from "./prohibited.js";
import { SCRATCH_EXCLUDE_PATHSPEC } from "./scratch.js";

/**
 * Sealing the change set (SCP-018).
 *
 * A change set is identified by `(base_commit, head_commit)`, so sealing is
 * what makes a review target exist at all — and re-sealing after a remediation
 * round is what makes the second review a review of something different rather
 * than the same verdict rewritten.
 *
 * Two things happen here that are not "run git commit":
 *
 * 1. **Materialized secrets are removed from the staged set by content hash.**
 *    They are usually gitignored, and "usually" is not a control. A repository
 *    that does not ignore its own `.env` would otherwise commit one.
 * 2. **The changed paths are inspected against the prohibited-action list.**
 *    The command allow-list sees commands; a file write is not a command, and
 *    this is where the same act gets caught.
 * 3. **The file list never comes from the diff.** `git diff --name-status` is
 *    small and complete whatever the change's size; the diff body is measured
 *    and, past `MAX_REVIEWABLE_DIFF_BYTES`, withheld rather than cut. A cut
 *    diff loses its leading files silently, and a file the scope check never
 *    saw is a scope escape nobody caught.
 * 4. **The change set is the branch's diff against the base commit**, never
 *    the attempt's own delta. `base_commit..HEAD` is what is listed, diffed and
 *    inspected, so a branch that already carries commits an earlier attempt
 *    sealed is reviewed for everything it adds to base. An attempt that stages
 *    nothing therefore commits nothing and still returns that change set; only
 *    an empty range returns none.
 * 5. **A changed path outside the contract's globs is a runner defect.** The
 *    guard refuses those writes before they happen (SCP-195), so one that
 *    reached the change set is a write the guard could not see — reported as
 *    `outside_allowed_paths` for the loop to stop the attempt on, rather than
 *    left for the review to find at the cost of a run. It is read by
 *    `describeRange`, so a merge-up that re-reads the range re-asserts it over
 *    the change set the review will actually see.
 * 6. **The executor's scratch directory is excluded by pathspec, here.** The
 *    runner points `TMPDIR` at `<worktree>/.perbo-tmp` (SCP-166) and this is
 *    where that directory stops: every list the seal builds carries
 *    `SCRATCH_EXCLUDE_PATHSPEC`, so the directory is never staged, never
 *    committed and never in the diff a reviewer reads — however it got there.
 *    The alternative, a `.gitignore` line or a Git exclude file, would have the
 *    runner write outside the attempt's worktree to keep the executor inside it.
 * 7. **The spec commit's files are excluded from the change set** (D-103,
 *    SCP-314). The branch's first commit holds the spec the contract was
 *    drafted from, and it lands with the change; the review reads the diff
 *    after it. `spec_paths` is what keeps every file that commit holds out of
 *    the list, the diff and the scope assertion, so the checks, the review, the
 *    verification and the pull request still read one change set (SCP-192) and
 *    none of them reads the spec as work.
 */

export interface SealRequest {
  worktree: string;
  base_commit: string;
  ticket_key: string;
  attempt_id: string;
  /** The plan's approved outcome. Nothing the agent wrote reaches the message. */
  outcome: string;
  secrets: SecretIndex;
  judging?: JudgingArtifacts;
  /**
   * The globs the approved contract admits a write under (SCP-195). The guard
   * refuses a write outside them before it happens, so a changed path outside
   * them here is a write the guard never saw — reported rather than left for
   * the review to find. Omitted asserts nothing, which is how a caller with no
   * contract seals.
   */
  paths_allowed?: readonly string[];
  /**
   * Paths the pinned checks produced in a previous round. A check that writes
   * coverage output into a worktree leaves it there, and the next round's
   * `git add -A` would commit it as if the agent had written it. Where the
   * repository ignores its own build output this is empty, and where it does
   * not this is the difference between a clean diff and a spurious scope escape.
   */
  exclude_paths?: readonly string[];
  /**
   * The files the branch's spec commit holds (D-103), kept out of the change
   * set this describes. The spec lands with the change and the reviewer may
   * open it as it opens any file; what it must not read is the spec as part of
   * the work it is judging.
   */
  spec_paths?: readonly string[];
  timeoutMs?: number;
  /** Bytes of diff the reviewer is handed whole. Defaults to `MAX_REVIEWABLE_DIFF_BYTES`. */
  max_diff_bytes?: number;
}

export interface SealResult {
  changeset: ChangeSet | null;
  /** The branch head the change set was measured against: `base_commit..head_commit`. */
  head_commit: string | null;
  /** Empty when the change set is `truncated`: the body was withheld, not cut. */
  diff: string;
  /** Paths kept out of the commit because their bytes matched a materialized secret. */
  excluded_paths: string[];
  /** Paths kept out because a previous round's checks produced them. */
  excluded_check_artifacts: string[];
  prohibited: ProhibitedHit[];
  changed_paths: string[];
  /**
   * Changed paths the contract does not admit a write to, sorted. Non-empty
   * means the pre-execution guard missed one, which is a defect in the runner
   * and not a finding for the review to buy.
   */
  outside_allowed_paths: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * What a listing of the range may say, past which only its tail arrives.
 *
 * The file list is parsed into the change set, so a cut one is a change set
 * with its first files missing — shaped exactly like a complete one, and the
 * files it lost are the ones nothing would inspect. The module's own named
 * questions refuse a cut answer; this is the same ceiling for the two listings
 * that have no named form.
 */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

export async function sealChangeSet(request: SealRequest): Promise<SealResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = request.worktree;
  // The spec commit's files are excluded from the staging as well as from the
  // range: a write to one is refused before it happens (D-103), and one that
  // reached the worktree anyway is left there rather than committed into a
  // change set that does not list it.
  const pathspec = [...SCRATCH_EXCLUDE_PATHSPEC, ...excludeSpec(request.spec_paths)];

  await git.stage(cwd, pathspec, { timeoutMs });

  const stagedPaths = await git.stagedPaths(cwd, pathspec, { timeoutMs });

  // Content-hash exclusion (D-012). The filename check stays as a second line;
  // it is not the mechanism, because the same bytes under another name are the
  // same disclosure.
  const excluded_paths: string[] = [];
  const excluded_check_artifacts: string[] = [];
  const producedByChecks = new Set(request.exclude_paths ?? []);
  for (const path of stagedPaths) {
    if (producedByChecks.has(path)) {
      await git.run(cwd, ["restore", "--staged", "--", path], { timeoutMs });
      excluded_check_artifacts.push(path);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(cwd, path));
    } catch {
      continue;
    }
    const matchesContent = request.secrets.matchesFile(bytes);
    const matchesValue = request.secrets.size > 0 && request.secrets.contains(bytes.toString("utf8"));
    if (matchesContent || matchesValue || (isSecretPath(path) && request.secrets.size > 0)) {
      await git.run(cwd, ["restore", "--staged", "--", path], { timeoutMs });
      excluded_paths.push(path);
    }
  }

  const toCommit = await git.stagedPaths(cwd, pathspec, { timeoutMs });

  // An attempt that staged nothing is not sealed into an empty commit; the
  // branch head stays where it was, and the range below still describes
  // whatever earlier attempts left on it.
  if (toCommit.length > 0) {
    const message =
      `${request.ticket_key}: ${request.outcome}\n\n` +
      `Attempt: ${request.attempt_id}\nBase: ${request.base_commit}\n`;
    await git.commit(cwd, message, { timeoutMs });
  }

  const described = await describeRange({
    worktree: cwd,
    base_commit: request.base_commit,
    ...(request.judging ? { judging: request.judging } : {}),
    ...(request.paths_allowed === undefined ? {} : { paths_allowed: request.paths_allowed }),
    ...(request.spec_paths === undefined ? {} : { spec_paths: request.spec_paths }),
    fallback_paths: toCommit,
    timeoutMs,
    ...(request.max_diff_bytes === undefined ? {} : { max_diff_bytes: request.max_diff_bytes }),
  });

  return {
    ...described,
    // An attempt that staged nothing into an empty range sealed no commit, so
    // it has no head of its own to name — whatever HEAD happens to be.
    head_commit:
      described.changeset === null && toCommit.length === 0 ? null : described.head_commit,
    excluded_paths,
    excluded_check_artifacts,
  };
}

/** What `base_commit..HEAD` contains, with nothing staged and nothing committed. */
export interface RangeDescription {
  changeset: ChangeSet | null;
  /** The branch head the range was measured to. Always a commit. */
  head_commit: string;
  /** Empty when the change set is `truncated`: the body was withheld, not cut. */
  diff: string;
  prohibited: ProhibitedHit[];
  changed_paths: string[];
  /**
   * Changed paths the contract does not admit a write to, sorted. Non-empty
   * means the pre-execution guard missed one, which is a defect in the runner
   * and not a finding for the review to buy (SCP-195). Empty where the caller
   * named no globs.
   */
  outside_allowed_paths: string[];
}

/**
 * The change set `base_commit..HEAD` describes, read and nothing more.
 *
 * The seal's second half, extracted because it is needed twice: once where the
 * seal makes the commit, and again after a merge-up has moved both ends of the
 * range (SCP-192). A branch merged with the base's new tip is reviewed against
 * that tip, and re-running the whole seal to get there would stage and commit
 * whatever the round has since left in the worktree.
 */
export async function describeRange(args: {
  worktree: string;
  base_commit: string;
  judging?: JudgingArtifacts;
  /** The globs the approved contract admits a write under (SCP-195). */
  paths_allowed?: readonly string[];
  /** The files the branch's spec commit holds, kept out of the range (D-103). */
  spec_paths?: readonly string[];
  /** Paths to inspect when the range is empty — the seal's staged set. */
  fallback_paths?: readonly string[];
  timeoutMs?: number;
  max_diff_bytes?: number;
}): Promise<RangeDescription> {
  const cwd = args.worktree;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const head_commit = await git.head(cwd, { timeoutMs });
  if (head_commit === null) throw new Error(`${cwd} is on no commit, so there is no range to describe`);
  const range = `${args.base_commit}..${head_commit}`;
  const pathspec = [...SCRATCH_EXCLUDE_PATHSPEC, ...excludeSpec(args.spec_paths)];

  const listed = await git.runOrThrow(
    cwd,
    ["diff", "--name-status", "-z", range, "--", ...pathspec],
    { timeoutMs, maxOutputBytes: MAX_LISTING_BYTES },
  );
  if (listed.truncated) throw new Error(`${range} lists more than ${MAX_LISTING_BYTES} bytes of files`);
  const files = parseNameStatus(listed.stdout);

  // The prohibited-path inspection reads the range, not this attempt's staged
  // set: what is judged is the change set that goes to review, whichever
  // attempt wrote each of its files.
  const excluded = new Set(args.spec_paths ?? []);
  const changedPaths =
    files.length > 0
      ? files.map((file) => file.path)
      : [...(args.fallback_paths ?? [])].filter((path) => !excluded.has(path));
  const prohibited = inspectPaths(changedPaths, args.judging, { root: cwd });

  /**
   * The guard's own audit, over the change set rather than over a tool call.
   *
   * It reads the same globs the guard was given, so agreement between them is
   * not a matter of two lists staying in step. What it can catch that the guard
   * cannot is a write no command named: a compiled program, a script file, a
   * process that outlived the line that started it.
   *
   * It lives in the range description rather than in the seal because a
   * merge-up re-reads the range through this function without re-sealing
   * (SCP-192), and the assertion has to be about the change set the checks and
   * the review are actually going to read.
   */
  const admitted = args.paths_allowed;
  const outside_allowed_paths =
    admitted === undefined
      ? []
      : changedPaths.filter((path) => !insideAllowedPaths(path, admitted)).sort();

  if (files.length === 0) {
    return {
      changeset: null,
      head_commit,
      diff: "",
      prohibited,
      changed_paths: [],
      outside_allowed_paths,
    };
  }

  // Written to a file rather than captured: the capture keeps a tail, and a
  // tail of a diff is a diff with its first files missing. The size decides
  // whether the body is handed over at all.
  const cap = args.max_diff_bytes ?? MAX_REVIEWABLE_DIFF_BYTES;
  const scratch = mkdtempSync(join(tmpdir(), "perbo-seal-"));
  const diffPath = join(scratch, "change.diff");
  let diff: string | null;
  let diff_bytes: number;
  try {
    await git.runOrThrow(
      cwd,
      ["diff", "--no-color", `--output=${diffPath}`, range, "--", ...pathspec],
      { timeoutMs },
    );
    diff_bytes = statSync(diffPath).size;
    diff = diff_bytes <= cap ? readFileSync(diffPath, "utf8") : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return {
    changeset: changeSetFromNameStatus({
      files,
      diff,
      diff_bytes,
      base_commit: args.base_commit,
      head_commit,
    }),
    head_commit,
    diff: diff ?? "",
    prohibited,
    changed_paths: files.map((file) => file.path),
    outside_allowed_paths,
  };
}

/**
 * One `:(exclude,literal)` pathspec per file the spec commit holds.
 *
 * `literal` because a recorded path is a filename and not a glob: a spec whose
 * name contains a `*` or a `[` would otherwise exclude whatever it matched.
 */
function excludeSpec(paths: readonly string[] | undefined): string[] {
  return (paths ?? []).map((path) => `:(exclude,literal)${path}`);
}

/**
 * The commits `base_commit..HEAD` on the branch, oldest first.
 *
 * Read before an attempt runs, this is the part of the change set the attempt
 * inherits: commits an earlier attempt sealed and its termination left on the
 * branch. Both ends are the runner's own — the base comes from the approved
 * contract and the head from git — so nothing a model returned reaches the argv.
 */
export async function commitsSince(args: {
  worktree: string;
  base_commit: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const result = await git.runOrThrow(
    args.worktree,
    ["rev-list", "--reverse", `${args.base_commit}..HEAD`],
    { timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxOutputBytes: MAX_LISTING_BYTES },
  );
  if (result.truncated) {
    throw new Error(`${args.base_commit}..HEAD lists more than ${MAX_LISTING_BYTES} bytes of commits`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((sha) => sha.length > 0);
}

/**
 * The commit a worktree is on, or null where it has none.
 *
 * Read straight after provisioning, this is where the materialization's verify
 * command runs: the contract's base commit for a branch the run created, and
 * the branch's own sealed head for one it took over. Nothing a model produced
 * reaches the argv — there is none.
 */
export async function headCommit(args: {
  worktree: string;
  timeoutMs?: number;
}): Promise<string | null> {
  try {
    return await git.head(args.worktree, { timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch {
    // A worktree git cannot read at all is one with no head to name, which is
    // what every caller of this does next anyway.
    return null;
  }
}

/**
 * What the working tree **gained** while the checks ran, passed to the next
 * round's seal so a coverage directory is never mistaken for the agent's work.
 *
 * Untracked files only. A check that modifies a tracked file is a different and
 * larger problem, and excluding it here would hide it — and would silently drop
 * the same file if the agent legitimately edits it in the next round.
 */
export async function untrackedAfterChecks(args: {
  worktree: string;
  timeoutMs?: number;
  /** What the listing may say; the default is the module's own ceiling. */
  maxOutputBytes?: number;
}): Promise<string[]> {
  const result = await git.run(
    args.worktree,
    ["status", "--porcelain", "--untracked-files=all", "--", ...SCRATCH_EXCLUDE_PATHSPEC],
    {
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: args.maxOutputBytes ?? MAX_LISTING_BYTES,
    },
  );
  // A listing held from its end has lost the paths it opens with, and the
  // next round's seal would then commit a check artifact as the agent's work.
  if (result.truncated) {
    throw new Error(
      `what the checks left untracked in ${args.worktree} could not be read whole within ` +
        `${args.maxOutputBytes ?? MAX_LISTING_BYTES} bytes, so the next seal cannot leave it out`,
    );
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
}
