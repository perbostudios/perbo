import { z } from "zod";

/**
 * Identifiers are opaque and prefixed. The prefix is part of the value, so a
 * plan id can never be accepted where a ticket id is required.
 */
const prefixed = (prefix: string, label: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}[0-9A-Za-z][0-9A-Za-z_-]{0,63}$`),
      `${label} must look like ${prefix}<id>`,
    );

export const PlanIdSchema = prefixed("plan_", "plan_id");
export const TicketIdSchema = prefixed("ticket_", "ticket_id");
export const RepositoryIdSchema = prefixed("repo_", "repository_id");
export const ChangeSetIdSchema = prefixed("cs_", "changeset_id");
export const ReviewIdSchema = prefixed("rev_", "review_id");
export const CheckIdSchema = prefixed("check_", "check_id");
export const AttemptIdSchema = prefixed("att_", "attempt_id");

/** Criterion ids are plan-local, so they carry their own short prefix. */
export const CriterionIdSchema = z
  .string()
  .regex(/^ac_[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/, "criterion id must look like ac_<id>");

/** Node ids are plan-local too, and carry their own prefix for the same reason. */
export const NodeIdSchema = z
  .string()
  .regex(/^node_[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/, "node id must look like node_<id>");

/**
 * A requirement's id in a spec: `R1` upward, written into the spec when the
 * requirement is written and never reused (D-103). Not prefixed like the ids
 * above, because a person types it in Markdown and reads it back there.
 */
export const RequirementIdSchema = z
  .string()
  .regex(/^R[1-9]\d*$/, "requirement id must look like R1");

export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "commit must be a 7-40 character lowercase hex sha");

export const ContextManifestHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "context manifest hash must be sha256:<64 hex>");

export type PlanId = z.infer<typeof PlanIdSchema>;
export type TicketId = z.infer<typeof TicketIdSchema>;
export type RepositoryId = z.infer<typeof RepositoryIdSchema>;
export type ChangeSetId = z.infer<typeof ChangeSetIdSchema>;
export type ReviewId = z.infer<typeof ReviewIdSchema>;
export type CheckId = z.infer<typeof CheckIdSchema>;
export type CriterionId = z.infer<typeof CriterionIdSchema>;
export type NodeId = z.infer<typeof NodeIdSchema>;
export type RequirementId = z.infer<typeof RequirementIdSchema>;
export type AttemptId = z.infer<typeof AttemptIdSchema>;
