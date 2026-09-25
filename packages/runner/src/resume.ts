import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleIdSchema, CommitShaSchema, type ResumedFrom, type RunBundle } from "@perbo/contracts";
import { git } from "@perbo/workspace";
import { BundleStore } from "./bundle.js";

/**
 * Resuming an attempt a ceiling cut or a person stopped (SCP-154).
 *
 * An attempt that ended part-way — stopped by `attempt_cost_micros` or another
 * ceiling, or `cancelled` by a person's stop — has already been paid for, and
 * its work survives in two places: the commit its seal made on the attempt
 * branch, and the retained `change.diff` of its execution bundle.
 * `perbo run --ticket <id> --resume-from <bundle_id>` starts the next attempt
 * from that work instead of from nothing.
 *
 * Four properties are what make that safe rather than merely convenient:
 *
 * 1. **The diff is applied to the tree it was made against.** A diff is a
 *    statement about one base commit. The bundle records which, and a resume
 *    whose run would start somewhere else is refused rather than force-fitted —
 *    `git apply --3way` would happily produce a merge nobody asked for.
 * 2. **The bundle is read, never written.** The prior attempt's record and its
 *    diff bytes are what a person reads to understand what was lost; the
 *    resumed attempt references them and writes its own bundle beside them.
 * 3. **A branch that holds the sealed commit is not given the diff again.** The
 *    diff is the whole attempt's work, so where the branch still carries the
 *    commit that attempt sealed, the work is already there; applying it again
 *    is a no-op at best and, over a later commit that deliberately undid part
 *    of it, puts that part back without a word. Only a branch deleted or reset
 *    past that commit needs the diff.
 * 4. **A diff that does not apply is dropped, not fatal.** A diff that
 *    conflicts with the commit the worktree was provisioned on, or a record
 *    whose bytes git cannot apply, leaves the worktree reset to that commit and
 *    the executor starting from it, with the run's log and the attempt's record
 *    saying the unverified prior work was dropped. A resume that ended the run
 *    instead would leave the ticket nothing to continue with.
 *
 * Every refusal names `change.diff`, because that file is the thing the person
 * is trying to recover and the thing they can open when the resume will not.
 */

/** The name the loop writes the executor's diff under, in every execution bundle. */
export const RETAINED_DIFF_ARTIFACT = "change.diff";

/** The name the loop writes the attempt's own record under, in every execution bundle. */
const ATTEMPT_ARTIFACT = "attempt.json";

/** The resume cannot proceed, and nothing has been provisioned or spent. */
export class ResumeRefusedError extends Error {
  readonly bundle_id: string;

  constructor(bundle_id: string, message: string) {
    super(message);
    this.name = "ResumeRefusedError";
    this.bundle_id = bundle_id;
  }
}

export interface ResumeSource {
  /** The prior attempt's execution bundle, exactly as it is on disk. */
  bundle: RunBundle;
  bundle_id: string;
  /** The attempt that bundle records: the resumed attempt's predecessor. */
  attempt_id: string;
  /** The base commit the diff was made against, from the bundle's inputs. */
  base_commit: string;
  /** The retained diff bytes. */
  diff: string;
  diff_sha256: string;
  /**
   * The commit the prior attempt's seal made, from the attempt record its
   * bundle retains; null where that record names none or is not retained.
   * A branch that holds it already carries the whole diff.
   */
  head_commit: string | null;
  /** How the prior attempt ended, where its bundle recorded a reason. */
  termination: string | null;
}

/** What a resume did with the retained diff, which the record and the brief state. */
export type ResumeOutcome =
  /** Applied into the worktree, uncommitted, before the executor ran. */
  | { state: "applied" }
  /** Not applied: the branch already holds `at`, the commit the prior attempt sealed. */
  | { state: "held"; at: string }
  /**
   * Not applied: it did not apply, and the worktree is back at `at`, the commit
   * it was on before. `reason` is what `git apply` said.
   */
  | { state: "dropped"; at: string; reason: string };

/**
 * Whether two recorded commit shas name the same commit.
 *
 * A contract may pin an abbreviated sha and a bundle records the resolved one,
 * so equality alone would refuse a resume that is perfectly in order. Git's own
 * abbreviation rule — a prefix identifies one commit in the repository — is
 * what makes the prefix comparison the right one rather than a loosening.
 *
 * The rule holds only for a prefix long enough to be an abbreviation. Git will
 * not print one shorter than seven characters, and `CommitShaSchema` is where
 * this repository already states that floor; anything below it is a string that
 * happens to start the same way, and `0` or `00` would match half the commits
 * in a repository. Neither side is compared until it has passed that schema, so
 * a bundle recording a truncated base is not silently read as a match.
 */
export function sameCommit(one: string, other: string): boolean {
  if (!CommitShaSchema.safeParse(one).success) return false;
  if (!CommitShaSchema.safeParse(other).success) return false;
  return one.startsWith(other) || other.startsWith(one);
}

