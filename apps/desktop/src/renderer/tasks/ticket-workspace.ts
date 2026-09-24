import { z } from "zod";
import type { Detail, Snapshot, TaskRow } from "../../shared/protocol.js";
import type { TaskView } from "../shell/route.js";
import { runnerProgress } from "../../shared/runner-progress.js";
import { exclusiveJob, heldRepository, isRun, ticketRun } from "../../shared/jobs.js";
import { GIVEN_UP_STATES, JOURNEY_END_STATES, isFiled, isPreLoop } from "../../shared/archive.js";

export const displayKey = (key: string): string => "#" + key.replace(/^PRB-/, "");
export const stageName = (stage: number): string =>
  ["contract", "execution", "checks", "decisions required", "refinement", "review"][stage - 1] ?? "contract";
const stageOf = (state: string): number =>
  ["pr_open", "independent_review"].includes(state) ? 6 : state === "changes_requested" ? 4 :
  state === "verifying" ? 3 : ["executing", "provisioning"].includes(state) ? 2 : 1;
const closureSchema = z.object({
  all_closed: z.boolean(), deterministic_failure: z.string().nullable(), open_keys: z.array(z.string()),
  per_finding: z.array(z.object({ finding_key: z.string(), status: z.enum(["closed", "not_closed", "cannot_tell"]), pointer: z.string() })),
});

/** Where a Home ticket stands, in the order the rail's Home badge shows them. */
export const HOME_TONES = ["yellow", "red", "green"] as const;
export type HomeTone = (typeof HOME_TONES)[number];
/** What a count of Home tickets at each tone says, on the rail's Home badge and in Home's header. */
export const HOME_TONE_LABELS: Record<HomeTone, (count: number) => string> = {
  yellow: (count) => `${count} ${count === 1 ? "ticket needs" : "tickets need"} action`,
  red: (count) => `${count} stopped`,
  green: (count) => `${count} completed`,
};

/**
 * Where a Home ticket stands (S4), the one answer its card's colour, the
 * header's counts and the rail's Home badge all read: yellow where a finding
 * waits on the person's answer mid-loop; red where the loop stopped and will
 * not reach the end on its own; green where the journey ended — a pull request
 * opened, merged or closed without merge, or a local run finished with no pull
 * request to merge; none for every other part of the loop.
 *
 * A repository's records being read again does not move it, so nothing that
 * shows it blinks while they are: a run that completed while its ticket still
 * reads mid-loop is the record not yet read, and is not taken for a stop.
 */
export function homeTone(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos">,
  row: Pick<TaskRow, "repoId" | "ticket">,
): HomeTone | null {
  const { ticket } = row;
  const { jobs, active, stoppedShort } = ticketRun(workspace, row);
  const settling = jobs.filter(isRun).at(-1)?.state === "completed" && workspace.refreshingRepos?.includes(row.repoId);
  if ((active?.state === "stopping" && isRun(active)) || (stoppedShort && !settling) || (!active && GIVEN_UP_STATES.includes(ticket.state))) return "red";
  if (!active && ticket.state === "changes_requested") return "yellow";
  return JOURNEY_END_STATES.includes(ticket.state) ? "green" : null;
}

/**
 * The tickets Home lists. Home is the board for work the loop is carrying: a
 * plan nobody has approved is still being planned, and it is reached from the
 * Create picker, which is where every pre-loop thing lives — a name, a spec,
 * and a plan drafted and not yet approved (D-129).
 */
export const homeRows = (workspace: Pick<Snapshot, "tasks" | "archived" | "jobs">): TaskRow[] =>
  workspace.tasks.filter((row) => !isFiled(workspace, row) && !isPreLoop(row));

/** Home's order, top to bottom: completed, a decision waiting on the person, stopped, then running. */
const HOME_ORDER: readonly (HomeTone | null)[] = ["green", "yellow", "red", null];

/**
 * Home's tickets by where each stands, in `HOME_ORDER`, and within a colour by
 * `by`: `opened`, the one whose page was opened most recently first, a ticket
 * never opened coming after every opened one of its colour, the most recently
 * admitted first; `newest` or `oldest`, by when the ticket last moved.
 */
