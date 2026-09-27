import { costOf, formatUsd, rollCosts, type Cost } from "@perbo/contracts/browser";
import type { ProhibitedAction, ReviewError } from "@perbo/contracts";
import { isLive, isRun } from "../../shared/jobs.js";
import { runnerStages, runnerTally, spokenWords, type LoggedStage, type RunnerStage } from "../../shared/runner-progress.js";
import { retainedOutput, type TranscriptEntry } from "./retained-output.js";
import type { AttemptView, Detail, Job, OpenDraft } from "../../shared/protocol.js";
import type { PageProps, TaskView } from "../shell/route.js";
import { projectTicket } from "./ticket-workspace.js";
export interface TaskContext extends PageProps {
  detail: Detail;
  repoId: string;
  show: (view: TaskView) => void;
}
export function taskRecords({ detail, workspace, repoId }: TaskContext) {
  const { ticket, contract } = detail;
  const projection = projectTicket(workspace, { repoId, ticket }, detail);
  const { jobs, active, recoverable, latest, review } = projection;
  const elapsedMs = jobs
    .filter((job) => ["run", "decide"].includes(job.kind) && job.endedAt)
    .reduce(
      (total, job) =>
        total +
        Math.max(0, Date.parse(job.endedAt!) - Date.parse(job.startedAt)),
      0,
    );
  const measuredMs = detail.attempts
    .flatMap((attempt) => attempt.bundles)
    .reduce((total, bundle) => total + bundle.usage.wall_clock_ms, 0);
  const seconds = Math.round((elapsedMs || measuredMs) / 1000);
  return {
    ticket,
    contract,
    jobs,
    active,
    recoverable,
    latest,
    review,
    projection,
    elapsed: seconds
      ? (seconds >= 60 ? Math.floor(seconds / 60) + "m " : "") +
        (seconds % 60) +
        "s"
      : "Not recorded",
    busy: projection.busy,
    held: projection.held,
    criteria:
      "acceptance_criteria" in contract ? contract.acceptance_criteria : [],
    models:
      workspace.taskModels?.[repoId + ":" + ticket.key] ?? workspace.settings,
    repo: workspace.repositories.find((repo) => repo.id === repoId),
    title: workspace.titles?.[repoId + ":" + ticket.key] ?? ticket.title,
  };
}
/**
 * What a run has cost so far. A total is all-in only where every component of
 * it is priced (D-070): where some are not, the figure is a floor and says so,
 * and where none is, there is no figure to give.
 */
export const costLabel = ({ cost }: Pick<Detail, "cost">): string =>
  cost.unavailable > 0 && cost.micros === 0
    ? "Unavailable"
    : cost.partial && cost.micros > 0
      ? `at least ${formatUsd(cost.micros, 2)}`
      : formatUsd(cost.micros, 2);

/** The loop page's strip, over every run of the ticket. */
export interface LoopTally {
  /** The commands every attempt was let run. */
  commands: number;
  /** The distinct paths every attempt's change set touched. */
  files: number;
  /** Input and output tokens, as each provider reported them (D-104). */
  tokens: string;
  /**
   * Dollars where any provider gave them, in `costLabel`'s words; null where
   * none did, which the tokens say alone.
   */
  dollars: string | null;
}

/**
 * The loop page's strip: the commands, the files and the spend of the whole
 * ticket, every run of it (D-104).
 *
 * Read from the records of every attempt: each attempt's admitted commands, the paths
 * its change set holds, and the usage its bundles record — the executor's, the
 * review's and the closure verification's. While a run goes, what it has done
 * so far comes from the runner's tally line in its log, added to the records
 * of the attempts from before it; the last run's log stands in the same way
 * while the records hold no attempt of it. The tally counts only paths the
 * attempts before the run had not changed, so the sum is the distinct paths of
 * every run, and once the records hold the run they come to the same figures
 * its last tally did.
 */