/** Who the prior attempt was and how it ended, as every resume sentence opens. */
function resumedFromClause(source: ResumeSource, tense: "ed" | "ing"): string {
  return (
    `resum${tense} from execution bundle ${source.bundle_id} (attempt ` +
    `${source.attempt_id}${source.termination === null ? "" : `, ${source.termination}`})`
  );
}

/**
 * The sentence the resumed attempt's record and the run's log carry, one per
 * outcome.
 *
 * `planned` is the same fact stated before the run starts, where nothing has
 * been applied yet: the CLI says it in the future tense, naming the commit
 * whose presence on the branch skips the diff, so a preview is not a claim.
 */
export function resumeNote(source: ResumeSource, outcome: ResumeOutcome | "planned"): string {
  if (outcome === "planned") {
    return (
      `${resumedFromClause(source, "ing")}: its retained ${RETAINED_DIFF_ARTIFACT} will be applied ` +
      `at ${source.base_commit} before the executor runs` +
      (source.head_commit === null
        ? ""
        : `, unless the branch already holds ${source.head_commit}, the commit that attempt sealed`) +
      ", and is unverified prior work"
    );
  }
  const from = resumedFromClause(source, "ed");
  if (outcome.state === "applied") {
    return (
      `${from}: its retained ${RETAINED_DIFF_ARTIFACT} was applied at ${source.base_commit} before ` +
      "the executor ran, and is unverified prior work"
    );
  }
  if (outcome.state === "held") {
    return (
      `${from}: the branch already holds ${outcome.at}, the commit that attempt sealed, so its ` +
      `retained ${RETAINED_DIFF_ARTIFACT} was not applied again, and that unverified prior work ` +
      "is committed on the branch"
    );
  }
  return (
    `${from}: its retained ${RETAINED_DIFF_ARTIFACT} did not apply at ${outcome.at}, so that ` +
    `unverified prior work was dropped and the executor started from ${outcome.at} without it`
  );
}

/** The record the resumed attempt carries, so the chain is readable from it. */
export function resumedFromRecord(source: ResumeSource, outcome: ResumeOutcome): ResumedFrom {
  return {
    bundle_id: source.bundle_id,
    attempt_id: source.attempt_id,
    diff_sha256: source.diff_sha256,
    note: resumeNote(source, outcome),
  };
}

/**
 * The bundle a `--resume-from` names, with its retained diff, or a refusal.
 *
 * Called twice on the way to an attempt: once by the CLI, before the ticket is
 * moved and before a worktree exists, so a mismatch costs nothing; and once by
 * the loop against the base commit it actually provisioned. The second is the
 * one the property rests on — the first only moves the refusal earlier.
 */
export function resolveResumeSource(args: {
  bundle_root: string;
  bundle_id: string;
  /** The ticket the resuming run belongs to. A bundle of another's is refused. */
  ticket_id: string;
  /** The base commit the resumed attempt starts from. */
  base_commit: string;
}): ResumeSource {
  // Annotated on the declaration, so a call to it narrows what follows: TypeScript
  // only reads a `never` return as unreachable when the name carries the type.
  const refuse: (message: string) => never = (message) => {
    throw new ResumeRefusedError(args.bundle_id, message);
  };

  if (!BundleIdSchema.safeParse(args.bundle_id).success) {
    refuse(
      `'${args.bundle_id}' is not a bundle id, so no ${RETAINED_DIFF_ARTIFACT} can be read from ` +
        "it — `perbo inspect <ticket>` lists the bundle of every attempt on record",
    );
  }

  const store = new BundleStore({ root: args.bundle_root, retainContext: true });
  const bundle = store.read(args.bundle_id);
  if (bundle === null) {
    refuse(
      `${args.bundle_root} holds no bundle ${args.bundle_id}, so there is no ` +
        `${RETAINED_DIFF_ARTIFACT} to resume from`,
    );
  }

  if (bundle.kind !== "execution") {
    refuse(
      `${args.bundle_id} is a ${bundle.kind} bundle, and only an execution bundle carries the ` +
        `executor's ${RETAINED_DIFF_ARTIFACT}`,
    );
  }
  if (bundle.ticket_id !== args.ticket_id) {
    refuse(
      `${args.bundle_id} records an attempt of ${bundle.ticket_id} and this run is ` +
        `${args.ticket_id}; applying another ticket's ${RETAINED_DIFF_ARTIFACT} would put work ` +
        "nobody asked for into this attempt's change set",
    );
  }

  const artifact = bundle.artifacts.find((entry) => entry.name === RETAINED_DIFF_ARTIFACT);
  if (artifact === undefined) {
    refuse(
      `${args.bundle_id} has no ${RETAINED_DIFF_ARTIFACT}: the attempt it records changed ` +
        "nothing, so there is no work to resume",
    );
  }
  if (!artifact.retained) {
    refuse(
      `${args.bundle_id} kept only the hash of its ${RETAINED_DIFF_ARTIFACT} (the run was ` +
        "configured with retain_context false), so the bytes to resume from are gone",
    );
  }
  const diff = store.readObject(artifact.sha256);
  if (diff === null) {
    refuse(
      `${args.bundle_id} references ${RETAINED_DIFF_ARTIFACT} as ${artifact.sha256}, and those ` +
        `bytes are not in ${join(args.bundle_root, "objects")}`,
    );
  }
  if (diff.trim().length === 0) {
    refuse(`${args.bundle_id} retained an empty ${RETAINED_DIFF_ARTIFACT}: there is nothing to apply`);
  }

  const recordedBase = bundle.inputs.base_commit;
  if (typeof recordedBase !== "string" || recordedBase.length === 0) {
    refuse(
      `${args.bundle_id} records no base commit, so nothing establishes which tree its ` +
        `${RETAINED_DIFF_ARTIFACT} was made against`,
    );
  }
  // A base too short to be a git abbreviation establishes nothing either: it
  // would prefix-match commits the diff was never made against, which is the
  // one thing the comparison below is here to prevent.
  if (!CommitShaSchema.safeParse(recordedBase).success) {
    refuse(
      `${args.bundle_id} records its base commit as '${recordedBase}', which is not a commit sha ` +
        `(7 to 40 lowercase hex characters), so nothing establishes which tree its ` +
        `${RETAINED_DIFF_ARTIFACT} was made against`,
    );
  }
  if (!sameCommit(recordedBase, args.base_commit)) {
    refuse(
      `${args.bundle_id}'s ${RETAINED_DIFF_ARTIFACT} was made against ${recordedBase} ` +
        `and this run starts at ${args.base_commit}. The base commit has moved, so the diff no ` +
        "longer describes this tree; re-run the ticket from the top, or admit it again against " +
        "the commit the work was written on",
    );
  }

  const termination = bundle.inputs.termination;
  return {
    bundle,
    bundle_id: bundle.bundle_id,
    attempt_id: bundle.subject_id,
    base_commit: recordedBase,
    diff,
    diff_sha256: artifact.sha256,
    head_commit: sealedHead(store, bundle),
    termination: typeof termination === "string" && termination.length > 0 ? termination : null,
  };
}

