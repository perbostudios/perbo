import { z } from "zod";
import {
  CommitShaSchema,
  ContextManifestHashSchema,
  CriterionIdSchema,
  NodeIdSchema,
  PlanIdSchema,
  RepositoryIdSchema,
  RequirementIdSchema,
  TicketIdSchema,
} from "./ids.js";
import { insideAllowedPaths } from "./paths.js";

/**
 * The plan contract (docs/04, docs/14, ADR-0016, SCP-009).
 *
 * The P1 body is exactly `outcome`, `acceptance_criteria`, `scope` and `base`.
 * Every object here is strict, which is what makes `steps`, `alternatives`,
 * `assumptions` and `problem_statement` *unrepresentable* rather than
 * discouraged — a soft rule would not survive contact with a model that likes
 * writing prose.
 */

export const PLAN_LEVELS = ["P0", "P1", "P2", "P3"] as const;
export const PlanLevelSchema = z.enum(PLAN_LEVELS);
export type PlanLevel = (typeof PLAN_LEVELS)[number];

export const VERIFICATION_KINDS = ["test", "query", "metric", "artifact", "manual"] as const;
export const VerificationKindSchema = z.enum(VERIFICATION_KINDS);
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

/**
 * What must be PROVEN — never where the proof will live. At approval the test
 * usually does not exist, so a selector here produces invented paths. The
 * binding to real evidence is `CriterionEvidenceBinding`, produced by review.
 */
export const ExpectedVerificationSchema = z
  .strictObject({
    kind: VerificationKindSchema,
    assertion: z.string().min(1),
    // `manual` alone carries these two, because a criterion nobody can
    // automate needs a name against it and a reason it is not automatable.
    manual_reviewer: z.string().min(1).optional(),
    manual_reason: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "manual") {
      if (value.manual_reviewer === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["manual_reviewer"],
          message: "expected_verification.kind 'manual' requires a named reviewer",
        });
      }
      if (value.manual_reason === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["manual_reason"],
          message: "expected_verification.kind 'manual' requires a reason it cannot be automated",
        });
      }
      return;
    }
    if (value.manual_reviewer !== undefined || value.manual_reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "manual_reviewer and manual_reason are only valid when kind is 'manual'",
      });
    }
  });
export type ExpectedVerification = z.infer<typeof ExpectedVerificationSchema>;

export const AcceptanceCriterionSchema = z.strictObject({
  id: CriterionIdSchema,
  text: z.string().min(1),
  expected_verification: ExpectedVerificationSchema,
  /**
   * The spec requirement this criterion was drafted from (D-103). Optional: a
   * plan drafted from an issue has no spec and carries none. Which id a spec
   * actually holds is not knowable here — {@link unknownRequirementIds} is the
   * check, and the caller supplies the set.
   */
  requirement_id: RequirementIdSchema.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

const AcceptanceCriteriaSchema = z
  .array(AcceptanceCriterionSchema)
  .min(1)
  .superRefine((criteria, ctx) => {
    const seen = new Set<string>();
    for (const [index, criterion] of criteria.entries()) {
      if (seen.has(criterion.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `duplicate criterion id ${criterion.id}`,
        });
      }
      seen.add(criterion.id);
    }
  });

/**
 * One part of an execution graph: a group of the plan's acceptance criteria and
 * the paths expected to satisfy them (D-100, ADR-0037).
 *
 * Strict like everything else here, so a node cannot grow steps, an estimate or
 * an order of its own: the order between nodes is approach and lives in the
 * approach record, not in the contract.
 */
export const PlanNodeSchema = z
  .strictObject({
    id: NodeIdSchema,
    title: z.string().min(1),
    criteria: z.array(CriterionIdSchema).min(1),
    paths: z.array(z.string().min(1)).min(1),
  })
  .superRefine((node, ctx) => {
    const seen = new Set<string>();
    for (const [index, id] of node.criteria.entries()) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria", index],
          message: `node ${node.id} names criterion ${id} twice`,
        });
      }
      seen.add(id);
    }
  });
export type PlanNode = z.infer<typeof PlanNodeSchema>;

