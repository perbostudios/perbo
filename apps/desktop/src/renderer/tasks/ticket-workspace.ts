import { z } from "zod";
import type { AttemptView, Detail, Job, Snapshot, TaskRow } from "../../shared/protocol.js";
import type { TaskView } from "../shell/route.js";
import { runnerProgress, WHEEL_STEPS, wheelAt, wheelStep, type RunnerStage } from "../../shared/runner-progress.js";
import { heldTicket, inTheWay, isRun, ticketRun } from "../../shared/jobs.js";
import { GIVEN_UP_STATES, JOURNEY_END_STATES, isFiled, isMergeDecided, isPreLoop } from "../../shared/archive.js";

export const displayKey = (key: string): string => "#" + key.replace(/^PRB-/, "");
/**
 * Where the wheel stands once the ticket's journey ended — a pull request
 * opened, merged or closed, or a local run finished with nothing to merge:
 * past every step, the ring full. Only a loop still running, paused or
 * stopped sits at a step.
 */
export const JOURNEY_END = WHEEL_STEPS.length + 1;
export const stageName = (stage: number): string =>
  stage === JOURNEY_END ? "review ready" : (WHEEL_STEPS[stage - 1] ?? "contract");
/** The wheel's step a ticket's state names while the loop carries it; a journey that ended is `JOURNEY_END`. */
export const stageOf = (state: string): number =>
  wheelStep(
    state === "independent_review"
      ? "review"
      : state === "changes_requested"
        ? "decisions required"
        : state === "verifying"
          ? "checks"
          : ["executing", "provisioning"].includes(state)
            ? "execution"
            : "contract",
  );
const closureSchema = z.object({
  all_closed: z.boolean(), deterministic_failure: z.string().nullable(), open_keys: z.array(z.string()),
  per_finding: z.array(z.object({ finding_key: z.string(), status: z.enum(["closed", "not_closed", "cannot_tell"]), pointer: z.string() })),
});

/** Where a Home ticket stands, in the order the rail's Home badge shows them. */
export const HOME_TONES = ["yellow", "red", "green"] as const;
export type HomeTone = (typeof HOME_TONES)[number];
/**
 * What a count of Home tickets at each tone says, on the rail's Home badge and
 * in Home's header. Green there is a pull request waiting on the merge
 * decision; "completed" is only ever a ticket whose merge is decided.
 */
export const HOME_TONE_LABELS: Record<HomeTone, (count: number) => string> = {
  yellow: (count) => `${count} ${count === 1 ? "ticket needs" : "tickets need"} action`,
  red: (count) => `${count} stopped`,
  green: (count) => `${count} waiting on your merge decision`,
};
/** What a count of Home tickets whose merge is decided says in Home's header. */
export const completedLabel = (count: number): string => `${count} completed`;

/**
 * Where a Home ticket stands (S4), the one answer its card's colour, the
 * header's counts and the rail's Home badge all read: yellow where the loop
 * paused for the person — a finding waits on their answer, the run just ended
 * on a verdict for them, or a live run waits on their answer about a host off
 * the allow-list (D-NEW-an-unlisted-host-asks); red only where the loop
 * stopped on an error or because the person stopped it, and will not reach the
 * end on its own; green where the journey ended — a pull request opened,
 * merged or closed without merge, or a local run finished with no pull request
 * to merge; none for every other part of the loop.
 *
 * A repository's records being read again does not move it, so nothing that
 * shows it blinks while they are: a run that completed while its ticket still
 * reads mid-loop is the record not yet read, and is not taken for a stop, and
 * one that completed on a verdict is yellow from the moment it ends.
 */
export function homeTone(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos">,
  row: Pick<TaskRow, "repoId" | "ticket">,
): HomeTone | null {
  const { ticket } = row;
  const { jobs, active, stoppedShort, paused, asking } = ticketRun(workspace, row);
  const settling = jobs.filter(isRun).at(-1)?.state === "completed" && workspace.refreshingRepos?.includes(row.repoId);
  if ((active?.state === "stopping" && isRun(active)) || (stoppedShort && !settling) || (!active && GIVEN_UP_STATES.includes(ticket.state))) return "red";
  if (paused || asking || (!active && ticket.state === "changes_requested")) return "yellow";
  return JOURNEY_END_STATES.includes(ticket.state) ? "green" : null;
}

