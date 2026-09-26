import { formatUsd } from "@perbo/contracts/browser";
import type { ProhibitedAction } from "@perbo/contracts";
import { isRun } from "../../shared/jobs.js";
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
 * an approval — the review requesting changes, an attempt terminated, a
 * ceiling reached — and its error is then the whole run log. What a person
 * needs is the verdict, read from the attempt the run recorded. Where there is
 * no verdict to read — the CLI refusing to start, an approval refused, a
 * failure after the review, Perbo closing mid-command — the command's own
 * output is what there is, carried whole in `log`.
 *
 * Every word of `reason` comes from the records: the termination the runner
 * wrote, the ceiling it hit, the review's findings and the CLI's own error
 * lines. The findings are the reviewer's words, shown as what it found and
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
function cliSentence(error: string): string {
  const lines = error.split("\n").map((line) => line.trim()).filter(Boolean);
  const marked = (line: string): boolean => /^(error|blocking)\b/.test(line);
  const said = lines.filter(marked).map((line) => line.replace(/^error:\s*/, "").replace(/^blocking\s+/, ""));
  const last = lines.at(-1);
  return [...said, ...(last === undefined || marked(last) ? [] : [last])].join("\n");
}