export const ScopeSchema = z.strictObject({
  repository_id: RepositoryIdSchema,
  paths_allowed: z.array(z.string().min(1)).min(1),
  paths_prohibited: z.array(z.string().min(1)),
  /** Exempt from scope accounting: lockfiles and codegen would otherwise fire on every change. */
  generated_paths: z.array(z.string().min(1)),
  /**
   * Optional, keyed by a glob over `generated_paths`: the files whose change
   * explains a change to the generated output. A generated file matching a key
   * that changes with **no** declared source in the same diff is a
   * deterministic blocking finding (D-062) — either a hand edit regeneration
   * will erase, or a regeneration nothing in the change accounts for. Paths
   * with no key keep the plain exemption, so declaring nothing changes nothing.
   */
  generated_sources: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  expansion_budget_files: z.number().int().min(0),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const BaseSchema = z.strictObject({
  base_commit: CommitShaSchema,
  context_manifest_hash: ContextManifestHashSchema,
  captured_at: z.iso.datetime(),
});
export type PlanBase = z.infer<typeof BaseSchema>;

export const BudgetSchema = z.strictObject({
  max_cost_micros: z.number().int().min(0),
  max_wall_clock_ms: z.number().int().min(0),
});

const identity = {
  plan_id: PlanIdSchema,
  version: z.number().int().positive(),
  ticket_id: TicketIdSchema,
};

/**
 * The four load-bearing fields. Higher levels reuse this object verbatim, so
 * "higher levels add fields additively without changing the P1 shape" is
 * structural rather than a promise (SCP-009).
 */
const p1Body = {
  ...identity,
  outcome: z.string().min(1),
  acceptance_criteria: AcceptanceCriteriaSchema,
  scope: ScopeSchema,
  base: BaseSchema,
  /**
   * The execution graph's nodes (D-100). Absent for a flat plan, which is most
   * of them, and a plan without them is as valid as it ever was. Present, the
   * nodes partition the criteria: {@link refineNodes} is the whole of what that
   * means, and it is checked here rather than at the one command that writes
   * them, so no other writer can produce a graph that does not hold.
   */
  nodes: z.array(PlanNodeSchema).min(1).optional(),
};

/**
 * What a graph has to be for a node's criteria and paths to be contract: every
 * criterion in exactly one node, every node id its own, and every node path
 * inside the scope the plan already declares.
 *
 * Node paths narrow `paths_allowed`; they never widen it. A node reaching
 * outside the allowed scope would make the graph a second, disagreeing
 * statement of what the change may touch, and the write guard enforces the
 * first one.
 */
function refineNodes(
  value: {
    acceptance_criteria: readonly { id: string }[];
    scope: { paths_allowed: readonly string[] };
    nodes?: readonly PlanNode[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const nodes = value.nodes;
  if (nodes === undefined) return;
  const declared = new Set(value.acceptance_criteria.map((criterion) => criterion.id));
  const ids = new Set<string>();
  const covered = new Map<string, string>();
  for (const [index, node] of nodes.entries()) {
    if (ids.has(node.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes", index, "id"],
        message: `duplicate node id ${node.id}`,
      });
    }
    ids.add(node.id);
    for (const [at, id] of node.criteria.entries()) {
      if (!declared.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "criteria", at],
          message: `node ${node.id} names ${id}, which is not an acceptance criterion of this plan`,
        });
        continue;
      }
      const already = covered.get(id);
      if (already !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "criteria", at],
          message: `${id} is in ${already} and in ${node.id}; a criterion belongs to one node`,
        });
        continue;
      }
      covered.set(id, node.id);
    }
    for (const [at, path] of node.paths.entries()) {
      if (!insideAllowedPaths(path, value.scope.paths_allowed)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "paths", at],
          message: `node ${node.id} names ${path}, which is outside scope.paths_allowed`,
        });
      }
    }
  }
  for (const [index, criterion] of value.acceptance_criteria.entries()) {
    if (!covered.has(criterion.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptance_criteria", index, "id"],
        message: `${criterion.id} is in no node; a plan with nodes groups every criterion`,
      });
    }
  }
}

export const PlanContractP0Schema = z.strictObject({
  ...identity,
  level: z.literal("P0"),
  outcome: z.string().min(1),
  scope: ScopeSchema,
  base: BaseSchema,
  budget: BudgetSchema,
});

export const PlanContractP1Schema = z
  .strictObject({
    ...p1Body,
    level: z.literal("P1"),
  })
  .superRefine(refineNodes);

const p2Additions = {
  data_impact: z.string().min(1),
  security_impact: z.string().min(1),
  rollout: z.string().min(1),
  rollback: z.string().min(1),
  estimated_recurring_cost_micros: z.number().int().min(0),
};

export const PlanContractP2Schema = z
  .strictObject({
    ...p1Body,
    level: z.literal("P2"),
    ...p2Additions,
  })
  .superRefine(refineNodes);

export const PlanContractP3Schema = z
  .strictObject({
    ...p1Body,
    level: z.literal("P3"),
    ...p2Additions,
    decision_record: z.string().min(1),
    named_approver: z.string().min(1),
    alternatives: z.array(z.string().min(1)).min(1),
    contingency: z.string().min(1),
  })
  .superRefine(refineNodes);

export const PlanContractSchema = z.discriminatedUnion("level", [
  PlanContractP0Schema,
  PlanContractP1Schema,
  PlanContractP2Schema,
  PlanContractP3Schema,
]);

export type PlanContract = z.infer<typeof PlanContractSchema>;
export type PlanContractP0 = z.infer<typeof PlanContractP0Schema>;
export type PlanContractWithCriteria = z.infer<
  typeof PlanContractP1Schema | typeof PlanContractP2Schema | typeof PlanContractP3Schema
>;

/** P0 has no acceptance criteria, so independent semantic review is undefined for it. */
export function hasAcceptanceCriteria(
  contract: PlanContract,
): contract is PlanContractWithCriteria {
  return contract.level !== "P0";
}

/**
 * A plan's nodes, empty for a flat plan and for P0, which has no criteria to
 * group. One reading for every caller, so nothing has to know that "no graph"
 * is an absent field rather than an empty list.
 */
export function planNodes(contract: PlanContract): readonly PlanNode[] {
  return hasAcceptanceCriteria(contract) ? (contract.nodes ?? []) : [];
}

/**
 * The criteria citing a requirement id the spec does not carry.
 *
 * The schema checks the shape of an id and can go no further: what requirements
 * exist is a fact about a Markdown file in the repository, not about the
 * contract. Admission and `perbo edit` hold that file and call this; a plan
 * drafted from an issue cites nothing and this returns nothing for it.
 */
export function unknownRequirementIds(
  contract: PlanContract,
  known: Iterable<string>,
): Array<{ criterion_id: string; requirement_id: string }> {
  const carried = new Set(known);
  if (!hasAcceptanceCriteria(contract)) return [];
  return contract.acceptance_criteria.flatMap((criterion) =>
    criterion.requirement_id !== undefined && !carried.has(criterion.requirement_id)
      ? [{ criterion_id: criterion.id, requirement_id: criterion.requirement_id }]
      : [],
  );
}