/**
 * The tickets Home lists. Home is the board for work the loop is carrying: a
 * plan nobody has approved is still being planned, and it is reached from the
 * Create picker, which is where every pre-loop thing lives — a name, a spec,
 * and a plan drafted and not yet approved (D-129).
 */
export const homeRows = (workspace: Pick<Snapshot, "tasks" | "archived" | "jobs" | "calledOff">): TaskRow[] =>
  workspace.tasks.filter((row) => !isFiled(workspace, row) && !isPreLoop(row));

/**
 * The group a Home ticket stands in: `decided` once its merge is decided,
 * merged, closed without merge or called off, under every colour; otherwise
 * its colour, or none while the loop carries it.
 */
export type HomeGroup = HomeTone | "decided" | null;
export const homeGroup = (
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos" | "calledOff">,
  row: Pick<TaskRow, "repoId" | "ticket">,
): HomeGroup => (isMergeDecided(workspace, row) ? "decided" : homeTone(workspace, row));

/**
 * Home's order, top to bottom: a pull request waiting on the merge decision,
 * a decision waiting on the person, stopped, running, and last every ticket
 * whose merge is decided.
 */
const HOME_ORDER: readonly HomeGroup[] = ["green", "yellow", "red", null, "decided"];

/**
 * Home's tickets by where each stands, in `HOME_ORDER`, and within a group by
 * `by`: `opened`, the one whose page was opened most recently first, a ticket
 * never opened coming after every opened one of its group, the most recently
 * admitted first; `newest` or `oldest`, by when the ticket last moved.
 */
