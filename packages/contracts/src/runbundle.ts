import { createHash } from "node:crypto";
import { z } from "zod";
import { ContextItemSchema } from "./context.js";
import { CostBasisSchema } from "./cost.js";

/**
 * The immutable run bundle (ADR-0013 as amended, ADR-0026, SCP-048).
 *
 * A run that is not recorded is lost permanently and cannot be backfilled.
 * That is the whole argument for this file existing in Stage 2 rather than
 * later: every other artifact here can be recomputed from its inputs, and this
 * one is the inputs.
 *
 * Bundles are written to a directory on the machine that produced them.
 */

export const RUN_BUNDLE_KINDS = ["planning", "execution", "review", "delivery"] as const;
export const RunBundleKindSchema = z.enum(RUN_BUNDLE_KINDS);
export type RunBundleKind = (typeof RUN_BUNDLE_KINDS)[number];

/**
 * ADR-0026. The tier is **computed**, never asserted, and it degrades: a bundle
 * that references repository context by commit alone is `forensic`, and says so
 * rather than implying a replay it cannot support.
 */
export const REPLAYABILITY_TIERS = ["exact", "re_executable", "forensic"] as const;
export const ReplayabilityTierSchema = z.enum(REPLAYABILITY_TIERS);
export type ReplayabilityTier = (typeof REPLAYABILITY_TIERS)[number];

export const ArtifactRefSchema = z.strictObject({
  name: z.string().min(1),
  /** Content address. The bytes live under this name in the local store. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  media_type: z.string().min(1),
  /** False when only the hash was kept: the difference between the two tiers. */
  retained: z.boolean(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const TransitionSchema = z.strictObject({
  at: z.iso.datetime(),
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1),
});

export const RetentionSchema = z.strictObject({
  /** `replay_retained` is the small, long-lived subset ADR-0026 defines. */
  class: z.enum(["replay_retained", "raw_transcript", "artifact"]),
  expires_at: z.iso.datetime().nullable(),
});

/**
 * What was removed before anything was written, and how much. A bundle that
 * says `redactions: 0` is making a claim; one that omits the field is not
 * making one, which is worse.
 */
export const RedactionRecordSchema = z.strictObject({
  secret_content_sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  secret_value_count: z.number().int().min(0),
  redactions: z.number().int().min(0),
  excluded_paths: z.array(z.string().min(1)),
});
export type RedactionRecord = z.infer<typeof RedactionRecordSchema>;

export const RUN_BUNDLE_SCHEMA_VERSION = 1;

/** `bundle_` and sixteen hex digits, as `bundleId` mints it. */
export const BundleIdSchema = z
  .string()
  .regex(/^bundle_[0-9a-f]{16}$/, "bundle_id must look like bundle_<16 hex>");
export type BundleId = z.infer<typeof BundleIdSchema>;

export const RunBundleSchema = z.strictObject({
  schema_version: z.literal(RUN_BUNDLE_SCHEMA_VERSION),
  bundle_id: BundleIdSchema,
  kind: RunBundleKindSchema,
  created_at: z.iso.datetime(),
  /** The attempt, review or delivery this bundle records. */
  subject_id: z.string().min(1),
  ticket_id: z.string().min(1),

  /** Bounded: identifiers, hashes and counts, never whole inputs. */
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** Per-item trust tier, which is what makes "what did the model read" answerable. */
  context_manifest: z.array(ContextItemSchema),
  versions: z.strictObject({
    code: z.string().min(1),
    prompt: z.string().min(1),
    policy: z.string().min(1),
    model: z.string().min(1),
    tool: z.string().min(1),
  }),
  usage: z.strictObject({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cost_micros: z.number().int().min(0),
    /** A v1 bundle can represent execution, review or verification, so its old basis is unknowable. */
    cost_basis: CostBasisSchema.default("unavailable"),
    /**
     * The subject was stopped before its transport wrote a final accounting
     * line, so cost is either its last running transport total or a list-rate
     * estimate over the observed prefix. Absent on a subject that ran to
     * completion and on bundles written before the field.
     */
    cost_partial: z.boolean().optional(),
    wall_clock_ms: z.number().int().min(0),
  }),
  artifacts: z.array(ArtifactRefSchema),
  errors: z.array(z.strictObject({ kind: z.string().min(1), message: z.string() })),
  transitions: z.array(TransitionSchema),
  retention: RetentionSchema,
  redaction: RedactionRecordSchema,
  /** Computed by `computeReplayability`, never supplied by a caller. */
  replayability: ReplayabilityTierSchema,
  replayability_reason: z.string().min(1),
});
export type RunBundle = z.infer<typeof RunBundleSchema>;

export function bundleId(seed: string): string {
  return `bundle_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * ADR-0026's table, as code.
 *
 * `re_executable` needs the materialized context **bytes** the model actually
 * saw; a commit reference alone does not qualify, because the branch can be
 * force-pushed away. `exact` needs a deterministic component with pinned code
 * and pinned inputs — no model call in it at all.
 */
export function computeReplayability(args: {
  deterministic: boolean;
  context_bytes_retained: boolean;
  model_version_pinned: boolean;
}): { tier: ReplayabilityTier; reason: string } {
  if (args.deterministic && args.context_bytes_retained) {
    return {
      tier: "exact",
      reason: "deterministic component with pinned code and pinned inputs retained",
    };
  }
  if (args.context_bytes_retained && args.model_version_pinned) {
    return {
      tier: "re_executable",
      reason: "the materialized context bytes the model saw were retained, against a pinned model",
    };
  }
  if (args.context_bytes_retained) {
    return {
      tier: "re_executable",
      reason: "context bytes retained; the model version is not pinned, so comparison is approximate",
    };
  }
  return {
    tier: "forensic",
    reason:
      "only metadata and hashes were retained, so this bundle can be reconstructed but not re-run",
  };
}
