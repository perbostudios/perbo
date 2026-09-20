import {
  checksForNode,
  hasAcceptanceCriteria,
  matchesAny,
  parseUnifiedDiff,
  planNodes,
  wholeChangeChecks,
  ReviewArtifactSchema,
  type CheckResult,
  type CoverageStatus,
  type CriterionEvidenceBinding,
  type Finding,
  type NodeId,
  type PlanNode,
  type ReviewArtifact,
  type VerificationStrength,
} from "@perbo/contracts";
import type { Model } from "@perbo/model";
import { deriveDecision, escalationCount, runReview, type ReviewInput, type ReviewOutcome } from "./review.js";

/**
 * One node's review beside the whole change's, and the gate's combined view
 * of both (D-107). `nodes` is empty for a flat contract, and `combined` is
 * then `overall.artifact` itself — not a copy, so a flat ticket reviews
 * exactly as it did before this existed.
 */
export interface GraphReviewOutcome {
  overall: ReviewOutcome;
  nodes: Array<{ node_id: NodeId; outcome: ReviewOutcome | null }>;
  combined: ReviewArtifact;
}

export interface ReviewGraphOptions {
  /**
   * Builds the model a node or overall call uses, from that call's own
   * contract and checks. The transport binds a verdict schema to the
   * contract it is built for (`reviewerModel`, `perbo review`'s `schema`),
   * so a model shared across every call would offer a node's call a schema
   * demanding every criterion and every check id in the full plan and reject
   * what that node's own, narrower review submits. Absent, every call reuses
   * `input.model` unchanged, as before this existed.
   */
  modelFor?: (contract: ReviewInput["contract"], checks: readonly CheckResult[]) => Model;
}

/**
 * Review a ticket's execution graph: that node's criteria, the part of the
 * diff inside its paths, and that node's check results, once per node — in
 * plan order, sequentially — and once more over the whole change, unnarrowed.
 * The gate reads `combined` (`combineReviews`), never `overall` alone, so a
 * node-local blocking finding can close it on its own (D-107).
 *
 * `run` is `runReview` by default; the runner passes its own `hooks.review`
 * double instead, and every call — node or overall — goes through it.
 */
export async function reviewGraph(
  input: ReviewInput,
  run: (input: ReviewInput) => Promise<ReviewOutcome> = runReview,
  options?: ReviewGraphOptions,
): Promise<GraphReviewOutcome> {
  const graphNodes = planNodes(input.contract);
  if (graphNodes.length === 0) {
    // Never handed a built model: a flat plan has no node to build one for,
    // and this is the one call a flat ticket has always made, on the input
    // the caller built — the same object, unless its checks name a node this
    // flat plan does not have (`narrowedToWholeChange`).
    const overall = await run(narrowedToWholeChange(input));
    return { overall, nodes: [], combined: overall.artifact };
  }

  const nodes: Array<{ node_id: NodeId; outcome: ReviewOutcome | null }> = [];
  for (const node of graphNodes) {
    const sliced = sliceForNode(input, node);
    const nodeInput =
      sliced && options?.modelFor ? { ...sliced, model: options.modelFor(sliced.contract, sliced.checks) } : sliced;
    nodes.push({ node_id: node.id, outcome: nodeInput ? await run(nodeInput) : null });
  }
  // The overall call keeps the caller's contract, diff and change set
  // untouched — a path `scope.paths_allowed` admits that no node's paths
  // match is in this call's change set and in no node's (AC4) — and narrows
  // only `checks`, to the whole-change results, exactly as a flat ticket's
  // one review always has.
  const wholeChangeInput = narrowedToWholeChange(input);
  const overallInput = options?.modelFor
    ? { ...wholeChangeInput, model: options.modelFor(input.contract, wholeChangeInput.checks) }
    : wholeChangeInput;
  const overall = await run(overallInput);
  const combined = combineReviews(overall, nodes);
  return { overall, nodes, combined };
}

