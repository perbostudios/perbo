import { z } from "zod";
import { GREEN_CHECK_CONCLUSIONS } from "./github.js";
import { commitCarriesLoopAttempt } from "./unattended.js";

/**
 * The loop merging the pull request it opened (SCP-202, D-077).
 *
 * D-041's answer was **never**: the executor and the reviewer are the same
 * system, and auto-merge collapses the independence the verification gate
 * depends on. D-077 changes that for the integration branch only, and only
 * once the loop has cleared D-076's bar — so the mechanism is built behind
 * `merge` in the repository configuration, whose default is a person's click,
 * and D-041 stands for `main` and for any customer repository.
 *
 * What is here is the decision and nothing else: which conditions a merge
 * needs, read from facts a caller gathered, with no process, no network and no
 * clock. The `gh` reads and the merge itself are the runner's, because the
 * runner holds the credential — the same division as the push.
 *
 * The six conditions are D-073's rule applied to the loop itself. Each is its
 * own stop with its own rule id, because "it did not merge" is not something a
 * person can act on: what they need is which of the six was missing.
 */

export const MERGE_MODES = ["person", "loop"] as const;
export const MergeModeSchema = z.enum(MERGE_MODES);
export type MergeMode = z.infer<typeof MergeModeSchema>;

/**
 * The default, and it is the decision rather than a convenience: D-077 is
 * decided *in principle*, effective when D-076's bar is read, and until then
 * every repository — this one included — merges by a person's click.
 */
export const DEFAULT_MERGE_MODE: MergeMode = "person";

export const LOOP_MERGE_RULE_IDS = [
  /** The switch is `person`: the merge is not the loop's to make here. */
  "merge.switch_is_person",
  /** Another loop merge holds this base. Phase 1 is serial; the queue is SCP-227. */
  "merge.in_flight",
  /** There is no open pull request on the branch to merge. */
  "merge.no_pull_request",
  /** No separate review run left a D-073 APPROVE verdict on this pull request. */
  "merge.no_separate_approval",
  /** A required check on the head is not green, or there is none to read. */
  "merge.checks_not_green",
  /** GitHub does not report the branch as mergeable into its base. */
  "merge.not_mergeable",
  /** A commit on the branch carries no loop attempt trailer. */
  "merge.commit_outside_loop",
  /** A commit on the branch has no verified signature. */
  "merge.unverified_signature",
  /** The approval names a head that is no longer the head. */
  "merge.head_moved_after_approval",
  /** The read taken immediately before the merge disagreed with the decision's. */
  "merge.base_moved",
  /** `gh pr merge` itself refused. */
  "merge.refused_by_github",
] as const;
export const LoopMergeRuleIdSchema = z.enum(LOOP_MERGE_RULE_IDS);
export type LoopMergeRuleId = z.infer<typeof LoopMergeRuleIdSchema>;

/** Why the loop did not merge: the rule that stopped it, and what it read. */
export interface LoopMergeStop {
  rule_id: LoopMergeRuleId;
  /**
   * One sentence naming the condition and the value that failed it, in words
   * somebody running this on their own repository can act on: no decision or
   * ticket identifier, which would name a document they do not have.
   */
  statement: string;
}

export type LoopMergeDecision =
  | {
      merge: true;
      /**
       * The head the approval named. The current head where it named it
       * directly; an earlier head of the same branch where the approval was
       * carried forward across a clean re-level (see {@link CarriedApproval}).
       */
      approved_head?: string;
    }
  | ({ merge: false } & LoopMergeStop);

const stop = (rule_id: LoopMergeRuleId, statement: string): LoopMergeDecision => ({
  merge: false,
  rule_id,
  statement,
});

/**
 * The switch, on its own: null where the loop may go on to read the pull
 * request, and the stop where the merge is a person's.
 *
 * Separate from the six conditions because it is answered before anything is
 * read — a repository that merges by hand spends no credential being told so —
 * and stating it in one place is what keeps the sentence the same wherever it
 * is said.
 */
export function mergeSwitchStop(mode: MergeMode): LoopMergeStop | null {
  if (mode === "loop") return null;
  return {
    rule_id: "merge.switch_is_person",
    statement:
      'the `merge` switch is "person", so this merge is a person\'s click: the pull request is ' +
      "open and waiting for one",
  };
}

/**
 * The D-073 verdict comment a separate review run leaves on the pull request:
 *
 *     **D-073 review — <model> — verdict: APPROVE** (head `<sha>`)
 *
 * The em dash is the separator and nothing else is, because a model name
 * carries hyphens (`claude-opus-5`) and a hyphen separator would split inside
 * one. Anything a comment says outside this shape is a person talking on a
 * pull request, which is data.
 *
 * The verdict may be more than one word: the two a review leaves are `APPROVE`
 * and {@link D073_CHANGES_REQUESTED}, and a reader that stopped at the first
 * word read every comment carrying the second as no verdict at all.
 */
