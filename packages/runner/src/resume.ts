import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleIdSchema, CommitShaSchema, type ResumedFrom, type RunBundle } from "@perbo/contracts";
import { git } from "@perbo/workspace";
import { BundleStore } from "./bundle.js";

/**
 * Resuming an attempt a ceiling cut (SCP-154).
 *
 * An attempt stopped by `attempt_cost_micros` — or by any other ceiling — has
 * already been paid for, and its work survives in the retained `change.diff` of
 * its execution bundle. `perbo run --ticket <id> --resume-from <bundle_id>`
 * starts the next attempt from those bytes instead of from nothing.
 *
 * Two properties are what make that safe rather than merely convenient:
 *
 * 1. **The diff is applied to the tree it was made against.** A diff is a
 *    statement about one base commit. The bundle records which, and a resume
 *    whose run would start somewhere else is refused rather than force-fitted —
 *    `git apply --3way` would happily produce a merge nobody asked for.
 * 2. **The bundle is read, never written.** The cut attempt's record and its
 *    diff bytes are what a person reads to understand what was lost; the
 *    resumed attempt references them and writes its own bundle beside them.
 *
 * Every refusal names `change.diff`, because that file is the thing the person
 * is trying to recover and the thing they can open when the resume will not.
 */

/** The name the loop writes the executor's diff under, in every execution bundle. */
export const RETAINED_DIFF_ARTIFACT = "change.diff";

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
  /** The cut attempt's execution bundle, exactly as it is on disk. */
  bundle: RunBundle;
  bundle_id: string;
  /** The attempt that bundle records: the resumed attempt's predecessor. */
  attempt_id: string;
  /** The base commit the diff was made against, from the bundle's inputs. */
  base_commit: string;
  /** The retained diff bytes. */
  diff: string;
  diff_sha256: string;
  /** How the cut attempt ended, where its bundle recorded a reason. */
  termination: string | null;
}

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

/**
 * The sentence the resumed attempt's record and the run's progress both carry.
 *
 * `when` is the tense, because the same fact is stated at two moments: the CLI
 * says it before the run starts, where nothing has been applied yet, and the
 * record says it afterwards. One sentence in the future tense at the point the
 * diff is still only a plan is the difference between a preview and a claim.
 */
export function resumeNote(source: ResumeSource, when: "applied" | "planned" = "applied"): string {
  const applied = when === "applied";
  return (
    `resum${applied ? "ed" : "ing"} from execution bundle ${source.bundle_id} (attempt ` +
    `${source.attempt_id}${source.termination === null ? "" : `, ${source.termination}`}): its ` +
    `retained ${RETAINED_DIFF_ARTIFACT} ${applied ? "was" : "will be"} applied at ` +
    `${source.base_commit} before the executor ${applied ? "ran" : "runs"}, and is unverified ` +
    "prior work"
  );
}

/** The record the resumed attempt carries, so the chain is readable from it. */
export function resumedFromRecord(source: ResumeSource): ResumedFrom {
  return {
    bundle_id: source.bundle_id,
    attempt_id: source.attempt_id,
    diff_sha256: source.diff_sha256,
    note: resumeNote(source),
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
    termination: typeof termination === "string" && termination.length > 0 ? termination : null,
  };
}

/**
 * Put the retained diff into the worktree, before the executor is invoked.
 *
 * `git apply --3way` is the established form: it applies the patch directly
 * where the tree still matches, falls back to a three-way merge against the
 * blobs the patch names where it does not — which is what makes an already
 * applied diff a clean no-op rather than a failure — and refuses rather than
 * guessing when the two genuinely conflict. That refusal is ours to report,
 * with the file named.
 */
export async function applyRetainedDiff(args: {
  worktree: string;
  source: ResumeSource;
  timeoutMs?: number;
}): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "perbo-resume-"));
  const path = join(scratch, RETAINED_DIFF_ARTIFACT);
  try {
    writeFileSync(path, args.source.diff);
    const applied = await git.run(
      args.worktree,
      ["apply", "--3way", "--whitespace=nowarn", "--", path],
      { timeoutMs: args.timeoutMs ?? 120_000 },
    );
    if (applied.code !== 0) {
      throw new ResumeRefusedError(
        args.source.bundle_id,
        `${args.source.bundle_id}'s ${RETAINED_DIFF_ARTIFACT} does not apply cleanly to ` +
          `${args.source.base_commit} in ${args.worktree}: ` +
          `${applied.stderr.trim() || applied.stdout.trim() || "git apply --3way failed"}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
