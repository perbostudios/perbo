import { matchesAny } from "@perbo/contracts/browser";
import type { VerificationStrength } from "@perbo/contracts";
import type {
  GraphCriterionState,
  GraphLiveView,
  GraphNodeLive,
  GraphNodeState,
} from "./protocol.js";

/** One node of the plan, as the live read needs it: its globs and its criteria. */
export interface LiveNodeInput {
  id: string;
  paths: readonly string[];
  criteria: readonly string[];
}
/** One pinned check, and the node the loop narrowed it to (D-107). */
export interface LiveCheck {
  name: string;
  status: string;
  node: { id: string; scope: string | undefined } | null;
}
/** The review artifact on record, as this derivation reads one. */
export interface LiveReview {
  /**
   * The plan it judged. A criterion id is only unique within a plan version —
   * a re-draft from the spec renumbers them — so a review of an older version
   * is not an account of these criteria. Undefined is read as the plan it is
   * beside.
   */
  planVersion: number | undefined;
  /** When it was recorded, which is what a closure has to be no older than. */
  createdAt: string;
  coverage: readonly {
    criterion_id: string;
    status: "met" | "not_met" | "cannot_determine";
    verification_strength?: VerificationStrength | undefined;
    evidence?:
      | { ref?: string | null | undefined; location?: { file: string; line?: number | null | undefined } | null | undefined }
      | null
      | undefined;
  }[];
  findings: readonly {
    key?: string | undefined;
    criterion_id?: string | null | undefined;
    status?: string | undefined;
    statement?: string | undefined;
  }[];
}
/** Everything the records say, read and parsed, with nothing derived from it yet. */
export interface LiveRecords {
  /** The latest attempt on record, or null before a ticket has run. */
  attempt: string | null;
  /** The sealed change set's paths, or null where its bytes could not be read. */
  changed: readonly string[] | null;
  /** The latest attempt carries a changeset id, so a change set was sealed. */
  sealed: boolean;
  checks: readonly LiveCheck[];
  review: LiveReview | null;
  /** Every closure verification on record, each naming the findings it closed (D-061). */
  closures: readonly { createdAt: string; closed: readonly string[] }[];
}

/**
 * How a node's records are read into one state (D-100, SCP-317):
 * {@link ../shared/protocol.js#GRAPH_NODE_STATES} in precedence order, the
 * most conclusive record first, and the first that holds is the node's.
 */
function nodeState(node: {
  touched: readonly string[];
  ran: readonly { status: string }[];
  criteria: readonly GraphCriterionState[];
}): GraphNodeState {
  if (node.criteria.some((criterion) => criterion.finding !== null)) return "finding_open";
  if (node.ran.some((check) => check.status !== "passed")) return "checks_failed";
  if (node.criteria.length > 0 && node.criteria.every((criterion) => criterion.state === "met"))
    return "covered";
  if (node.ran.length > 0) return "checks_passed";
  return node.touched.length > 0 ? "changed" : "untouched";
}

/**
 * What a run's records say about a plan's execution graph (D-100, SCP-317).
 *
 * The records and no others: the sealed change set, whose paths say which of a
 * node's globs the branch has touched; the pinned checks, each carrying the
 * node it was narrowed to (D-107); the review artifact's evidence bindings,
 * which are the only account of a criterion's state that is not the executor's
 * own, read only where that review judged the plan the ticket now carries; and
 * the verifications the rounds since have recorded beside it, because a review
 * artifact is immutable and a finding it opened would otherwise read open for
 * ever (D-061). The executor's transcript and its account of its own change
 * are in the same bundle and are read by nothing here, which is the rule
 * [ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md) states
 * and the reason this exists.
 *
 * Here rather than beside either caller because two derive it: the host from a
 * repository's own records, and the sample host from its sample ones. A second
 * copy would be a second answer to one question.
 */
export function assembleLiveGraph(
  nodes: readonly LiveNodeInput[],
  records: LiveRecords,
  planVersion: number | undefined,
): GraphLiveView {
  const changed = records.changed ?? [];
  // A change set was sealed and its bytes are not here to read: withheld above
  // the reviewable cap, or not retained. Saying so is the difference between a
  // node nobody touched and a node nothing could be read about.
  const note =
    records.sealed && records.changed === null
      ? "This attempt's sealed change set is not in the bundle store, so no path could be read from it."
      : null;

  const reviewed = records.review;
  const stale =
    reviewed?.planVersion !== undefined &&
    planVersion !== undefined &&
    reviewed.planVersion !== planVersion;
  const review = stale ? null : reviewed;
  const reviewNote = stale
    ? "The plan has been re-drafted since it was reviewed, so the review on record is not an account " +
      "of these criteria."
    : null;

  // What the rounds since that review closed. A review artifact is immutable,
  // so a finding it opened reads open for ever unless the closures beside it
  // are read too (D-061) — every one of them, because a round's list names
  // only what that round closed, and only those made after the review, so a
  // finding a later review raised again is not answered by an older closure.
  const since = reviewed?.createdAt ?? "";
  const closed = new Set(
    records.closures
      .filter((closure) => closure.createdAt.localeCompare(since) >= 0)
      .flatMap((closure) => closure.closed),
  );
  const bound = new Map((review?.coverage ?? []).map((entry) => [entry.criterion_id, entry]));
  const open = new Map<string, string>();
  for (const finding of review?.findings ?? [])
    if (
      finding.criterion_id &&
      finding.status === "open" &&
      finding.statement &&
      !(finding.key && closed.has(finding.key))
    )
      open.set(finding.criterion_id, open.get(finding.criterion_id) ?? finding.statement);

  return {
    attempt: records.attempt,
    nodes: nodes.map((node): GraphNodeLive => {
      const touched = changed.filter((path) => matchesAny(path, node.paths)).sort();
      // A run the loop could not narrow to this node is the whole command with
      // the node's name on it: the loop runs every pinned check once per node
      // for every node, so a node the change never reached has one, it passes,
      // and counting it would read that node as further along than a node the
      // change did reach (D-107).
      const ran = records.checks
        .filter((check) => check.node?.id === node.id && check.node.scope === "files")
        .map((check) => ({ name: check.name, status: check.status }));
      const criteria = node.criteria.map((id): GraphCriterionState => {
        const binding = bound.get(id);
        const location = binding?.evidence?.location ?? null;
        return {
          id,
          state: binding?.status ?? "unbound",
          strength: binding?.verification_strength ?? null,
          evidence: location
            ? location.line
              ? `${location.file}:${location.line}`
              : location.file
            : (binding?.evidence?.ref ?? null),
          finding: open.get(id) ?? null,
        };
      });
      return { id: node.id, state: nodeState({ touched, ran, criteria }), changed: touched, criteria, checks: ran };
    }),
    // A flat plan has no node for a path to be outside of, so nothing is: its
    // whole change set is the change, and the task screen is where it is read.
    outside:
      nodes.length === 0
        ? []
        : changed.filter((path) => !nodes.some((node) => matchesAny(path, node.paths))).sort(),
    note: note ?? reviewNote,
  };
}