const D073_VERDICT =
  /\*\*D-073 review\s*—\s*([^—*]+?)\s*—\s*verdict:\s*([A-Za-z_]+(?:\s+[A-Za-z_]+)*)\s*\*\*\s*\(head\s*`([0-9a-fA-F]{7,40})`\)/g;

/**
 * The verdict that closes the gate, spelled once.
 *
 * `perbo sync` reads it off a closed pull request to decide where the ticket
 * behind it goes (D-083), and this is the string both that reading and this
 * file's own decision compare against.
 */
export const D073_CHANGES_REQUESTED = "CHANGES REQUESTED";

export interface D073Verdict {
  model: string;
  /** `APPROVE`, or whatever else the comment said — never normalised away. */
  verdict: string;
  /** The head the verdict names, as the comment abbreviated it. */
  head: string;
}

/** Every D-073 verdict a comment body carries, in the order it carries them. */
export function readD073Verdicts(body: string): D073Verdict[] {
  const found: D073Verdict[] = [];
  for (const match of body.matchAll(D073_VERDICT)) {
    found.push({
      model: match[1]!.trim(),
      // Whitespace inside a multi-word verdict is collapsed to one space, so a
      // comment that wrapped the line reads as the same verdict as one that
      // did not.
      verdict: match[2]!.trim().replace(/\s+/g, " ").toUpperCase(),
      head: match[3]!.toLowerCase(),
    });
  }
  return found;
}

/**
 * Whether two shas name the same commit, by prefix in either direction.
 *
 * Seven characters is the shortest either side may be: a comment abbreviates
 * the head, and a prefix shorter than that names too many commits to be an
 * approval of one.
 */
