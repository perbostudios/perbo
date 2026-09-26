import { z } from "zod";
import { InterviewOptionSchema } from "@perbo/contracts/browser";
import { DraftModelRecordSchema } from "./model-record.js";

/**
 * The shape of a drift reading, and the texts a plan's promise is made of.
 *
 * Kept apart from the reading itself so the desktop's renderer can hold a
 * finding without loading a model transport: this file touches no file system
 * and no provider (see `assertion-drift.ts` for the same split).
 */

/** The most differences one reading reports, and the most answers each offers. */
export const MAX_DRIFT_FINDINGS = 6;
export const MAX_DRIFT_OPTIONS = 4;

/** One place the spec and the plan have parted, with the ways to close it. */
export const DriftFindingSchema = z.strictObject({
  /** What it is about, for the card's head: "Criterion 2 and R2", "The outcome". */
  heading: z.string().trim().min(1).max(120),
  /** The difference, said to the person in one or two sentences. */
  difference: z.string().trim().min(1).max(600),
  /**
   * Ways to close it, each in the person's own voice as the turn it would send
   * to the interview. At most one is recommended.
   */
  options: z
    .array(InterviewOptionSchema)
    .min(2)
    .max(MAX_DRIFT_OPTIONS)
    .refine((options) => options.filter((option) => option.recommended).length <= 1, {
      message: "at most one option is recommended",
    }),
});
export type DriftFinding = z.infer<typeof DriftFindingSchema>;

export const DriftReportSchema = z.strictObject({
  findings: z.array(DriftFindingSchema).max(MAX_DRIFT_FINDINGS),
});
export type DriftReport = z.infer<typeof DriftReportSchema>;

/**
 * The same shape as JSON Schema, for the transport to enforce. Every property
 * is required and nothing else is allowed, which is what a strict tool schema
 * needs (see `CONTRACT_DRAFT_JSON_SCHEMA`).
 */
export const DRIFT_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: MAX_DRIFT_FINDINGS,
      description:
        "Every place the spec and the plan no longer say the same thing, or empty when they agree. Never a difference of arrangement or of proof.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "difference", "options"],
        properties: {
          heading: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            description:
              "What this is about, in a few words: 'The outcome', 'Criterion 2 and R2', 'R3'. No trailing full stop.",
          },
          difference: {
            type: "string",
            minLength: 1,
            maxLength: 600,
            description:
              "The difference, in one or two sentences a person reads: what the spec says, what the plan says, and how they part.",
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: MAX_DRIFT_OPTIONS,
            description:
              "Two to four ways to close it, each a complete instruction in the person's own voice, as they would say it to their planning assistant. Say what to change and to what. Mark the one you would pick as recommended, and no other.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "detail", "recommended"],
              properties: {
                label: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                  description:
                    "The instruction itself, one sentence: 'Reword criterion 2 to say exactly two activation emails are queued.' or 'Change R2 in the spec to ask for one activation email.'",
                },
                detail: {
                  type: ["string", "null"],
                  maxLength: 600,
                  description: "What picking it means, where the label alone does not carry it. Null otherwise.",
                },
                recommended: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
};

/** What the reading is given of the spec: the words that state what is wanted. */
export interface DriftSpec {
  outcome: string;
  requirements: readonly { id: string | null; text: string }[];
}

/** What the reading is given of the plan: the words that state what is promised. */
export interface DriftPlan {
  key: string;
  outcome: string;
  criteria: readonly { id: string; text: string; requirement_id: string | null }[];
}

/**
 * The texts the plan's promise is made of, in a form that does not move under
 * arrangement: the outcome, then each criterion's words, sorted. Two plans
 * with the same list promise the same thing whatever their nodes and edges,
 * so this is what a verdict is kept against. Ids are left out: a flag edit
 * numbers criteria afresh, so an id is a position and not a promise.
 */
export function promiseTexts(plan: {
  outcome: string;
  criteria: readonly { text: string }[];
}): string[] {
  return [
    plan.outcome.trim(),
    ...plan.criteria.map((criterion) => criterion.text.trim()).sort(),
  ];
}

/** How a verdict came to be. */
export const DRIFT_ORIGINS = ["drafted", "carried", "read"] as const;

/**
 * The verdict kept beside the ticket, at `.perbo/tickets/<KEY>.drift.json`.
 *
 * Keyed by the two hashes: the spec's bytes and the plan's promise texts. It
 * holds while neither moves, so an arrangement edit keeps it and a hand edit
 * of a promise, or of the spec, lets it go. `drafted` is the verdict a plan
 * has by construction as it is drafted; `carried` is that verdict brought
 * forward by a chat turn that moved the plan, which the interview's guard
 * held to the spec; `read` is a model's. `dismissed` records that these
 * findings were dismissed (`perbo drift --dismiss`), so the same reading is
 * not put again at the same state.
 */
export const DriftRecordSchema = z.strictObject({
  spec: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  promises: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  origin: z.enum(DRIFT_ORIGINS),
  findings: z.array(DriftFindingSchema).max(MAX_DRIFT_FINDINGS),
  dismissed: z.boolean(),
  checked_at: z.iso.datetime(),
  model: DraftModelRecordSchema.nullable(),
});
export type DriftRecord = z.infer<typeof DriftRecordSchema>;

/** What `perbo drift KEY --json` prints: the record, named, and whether a model ran for it. */
export const DriftVerdictSchema = DriftRecordSchema.extend({
  key: z.string().min(1),
  cached: z.boolean(),
});
export type DriftVerdict = z.infer<typeof DriftVerdictSchema>;
