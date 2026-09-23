import { z } from "zod";

/**
 * Provenance of a model's reading, persisted beside the ticket: the draft's,
 * and the drift reading's. On its own so a renderer can hold one without
 * loading the drafter.
 */
export const DraftModelRecordSchema = z.strictObject({
  provider: z.string().min(1),
  model_id: z.string().min(1),
  prompt_version: z.string().min(1),
  turns: z.number().int().min(1),
  usage: z.strictObject({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cache_read_input_tokens: z.number().int().min(0),
    cache_creation_input_tokens: z.number().int().min(0),
  }),
  cost_micros: z.number().int().min(0),
  cost_basis: z.enum(["transport_reported", "provider_list_estimate", "unavailable"]),
});
export type DraftModelRecord = z.infer<typeof DraftModelRecordSchema>;