function shaMatches(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** One check on the head, as `gh`'s status rollup reports it. */
export interface LoopMergeCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

/** One commit on the branch: its own message, and whether its signature verifies. */
export interface LoopMergeCommit {
  sha: string;
  /** Headline and body together, which is where the attempt trailer lives. */
  message: string;
  /** `verification.verified` from the commits API; null where it named none. */
  verified: boolean | null;
}

/**
 * An approval that named an earlier head of this branch, and what the runner
 * established about whether it still describes the head now (SCP-227).
 *
 * The queue keeps every open branch level with its base, and each re-level is
 * a commit that moves the head. An approval bound to a head sha alone would
 * be spent by every one of them, so it is bound to what was approved: the
 * change set's content — the branch's diff against its base — and the paths
 * in the contract's scope. A re-level that leaves the content byte-identical
 * and brought in no base commit touching the scope is one a person would
 * accept without re-reading, and the approval carries; anything else needs a
 * fresh one, which a resolved conflict always does by construction.
 *
 * Every field is the runner's reading of local git, never `gh`'s, and never a
 * model's.
 */
export interface CarriedApproval {
  /** The head the approval named, resolved to the full sha. */
  head: string;
  /** Whether the branch's diff against its base is byte-identical at that head and at the head now. */
  content_equal: boolean;
  /**
   * The paths the base advanced over between the two heads' bases that lie
   * inside the contract's scope. Empty is what carries; anything named here is
   * a base change the approved review never saw beside this change.
   */
  scope_touched: readonly string[];
}

/** What one read of the pull request establishes. Every field comes from `gh`. */
export interface LoopMergeObservation {
  state: "none" | "open" | "merged" | "closed";
  head_sha: string | null;
  base_ref: string | null;
  mergeable: "mergeable" | "conflicting" | "unknown" | null;
  checks: readonly LoopMergeCheck[];
  /** Every comment body on the pull request. Read for D-073 verdicts, nothing else. */
  comments: readonly string[];
  commits: readonly LoopMergeCommit[];
  /**
   * For each approval that named a head other than the current one: whether
   * it carries. Absent where the runner could not read the branch locally,
   * which fails closed — an approval that cannot be shown to carry does not.
   */
  carried_approvals?: readonly CarriedApproval[];
}

/**
 * Whether the loop may merge this pull request, and if not, which condition
 * stopped it.
 *
 * The order is the order a person would want to be told about: the switch
 * first, because it costs nothing to read and answers the whole question; then
 * whether there is a pull request at all; then the six conditions.
 *
 * **The approval is two conditions, not one.** "There is a separate review
 * run's APPROVE verdict" and "it names the head that is about to merge" fail
 * for different reasons and ask a person for different things — the first for
 * a review, the second for one of the head that moved under it — so each has
 * its own rule id. Together they are the single sentence D-077 states: the
 * approval must name the current head.
 *
 * Every absence fails closed. A pull request with no check reported is not one
 * whose checks are green, and a commit the commits API named no verification
 * for is not one whose signature verified: in both, the missing answer is the
 * evidence that is missing.
 */
export function loopMergeDecision(args: {
  mode: MergeMode;
  observed: LoopMergeObservation;
}): LoopMergeDecision {
  const { observed } = args;
  const switched = mergeSwitchStop(args.mode);
  if (switched !== null) return { merge: false, ...switched };

  if (observed.state !== "open" || observed.head_sha === null) {
    return stop(
      "merge.no_pull_request",
      `there is no open pull request to merge: \`gh\` reports ${observed.state}` +
        (observed.head_sha === null ? " and named no head commit" : ""),
    );
  }
  const head = observed.head_sha;

  const verdicts = observed.comments.flatMap((body) => readD073Verdicts(body));
  const approvals = verdicts.filter((one) => one.verdict === "APPROVE");
  if (approvals.length === 0) {
    return stop(
      "merge.no_separate_approval",
      verdicts.length === 0
        ? "no comment on this pull request carries a review verdict, so no separate review run " +
          "has approved the head"
        : `the only review verdict(s) on this pull request are ${[...new Set(verdicts.map((one) => one.verdict))].join(", ")}`,
    );
  }

  const notGreen = observed.checks.filter(
    (check) =>
      check.conclusion === null ||
      !GREEN_CHECK_CONCLUSIONS.includes(check.conclusion.toUpperCase() as never),
  );
  if (observed.checks.length === 0 || notGreen.length > 0) {
    return stop(
      "merge.checks_not_green",
      observed.checks.length === 0
        ? `\`gh\` reports no check at all on ${head.slice(0, 12)}, which is not evidence that the ` +
          "required checks passed"
        : `${notGreen.length} check(s) on ${head.slice(0, 12)} are not green: ` +
          notGreen.map((check) => `${check.name} ${check.conclusion ?? check.status}`).join(", "),
    );
  }

  if (observed.mergeable !== "mergeable") {
    return stop(
      "merge.not_mergeable",
      `GitHub reports this pull request as ${observed.mergeable ?? "unread"} rather than mergeable`,
    );
  }

  if (observed.commits.length === 0) {
    return stop(
      "merge.commit_outside_loop",
      "`gh` named no commit on this pull request, so there is nothing to read the loop's attempt " +
        "trailer on",
    );
  }
  const outside = observed.commits.filter((commit) => !commitCarriesLoopAttempt(commit.message));
  if (outside.length > 0) {
    return stop(
      "merge.commit_outside_loop",
      `${outside.length} commit(s) on this branch carry no loop attempt trailer: ` +
        outside.map((commit) => commit.sha.slice(0, 12)).join(", "),
    );
  }

  const unverified = observed.commits.filter((commit) => commit.verified !== true);
  if (unverified.length > 0) {
    return stop(
      "merge.unverified_signature",
      `${unverified.length} commit(s) on this branch have no verified signature: ` +
        unverified.map((commit) => commit.sha.slice(0, 12)).join(", "),
    );
  }

  const naming = approvals.find((one) => shaMatches(one.head, head));
  if (naming !== undefined) return { merge: true, approved_head: head };

  // The head moved. An approval of an earlier head carries only where the
  // runner established that what was approved is what is here: the same
  // content, and no base commit inside the scope brought in between.
  const carried = (observed.carried_approvals ?? []).filter((entry) =>
    approvals.some((one) => shaMatches(one.head, entry.head)),
  );
  const carries = carried.find((entry) => entry.content_equal && entry.scope_touched.length === 0);
  if (carries !== undefined) return { merge: true, approved_head: carries.head };

  const named = approvals.map((one) => one.head).join(", ");
  const why =
    carried.length === 0
      ? "something reached this branch after the approval"
      : carried.some((entry) => entry.content_equal)
        ? "the base was merged in and touched " +
          `${[...new Set(carried.flatMap((entry) => entry.scope_touched))].slice(0, 5).join(", ")} ` +
          "inside the change's own scope, which the approved review never saw beside it"
        : "the change set's content is no longer what was approved";
  return stop(
    "merge.head_moved_after_approval",
    `the approval names head ${named}, and the head now is ${head.slice(0, 12)}: ${why}`,
  );
}

/**
 * Whether the read taken immediately before the merge still supports it
 * (SCP-202 criterion 3).
 *
 * A base that moved between the decision and the merge is a stop rather than a
 * conflict landed, and it is a stop of its own: the six conditions were all
 * true when they were read, and what changed is the pull request underneath
 * them.
 */
export function reReadStillMerges(args: {
  decided: LoopMergeObservation;
  now: LoopMergeObservation;
}): LoopMergeDecision {
  const { decided, now } = args;
  if (now.state !== "open") {
    return stop("merge.base_moved", `the pull request is ${now.state} at the moment of the merge`);
  }
  if (now.head_sha !== decided.head_sha) {
    return stop(
      "merge.base_moved",
      `the head moved from ${(decided.head_sha ?? "none").slice(0, 12)} to ` +
        `${(now.head_sha ?? "none").slice(0, 12)} between the decision and the merge`,
    );
  }
  if (now.mergeable !== "mergeable") {
    return stop(
      "merge.base_moved",
      `GitHub reported this pull request as ${now.mergeable ?? "unread"} at the moment of the ` +
        "merge: the base moved under it",
    );
  }
  return { merge: true };
}