export function loopTally(input: { jobs: readonly Job[]; active: Job | undefined; attempts: readonly AttemptView[] }): LoopTally {
  const { jobs, active, attempts } = input;
  const since = (job: Job) => (attempt: AttemptView) => Date.parse(attempt.startedAt) >= Date.parse(job.startedAt);
  const last = jobs.filter(isRun).at(-1);
  const logged =
    active !== undefined && isRun(active)
      ? active
      : last !== undefined && !attempts.some(since(last))
        ? last
        : undefined;
  const recorded = logged === undefined ? attempts : attempts.filter((attempt) => !since(logged)(attempt));
  const running = logged === undefined ? null : runnerTally(logged.log);
  const paths = new Set(recorded.flatMap((attempt) => attempt.changes.map((change) => change.path)));
  const bundles = recorded.flatMap((attempt) => attempt.bundles);
  const costs: Cost[] = bundles.map((bundle) =>
    costOf({ micros: bundle.usage.cost_micros, basis: bundle.usage.cost_basis, partial: bundle.usage.cost_partial === true }),
  );
  const roll = rollCosts(costs);
  const micros = roll.micros + (running?.micros ?? 0);
  const unpriced = roll.unavailable + (running?.unpriced ?? 0);
  const partial = roll.partial + (running?.partial ?? 0);
  const tokens =
    bundles.reduce((total, bundle) => total + bundle.usage.input_tokens + bundle.usage.output_tokens, 0) +
    (running === null ? 0 : running.input_tokens + running.output_tokens);
  return {
    commands: recorded.reduce((total, attempt) => total + attempt.admittedCommands, 0) + (running?.commands ?? 0),
    files: paths.size + (running?.files ?? 0),
    tokens: `${tokens.toLocaleString("en-US")} ${tokens === 1 ? "token" : "tokens"}`,
    dollars:
      micros === 0 && unpriced > 0
        ? null
        : costLabel({ cost: { micros, partial: partial > 0 || unpriced > 0, unavailable: unpriced } }),
  };
}

/**
 * The scope a saved editing session holds that this contract does not carry.
 *
 * A mark made in the Explorer writes the session's own draft and reaches the
 * contract only through a compile. Approval freezes the contract's scope and
 * sends the contract file's digest, which a mark never changes — so without
 * this the freeze would pass, the marks would be left behind, and the page
 * would have said nothing about either.
 *
 * Null when there is no session for this ticket, or when the two agree. Order
 * is not part of the comparison: a list the person reordered is the same scope.
 */
export function pendingScope(
  drafts: readonly OpenDraft[] | undefined,
  repoId: string,
  key: string,
  scope: { paths_allowed: readonly string[]; paths_prohibited: readonly string[] },
): { allowed: readonly string[]; prohibited: readonly string[] } | null {
  const draft = (drafts ?? []).find(
    (each) => each.repoId === repoId && each.key === key && each.phase !== "discarded",
  );
  if (draft === undefined) return null;
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
  if (same(draft.scope.paths, scope.paths_allowed) && same(draft.scope.prohibited, scope.paths_prohibited))
    return null;
  return { allowed: draft.scope.paths, prohibited: draft.scope.prohibited };
}

/** One attempt of a run and its retained transcript: `undefined` until it is read, `null` where none was retained. */
export interface AttemptTranscript {
  attempt: AttemptView;
  transcript: string | null | undefined;
}

/**
 * What the Watch page's transcript lists: the executor's and the reviewer's
 * own words, oldest first so the latest is at the bottom, and never a row for
 * a tool call.
 *
 * While a run is live they are read from its log as the CLI prints them, each
 * turn as it arrives. Once none is, they are rebuilt from the records of each
 * attempt of the latest run, in order: each turn its retained transcript holds
 * of the executor's own session, then each finding the reviewer filed that the
 * review of that attempt left open, in its own words — the lines the run
 * printed for them as it went. A finding the runner states itself, such as a
 * flaky check, is the runner's line and not the reviewer's words, so it is not
 * listed. The last run's log stands in until every attempt's transcript is
 * read, and where no attempt retained the executor's words while the log holds
 * some; the records stand where the log holds nothing.
 */
export function watchTranscript(
  jobs: readonly Job[],
  active: Job | undefined,
  attempts: readonly AttemptTranscript[],
): TranscriptEntry[] {
  const fromLog = (job: Job | undefined): TranscriptEntry[] =>
    spokenWords(job?.log ?? "").map(({ speaker, words }) =>
      speaker === "executor"
        ? { author: "Executor", label: "message", text: words }
        : { author: "Reviewer", label: "finding", text: words },
    );
  if (active !== undefined && isRun(active)) return fromLog(active);
  const logged = fromLog(jobs.filter(isRun).at(-1));
  if (attempts.some(({ transcript }) => transcript === undefined)) return logged;
  const spoken = attempts.map(({ transcript }) => retainedOutput(transcript).entries);
  const recorded = attempts.flatMap(({ attempt }, at) => [
    ...spoken[at]!,
    ...(attempt.review?.findings ?? [])
      .filter((finding) => finding.status === "open" && finding.source !== "deterministic")
      .map((finding) => ({ author: "Reviewer", label: "finding", text: finding.statement })),
  ]);
  return spoken.some((entries) => entries.length > 0) || logged.length === 0 ? recorded : logged;
}