export function homeOrder<Row extends Pick<TaskRow, "repoId" | "ticket">>(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos" | "lastOpened" | "calledOff">,
  rows: readonly Row[],
  by: "opened" | "newest" | "oldest",
): Row[] {
  const rank = (row: Row): number => HOME_ORDER.indexOf(homeGroup(workspace, row));
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

/**
 * How many Home tickets stand at each tone, and how many are completed: a
 * ticket whose merge is decided counts as completed and at no tone.
 */
export function homeTally(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos" | "calledOff">,
  rows: readonly Pick<TaskRow, "repoId" | "ticket">[],
): Record<HomeTone | "completed", number> {
  const tally = { yellow: 0, red: 0, green: 0, completed: 0 };
  for (const row of rows) {
    const group = homeGroup(workspace, row);
    if (group) tally[group === "decided" ? "completed" : group]++;
  }
  return tally;
}

/**
 * When the ticket came to stand where its colour says: the newest row of its
 * history moving it into the state it holds, and for a stop the moment its
 * last run ended, whichever is later.
 */
function attentionSince(
  workspace: Pick<Snapshot, "jobs">,
  row: Pick<TaskRow, "repoId" | "ticket">,
  tone: HomeTone,
): string {
  const moved = row.ticket.history.findLast((entry) => entry.to === row.ticket.state)?.at ?? row.ticket.updated_at;
  const ended = tone === "red" ? ticketRun(workspace, row).jobs.filter(isRun).at(-1)?.endedAt : null;
  return ended && ended > moved ? ended : moved;
}

/**
 * Whether this ticket needs the person and they have not opened it since it
 * came to: yellow, red, or green with its merge decision still to make, whose
 * page was last opened before it came to stand there, or never. A ticket whose
 * merge is decided needs nobody. The rail's Home badge counts these, and each
 * card carries a blue circle while it is one; opening the ticket clears it,
 * and a ticket that comes to need the person again counts again (S4).
 */
export function unseenAttention(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos" | "lastOpened" | "calledOff">,
  row: Pick<TaskRow, "repoId" | "ticket">,
): boolean {
  const tone = homeTone(workspace, row);
  if (tone === null || isMergeDecided(workspace, row)) return false;
  const opened = workspace.lastOpened?.[row.repoId + ":" + row.ticket.key];
  return opened === undefined || opened < attentionSince(workspace, row, tone);
}

/** One stage an attempt on record went through, at the time its record holds. */
export interface RecordedStage {
  stage: RunnerStage;
  at: string;
  /** For a check, its recorded result. */
  check?: AttemptView["checks"][number];
  /** For a review round whose review is on record, how many findings it left open. */
  open?: number;
}

/**
 * The stages each attempt on record went through, one list per attempt, in the
 * order it ran them: a run provisions its worktree once, and each attempt is
 * executed, sealed, checked, and then reviewed or has its closures verified —
 * the same stages a run's log announces as it goes.
 */
export function recordedRunnerStages(attempts: readonly AttemptView[]): RecordedStage[][] {
  const provisioned = new Set<number>();
  const remediations = new Map<number, Set<number>>();
  return attempts.map((attempt) => {
    const stages: RecordedStage[] = [];
    const execution = attempt.bundles.find((bundle) => bundle.kind === "execution");
    const kind = execution?.inputs["round_kind"] ?? (attempt.round === 0 ? "execute" : "remediate");
    if (!provisioned.has(attempt.run)) {
      provisioned.add(attempt.run);
      stages.push({ stage: { kind: "worktree" }, at: attempt.startedAt });
    }
    if (kind === "execute") stages.push({ stage: { kind: "executing" }, at: attempt.startedAt });
    else if (kind === "resolve_conflict") stages.push({ stage: { kind: "conflict" }, at: attempt.startedAt });
    else {
      const rounds = remediations.get(attempt.run) ?? new Set<number>();
      rounds.add(attempt.round);
      remediations.set(attempt.run, rounds);
      stages.push({ stage: { kind: "remediation", round: rounds.size }, at: attempt.startedAt });
    }
    const sealed =
      execution === undefined
        ? attempt.startedAt
        : new Date(Date.parse(attempt.startedAt) + execution.usage.wall_clock_ms).toISOString();
    stages.push({ stage: { kind: "seal" }, at: sealed });
    for (const check of attempt.checks) stages.push({ stage: { kind: "check", name: check.name }, at: sealed, check });
    const reviewBundle = attempt.bundles.find(
      (bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"),
    );
    if (attempt.review !== null || reviewBundle !== undefined) {
      const review = attempt.review;
      stages.push({
        stage: { kind: "review", round: attempt.round },
        at: review?.created_at ?? reviewBundle!.created_at,
        ...(review === null ? {} : { open: review.findings.filter((finding) => finding.status === "open").length }),
      });
    }
    const verification = attempt.bundles.find(
      (bundle) => bundle.kind === "review" && bundle.subject_id === `cv_${attempt.id}`,
    );
    if (attempt.verification !== null || verification !== undefined)
      stages.push({ stage: { kind: "verify", round: attempt.round }, at: verification?.created_at ?? sealed });
    return stages;
  });
}

/**
 * Where the progress wheel stood when the ticket's last run stopped: the last
 * stage that moves it among the stage lines that run printed, and where its
 * log holds none, among the stages the attempts on record went through. Null
 * where neither says, so a stop never puts the wheel back to the contract.
 */
function stageReached(lastRun: Job | undefined, attempts: readonly AttemptView[]): number | null {
  const logged = lastRun === undefined ? null : runnerProgress(lastRun.log);
  return logged?.stage ?? wheelAt(recordedRunnerStages(attempts).flat().map(({ stage }) => stage))?.stage ?? null;
}

/**
 * Whether the person stopped the ticket's last run themselves: its record says
 * a stop was taken for it, settled or still settling.
 */
export const stoppedByPerson = (jobs: readonly Job[]): boolean => {
  const run = jobs.filter(isRun).at(-1);
  return run?.state === "cancelled" || run?.state === "stopping";
};

/**
 * Whether Continue the task carries on from the ticket's last run: the person
 * stopped it, or Perbo closed while it was going, quit or crashed alike
 * (`interrupted`). Nothing about the plan or an error stood in the way of
 * either; every other stop is a limit, a refusal or an error that another
 * attempt at the same plan meets again.
 */
export const carriesOn = (jobs: readonly Job[]): boolean =>
  stoppedByPerson(jobs) || jobs.filter(isRun).at(-1)?.state === "interrupted";

/** A read-only projection of one repository-qualified Ticket. It performs no reads or writes. */
export function projectTicket(
  workspace: Pick<Snapshot, "jobs" | "refreshingRepos">,
  row: Pick<TaskRow, "repoId" | "ticket">,
  detail?: Detail,
  requested: TaskView = "auto",
  refreshing = workspace.refreshingRepos?.includes(row.repoId) ?? false,
) {
  const { ticket, repoId } = row;
  const { jobs, active, stoppedShort, paused, asking } = ticketRun(workspace, row);
  // This ticket's own run, decision or publication takes its turn; another
  // ticket's run and planning anywhere do not hold it up (D-049, D-101).
  const busy = Boolean(inTheWay(workspace.jobs, { repoId, key: ticket.key, kind: "run" }));
  // Deleting this contract waits for a command running for this ticket, as
  // the host does; another ticket's run does not hold it (D-129).
  const held = heldTicket(workspace.jobs, repoId, ticket.key);
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
  const tone = homeTone(workspace, row);
  // A journey that ended is past every step, whatever stage the loop's last
  // line named. A stopped run keeps the wheel where the run had taken it,
  // rather than where the state its stop left the ticket at would put it, and
  // a run paused for the person is at the decision before the records say so,
  // as is a run waiting on their answer about a host until they give it.
  const stage =
    (tone === "green"
      ? JOURNEY_END
      : stopped
      ? stageReached(jobs.filter(isRun).at(-1), currentDetail && detail ? detail.attempts : [])
      : paused || asking
        ? stageOf("changes_requested")
        : observed?.stage) ?? stageOf(ticket.state);
  // Continue the task is offered only after the person's own stop, taken or
  // still settling, or Perbo closing mid-run.
  const continuable = carriesOn(jobs);
  const attention = !active && !refreshing && (recoverable || paused || ["changes_requested", "pr_open", "failed", "blocked", "plan_invalid"].includes(ticket.state));
  let screen: Exclude<TaskView, "auto">;
  if (requested === "output") screen = "output";
  // The merge screen follows the review whatever the ticket holds: it merges
  // the pull request, opens it first where the run retained its branch, or
  // says why neither (D-NEW-publish-a-retained-branch-later). Calling a merge
  // off needs a pull request to leave open.
  else if (requested === "merge") screen = "merge";
  else if (requested === "called-off") screen = ticket.delivery.pull_request_url ? "called-off" : "review";
  else if (requested === "complete" && ticket.delivery.state === "merged") screen = "complete";
  else if (requested === "contract") screen = "contract";
  // The repository's files beside this contract, read-only: asked for from the
  // contract, and never chosen for a person, so it is only ever `requested`.
  else if (requested === "explorer") screen = "explorer";
  else if (requested === "review" || ((requested === "auto" || requested === "loop") && resultReady)) screen = "review";
  else if (requested === "auto" && ["plan_review", "ready", "draft", "specifying"].includes(ticket.state) && !active) screen = "contract";
  // A run stopped, before the record it left is read as a result. A stop seals
  // to `failed` inside the executor's window and strands the ticket where it
  // stood outside it, and `recoverable` is the one flag that covers both, read
  // from the ticket's state alone, so a stopped ticket whose run has left the
  // journal still lands here with Plan it again. It stands ahead of the line
  // that would send the failed one to the review screen, whose only offer is
  // the frozen contract it cannot change.
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
    paused || ticket.state === "changes_requested" ? { label: "Answer", view: "decisions" as const } :
    screen === "review" ? { label: "Review result", view: "review" as const } :
    stage === 1 ? { label: "Review contract", view: "contract" as const } : { label: "Watch", view: "loop" as const };
  const descriptions: Record<string, string> = {
    plan_review: "Criteria drafted and the contract is compiled, waiting for your approval before the loop starts.",
    ready: "The approved contract is ready. Start the loop when you are ready.",
    changes_requested: "A finding needs your judgement. Read the question and confirm your answer before the loop resumes.",
    pr_open: ticket.delivery.pull_request_url ? "The pull request is open. Review the evidence and make the merge decision on GitHub." : "The local run is complete and its branch is kept on this machine, not pushed. Review its changes and evidence; merging opens its pull request.",
    executing: "The agent is working in its own worktree. Watch its progress and inspect the output.",
    provisioning: "Materialising a clean worktree from the approved base.",
    verifying: "Running the pinned checks on the sealed change set. Their results will stay with the attempt.",
    independent_review: "The reviewer is checking the diff against the approved criteria, without the executor’s narrative.",
    failed: "The loop stopped. Its work and evidence have been retained. Open the task to inspect the cause.",
  };
  const description = stopped ? `The run stopped. Its work and evidence have been retained — ${continuable ? "carry on with the task, plan it again," : "plan it again"} or delete it.` :
    refreshing ? "Reading the task's recorded outcome…" :
    descriptions[paused ? "changes_requested" : (observed?.state ?? ticket.state)] ?? "Open the ticket to see its contract, latest state and retained evidence.";
  return { jobs, active, busy, held, recoverable, continuable, paused, asking, resultReady, refreshing, attention, tone, primary, screen, stage, description, observed, latest, review, evidence };
}