export function homeOrder<Row extends Pick<TaskRow, "repoId" | "ticket">>(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos" | "lastOpened">,
  rows: readonly Row[],
  by: "opened" | "newest" | "oldest",
): Row[] {
  const rank = (row: Row): number => HOME_ORDER.indexOf(homeTone(workspace, row));
  // Never opened reads as "", which sorts after every opening.
  const opened = (row: Row): string => workspace.lastOpened?.[row.repoId + ":" + row.ticket.key] ?? "";
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (by === "newest"
        ? b.ticket.updated_at.localeCompare(a.ticket.updated_at)
        : by === "oldest"
          ? a.ticket.updated_at.localeCompare(b.ticket.updated_at)
          : opened(b).localeCompare(opened(a)) ||
            (opened(a) === "" ? b.ticket.admitted_at.localeCompare(a.ticket.admitted_at) : 0)),
  );
}

/** How many Home tickets stand at each tone. */
export function homeTally(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos">,
  rows: readonly Pick<TaskRow, "repoId" | "ticket">[],
): Record<HomeTone, number> {
  const tally = { yellow: 0, red: 0, green: 0 };
  for (const row of rows) {
    const tone = homeTone(workspace, row);
    if (tone) tally[tone]++;
  }
  return tally;
}

/** A read-only projection of one repository-qualified Ticket. It performs no reads or writes. */
export function projectTicket(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos">,
  row: Pick<TaskRow, "repoId" | "ticket">,
  detail?: Detail,
  requested: TaskView = "auto",
  refreshing = workspace.refreshingRepos?.includes(row.repoId) ?? false,
) {
  const { ticket, repoId } = row;
  const { jobs, active, stoppedShort } = ticketRun(workspace, row);
  // A run, a decision or a publication takes its turn; planning elsewhere does not hold it up (D-101).
  const busy = Boolean(exclusiveJob(workspace.jobs));
  // Deleting this contract waits for every command running in its repository, as the host does.
  const held = heldRepository(workspace.jobs, repoId);
  const recoverable = stoppedShort && !refreshing;
  // A stop the host has taken for this ticket's run and not yet finished: the
  // person has said the run is over, so it reads as stopped while the process
  // goes and the record it leaves is written.
  const stopped = recoverable || (active?.state === "stopping" && isRun(active));
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
  const tone = homeTone(workspace, row);
  let screen: Exclude<TaskView, "auto">;
  if (requested === "output") screen = "output";
  else if (["merge", "called-off"].includes(requested)) screen = ticket.delivery.pull_request_url ? requested as "merge" | "called-off" : "review";
  else if (requested === "complete" && ticket.delivery.state === "merged") screen = "complete";
  else if (requested === "contract") screen = "contract";
  // The repository's files beside this contract, read-only: asked for from the
  // contract, and never chosen for a person, so it is only ever `requested`.
  else if (requested === "explorer") screen = "explorer";
  else if (requested === "review" || ((requested === "auto" || requested === "loop") && resultReady)) screen = "review";
  else if (requested === "auto" && ["plan_review", "ready", "draft", "specifying"].includes(ticket.state) && !active) screen = "contract";
  // A run stopped, before the record it left is read as a result. A stop seals
  // to `failed` inside the executor's window and strands the ticket where it
  // stood outside it, and `recoverable` is the one flag that covers both — so
  // this stands ahead of the line that would send the failed one to the review
  // screen, whose only offer is the frozen contract it cannot change.
  //
  // Asked for by name, the page also holds while the stop is on its way and
  // while the record it leaves is read, since Stop the loop lands here at once:
  // the run is still live, then briefly neither live nor read, and neither is
  // somewhere else to send the person.
  else if (requested === "stopped" ? stopped || active || refreshing : requested === "auto" && stopped) screen = "stopped";
  else if (requested === "auto" && ["merged", "closed", "failed", "cancelled", "inconclusive"].includes(ticket.state) && !active) screen = "review";
  else screen = requested === "decisions" ? "decisions" : "loop";
  const primary = stopped ? { label: "See the stopped run", view: "stopped" as const } :
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
  const description = stopped ? "The run stopped. Its work and evidence have been retained — carry on with the task, plan it again, or delete it." :
    refreshing ? "Reading the task's recorded outcome…" :
    descriptions[observed?.state ?? ticket.state] ?? "Open the ticket to see its contract, latest state and retained evidence.";
  return { jobs, active, busy, held, recoverable, resultReady, refreshing, attention, tone, primary, screen, stage, description, observed, latest, review, evidence };
}
