import { costOf, formatUsd, rollCosts, type Cost } from "@perbo/contracts/browser";
import type { DefaultedResource, LimitedResource, PerTokenCostLimit, ProhibitedAction, ReviewError } from "@perbo/contracts";
import { isLive, isRun } from "../../shared/jobs.js";
import { runnerStages, runnerTally, spokenWords, type LoggedStage, type RunnerStage } from "../../shared/runner-progress.js";
import { retainedOutput, type TranscriptEntry } from "./retained-output.js";
import type { AttemptView, Detail, Job, OpenDraft } from "../../shared/protocol.js";
import type { PageProps, TaskView } from "../shell/route.js";
import { projectTicket, recordedRunnerStages, stoppedByPerson } from "./ticket-workspace.js";
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
  // D-137: while the run waits on the person, the pause
  // is the last line, in the runner's own words and never an agent's.
  if (active !== undefined && isRun(active)) {
    const last = runnerStages(active.log).findLast(({ stage }) => stage.kind === "egress" || stage.kind === "egressSettled");
    return last?.stage.kind === "egress"
      ? [...fromLog(active), { author: "Perbo", label: "decision raised", text: stageWords(last.stage) }]
      : fromLog(active);
  }
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
    // D-137: the pause, and how it ended.
    case "egress":
      return `Waiting on you: allow ${stage.host}?`;
    case "egressSettled":
      return stage.settled === "allowed"
        ? `You allowed ${stage.host}`
        : stage.settled === "refused"
          ? `You refused ${stage.host}`
          : `Nobody answered about ${stage.host}`;
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
 */
