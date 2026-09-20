import { join } from "node:path";
import { limitFor, type LimitedResource, type TerminationReason } from "@perbo/contracts";
import type { TicketRunConfig } from "./config.js";

/**
 * What one attempt ended as, and what the record says about it.
 */

/** The limits-table key behind each ceiling termination, so the stop names its setting. */
const CEILING_RESOURCE: Partial<Record<TerminationReason, LimitedResource>> = {
  stalled: "attempt_stall_ms",
  wall_clock_exceeded: "attempt_wall_clock_ms",
  command_ceiling_exceeded: "attempt_commands",
  iteration_ceiling_exceeded: "attempt_iterations",
  round_iteration_ceiling_exceeded: "round_iterations",
  token_ceiling_exceeded: "attempt_tokens",
  cost_ceiling_exceeded: "attempt_cost_micros",
};

/**
 * A ceiling is configuration, and a partner meeting one should see the key
 * and the file that raise it rather than a bare number.
 */
export function withCeilingGuidance(
  termination: { reason: TerminationReason; detail: string },
  config: TicketRunConfig,
): { reason: TerminationReason; detail: string } {
  const resource = CEILING_RESOURCE[termination.reason];
  if (!resource) return termination;
  const current = limitFor(config.limits, resource);
  return {
    reason: termination.reason,
    detail:
      `${termination.detail} — raise limits.limits.${resource} in ` +
      `${join(config.repository_root, ".perbo", "config.json")}` +
      (current === null ? "" : ` (currently ${current})`),
  };
}
