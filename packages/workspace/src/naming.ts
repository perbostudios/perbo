/**
 * Branch naming (docs/04, docs/07, ADR-0023 §4).
 *
 * `prb/<ticket id>/<short-slug>`, and every part of it is derived here from the
 * ticket's id and the approved plan —
 * never from anything a model said during execution. The slug comes from the
 * plan's `outcome`, which is machine-drafted and **human-confirmed at
 * approval**; it then passes through an allow-list, so even a hostile outcome
 * string cannot produce a branch name that is anything other than a branch name.
 *
 * A name is derived only for a ticket or run that has no branch yet: a branch
 * already recorded for one is a recorded identifier and is kept
 * ({@link recordedBranch}, D-098).
 */

/** The prefix a newly derived branch takes. */
export const BRANCH_PREFIX = "prb";
/** The prefix of branches recorded before `prb/`, still an attempt branch (D-098). */
export const AYO_BRANCH_PREFIX = "ayo";
export const MAX_SLUG_LENGTH = 32;

function allowListed(value: string, maxLength: number): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug;
}

export function ticketKey(ticketId: string): string {
  const key = allowListed(ticketId.replace(/^ticket_/, ""), 48);
  if (key.length === 0) throw new Error(`ticket id ${ticketId} yields no usable branch key`);
  return key;
}

/**
 * Deterministic: the same plan always produces the same branch, so a retry
 * lands on the branch its predecessor used rather than scattering work.
 */
export function shortSlug(outcome: string): string {
  const slug = allowListed(outcome, MAX_SLUG_LENGTH);
  return slug.length > 0 ? slug : "change";
}

export interface BranchNameArgs {
  /** The ticket's key, or a local run's label. */
  ticket_key: string;
  ticket_id: string;
  outcome: string;
}

export function branchName(args: BranchNameArgs): string {
  return `${BRANCH_PREFIX}/${ticketKey(args.ticket_id)}/${shortSlug(args.outcome)}`;
}

const ATTEMPT_BRANCH = new RegExp(
  `^(?:${BRANCH_PREFIX}|${AYO_BRANCH_PREFIX})/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$`,
);

/**
 * A branch this system is allowed to push to. Prohibited action 4 restricts the
 * push to the attempt's own branch, and this is the predicate that decides it.
 */
export function isAttemptBranch(branch: string): boolean {
  return ATTEMPT_BRANCH.test(branch);
}

/** Where a ticket's or a run's branch is already written down. */
export interface RecordedBranches {
  /** The delivery record's: the branch its pull request is on. */
  delivery?: string | null | undefined;
  /** The latest attempt's workspace branch, from the attempts record. */
  attempt?: string | null | undefined;
  /** A live lease's: the branch the worktree an attempt holds is on. */
  lease?: string | null | undefined;
}

/**
 * The branch already recorded for a ticket or run, or null where none is: the
 * delivery record's, then the latest attempt's, then a live lease's. Every site
 * that names a ticket's branch asks this first and derives a new name only on
 * null, so a ticket that published on `ayo/` stays there whatever its key
 * derives now.
 *
 * Only a branch the loop could have minted for this ticket or run is kept: one
 * in the loop's namespaces whose middle segment is `ticketKey(ticketId)`. A
 * direct arm's `direct/…` delivery is outside those namespaces, and a branch
 * under another id is another ticket's; both are passed over.
 */
export function recordedBranch(recorded: RecordedBranches, ticketId: string): string | null {
  const own = ticketKey(ticketId);
  for (const branch of [recorded.delivery, recorded.attempt, recorded.lease]) {
    if (typeof branch === "string" && isAttemptBranch(branch) && branch.split("/")[1] === own) return branch;
  }
  return null;
}
