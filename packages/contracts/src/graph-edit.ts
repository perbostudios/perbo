import { z } from "zod";
import { CriterionIdSchema, NodeIdSchema, RequirementIdSchema } from "./ids.js";
import { ExpectedVerificationSchema } from "./plan.js";

/**
 * The one validated edit path an unapproved plan changes through (D-100),
 * whether the hand on it is a person's or the interview's.
 *
 * A closed union rather than a patch document: every operation names what it
 * touches, so an edit can be recorded with the entity keys it changed and the
 * values before and after — which is what makes it undoable, and what makes
 * D-100's rule about a later edit on the same key decidable.
 */

export const GRAPH_EDIT_OPS = [
  "add_node",
  "split_node",
  "merge_nodes",
  "delete_node",
  "set_criterion",
  "set_node_paths",
  "add_edge",
  "remove_edge",
] as const;
export type GraphEditOp = (typeof GRAPH_EDIT_OPS)[number];

const PathsSchema = z.array(z.string().min(1)).min(1);

/** A criterion written by the edit itself: the plan gives it its id. */
export const NewCriterionSchema = z.strictObject({
  text: z.string().min(1),
  expected_verification: ExpectedVerificationSchema,
  /**
   * The spec requirement this criterion answers, where it answers one.
   *
   * Without it a criterion written by an edit reaches the executor as work
   * drafted from nothing: a node's page derives its Requirements section from
   * these citations and prints "No requirement of this spec is derived to this
   * node yet" when there are none, and that page is committed as the branch's
   * first commit and is what the executor reads (D-103).
   *
   * Optional, because a plan drafted from an issue has no spec and cites
   * nothing. Which ids a spec actually carries is not knowable here — the
   * caller supplies the set, as it does for a drafted criterion.
   */
  requirement_id: RequirementIdSchema.optional(),
});
export type NewCriterion = z.infer<typeof NewCriterionSchema>;

/** One half of a split: the title it takes, and the criteria and paths it keeps. */
export const NodeHalfSchema = z.strictObject({
  title: z.string().min(1),
  criteria: z.array(CriterionIdSchema).min(1),
  paths: PathsSchema,
});

const AddNodeSchema = z
  .strictObject({
    op: z.literal("add_node"),
    title: z.string().min(1),
    paths: PathsSchema,
    /** Criteria already in the plan, moved out of their node into this one. */
    criteria: z.array(CriterionIdSchema).default([]),
    /** Criteria this edit writes, added to the plan and to this node. */
    new_criteria: z.array(NewCriterionSchema).default([]),
  })
  .superRefine((edit, ctx) => {
    if (edit.criteria.length + edit.new_criteria.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "add_node needs at least one criterion: a node with none is not a node",
      });
    }
  });

const SplitNodeSchema = z.strictObject({
  op: z.literal("split_node"),
  id: NodeIdSchema,
  /** Exactly two: a split into one is a rename and a split into three is two splits. */
  into: z.tuple([NodeHalfSchema, NodeHalfSchema]),
});

const MergeNodesSchema = z
  .strictObject({
    op: z.literal("merge_nodes"),
    ids: z.tuple([NodeIdSchema, NodeIdSchema]),
    /** The merged node's title. The first node's, where none is given. */
    title: z.string().min(1).optional(),
  })
  .superRefine((edit, ctx) => {
    if (edit.ids[0] === edit.ids[1]) {
      ctx.addIssue({ code: "custom", path: ["ids"], message: "merge_nodes needs two nodes" });
    }
  });

const DeleteNodeSchema = z.strictObject({
  op: z.literal("delete_node"),
  id: NodeIdSchema,
  /** The node its criteria move to. Null where each one is deleted instead. */
  move_criteria_to: NodeIdSchema.nullable().default(null),
  /** Criteria deleted from the plan along with the node. */
  delete_criteria: z.array(CriterionIdSchema).default([]),
});

const SetCriterionSchema = z.strictObject({
  op: z.literal("set_criterion"),
  id: CriterionIdSchema,
  text: z.string().min(1),
  expected_verification: ExpectedVerificationSchema,
});

const SetNodePathsSchema = z.strictObject({
  op: z.literal("set_node_paths"),
  id: NodeIdSchema,
  paths: PathsSchema,
});

const edge = <Op extends "add_edge" | "remove_edge">(op: Op) =>
  z
    .strictObject({ op: z.literal(op), from: NodeIdSchema, to: NodeIdSchema })
    .superRefine((value, ctx) => {
      if (value.from === value.to) {
        ctx.addIssue({ code: "custom", message: `${value.from} cannot follow itself` });
      }
    });

export const GraphEditSchema = z.discriminatedUnion("op", [
  AddNodeSchema,
  SplitNodeSchema,
  MergeNodesSchema,
  DeleteNodeSchema,
  SetCriterionSchema,
  SetNodePathsSchema,
  edge("add_edge"),
  edge("remove_edge"),
]);
export type GraphEdit = z.infer<typeof GraphEditSchema>;