/**
 * The commit the bundle's attempt sealed, read from the attempt record it
 * retains. Null where the record is absent, unreadable or names no commit: the
 * resume then cannot tell whether the branch holds the work, and applies the
 * diff, whose `--3way` makes an already-present change a no-op.
 */
function sealedHead(store: BundleStore, bundle: RunBundle): string | null {
  const artifact = bundle.artifacts.find((entry) => entry.name === ATTEMPT_ARTIFACT);
  if (artifact === undefined || !artifact.retained) return null;
  const body = store.readObject(artifact.sha256);
  if (body === null) return null;
  let record: unknown;
  try {
    record = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const parsed = CommitShaSchema.safeParse((record as { head_commit?: unknown }).head_commit);
  return parsed.success ? parsed.data : null;
}

/**
 * Put the retained diff into the worktree, before the executor is invoked,
 * unless the branch already holds the commit the prior attempt sealed.
 *
 * That commit carries the whole diff, so a worktree whose history holds it is
 * left exactly as it is: the diff is not applied again, and a later commit that
 * undid part of the work stays undone.
 *
 * Otherwise `git apply --3way` is the established form: it applies the patch
 * directly where the tree still matches, and falls back to a three-way merge
 * against the blobs the patch names where it does not, a binary file's
 * included, since the diff is taken with `--binary`.
 *
 * Where it fails, the failure may be partial: `--3way` leaves the files it
 * merged applied and the ones it could not in conflict. So the worktree is
 * reset to the commit it was on, whole, before the executor sees it, and the
 * caller is told the diff was dropped rather than handed a half-applied tree.
 * `--3way` works through the index, so every path it touched is one the reset
 * restores; an untracked file it never wrote is left alone.
 */
export async function applyRetainedDiff(args: {
  worktree: string;
  source: ResumeSource;
  timeoutMs?: number;
}): Promise<ResumeOutcome> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const head = await git.head(args.worktree, { timeoutMs });
  if (head === null) {
    throw new Error(
      `${args.worktree} is on no commit, so ${args.source.bundle_id}'s ` +
        `${RETAINED_DIFF_ARTIFACT} has nothing to apply to`,
    );
  }
  const sealed = args.source.head_commit;
  if (sealed !== null && (await git.isAncestor(args.worktree, sealed, head, { timeoutMs }))) {
    return { state: "held", at: sealed };
  }
  const scratch = mkdtempSync(join(tmpdir(), "perbo-resume-"));
  const path = join(scratch, RETAINED_DIFF_ARTIFACT);
  try {
    writeFileSync(path, args.source.diff);
    const applied = await git.run(
      args.worktree,
      ["apply", "--3way", "--whitespace=nowarn", "--", path],
      { timeoutMs },
    );
    if (applied.code === 0) return { state: "applied" };
    await git.runOrThrow(args.worktree, ["reset", "--hard", "--quiet", head], { timeoutMs });
    return {
      state: "dropped",
      at: head,
      reason: applied.stderr.trim() || applied.stdout.trim() || "git apply --3way failed",
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
