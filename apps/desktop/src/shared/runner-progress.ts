import type { TicketState } from "@perbo/contracts";

/** Observed CLI milestones, used for display while ticket persistence lags and for the stage-change notification. */
export function runnerProgress(
  log: string,
): { stage: number; title: string; state: TicketState } | null {
  let current: { stage: number; title: string; state: TicketState } | null =
    null;
  for (const line of log.split("\n").map((line) => line.trim())) {
    if (line.startsWith("worktree "))
      current = {
        stage: 2,
        title: "Materialising the worktree",
        state: "provisioning",
      };
    else if (line === "executing")
      current = {
        stage: 2,
        title: "Working on the approved outcome",
        state: "executing",
      };
    else if (/^remediation round \d+ of at most \d+$/.test(line))
      current = { stage: 5, title: "Refining the change", state: "executing" };
    else if (/^check [^:]+: /.test(line))
      current = {
        stage: 3,
        title: "Running deterministic checks",
        state: "verifying",
      };
    else if (/^review round \d+$/.test(line))
      current = {
        stage: 6,
        title: "Independent review",
        state: "independent_review",
      };
    else if (/^verifying closures, round \d+$/.test(line))
      current = {
        stage: 5,
        title: "Verifying the refinements",
        state: "independent_review",
      };
  }
  return current;
}
