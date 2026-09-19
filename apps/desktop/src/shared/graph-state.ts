import type { GraphCriterionState, GraphNodeState } from "./protocol.js";

/**
 * How a node's records are read into one state (D-100, SCP-317):
 * {@link GRAPH_NODE_STATES} in precedence order, the most conclusive record
 * first, and the first that holds is the node's.
 *
 * Here rather than beside either caller because two derive it: the host from a
 * repository's own records, and the browser preview from its sample ones. A
 * second copy would be a second answer to one question.
 */
export function nodeState(node: {
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