/** One entry of the loop page's steps. */
export interface LoopStep {
  /** What happened, in words. */
  text: string;
  /** The runner's own detail behind the `i`, or null where it recorded none. */
  reason: string | null;
  /** When, as an ISO time, or null where nothing says. */
  at: string | null;
}

/** A stage in the words the loop page says it in. */
export function stageWords(stage: RunnerStage): string {
  switch (stage.kind) {
    case "worktree":
      return "Provisioning the worktree";
    case "executing":
      return "Executing";
    case "remediation":
      return `Refinement round ${stage.round}`;
    case "conflict":
      return "Resolving a conflict with the base";
    case "seal":
      return "Sealing the change set";
    case "check":
      return `Running check ${stage.name}`;
    // The runner counts its rounds from 0; a person counts reviews from 1.
    case "review":
      return `Review round ${stage.round + 1}`;
    case "verify":
      return "Verifying closures";
    case "delivery":
      return "Opening the pull request";
  }
}

/** What the `i` on a review round says: how many findings it left open. */
const findingsLeft = (open: number): string =>
  `The review left ${open === 0 ? "no findings" : open === 1 ? "one finding" : `${open} findings`} open.`;

/**
 * The stages a run's log announced, kept for as long as the loop page is open,
 * with the time each was first read.
 *
 * The log is the CLI's output as it arrives, cut to its tail, and it carries no
 * times: a stage's time is the moment the page first read it, and the stages a
 * log already held when the page opened have none. A stage the tail has since
 * cut stays listed.
 */
export class StageLog {
  private readonly jobs = new Map<string, { stage: LoggedStage; at: string | null }[]>();

  read(job: Job, now: string): readonly { stage: LoggedStage; at: string | null }[] {
    const read = runnerStages(job.log);
    const known = this.jobs.get(job.id);
    if (known === undefined) {
      const first = read.map((stage) => ({ stage, at: null }));
      this.jobs.set(job.id, first);
      return first;
    }
    // Where the log's tail now starts among the stages read before: the first
    // place from which every stage known still leads what is read.
    const same = (left: LoggedStage, right: LoggedStage | undefined): boolean =>
      right !== undefined && JSON.stringify(left.stage) === JSON.stringify(right.stage);
    let from = 0;
    while (from < known.length && !known.slice(from).every((entry, at) => same(entry.stage, read[at]))) from += 1;
    const kept = known.length - from;
    for (let at = 0; at < kept; at += 1) known[from + at]!.stage = read[at]!;
    for (const stage of read.slice(kept)) known.push({ stage, at: now });
    return known;
  }
}

/** The ticket states a run moves through, so a move from one of them to `pr_open` is the run's own delivery. */
const RUN_STATES = new Set(["provisioning", "executing", "verifying", "independent_review"]);

/**
 * Every stage the attempts on record went through, oldest first, each at the
 * time its record holds and with the runner's detail where the record has
 * it: the check's result, and the findings a review left open.
 *
 * The same stages a run's log announces as it goes: a run provisions its
 * worktree once, and each attempt is executed, sealed, checked, and then
 * reviewed or has its closures verified.
 */
