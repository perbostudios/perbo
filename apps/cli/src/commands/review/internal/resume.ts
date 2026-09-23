import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CheckResultSchema,
  CriterionEvidenceBindingSchema,
  CriterionIdSchema,
  FindingSchema,
  PlanContractSchema,
  ReviewCostBasisSchema,
  ReviewIdSchema,
  type CriterionEvidenceBinding,
  type Finding,
  type PlanContract,
  type PlanContractWithCriteria,
  type ReviewArtifact,
} from "@perbo/contracts";
import { deriveDecision } from "@perbo/review";

/**
 * Resuming an unfinished review.
 *
 * A review that ends in `error` or `incomplete` leaves a record behind so the
 * criteria it never reached can be re-run without paying for the ones it did.
 * A completed review leaves nothing: the state directory only ever holds work
 * that did not finish.
 */

export const ResumeRecordSchema = z.strictObject({
  review_id: ReviewIdSchema,
  saved_at: z.iso.datetime(),
  contract: PlanContractSchema,
  diff: z.string(),
  checks: z.array(CheckResultSchema),
  repo: z.string(),
  head_commit: z.string().nullable(),
  resolved_coverage: z.array(CriterionEvidenceBindingSchema),
  resolved_findings: z.array(FindingSchema),
  unresolved: z.array(CriterionIdSchema).min(1),
  cost_micros: z.number().int().min(0),
  cost_basis: ReviewCostBasisSchema.default("provider_list_estimate"),
  model_usage: z
    .strictObject({
      input_tokens: z.number().int().min(0),
      cache_read_input_tokens: z.number().int().min(0),
      cache_creation_input_tokens: z.number().int().min(0),
      output_tokens: z.number().int().min(0),
    })
    .default({
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    }),
  latency_ms: z.number().int().min(0),
});
export type ResumeRecord = z.infer<typeof ResumeRecordSchema>;

const pathFor = (stateDir: string, reviewId: string) => join(stateDir, `${reviewId}.json`);

export function saveResumeRecord(stateDir: string, record: ResumeRecord): string {
  const path = pathFor(stateDir, record.review_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function loadResumeRecord(stateDir: string, reviewId: string): ResumeRecord {
  return ResumeRecordSchema.parse(JSON.parse(readFileSync(pathFor(stateDir, reviewId), "utf8")));
}

/** The unresolved criteria, and nothing else, as a contract of the same level. */
export function contractForUnresolved(
  contract: PlanContractWithCriteria,
  unresolved: string[],
): PlanContract {
  const wanted = new Set(unresolved);
  const remaining = contract.acceptance_criteria.filter((criterion) => wanted.has(criterion.id));
  if (remaining.length === 0) {
    throw new Error("the resumed review has no unresolved criteria left");
  }
  // A node's own criteria narrow with the plan's: one still naming a
  // resolved criterion is not a contract the schema's node/criteria check
  // would parse, and a node left with none of the unresolved criteria has
  // nothing left to gate.
  const nodes = contract.nodes
    ?.map((node) => ({ ...node, criteria: node.criteria.filter((id) => wanted.has(id)) }))
    .filter((node) => node.criteria.length > 0);
  return PlanContractSchema.parse({
    ...contract,
    acceptance_criteria: remaining,
    ...(nodes === undefined ? {} : { nodes }),
  });
}

/**
 * Fold the resumed run back into what the first run established. Findings are
 * merged by key, and the newer run wins — a stable key is exactly what makes
 * that possible.
 */
export function mergeResumed(
  record: ResumeRecord,
  fresh: ReviewArtifact,
  order: string[],
): ReviewArtifact {
  const coverage = new Map<string, CriterionEvidenceBinding>();
  for (const entry of record.resolved_coverage) coverage.set(entry.criterion_id, entry);
  for (const entry of fresh.coverage) coverage.set(entry.criterion_id, entry);

  const findings = new Map<string, Finding>();
  for (const finding of record.resolved_findings) findings.set(finding.key, finding);
  for (const finding of fresh.findings) findings.set(finding.key, finding);

  // A resumed artifact is one logical review. Its dollar total is complete
  // only when both halves have the same defensible basis. A known subtotal is
  // not carried through as if it priced the whole review.
  const costBasis: ReviewArtifact["model"]["cost_basis"] =
    record.cost_basis !== "unavailable" && record.cost_basis === fresh.model.cost_basis
      ? record.cost_basis
      : "unavailable";

  const merged = {
    ...fresh,
    coverage: order.map((id) => coverage.get(id)).filter((entry): entry is CriterionEvidenceBinding => Boolean(entry)),
    findings: [...findings.values()],
    cost_micros: costBasis === "unavailable" ? 0 : fresh.cost_micros + record.cost_micros,
    latency_ms: fresh.latency_ms + record.latency_ms,
    resumed_from: record.review_id,
    model: {
      ...fresh.model,
      input_tokens: fresh.model.input_tokens + record.model_usage.input_tokens,
      cache_read_input_tokens:
        fresh.model.cache_read_input_tokens + record.model_usage.cache_read_input_tokens,
      cache_creation_input_tokens:
        fresh.model.cache_creation_input_tokens + record.model_usage.cache_creation_input_tokens,
      output_tokens: fresh.model.output_tokens + record.model_usage.output_tokens,
      cost_basis: costBasis,
    },
  };

  return {
    ...merged,
    decision: deriveDecision({
      error: merged.error,
      coverage: merged.coverage,
      findings: merged.findings,
      // An escalation is carried on the finding itself as its routing, and a
      // merged finding set keeps it, so recounting from the findings is the
      // honest source rather than a count carried forward.
      escalations: merged.findings.filter((finding) => finding.routing === "escalates").length,
    }),
  };
}
