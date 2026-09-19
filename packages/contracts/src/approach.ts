import { z } from "zod";
import { NodeIdSchema, PlanIdSchema, TicketIdSchema } from "./ids.js";
import type { PlanNode } from "./plan.js";

/**
 * The approach half of a plan with an execution graph (ADR-0016, D-100): the
 * suggested order between the nodes, and the spec's No-Gos.
 *
 * A record of its own, beside the ticket's three files, because it is the half
 * that may change **after** approval — the contract is immutable from there and
 * the approach is the executor's. Keeping it in the contract would have made
 * "the contract did not change during execution" untrue by construction.
 *
 * **The reviewer never receives it.** `ReviewInput` has no field for an edge or
 * a No-Go, and nothing may add one: a No-Go names behaviour excluded from the
 * outcome, not a criterion, and review judges the criteria.
 */

export const APPROACH_SCHEMA_VERSION = 1;

/** One suggested order: `to` follows `from`. */
export const GraphEdgeSchema = z.strictObject({
  from: NodeIdSchema,
  to: NodeIdSchema,
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/**
 * The first cycle reachable in a directed graph, as the path that closes it
 * (`a, b, a`), or null where there is none.
 *
 * Generic in the node key so there is one cycle check rather than two: the
 * drafter proposes edges over node *indices* and everything after approval
 * holds them over node *ids*, and a second implementation for the other type is
 * a second thing to get wrong.
 */
export function findCycle<T>(edges: readonly { from: T; to: T }[]): T[] | null {
  const out = new Map<T, T[]>();
  for (const edge of edges) {
    const from = out.get(edge.from);
    if (from) from.push(edge.to);
    else out.set(edge.from, [edge.to]);
  }
  const done = new Set<T>();
  const onPath = new Set<T>();
  const path: T[] = [];

  const walk = (node: T): T[] | null => {
    if (onPath.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (done.has(node)) return null;
    onPath.add(node);
    path.push(node);
    for (const next of out.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(node);
    done.add(node);
    return null;
  };

  for (const edge of edges) {
    const cycle = walk(edge.from);
    if (cycle) return cycle;
  }
  return null;
}

export const ApproachRecordSchema = z
  .strictObject({
    schema_version: z.literal(APPROACH_SCHEMA_VERSION),
    ticket_id: TicketIdSchema,
    plan_id: PlanIdSchema,
    edges: z.array(GraphEdgeSchema),
    /** Behaviour deliberately excluded from the outcome, read from the spec. */
    no_gos: z.array(z.string().min(1)),
  })
  .superRefine((record, ctx) => {
    const seen = new Set<string>();
    for (const [index, edge] of record.edges.entries()) {
      if (edge.from === edge.to) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message: `${edge.from} cannot follow itself`,
        });
        continue;
      }
      const key = `${edge.from} -> ${edge.to}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message: `duplicate edge ${edge.from} -> ${edge.to}`,
        });
      }
      seen.add(key);
    }
    const cycle = findCycle(record.edges);
    if (cycle) {
      ctx.addIssue({
        code: "custom",
        path: ["edges"],
        message: `the edges make a cycle: ${cycle.join(" -> ")}`,
      });
    }
  });
export type ApproachRecord = z.infer<typeof ApproachRecordSchema>;

/**
 * What the approach says that the plan it belongs to does not support: an edge
 * end that is not one of the plan's nodes.
 *
 * Separate from the schema because the record does not carry the nodes — they
 * are contract and live in the contract — so only a caller holding both can
 * ask. Everything decidable from the edges alone is refused by the schema.
 */
export function approachProblems(
  approach: ApproachRecord,
  nodes: readonly PlanNode[],
): string[] {
  const ids = new Set(nodes.map((node) => node.id));
  const problems: string[] = [];
  for (const edge of approach.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!ids.has(end)) {
        problems.push(`edge ${edge.from} -> ${edge.to}: ${end} is not a node of this plan`);
      }
    }
  }
  return problems;
}