function recordedStages(attempts: readonly AttemptView[]): LoopStep[] {
  const provisioned = new Set<number>();
  const remediations = new Map<number, Set<number>>();
  return attempts.flatMap((attempt) => {
    const steps: { stage: RunnerStage; at: string; reason?: string }[] = [];
    const execution = attempt.bundles.find((bundle) => bundle.kind === "execution");
    const kind = execution?.inputs["round_kind"] ?? (attempt.round === 0 ? "execute" : "remediate");
    if (!provisioned.has(attempt.run)) {
      provisioned.add(attempt.run);
      steps.push({ stage: { kind: "worktree" }, at: attempt.startedAt });
    }
    if (kind === "execute") steps.push({ stage: { kind: "executing" }, at: attempt.startedAt });
    else if (kind === "resolve_conflict") steps.push({ stage: { kind: "conflict" }, at: attempt.startedAt });
    else {
      const rounds = remediations.get(attempt.run) ?? new Set<number>();
      rounds.add(attempt.round);
      remediations.set(attempt.run, rounds);
      steps.push({ stage: { kind: "remediation", round: rounds.size }, at: attempt.startedAt });
    }
    const sealed =
      execution === undefined
        ? attempt.startedAt
        : new Date(Date.parse(attempt.startedAt) + execution.usage.wall_clock_ms).toISOString();
    steps.push({ stage: { kind: "seal" }, at: sealed });
    for (const check of attempt.checks)
      steps.push({
        stage: { kind: "check", name: check.name },
        at: sealed,
        reason: `Result: ${check.status}.` + (check.detail ? `\n\n${check.detail}` : ""),
      });
    const reviewBundle = attempt.bundles.find(
      (bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"),
    );
    if (attempt.review !== null || reviewBundle !== undefined) {
      const review = attempt.review;
      steps.push({
        stage: { kind: "review", round: attempt.round },
        at: review?.created_at ?? reviewBundle!.created_at,
        ...(review === null
          ? {}
          : { reason: findingsLeft(review.findings.filter((finding) => finding.status === "open").length) }),
      });
    }
    const verification = attempt.bundles.find(
      (bundle) => bundle.kind === "review" && bundle.subject_id === `cv_${attempt.id}`,
    );
    if (attempt.verification !== null || verification !== undefined)
      steps.push({ stage: { kind: "verify", round: attempt.round }, at: verification?.created_at ?? sealed });
    // Each stage no earlier than the one before it, as the attempt ran them.
    let floor = steps[0]!.at;
    return steps.map(({ stage, at, reason }) => {
      floor = Date.parse(at) > Date.parse(floor) ? at : floor;
      return { text: stageWords(stage), reason: reason ?? null, at: floor };
    });
  });
}

/**
 * What the loop page's steps list, newest first: every stage the runner went
 * through and every state the ticket was moved to, each where its time puts
 * it.
 *
 * While a run is live, its stages are read from its log as the CLI announces
 * them, beside the stages of the attempts on record from before it. Once none
 * is, they are rebuilt from the records of every attempt, so a page opened
 * again lists the same stages; the last run's log stands in where it recorded
 * no attempt, as a run that ended before its first did. Only the runner's own
 * stage lines are read: never the executor's or the reviewer's words, and
 * never a tool call, which are the Watch page's.
 */
export function loopSteps(input: {
  history: Detail["ticket"]["history"];
  jobs: readonly Job[];
  active: Job | undefined;
  attempts: readonly AttemptView[];
  log: StageLog;
  now: string;
}): LoopStep[] {
  const { history, jobs, active, attempts, log, now } = input;
  const last = jobs.filter(isRun).at(-1);
  const since = (job: Job) => (attempt: AttemptView) => Date.parse(attempt.startedAt) >= Date.parse(job.startedAt);
  const logged =
    active !== undefined && isRun(active)
      ? active
      : last !== undefined && !attempts.some(since(last))
        ? last
        : undefined;
  const recorded = recordedStages(logged === undefined ? attempts : attempts.filter((attempt) => !since(logged)(attempt)));
  const stages = (job: Job): (LoopStep & { key: string })[] =>
    log.read(job, now).map(({ stage, at }) => ({
      text: stageWords(stage.stage),
      // A review's count is the whole of it once a later stage followed, or the run ended.
      reason: stage.stage.kind === "review" && (stage.settled || !isLive(job)) ? findingsLeft(stage.findings) : null,
      at,
      // A stage read before the page was open has no time, and was announced
      // after the run started.
      key: at ?? job.startedAt,
    }));
  const moves = history.flatMap((entry): LoopStep[] => [
    // The run's delivery, where its log is not the one read.
    ...(entry.to === "pr_open" &&
    RUN_STATES.has(entry.from ?? "") &&
    (logged === undefined || Date.parse(entry.at) < Date.parse(logged.startedAt))
      ? [{ text: stageWords({ kind: "delivery" }), reason: null, at: entry.at }]
      : []),
    { text: entry.note || entry.to.replaceAll("_", " "), reason: null, at: entry.at },
  ]);
  return [
    ...recorded.map((step) => ({ ...step, key: step.at! })),
    ...(logged === undefined ? [] : stages(logged)),
    ...moves.map((step) => ({ ...step, key: step.at! })),
  ]
    .map((step, order) => ({ step, time: Date.parse(step.key), order }))
    .sort((left, right) => left.time - right.time || left.order - right.order)
    .reverse()
    .map(({ step: { text, reason, at } }) => ({ text, reason, at }));
}

/**
 * Whether a review's error means the reviewer answered and its answer could
 * not be used — every verdict it returned rejected, or one the plan could not
 * accept — rather than no answer being had at all.
 */
const UNPARSED: Record<ReviewError["kind"], boolean> = {
  verdict_rejected: true,
  malformed_verdict: true,
  unknown_criterion_id: true,
  provider_unavailable: false,
  budget_exhausted: false,
  timeout: false,
  internal: false,
};
/** What the desktop says of a review whose answer could not be used; the error as the review recorded it sits behind an `i` beside it. */
export const REVIEW_UNPARSED = "The reviewer's answer could not be parsed.";
/** The sentence a review's error is said in: {@link REVIEW_UNPARSED} for an answer that could not be used, `otherwise` for every other kind. */
export const reviewErrorSentence = (error: ReviewError, otherwise: string): string =>
  UNPARSED[error.kind] ? REVIEW_UNPARSED : otherwise;

/** A rule's or a reason's name in words: `wall_clock_exceeded` reads "wall clock exceeded". Only ever a name, never a path or a command. */
const words = (name: string): string => name.replaceAll("_", " ");
/** A duration as it is said: "10 minutes", or seconds under one. */
const lasting = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  const [n, unit] = minutes >= 1 ? [minutes, "minute"] : [Math.round(ms / 1000), "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};
/** A duration as a limit is named: "10-minute". */
const limitOf = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}-minute` : `${Math.round(ms / 1000)}-second`;
const count = (value: number): string => value.toLocaleString("en-US");

/** What the guard refuses (`PROHIBITED_ACTIONS`), as a person names it. */
const GUARD_KINDS: Record<ProhibitedAction, string> = {
  self_merge: "a merge of its own work",
  write_policy_path: "a write to a file that sets policy",
  write_outside_worktree: "a write outside the worktree",
  write_outside_scope: "a write outside the contract's scope",
  write_prohibited_path: "a write to a prohibited path",
  destructive_git: "a destructive git operation",
  registry_publication: "a publication to a package registry",
  non_local_migration: "a migration against a database that is not local",
  modify_judging_artifact: "a change to what judges the attempt",
  unlisted_egress_host: "a connection to a host that is not listed",
  external_communication: "an external communication",
  new_registry_dependency: "a new dependency from a package registry",
  enable_own_tooling: "enabling its own tooling",
};
const guardKind = (kind: string): string =>
  (GUARD_KINDS as Record<string, string | undefined>)[kind] ?? `a prohibited action (${words(kind)})`;

/**
 * Each refusal a prohibited-action termination records: `kind: reading: command`,
 * several joined by "; ". Split only where "; " is followed by a kind the guard
 * names, since a command can hold "; " of its own.
 */
function refusals(detail: string): { kind: string; reading: string; command: string | null }[] {
  const kinds = Object.keys(GUARD_KINDS).join("|");
  return detail
    .split(new RegExp(`; (?=(?:${kinds}):)`))
    .map((entry) => {
      const [kind = "", ...rest] = entry.split(":");
      const text = rest.join(":").trim();
      const at = text.indexOf(": ");
      return at < 0
        ? { kind: kind.trim(), reading: text, command: null }
        : { kind: kind.trim(), reading: text.slice(0, at).trim(), command: text.slice(at + 2).trim() };
    });
}

/** A ceiling measured in a count: "The attempt used 1,200 tokens against its 1,000-token limit." */
const counted =
  (verb: string, unit: string) =>
  (used: number | null, limit: number | null): string =>
    `The attempt ${verb} ${used === null ? `more ${unit}s than it may` : `${count(used)} ${unit}s`}` +
    (limit === null ? "." : ` against its ${count(limit)}-${unit} limit.`);

/**
 * The ceilings that end an attempt (D-096), each with the resource the record
 * measures it in, which is also the setting that raises it, and how its
 * sentence reads that measure. A stall is not among them: it is a hang, and is
 * said as one.
 */
const CEILINGS: Record<string, { resource: string; say: (used: number | null, limit: number | null) => string }> = {
  wall_clock_exceeded: {
    resource: "attempt_wall_clock_ms",
    say: (used, limit) =>
      `The attempt ran${used === null ? "" : ` for ${lasting(used)}`}` +
      (limit === null ? " past its time limit." : `, past its ${limitOf(limit)} limit.`),
  },
  cost_ceiling_exceeded: {
    resource: "attempt_cost_micros",
    say: (used, limit) =>
      `The attempt cost ${used === null ? "more than it may" : formatUsd(used, 2)}` +
      (limit === null ? "." : ` against its ${formatUsd(limit, 2)} limit.`),
  },
  token_ceiling_exceeded: { resource: "attempt_tokens", say: counted("used", "token") },
  iteration_ceiling_exceeded: { resource: "attempt_iterations", say: counted("took", "turn") },
  command_ceiling_exceeded: { resource: "attempt_commands", say: counted("ran", "command") },
};

/** What ended a command, as the loop page says it. */
export interface RunEnding {
  job: Job;
  /** The card's title: "The run ended" for the loop, the command's own name otherwise. */
  title: string;
  /** One sentence, read from the records. */
  sentence: string;
  /** The fuller account behind the sentence, from the same records. */
  reason: string;
  /** The command's own output, where there is no verdict of the loop's to say instead. */
  log: string | null;
}

/**
 * What ended a ticket's last command, where it failed or was cut off by Perbo
 * closing: one sentence, and the fuller reason behind it.
 *
 * A run whose loop reached a verdict ends `failed` whenever the verdict is not
 * an approval — the review requesting changes, the reviewer's answer not
 * parsing, an attempt terminated, a ceiling reached — and its error is then
 * the whole run log. What a person
 * needs is the verdict, read from the attempt the run recorded. Where there is
 * no verdict to read — the CLI refusing to start, an approval refused, a
 * failure after the review, Perbo closing mid-command — the command's own
 * output is what there is, carried whole in `log`.
 *
 * Every word of `reason` comes from the records: the termination the runner
 * wrote, the ceiling it hit, the review's findings or its error and the
 * CLI's own error lines. The findings are the reviewer's words, shown as what it found and
 * never acted on.
 *
 * Null where the last command neither failed nor was interrupted.
 */
export function runEnding(
  jobs: readonly Job[],
  latest: AttemptView | undefined,
  ticketState: string,
): RunEnding | null {
  const job = jobs.at(-1);
  if (job === undefined || (job.state !== "failed" && job.state !== "interrupted")) return null;
  const run = isRun(job);
  const title = run ? "The run ended" : `${job.label} failed`;
  const output = job.error ?? job.log;
  // Where there is no verdict of the loop's: the command's own words.
  const own = (sentence: string): RunEnding => ({ job, title, sentence, reason: cliSentence(output), log: output });
  if (job.state === "interrupted")
    return {
      ...own("Perbo closed before the command reported an outcome."),
      title: run ? "The run ended" : `${job.label} did not finish`,
      reason: output,
    };
  // The attempt is this command's own only where it started after the command did.
  const recorded = run && latest !== undefined && Date.parse(latest.startedAt) >= Date.parse(job.startedAt);
  if (!recorded)
    return own(
      run
        ? "The run ended before the loop recorded an attempt."
        : (cliSentence(output).split("\n")[0] ?? "") || `${job.label} failed.`,
    );
  const [head = "", ...rest] = latest.termination.split(":");
  const reason = head.trim();
  const detail = rest.join(":").trim();
  const noted = detail ? ` It recorded: ${detail}` : "";
  /** The measure the record holds of a resource, and its ceiling. */
  const measured = (resource: string): [number | null, number | null] => {
    const entry = latest.ceilings.find((each) => each.resource === resource);
    return [entry?.used ?? null, entry?.ceiling ?? null];
  };
  const ended = (sentence: string, why: string): RunEnding => ({ job, title, sentence, reason: why, log: null });
  if (reason === "no_changes")
    return ended(
      "The agent made no change to the branch.",
      "The attempt ended with nothing changed on the branch, so there was nothing to check or review." + noted,
    );
  if (reason === "no_changes_after_denials")
    return ended(
      "The agent made no change to the branch after the guard refused its commands.",
      "The guard refused the commands the agent tried, and the attempt ended with nothing changed on the branch." +
        noted,
    );
  if (reason === "prohibited_action") {
    const refused = refusals(detail);
    const kinds = [...new Set(refused.map((each) => guardKind(each.kind)))];
    return ended(
      `The attempt was terminated: the guard refused ${kinds.join(" and ")}.`,
      refused
        .map((each) =>
          each.command === null
            ? `The guard refused ${guardKind(each.kind)}: ${each.reading}.`
            : `The guard refused the command \`${each.command}\`: it read it as ${each.reading}, which is ${guardKind(each.kind)}.`,
        )
        .join("\n") + "\nSo it ended the attempt.",
    );
  }
  if (reason === "stalled") {
    const [quiet, limit] = measured("attempt_stall_ms");
    return ended(
      quiet !== null && limit !== null
        ? `The attempt stalled for ${lasting(quiet)}, past its ${limitOf(limit)} limit.`
        : "The attempt stalled: the agent stopped doing anything.",
      `The agent showed no tool activity for ${quiet === null ? "longer than the stall window" : lasting(quiet)}, ` +
        "and the runner ends an attempt that has gone quiet that long. That is a hang rather than a limit on " +
        "the work, so the same brief against the same tree would hang the same way.",
    );
  }
  if (reason === "round_iteration_ceiling_exceeded")
    return ended(
      "A refinement round took more turns than a round may.",
      "The runner ends a refinement round that reaches its turn limit, which the repository's configuration " +
        "sets as `round_iterations`; raise it there to give a round more turns." + noted,
    );
  const ceiling = CEILINGS[reason];
  if (ceiling !== undefined) {
    const sentence = ceiling.say(...measured(ceiling.resource));
    return ended(
      sentence,
      `${sentence} The runner stops an attempt at this limit, which the repository's configuration sets as ` +
        `\`${ceiling.resource}\`; raise it there to let a run go further.`,
    );
  }
  if (reason === "cancelled") return ended("The run was stopped.", "The attempt was stopped before it finished.");
  if (reason !== "completed")
    return ended(
      `The attempt was terminated: ${words(reason)}.`,
      `The runner ended the attempt (${words(reason)})${detail ? `. It recorded: ${detail}` : ""}.`,
    );
  const review = latest.review;
  // The reviewer answered and nothing it answered could be used: one sentence,
  // with the error behind the `i` exactly as the review recorded it.
  if (review?.error && UNPARSED[review.error.kind]) return ended(REVIEW_UNPARSED, review.error.message);
  const decision = review?.decision ?? latest.reviewDecision;
  const open = (review?.findings ?? []).filter((finding) => finding.status === "open");
  const findings = (asked: string): string =>
    `The independent review read the change against the contract and ${asked} ` +
    `${open.length === 1 ? "one thing" : `${open.length} things`}:\n` +
    open
      .map((finding, index) => `${index + 1}. ${finding.statement}${finding.blocking ? " (holds the merge)" : ""}`)
      .join("\n");
  if (decision === "changes_requested" || (decision !== "escalate" && ticketState === "changes_requested"))
    return ended(
      "The review requested changes.",
      open.length === 0
        ? "The independent review read the change against the contract and did not approve it; the review on the ticket says why."
        : findings("asked for changes to"),
    );
  if (decision === "escalate")
    return ended(
      "The review escalated the change to you.",
      open.length === 0
        ? "The independent review read the change against the contract and put the decision to you; the review on the ticket says what it is."
        : findings("put to you"),
    );
  if (/closure\(s\) still open/.test(latest.outcome))
    return ended(
      "Refinement ended with findings still open.",
      open.length === 0
        ? `The refinement rounds ended with ${latest.outcome}; the review on the ticket lists them.`
        : findings("still holds open"),
    );
  // No verdict of the loop's to say: the command's output says the rest.
  if (decision === "approve") return own("The review approved the change, and the run failed after it.");
  return own("The run failed after the loop recorded its attempt.");
}

/**
 * What a failed command said, out of its output: the lines the CLI marks as an
 * error or a blocking check, and its last line, which is where it says what it
 * did about them.
 */
export function cliSentence(error: string): string {
  const lines = error.split("\n").map((line) => line.trim()).filter(Boolean);
  const marked = (line: string): boolean => /^(error|blocking)\b/.test(line);
  const said = lines.filter(marked).map((line) => line.replace(/^error:\s*/, "").replace(/^blocking\s+/, ""));
  const last = lines.at(-1);
  return [...said, ...(last === undefined || marked(last) ? [] : [last])].join("\n");
}
