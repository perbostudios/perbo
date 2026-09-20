import { z } from "zod";
import type { Detail, Snapshot, TaskRow } from "../../shared/protocol.js";
import type { TaskView } from "../shell/App.js";
import { runnerProgress } from "../presentation.js";
import { exclusiveJob, heldRepository, isLive } from "../../shared/jobs.js";

export const displayKey = (key: string): string => "#" + key.replace(/^PRB-/, "");
export const stageName = (stage: number): string =>
  ["contract", "execution", "checks", "decisions required", "refinement", "review"][stage - 1] ?? "contract";
const stageOf = (state: string): number =>
  ["pr_open", "independent_review"].includes(state) ? 6 : state === "changes_requested" ? 4 :
  state === "verifying" ? 3 : ["executing", "provisioning"].includes(state) ? 2 : 1;
const inProgress = ["provisioning", "executing", "verifying", "independent_review"];
const closureSchema = z.object({
  all_closed: z.boolean(), deterministic_failure: z.string().nullable(), open_keys: z.array(z.string()),
  per_finding: z.array(z.object({ finding_key: z.string(), status: z.enum(["closed", "not_closed", "cannot_tell"]), pointer: z.string() })),
});

/** A read-only projection of one repository-qualified Ticket. It performs no reads or writes. */
export function projectTicket(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos">,
  row: Pick<TaskRow, "repoId" | "ticket">,
  detail?: Detail,
  requested: TaskView = "auto",
  refreshing = workspace.refreshingRepos?.includes(row.repoId) ?? false,
) {
  const { ticket, repoId } = row;
  const jobs = workspace.jobs.filter((job) => job.repoId === repoId && (job.key === ticket.key || job.resultKey === ticket.key));
  // The loop is what a ticket's screens watch and stop, so it wins over planning running beside it.
  const active = exclusiveJob(jobs) ?? jobs.find((job) => isLive(job));
  // A run, a decision or a publication takes its turn; planning elsewhere does not hold it up (D-101).
  const busy = Boolean(exclusiveJob(workspace.jobs));
  // Deleting this contract waits for every command running in its repository, as the host does.
  const held = heldRepository(workspace.jobs, repoId);
  const lastRun = jobs.filter((job) => ["run", "decide"].includes(job.kind)).at(-1);
  const recoverable = !active && !refreshing && (inProgress.includes(ticket.state) || ["failed", "cancelled"].includes(ticket.state)) &&
    (["interrupted", "failed", "cancelled"].includes(lastRun?.state ?? "") || inProgress.includes(ticket.state));
  const currentDetail = detail?.ticket.ticket_id === ticket.ticket_id && detail.contract.plan_id === ticket.plan_id && detail.contract.version === ticket.plan_version;
  const latest = currentDetail ? detail.attempts.at(-1) : undefined;
  const review = currentDetail ? [...detail.attempts].reverse().find((attempt) => attempt.review)?.review : undefined;
  const currentReview = latest?.review ?? undefined;
  const parsedClosure = closureSchema.safeParse(latest?.verification);
  const closure = parsedClosure.success ? parsedClosure.data : undefined;
  const closuresVerified = Boolean(closure?.all_closed && !closure.deterministic_failure && closure.open_keys.length === 0 && closure.per_finding.every((entry) => entry.status === "closed"));
  const checksPassed = Boolean(latest && latest.checks.length > 0 && latest.checks.every((check) => check.status === "passed"));
  const approved = Boolean((currentReview?.decision === "approve" || latest?.reviewDecision === "approve") &&
    !currentReview?.findings.some((finding) => finding.blocking && finding.status === "open"));
  const resultReady = !active && !refreshing && (ticket.state === "pr_open" || (ticket.state === "ready" && (approved || closuresVerified)));
  const evidence = {
    kind: !detail ? "unloaded" : !currentDetail ? "stale" : closure ? "closure" : currentReview ? "review" : "not-retained",
    latest, review: currentReview, priorReview: currentReview ? undefined : review, closure, checksPassed, closuresVerified,
    verified: currentReview?.coverage.filter((entry) => entry.status === "met" && entry.verification_strength === "directly_verified").length ?? null,
    ready: !active && !refreshing && ["pr_open", "ready", "merged"].includes(ticket.state) && checksPassed && (approved || closuresVerified),
  };
  const observed = active ? runnerProgress(active.log) : null;
  const stage = observed?.stage ?? stageOf(ticket.state);
  const attention = !active && !refreshing && (recoverable || ["changes_requested", "pr_open", "failed", "blocked", "plan_invalid"].includes(ticket.state));
  let screen: Exclude<TaskView, "auto">;
  if (requested === "output") screen = "output";
  else if (["merge", "called-off"].includes(requested)) screen = ticket.delivery.pull_request_url ? requested as "merge" | "called-off" : "review";
  else if (requested === "complete" && ticket.delivery.state === "merged") screen = "complete";
  else if (requested === "contract") screen = "contract";
  else if (requested === "review" || ((requested === "auto" || requested === "loop") && resultReady)) screen = "review";
  else if (requested === "auto" && ["plan_review", "ready", "draft", "specifying"].includes(ticket.state) && !active) screen = "contract";
  else if (requested === "auto" && ["merged", "closed", "failed", "cancelled", "inconclusive"].includes(ticket.state) && !active) screen = "review";
  else screen = requested === "decisions" ? "decisions" : "loop";
  const primary = recoverable ? { label: "Review and recover", view: "contract" as const } :
    active || refreshing ? { label: "Watch", view: "loop" as const } :
    resultReady ? { label: ticket.delivery.pull_request_url ? "Merge" : "Review result", view: "review" as const } :
    ticket.state === "changes_requested" ? { label: "Answer", view: "decisions" as const } :
    screen === "review" ? { label: "Review result", view: "review" as const } :
    stage === 1 ? { label: "Review contract", view: "contract" as const } : { label: "Watch", view: "loop" as const };
  const descriptions: Record<string, string> = {
    plan_review: "Criteria drafted and the contract is compiled, waiting for your approval before the loop starts.",
    ready: "The approved contract is ready. Start the loop when you are ready.",
    changes_requested: "A finding needs your judgement. Read the question and confirm your answer before the loop resumes.",
    pr_open: ticket.delivery.pull_request_url ? "The pull request is open. Review the evidence and make the merge decision on GitHub." : "The local run is complete. Review its retained changes and evidence. No pull request was created.",
    executing: "The agent is working in its own worktree. Watch its progress and inspect the output.",
    provisioning: "Materialising a clean worktree from the approved base.",
    verifying: "Running the pinned checks on the sealed change set. Their results will stay with the attempt.",
    independent_review: "The reviewer is checking the diff against the approved criteria, without the executor’s narrative.",
    failed: "The loop stopped. Its work and evidence have been retained. Open the task to inspect the cause.",
  };
  const description = recoverable ? "This task needs recovery. Review the contract and retained changes before another attempt." :
    refreshing ? "Reading the task's recorded outcome…" :
    descriptions[observed?.state ?? ticket.state] ?? "Open the ticket to see its contract, latest state and retained evidence.";
  return { jobs, active, busy, held, recoverable, resultReady, refreshing, attention, primary, screen, stage, description, observed, latest, review, evidence };
}
