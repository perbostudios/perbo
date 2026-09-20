import { closureVerifySchema } from "@perbo/review";
import { createModel, type Model } from "@perbo/model";
import type { TicketRunConfig } from "./config.js";

/**
 * Verifying the closures a remediation round claims (D-061).
 */

/**
 * The verifier transport (D-061). Same providers as the reviewer, but the
 * submit schema enumerates exactly the finding keys under verification, so the
 * tool cannot invent a finding or omit one silently.
 */
export function verifierModel(config: TicketRunConfig, keys: string[]): Model {
  return createModel(config.reviewer_provider, {
    submitSchema: closureVerifySchema(keys),
    modelId: config.reviewer_model,
  });
}