/**
 * `input` with `checks` narrowed to the whole-change results. Returns `input`
 * itself, unchanged, where nothing was tagged to a node — which is every
 * `checks` a flat ticket's own run ever builds — so the common call stays the
 * same object the caller passed, and only a checks file carrying a stray
 * node tag is ever rebuilt.
 */
function narrowedToWholeChange(input: ReviewInput): ReviewInput {
  const filtered = wholeChangeChecks(input.checks);
  return filtered.length === input.checks.length ? input : { ...input, checks: filtered };
}

/**
 * A node's own `ReviewInput`: the caller's input with its contract narrowed
 * to that node's criteria, its diff and change set narrowed to the files
 * inside that node's paths, and its checks narrowed to that node's own
 * results — nothing else changed. Null where no file falls inside the
 * node's paths: that node is not reviewed on its own, and the overall
 * review judges its criteria instead.
 */
function sliceForNode(input: ReviewInput, node: PlanNode): ReviewInput | null {
  const files = (input.changeset?.files ?? parseUnifiedDiff(input.diff)).filter((file) =>
    matchesAny(file.path, node.paths),
  );
  if (files.length === 0) return null;
  return {
    ...input,
    contract: contractForNode(input.contract, node),
    diff: files.map((file) => file.patch).join("\n"),
    changeset: input.changeset ? { ...input.changeset, files } : undefined,
    checks: checksForNode(input.checks, node.id),
  };
}

/** `contract`, its criteria narrowed to one node's and its graph removed. */
function contractForNode(contract: ReviewInput["contract"], node: PlanNode): ReviewInput["contract"] {
  if (!hasAcceptanceCriteria(contract)) return contract;
  return {
    ...contract,
    acceptance_criteria: contract.acceptance_criteria.filter((criterion) =>
      node.criteria.includes(criterion.id),
    ),
    nodes: undefined,
  };
}

const COVERAGE_STATUS_RANK: Record<CoverageStatus, number> = {
  met: 0,
  not_met: 1,
  cannot_determine: 2,
};

const VERIFICATION_STRENGTH_RANK: Record<VerificationStrength, number> = {
  directly_verified: 0,
  proxy: 1,
  asserted_only: 2,
};

/**
 * The stricter of two coverage entries for the same criterion (D-107): the
 * worse status wins, then the weaker evidence, then `a` — which
 * `combineReviews` always calls with the overall's entry first, so a tie
 * keeps the overall's, whole.
 */
function stricterCoverage(
  a: CriterionEvidenceBinding,
  b: CriterionEvidenceBinding,
): CriterionEvidenceBinding {
  const byStatus = COVERAGE_STATUS_RANK[b.status] - COVERAGE_STATUS_RANK[a.status];
  if (byStatus !== 0) return byStatus > 0 ? b : a;
  const byStrength =
    VERIFICATION_STRENGTH_RANK[b.verification_strength] -
    VERIFICATION_STRENGTH_RANK[a.verification_strength];
  return byStrength > 0 ? b : a;
}

/** The first occurrence of each key, in order — how `checks` and `context_manifest` are unioned below. */
function dedupeByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * How strictly the gate (`deriveDecision`) treats a finding, low to high:
 * blocking first, then routed `escalates`, then `remediable`, then anything
 * else (`advisory`, `waived`) — `deriveDecision`'s own precedence (a blocking
 * finding forces `changes_requested` before `escalations` is even read; an
 * escalation outranks `remediable`), read back off one finding instead of a
 * list.
 */
function gateRank(finding: Finding): number {
  if (finding.blocking) return 0;
  if (finding.routing === "escalates") return 1;
  if (finding.routing === "remediable") return 2;
  return 3;
}

/**
 * The first occurrence of each finding key, in its first-seen position — but
 * where a later finding under that key outranks the kept one (`gateRank`),
 * the later one is kept instead. Findings are the one place a repeated key
 * can carry two different readings of the same defect, and dropping the
 * second unconditionally would let a node's stricter reading lose to the
 * overall call's weaker one under the same key — the one gap in "the
 * stricter reading wins" (`combineReviews`'s doc comment). Two readings of
 * equal rank keep the first, same as `dedupeByKey`.
 */