function recordedStages(attempts: readonly AttemptView[]): LoopStep[] {
  return recordedRunnerStages(attempts).flatMap((stages) => {
    // Each stage no earlier than the one before it, as the attempt ran them.
    let floor = stages[0]!.at;
    return stages.map(({ stage, at, check, open }) => {
      floor = Date.parse(at) > Date.parse(floor) ? at : floor;
      return {
        text: stageWords(stage),
        reason:
          check !== undefined
            ? `Result: ${check.status}.` + (check.detail ? `\n\n${check.detail}` : "")
            : open !== undefined
              ? findingsLeft(open)
              : null,
        at: floor,
      };
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

/** The limits nothing sets unless a repository's own configuration names them, so a refusal by one is the repository's number. */
type RepositoryOnly = Exclude<LimitedResource, DefaultedResource | PerTokenCostLimit>;
const plural = (n: number, unit: string): string => `${count(n)} ${unit}${n === 1 ? "" : "s"}`;
/**
 * Each limit a run can be refused by, as a person reads it: what it bounds,
 * a measure of it in its own unit, and whether its number can only have come
 * from the repository's configuration or may be Perbo's default for it.
 */
const LIMITS: {
  [R in LimitedResource]: {
    bounds: string;
    measure: (n: number) => string;
    set: R extends RepositoryOnly ? "repository" : "default";
  };
} = {
  concurrent_local_attempts: {
    bounds: "the runs this machine takes at once",
    measure: (n) => plural(n, "run"),
    set: "repository",
  },
  local_workspace_bytes: {
    bounds: "the disk the worktrees fill on this machine",
    measure: (n) => `${(n / 1024 ** 3).toFixed(1)} GiB`,
    set: "default",
  },
  attempt_stall_ms: { bounds: "how long an agent may go without doing anything", measure: lasting, set: "default" },
  attempt_wall_clock_ms: { bounds: "how long one attempt may run", measure: lasting, set: "repository" },
  attempt_commands: { bounds: "the commands one attempt may run", measure: (n) => plural(n, "command"), set: "repository" },
  attempt_iterations: { bounds: "the turns one attempt may take", measure: (n) => plural(n, "turn"), set: "repository" },
  round_iterations: {
    bounds: "the turns one refinement round may take",
    measure: (n) => plural(n, "turn"),
    set: "repository",
  },
  attempt_tokens: { bounds: "the tokens one attempt may use", measure: (n) => plural(n, "token"), set: "repository" },
  attempt_cost_micros: { bounds: "what one attempt may spend", measure: (n) => formatUsd(n, 2), set: "default" },
  remediation_rounds: {
    bounds: "the refinement rounds one ticket may take",
    measure: (n) => plural(n, "round"),
    set: "default",
  },
  ticket_cost_micros: { bounds: "what one ticket may spend", measure: (n) => formatUsd(n, 2), set: "default" },
  wait_for_provider_ms: {
    bounds: "how long the loop waits out a provider's limit",
    measure: lasting,
    set: "default",
  },
};

/** The kill switches a refusal can name, by the words the refusal is printed in. */
const KILL_SWITCHES: { reads: RegExp; key: string; says: (match: RegExpExecArray) => string }[] = [
  { reads: /^global read-only mode is engaged/, key: "global_read_only", says: () => "which lets no attempt start or continue" },
  {
    reads: /^automation is disabled for organisation (.+)$/,
    key: "organisation_automation_disabled",
    says: (match) => `which stops automation for the organisation ${match[1]}`,
  },
  {
    reads: /^provider (\S+) is disabled by kill switch$/,
    key: "disabled_providers",
    says: (match) => `which names the provider ${match[1]}`,
  },
  {
    reads: /^model (\S+) is disabled by kill switch$/,
    key: "disabled_models",
    says: (match) => `which names the model ${match[1]}`,
  },
];

/**
 * A run the CLI refused by a limit (`describeFailure`), in Perbo's own words:
 * the limit named by what it bounds, where its number comes from — the
 * repository's `.perbo/config.json` and the key in it, or Perbo's default that
 * key would override — and, for the runs this machine takes at once, that a
 * run of another ticket was going (D-049). Null for output that holds no such
 * refusal, or one naming a limit this does not know.
 */
function limitRefusal(output: string): { sentence: string; reason: string } | null {
  const limit = /refused by a limit: (\w+) would reach (\d+), above the limit of (\d+)\./.exec(output);
  if (limit !== null) {
    const resource = limit[1]! as LimitedResource;
    const known = (LIMITS as Record<string, (typeof LIMITS)[LimitedResource] | undefined>)[resource];
    if (known === undefined) return null;
    const reached = Number(limit[2]);
    const ceiling = Number(limit[3]);
    const key = `limits.limits.${resource}`;
    if (resource === "concurrent_local_attempts" && reached - 1 === 0)
      return {
        sentence: "The run did not start: this repository's configuration allows no runs at all on this machine.",
        reason:
          `This repository's .perbo/config.json sets ${key} to 0, so no run starts on this machine, whatever ` +
          `else is going. Raise the number there, or remove ${key}, to let runs start.`,
      };
    if (resource === "concurrent_local_attempts") {
      const others = reached - 1 === 1 ? "a run of another ticket was" : `${count(reached - 1)} runs of other tickets were`;
      return {
        sentence: `The run did not start: this repository's configuration allows ${ceiling === 1 ? "one run" : `${count(ceiling)} runs`} at a time on this machine, and ${others} going.`,
        reason:
          "Runs of different tickets go side by side unless a repository's own configuration names a number. " +
          `This repository's .perbo/config.json sets ${key} to ${count(ceiling)}, and ${others} going when this one ` +
          `was started, so it was refused before anything ran. Raise the number there, or remove ${key}, to let ` +
          "runs go side by side.",
      };
    }
    const from =
      known.set === "repository"
        ? `This repository's .perbo/config.json sets ${key} to ${known.measure(ceiling)}.`
        : `The limit is ${known.measure(ceiling)}: Perbo's own unless this repository's .perbo/config.json names ${key}, which then sets it.`;
    return {
      sentence: `The run was refused by a limit on ${known.bounds}: it would reach ${known.measure(reached)}, above the limit of ${known.measure(ceiling)}.`,
      reason: `${from} The run was refused where it would have gone past it. Raise ${key} in .perbo/config.json to let a run go further.`,
    };
  }
  const switched = /refused by a limit: (.+?)\. Clear the kill switch/.exec(output);
  if (switched === null) return null;
  for (const { reads, key, says } of KILL_SWITCHES) {
    const match = reads.exec(switched[1]!);
    if (match !== null)
      return {
        sentence: "The run was refused: a kill switch in this repository's configuration is on.",
        reason:
          `This repository's .perbo/config.json turns on limits.kill_switches.${key}, ${says(match)}. ` +
          "Turn it off there to let a run start.",
      };
  }
  return null;
}

/** One reason a run stopped, in words, with the whole of what the records hold of it behind an `i`. */
export interface StopReason {
  /** One line, read from the records. */
  text: string;
  /** The whole recorded reason. */
  detail: string;
}

/** What ended a command, as the loop page and the stopped page say it. */
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
  /** Whether the person stopped the run themselves (`stoppedByPerson`): the one stop Continue the task carries on from. */
  byPerson: boolean;
  /**
   * Each reason the command ended, one line each: the sentence alone for most
   * endings, and one line for each command the guard refused.
   */
  reasons: StopReason[];
}

/** The review errors that are not an answer the reviewer gave, as the stop is said of them. */
const UNHAD: Record<Exclude<ReviewError["kind"], "verdict_rejected" | "malformed_verdict" | "unknown_criterion_id">, string> = {
  provider_unavailable: "The reviewer's model provider was unavailable, so the change was not reviewed.",
  budget_exhausted: "The review ran out of its budget before it reached a verdict.",
  timeout: "The review timed out before it reached a verdict.",
  internal: "The review failed inside Perbo before it reached a verdict.",
};

/**
 * What ended a ticket's last command, where it failed, was cut off by Perbo
 * closing, or was a run the person stopped: one sentence, the fuller reason
 * behind it, and the reasons one line each.
 *
 * A run that ends on a verdict for the person completes, paused for them
 * (`RUN_VERDICTS`), and is not an ending: this reads only what did not
 * complete. A run failed where the attempt it recorded was terminated — a
 * limit reached, a host reached for, a command refused, the agent or its
 * provider failing, the reviewer's answer not parsing — and that is read from
 * the attempt. Where there is none to read — the CLI refusing to start or
 * refusing a limit, a failure after the review, Perbo closing mid-command —
 * the command's own output is what there is, carried whole in `log`. A run the
 * person stopped says so, whatever its attempt recorded as it was cut off.
 *
 * Every word of `reason` comes from the records: the termination the runner
 * wrote, the ceiling it hit, the host it reached for, the review's error, and
 * the CLI's own error lines.
 *
 * Null where the last command neither failed, was interrupted, nor was a run
 * that was stopped.
 */
export function runEnding(jobs: readonly Job[], latest: AttemptView | undefined): RunEnding | null {
  const job = jobs.at(-1);
  if (job === undefined) return null;
  const run = isRun(job);
  const title = run ? "The run ended" : `${job.label} failed`;
  // The attempt is this command's own only where it started after the command did.
  const recorded = run && latest !== undefined && Date.parse(latest.startedAt) >= Date.parse(job.startedAt);
  if (run && stoppedByPerson([job])) {
    const sentence = "You stopped the run.";
    const why = recorded
      ? "The run was stopped from this desktop while its attempt was going, and the work that attempt had done is kept."
      : "The run was stopped from this desktop before the loop recorded an attempt of it.";
    return { job, title, sentence, reason: why, log: null, byPerson: true, reasons: [{ text: sentence, detail: why }] };
  }
  if (job.state !== "failed" && job.state !== "interrupted") return null;
  const output = job.error ?? job.log;
  // A run refused by a limit is said in Perbo's words, the whole log under Watch.
  const refused = run ? limitRefusal(output) : null;
  // Where there is no verdict of the loop's: the command's own words.
  const own = (sentence: string, reason = cliSentence(output)): RunEnding =>
    refused !== null
      ? {
          job,
          title,
          sentence: refused.sentence,
          reason: refused.reason,
          log: null,
          byPerson: false,
          reasons: [{ text: refused.sentence, detail: refused.reason }],
        }
      : { job, title, sentence, reason, log: output, byPerson: false, reasons: [{ text: sentence, detail: reason || output }] };
  if (job.state === "interrupted") {
    const sentence = run ? "Perbo closed while the run was going." : "Perbo closed before the command reported an outcome.";
    return {
      job,
      title: run ? "The run ended" : `${job.label} did not finish`,
      sentence,
      reason: output,
      log: output,
      byPerson: false,
      reasons: [{ text: sentence, detail: output }],
    };
  }
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
  const ended = (sentence: string, why: string, reasons: StopReason[] = [{ text: sentence, detail: why }]): RunEnding => ({
    job,
    title,
    sentence,
    reason: why,
    log: null,
    byPerson: false,
    reasons,
  });
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
    const told = refused.map((each) =>
      each.command === null
        ? {
            text: `The guard refused ${guardKind(each.kind)}.`,
            detail: `The guard refused ${guardKind(each.kind)}: ${each.reading}.`,
          }
        : {
            text: `The guard refused \`${each.command}\`, ${guardKind(each.kind)}.`,
            detail: `The guard refused the command \`${each.command}\`: it read it as ${each.reading}, which is ${guardKind(each.kind)}.`,
          },
    );
    return ended(
      `The attempt was terminated: the guard refused ${kinds.join(" and ")}.`,
      told.map((each) => each.detail).join("\n") + "\nSo it ended the attempt.",
      told.map((each) => ({ ...each, detail: `${each.detail}\nSo it ended the attempt.` })),
    );
  }
  if (reason === "unlisted_egress_host") {
    // The host as the runner named it, shown as words and never used.
    const host = /^(\S+) is not on\b/.exec(detail)?.[1] ?? null;
    // Asked about and left unanswered until the attempt's stall window closed.
    const unanswered = /nobody answered/.test(detail) ? ", and nobody answered whether to allow it" : "";
    return ended(
      host === null
        ? `The agent reached for a host the repository does not list${unanswered}.`
        : `The agent reached for ${host}, a host the repository does not list${unanswered}.`,
      "The runner ends an attempt whose agent reaches for a host outside the hosts the repository lists for its " +
        "executor." + noted,
    );
  }
  if (reason === "transport_unavailable")
    return ended(
      "The model provider was unavailable, so the attempt ended without doing the work.",
      "The provider kept answering that it could not take the request until the agent's retries ran out." + noted,
    );
  if (reason === "agent_error")
    return ended("The agent exited with an error.", "The coding agent ended the attempt on an error of its own." + noted);
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
  // Nothing the attempt recorded says why: the command's output says the rest.
  if (decision === "approve") return own("The review approved the change, and the run failed after it.");
  const failed = own("The run failed after the loop recorded its attempt.");
  // No answer was had from the reviewer at all: the reason says what kept it,
  // with the error as the review recorded it.
  return review?.error
    ? { ...failed, reasons: [{ text: UNHAD[review.error.kind as keyof typeof UNHAD], detail: review.error.message }] }
    : failed;
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
