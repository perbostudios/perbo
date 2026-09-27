import { z } from "zod";
import { DraftModelRecordSchema } from "./model-record.js";

/**
 * The shape of the answers the Architect offers to a finding a review routed
 * to a person (D-NEW-decision-options), kept apart from the reading itself so
 * the desktop's renderer can hold them without loading a model transport: this
 * file touches no file system and no provider.
 */

/** What one offered answer may hold: one or two sentences, whole. */
export const DECISION_OPTION_MAX_CHARS = 400;

/**
 * One answer the person can pick. `text` is the principle itself, in the
 * person's voice, and becomes their answer exactly as if they had typed it.
 */
export const DecisionOptionSchema = z.strictObject({
  text: z.string().trim().min(1).max(DECISION_OPTION_MAX_CHARS),
  recommended: z.boolean(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/** Answers to one finding: at least one, and exactly one of them recommended. */
export const DecisionOptionsSchema = z
  .array(DecisionOptionSchema)
  .min(1)
  .refine((options) => options.filter((option) => option.recommended).length === 1, {
    message: "exactly one option is recommended",
  });

/** A finding's answers, by the finding's key. */
export const FindingOptionsSchema = z.strictObject({
  finding_key: z.string().regex(/^[0-9a-f]{64}$/),
  options: DecisionOptionsSchema,
});
export type FindingOptions = z.infer<typeof FindingOptionsSchema>;

/**
 * What the model submits: the answers to each finding it was handed, named by
 * the number the finding was handed under. The number is matched back to the
 * finding here and becomes nothing else.
 */
export const DecisionOptionsReportSchema = z.strictObject({
  answers: z.array(
    z.strictObject({
      finding: z.number().int().min(1),
      options: DecisionOptionsSchema,
    }),
  ),
});
export type DecisionOptionsReport = z.infer<typeof DecisionOptionsReportSchema>;

/**
 * The same shape as JSON Schema, for the transport to enforce. How many
 * answers a finding gets is the prompt's to ask, not a bound here.
 */
export const DECISION_OPTIONS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      description: "One entry for every finding you were handed, each named by its number.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "options"],
        properties: {
          finding: {
            type: "integer",
            minimum: 1,
            description: "The number the finding was handed under.",
          },
          options: {
            type: "array",
            minItems: 1,
            description:
              "Two to four concrete answers to the finding, each a principle the person could adopt as their own. Mark exactly one as recommended.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "recommended"],
              properties: {
                text: {
                  type: "string",
                  minLength: 1,
                  maxLength: DECISION_OPTION_MAX_CHARS,
                  description:
                    "One or two sentences in the person's own voice, saying what the product should do: 'Park a permanently failed email on the dead-letter queue and alert the on-call channel.'",
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

/**
 * The answers kept beside a ticket, at `.perbo/tickets/<KEY>.options.json`:
 * for the review they answer, each finding's answers and the reading that
 * offered them. A later review of the ticket replaces the record, because its
 * findings are about another change.
 */
export const DecisionOptionsRecordSchema = z.strictObject({
  review_id: z.string().min(1),
  findings: z.array(
    FindingOptionsSchema.extend({
      offered_at: z.iso.datetime(),
      model: DraftModelRecordSchema,
    }),
  ),
});
export type DecisionOptionsRecord = z.infer<typeof DecisionOptionsRecordSchema>;

/**
 * What `perbo options KEY --json` prints: the answers to each finding asked
 * about, the review they answer, and whether a model ran for any of them.
 */
export const DecisionOptionsVerdictSchema = z.strictObject({
  key: z.string().min(1),
  review_id: z.string().min(1),
  findings: z.array(FindingOptionsSchema),
  cached: z.boolean(),
});
export type DecisionOptionsVerdict = z.infer<typeof DecisionOptionsVerdictSchema>;
