/**
 * The outcomes a run of the loop ends on that are a verdict on the change for
 * the person rather than a run that did not complete: the review asked for
 * changes or put a decision to them, or the refinement rounds ran out or
 * closed nothing. `perbo run` exits `EXIT_CODES.gate_closed` (2) for exactly
 * these, with its result on stdout, and the desktop reads such a run as
 * completed and paused for the person.
 */
export const RUN_VERDICTS = ["changes_requested", "escalated", "remediation_exhausted", "remediation_stalled"] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];

/** Whether a run's outcome is a verdict for the person (`RUN_VERDICTS`). */
export const isRunVerdict = (outcome: unknown): outcome is RunVerdict =>
  (RUN_VERDICTS as readonly unknown[]).includes(outcome);
