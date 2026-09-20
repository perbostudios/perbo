import {
  PlanningError,
  applyGraphEdit as applyInPackage,
  emptyApproach as emptyApproachInPackage,
  undoGraphEdit as undoInPackage,
  type GraphEditOutcome,
  type GraphState,
} from "@perbo/planning";
import type { ApproachRecord, PlanContract } from "@perbo/contracts";
import { UsageError } from "../../../usage-error.js";

/**
 * The command's side of the validated edit path (D-100): the engine is
 * `@perbo/planning`'s, and what this adds is the exit code.
 *
 * A refusal from the engine is a `PlanningError`, which nothing outside this
 * package knows; `perbo edit` exits 1 on a `UsageError` and 3 on anything
 * else, so a refused edit is translated here rather than at every call.
 */

function refusedAsUsage<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PlanningError) throw new UsageError(error.message);
    throw error;
  }
}

export function applyGraphEdit(
  state: GraphState,
  raw: unknown,
  reserved: readonly string[] = [],
): GraphEditOutcome {
  return refusedAsUsage(() => applyInPackage(state, raw, reserved));
}

export function undoGraphEdit(
  state: GraphState,
  before: Record<string, unknown>,
): GraphEditOutcome {
  return refusedAsUsage(() => undoInPackage(state, before));
}

export function emptyApproach(contract: PlanContract): ApproachRecord {
  return refusedAsUsage(() => emptyApproachInPackage(contract));
}