function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const kept = new Map<string, Finding>();
  const order: string[] = [];
  for (const finding of findings) {
    const existing = kept.get(finding.key);
    if (existing === undefined) {
      kept.set(finding.key, finding);
      order.push(finding.key);
    } else if (gateRank(finding) < gateRank(existing)) {
      kept.set(finding.key, finding);
    }
  }
  return order.map((key) => kept.get(key)!);
}

/**
 * The gate's combined view of a graphed ticket's reviews (D-107), built from
 * the overall artifact: `findings` is the overall's then each reviewed
 * node's, in order, a repeated key resolved to the reading the gate treats
 * as stricter — blocking, then escalating, then remediable (`dedupeFindings`,
 * `gateRank`) — or, among equal ranks, the first; `coverage` keeps, for each
 * of the overall contract's criteria, the stricter of the overall's entry
 * and the owning node's where one reviewed it; `error` is the overall's,
 * else the first node's; `decision` is `deriveDecision` over that
 * combination, unchanged; `cost_micros`, `latency_ms` and every one of
 * `model`'s token fields are summed over every call made — `model`'s
 * `provider`, `model_id`, `prompt_version` and `cost_basis` stay the
 * overall's, the last exact only where every call shared it (no "mixed"
 * member exists to mark one that did not); `checks` and `context_manifest`
 * are unioned, deduplicated on the key each already carries;
 * `rejected_verdicts` and `overrides` are concatenated; every other field is
 * the overall's. The stricter reading wins wherever the overall review and a
 * node's judged the same criterion or found the same defect.
 */
export function combineReviews(
  overall: ReviewOutcome,
  nodes: readonly { node_id: NodeId; outcome: ReviewOutcome | null }[],
): ReviewArtifact {
  const nodeArtifacts = nodes.flatMap((entry) => (entry.outcome ? [entry.outcome.artifact] : []));
  const all = [overall.artifact, ...nodeArtifacts];
  const sumTokens = (pick: (artifact: ReviewArtifact) => number) =>
    all.reduce((sum, artifact) => sum + pick(artifact), 0);

  const findings = dedupeFindings(all.flatMap((artifact) => artifact.findings));
  const coverage = overall.artifact.coverage.map((entry) =>
    nodeArtifacts
      .flatMap((artifact) =>
        artifact.coverage.filter((candidate) => candidate.criterion_id === entry.criterion_id),
      )
      .reduce(stricterCoverage, entry),
  );
  const error =
    overall.artifact.error ?? nodeArtifacts.find((artifact) => artifact.error !== null)?.error ?? null;
  const decision = deriveDecision({
    error,
    coverage,
    findings,
    escalations: escalationCount(findings),
  });

  return ReviewArtifactSchema.parse({
    ...overall.artifact,
    checks: dedupeByKey(
      all.flatMap((artifact) => artifact.checks),
      (check) => check.check_id,
    ),
    context_manifest: dedupeByKey(
      all.flatMap((artifact) => artifact.context_manifest),
      (item) => item.id,
    ),
    coverage,
    findings,
    rejected_verdicts: all.flatMap((artifact) => artifact.rejected_verdicts),
    overrides: all.flatMap((artifact) => artifact.overrides),
    decision,
    error,
    cost_micros: all.reduce((sum, artifact) => sum + artifact.cost_micros, 0),
    latency_ms: all.reduce((sum, artifact) => sum + artifact.latency_ms, 0),
    model: {
      ...overall.artifact.model,
      input_tokens: sumTokens((artifact) => artifact.model.input_tokens),
      cache_read_input_tokens: sumTokens((artifact) => artifact.model.cache_read_input_tokens),
      cache_creation_input_tokens: sumTokens((artifact) => artifact.model.cache_creation_input_tokens),
      output_tokens: sumTokens((artifact) => artifact.model.output_tokens),
      // provider, model_id, prompt_version and cost_basis come from the
      // spread above — the overall's own. ReviewCostBasisSchema has no
      // "mixed" member to mark a graphed review whose calls used different
      // bases, so cost_basis stays the overall's whether or not every call
      // agreed with it.
    },
  });
}
