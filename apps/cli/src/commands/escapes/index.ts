import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BaselineFileSchema,
  ESCAPE_WINDOW_DAYS,
  EXIT_CODES,
  PARTNER_READING_CAVEAT,
  TicketEscapesSchema,
  buildTicketEscapes,
  escapeRow,
  summariseEscapes,
  summariseStops,
  type EscapeRow,
  type ObservedCommit,
  type ObservedHead,
  type TicketCommit,
  type TicketEscapes,
} from "@perbo/contracts";
import { CommandFailedError, gh, git, type RunResult } from "@perbo/workspace";
import { UsageError } from "../../usage-error.js";
import type { Streams } from "../../streams.js";
import { baselinePath } from "../baseline/index.js";
import { countDueness, dueAt, duenessOf, escapeReading, type DueCounts } from "./internal/due.js";
import {
  METRIC_TABLE_HEADER,
  bounds,
  pct,
  readDecisions,
  readStopRecords,
  renderDecisions,
  renderMetricTable,
  stopsRows,
} from "../stops.js";
import { listChanges, storeDir, type SyncedChange } from "../../store/tickets.js";

/**
 * `perbo escapes` — of the changes that merged, how many were undone or
 * reworked within fourteen days (`SCP-145`).
 *
 * Two halves, deliberately split. The **collection** half runs under
 * `perbo sync`: local `git` and `gh`, writing
 * `<store>/state/<ticket_id>.escapes.json` whole every time. The **reporting**
 * half is this command, and it reads nothing but those files and the tickets
 * beside them — no network, no `gh`, no `git`. A weekly read that needs a
 * credential and a fetch to print a number is a number nobody prints.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** `git log` record and field separators; neither can occur in a path. */
const RECORD = "\u001e";
const FIELD = "\u001f";

export class EscapeCollectionError extends Error {}

export interface EscapesArgs {
  repo: string;
  store: string | null;
  json: boolean;
}

export function parseEscapesArgs(argv: readonly string[]): EscapesArgs {
  const args: EscapesArgs = { repo: ".", store: null, json: false };
  const tokens = argv.flatMap((token) =>
    token.startsWith("--") && token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token],
  );
  const value = (index: number, token: string): string => {
    const next = tokens[index];
    if (next === undefined) throw new UsageError(`${token} requires a value`);
    return next;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    switch (token) {
      case "--repo":
        args.repo = value(++i, token);
        break;
      case "--store":
        args.store = value(++i, token);
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new UsageError(`unknown option '${token}' for escapes`);
    }
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * Collection: local `git` and `gh`, under `perbo sync`.
 * ------------------------------------------------------------------ */

/**
 * What one answer to one of these questions may be. Collection reads a branch's
 * whole history and the paths every commit on it touched, which is large on a
 * busy default branch and is counted rather than skimmed.
 */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/** What a command that ran and failed said, preferring its own stderr. */
function said(result: RunResult): string {
  const line = result.stderr.split("\n").find((text) => text.trim() !== "");
  if (line !== undefined) return line.trim();
  return new CommandFailedError(result).message.split("\n")[0] ?? "";
}

/** What a command that never started said, which is Node's own wrapper. */
function reason(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
}

/** What GitHub knows and the local checkout does not: which merge, and when. */
export interface MergeFacts {
  /** The branch the pull request merged into. */
  default_branch: string;
  merge_commit: string;
  merged_at: string;
  /** The pull request's own commits, so a revert naming one of them is found. */
  branch_commits: string[];
  pull_request_url: string | null;
  pull_request_number: number | null;
}

interface GhMergedPullRequest {
  number?: number;
  url?: string;
  state?: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  baseRefName?: string;
  commits?: Array<{ oid?: string }>;
}

/**
 * The merge as `gh` reports it. Null when there is no merged pull request to
 * read; throws when `gh` could not be asked at all, because a missing answer
 * and an answered "not merged" must not write the same record.
 */
export function readMergeFacts(args: {
  repositoryRoot: string;
  branch: string;
  pull_request_number: number | null;
}): MergeFacts | null {
  let answer: RunResult;
  try {
    answer = gh.viewPullRequestSync(
      args.repositoryRoot,
      args.pull_request_number === null ? args.branch : String(args.pull_request_number),
      ["number", "url", "state", "mergedAt", "mergeCommit", "baseRefName", "commits"],
      { maxOutputBytes: MAX_ANSWER_BYTES },
    );
  } catch (error) {
    throw new EscapeCollectionError(
      `\`gh pr view\` could not be asked about ${args.branch}: ${reason(error)}`,
      { cause: error },
    );
  }
  // A body that arrived cut is not a pull request that did not merge: the two
  // must not write the same record, and only this says which one happened.
  if (answer.truncated) {
    throw new EscapeCollectionError(
      `\`gh pr view\` said more about ${args.branch} than ${MAX_ANSWER_BYTES} bytes, and only ` +
        "part of it arrived",
    );
  }
  if (answer.code !== 0) {
    throw new EscapeCollectionError(
      `\`gh pr view\` could not be asked about ${args.branch}: ${said(answer)}`,
      { cause: new CommandFailedError(answer) },
    );
  }
  let parsed: GhMergedPullRequest;
  try {
    parsed = JSON.parse(answer.stdout) as GhMergedPullRequest;
  } catch (error) {
    throw new EscapeCollectionError(
      `\`gh pr view\` returned something that is not JSON: ` +
        (error instanceof Error ? error.message.split("\n")[0] : String(error)),
    );
  }
  const sha = parsed.mergeCommit?.oid;
  if (parsed.state !== "MERGED" || !sha || !parsed.mergedAt) return null;
  return {
    default_branch: parsed.baseRefName ?? "main",
    merge_commit: sha,
    merged_at: new Date(parsed.mergedAt).toISOString(),
    branch_commits: (parsed.commits ?? []).flatMap((commit) => (commit.oid ? [commit.oid] : [])),
    pull_request_url: parsed.url ?? null,
    pull_request_number: parsed.number ?? null,
  };
}

/**
 * One read of this checkout's history, or the refusal that says it could not
 * be read. An answer cut at the ceiling is a refusal too: these are commits
 * and paths that get counted, and a list short by whatever was dropped counts
 * as an escape nobody had.
 */
const read = (cwd: string, ...args: string[]): string => {
  let result: RunResult;
  try {
    result = git.runSync(cwd, args, { maxOutputBytes: MAX_ANSWER_BYTES });
  } catch (error) {
    throw new EscapeCollectionError(`git ${args.join(" ")} failed in ${cwd}: ${reason(error)}`, {
      cause: error,
    });
  }
  if (result.truncated) {
    throw new EscapeCollectionError(
      `git ${args.join(" ")} in ${cwd} said more than ${MAX_ANSWER_BYTES} bytes, and only part ` +
        "of it arrived",
    );
  }
  if (result.code !== 0) {
    throw new EscapeCollectionError(`git ${args.join(" ")} failed in ${cwd}: ${said(result)}`, {
      cause: new CommandFailedError(result),
    });
  }
  return result.stdout;
};

/** The first of `refs` the checkout actually has; the default branch may be local, remote or both. */
function resolveRef(cwd: string, branch: string): string {
  const here = (ref: string): boolean => {
    try {
      return git.runSync(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;
    } catch {
      return false;
    }
  };
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`, branch]) {
    if (here(ref)) return ref;
  }
  throw new EscapeCollectionError(
    `neither origin/${branch} nor ${branch} is in this checkout, so the history after the merge ` +
      "cannot be read; fetch the default branch and sync again",
  );
}

/**
 * The default branch, brought up to date before anything is read from it.
 *
 * A clone that is behind has none of the reverts that landed while it was
 * behind, and a record written from it says "nothing came back" about history
 * it never saw. So collection — which is the half that already talks to GitHub
 * through `gh` — fetches first, and writes down whether it worked:
 * `refreshed` is what `escapeStatus` later uses to decide whether the record
 * covers the window or the ticket has to read `stale`. A repository with no
 * `origin` has nothing to be behind of and is refreshed by definition.
 */
function observeBranch(args: {
  cwd: string;
  branch: string;
  streams?: Streams | undefined;
}): { ref: string; head: ObservedHead } {
  const { cwd, branch } = args;
  /**
   * Null when the command succeeded, otherwise what it said when it did not.
   * The fetch crosses the network and the module waits on it for as long as it
   * waits on any other call that does, rather than for as long as it takes.
   */
  const attempt = (command: readonly string[]): string | null => {
    let result: RunResult;
    try {
      result = git.runSync(cwd, command, { maxOutputBytes: MAX_ANSWER_BYTES });
    } catch (error) {
      return reason(error);
    }
    return result.code === 0 ? null : said(result);
  };
  // The fetch is asked for first and the remote is asked about only if it
  // failed: the case worth being quick about is the one where there is a remote
  // and it answers.
  const attempted = attempt(["fetch", "--quiet", "origin", branch]);
  const hasOrigin = attempted === null || attempt(["remote", "get-url", "origin"]) === null;
  const failure = hasOrigin ? attempted : null;
  if (failure !== null) {
    args.streams?.stderr(
      `  escapes: \`git fetch origin ${branch}\` failed (${failure}), so the history after the ` +
        "merge is read from whatever this checkout already had; the record says so and its ticket " +
        "reads `stale` rather than `no escape` once the window closes\n",
    );
  }
  const ref = resolveRef(cwd, branch);
  // A local ref is not evidence about the branch even after a successful
  // fetch: `refs/heads/<branch>` is only as current as the last `git pull`.
  const refreshed = !hasOrigin || (failure === null && ref.startsWith("refs/remotes/"));
  const [sha = "", committed = ""] = read(cwd, "log", "-1", `--format=%H${FIELD}%cI`, ref)
    .trim()
    .split(FIELD);
  return {
    ref,
    head: { sha, committed_at: new Date(committed).toISOString(), refreshed },
  };
}

/** Every commit `git log` printed, with the paths each touched. */
function parseLog(output: string): ObservedCommit[] {
  return output
    .split(RECORD)
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [sha = "", committed = "", subject = "", body = "", rest = ""] = chunk.split(FIELD);
      return {
        sha: sha.trim(),
        subject,
        body,
        committed_at: new Date(committed.trim()).toISOString(),
        paths: rest
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      };
    });
}

/** The paths a commit put on the branch it landed on: its diff against its first parent. */
function pathsIntroducedBy(cwd: string, sha: string): string[] {
  const parents = read(cwd, "rev-list", "--parents", "-n", "1", sha).trim().split(/\s+/).slice(1);
  const output =
    parents.length === 0
      ? read(cwd, "show", "--format=", "--name-only", sha)
      : read(cwd, "diff", "--name-only", `${sha}^1`, sha);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * What the collection needs to know about the change it is collecting for: how
 * the store files it, what to call it, and the pull request its own record
 * names. A ticket answers all three, and so does a local run (SCP-284) — the
 * history after the merge is read from `git` either way.
 */
export type EscapeSubject = Pick<SyncedChange, "ticket_id" | "key" | "delivery">;

/**
 * One merged change's escape record, read through local `git` from the merge
 * `gh` named.
 *
 * The history walked is the default branch's first-parent history after the
 * merge, up to the end of the window: those are the commits that landed on the
 * branch the change merged into. `-m --first-parent` makes a later merge
 * report the paths it brought in rather than nothing, so a change reworked by
 * a second pull request is seen.
 */
export function collectTicketEscapes(args: {
  repositoryRoot: string;
  ticket: EscapeSubject;
  facts: MergeFacts;
  previous: TicketEscapes | null;
  observed_at: string;
  window_days?: number | undefined;
  streams?: Streams | undefined;
}): TicketEscapes {
  const cwd = args.repositoryRoot;
  const days = args.window_days ?? ESCAPE_WINDOW_DAYS;
  const { ref, head } = observeBranch({
    cwd,
    branch: args.facts.default_branch,
    streams: args.streams,
  });
  const subjectOf = (sha: string): string => read(cwd, "log", "-1", "--format=%s", sha).replace(/\n$/, "");
  const merge: TicketCommit = { sha: args.facts.merge_commit, subject: subjectOf(args.facts.merge_commit) };
  /**
   * The same, for a commit the checkout may not have. A squash or rebase merge
   * leaves `gh`'s `commits` naming objects that never reached this clone — the
   * head branch is deleted on merge — and losing the whole record over a
   * subject would report a merge nobody can see as one nobody reverted. The sha
   * is kept either way, so a `This reverts commit <sha>` trailer still matches.
   */
  const subjectIfPresent = (sha: string): string => {
    try {
      return subjectOf(sha);
    } catch {
      return "";
    }
  };

  // The pull request's commits as `gh` listed them, plus the ones the merge
  // itself brought in — a squashed or rebased merge has the second and not the
  // first, and a revert may name any of them.
  const parents = read(cwd, "rev-list", "--parents", "-n", "1", merge.sha).trim().split(/\s+/).slice(1);
  const merged =
    parents.length > 1
      ? read(cwd, "rev-list", `${merge.sha}^1..${merge.sha}^2`)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
      : [];
  const branch_commits: TicketCommit[] = [...new Set([...args.facts.branch_commits, ...merged])]
    .filter((sha) => sha !== merge.sha)
    .map((sha) => ({ sha, subject: subjectIfPresent(sha) }));

  const closes = new Date(Date.parse(args.facts.merged_at) + days * DAY_MS).toISOString();
  const later = parseLog(
    read(
      cwd,
      "log",
      "--first-parent",
      "-m",
      "--name-only",
      `--format=${RECORD}%H${FIELD}%cI${FIELD}%s${FIELD}%b${FIELD}`,
      `--until=${closes}`,
      `${merge.sha}..${ref}`,
    ),
  );

  return buildTicketEscapes({
    previous: args.previous,
    ticket: { ticket_id: args.ticket.ticket_id, key: args.ticket.key },
    pull_request_url: args.facts.pull_request_url ?? args.ticket.delivery.pull_request_url,
    pull_request_number: args.facts.pull_request_number ?? args.ticket.delivery.pull_request_number,
    default_branch: args.facts.default_branch,
    merge,
    merged_at: args.facts.merged_at,
    branch_commits,
    changed_paths: pathsIntroducedBy(cwd, merge.sha),
    later,
    observed_head: head,
    observed_at: args.observed_at,
    window_days: days,
  });
}

export const escapesPath = (dir: string, ticket_id: string): string =>
  join(dir, "state", `${ticket_id}.escapes.json`);

export function readTicketEscapes(dir: string, ticket_id: string): TicketEscapes | null {
  const path = escapesPath(dir, ticket_id);
  if (!existsSync(path)) return null;
  return TicketEscapesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Collect and write, under `sync`. Written whole from what `git` and `gh`
 * reported, so a second sync produces the same file but for `observed_at`.
 */
export function writeTicketEscapes(args: {
  dir: string;
  repositoryRoot: string;
  ticket: EscapeSubject;
  facts: MergeFacts;
  observed_at: string;
  streams: Streams;
}): TicketEscapes | null {
  let previous: TicketEscapes | null = null;
  const path = escapesPath(args.dir, args.ticket.ticket_id);
  if (existsSync(path)) {
    try {
      previous = readTicketEscapes(args.dir, args.ticket.ticket_id);
    } catch (error) {
      // Only `first_seen_at` is lost; everything else comes from git. Named.
      args.streams.stderr(
        `warning: ${path} is not a readable escapes record and is being rewritten from git: ` +
          `${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
      );
    }
  }
  const record = collectTicketEscapes({
    repositoryRoot: args.repositoryRoot,
    ticket: args.ticket,
    facts: args.facts,
    previous,
    observed_at: args.observed_at,
    streams: args.streams,
  });
  mkdirSync(join(args.dir, "state"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/* ------------------------------------------------------------------ *
 * Reporting: files only.
 * ------------------------------------------------------------------ */

/**
 * Whether this store's numbers are the stand-in's.
 *
 * [D-058](../../../../../docs/11-open-decisions.md) requires that a stand-in's
 * numbers are labelled dogfood and never pooled with a partner's. What tells
 * the two apart on disk is [D-038](../../../../../docs/11-open-decisions.md)'s
 * baseline: a partner's direct-agent comparison is captured **before** their
 * first ticket (`SCP-080`), and a store with no such baseline — this
 * repository's own included, where an agent stands in for the partner — has no
 * partner population to pool with. So a row is dogfood unless the store holds
 * a baseline that was captured before first use and has an entry in it. The
 * default is the safe direction: an unlabelled row is a claim, and this never
 * makes one nobody captured the evidence for.
 */
export function isDogfoodStore(dir: string): boolean {
  const path = baselinePath(dir);
  if (!existsSync(path)) return true;
  try {
    const file = BaselineFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return !file.captured_before_first_use || file.entries.length === 0;
  } catch {
    return true;
  }
}

/**
 * Every merged change, with whatever `sync` has recorded about its window,
 * read against `now`.
 *
 * SCP-284: a change, not a ticket — a local run that merged is a change that
 * merged, and its fourteen days are the same fourteen days. The escape record
 * `sync` writes is keyed by the id the store files everything under, so both
 * kinds are read out of `<store>/state` by the same lookup.
 */
export function escapeRows(dir: string, streams: Streams, now: Date): EscapeRow[] {
  const dogfood = isDogfoodStore(dir);
  const unreadable: string[] = [];
  const rows = listChanges(dir)
    // The population is "merged", the one post-merge state Stage 3 reaches.
    // `done`, `deployed` and `rolled_back` are in the lifecycle and unreachable
    // (`TICKET_STATES_REACHABLE`); when a mechanism drives one, it joins the
    // population here and `merged_at` on the record already dates it.
    .filter((change) => change.state === "merged")
    .map((change) => {
      let record: TicketEscapes | null = null;
      try {
        record = readTicketEscapes(dir, change.ticket_id);
      } catch (error) {
        unreadable.push(
          `${change.key} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
        );
      }
      return escapeRow({
        ticket: { ticket_id: change.ticket_id, key: change.key },
        record,
        dogfood,
        now: now.toISOString(),
      });
    });
  if (unreadable.length > 0) {
    // A record that cannot be read is not a ticket that did not escape.
    streams.stderr(
      `warning: ${unreadable.length} escapes record(s) in ${join(dir, "state")} are not readable ` +
        `and their tickets are reported as not observed: ${unreadable.join(", ")}\n`,
    );
  }
  return rows;
}

const shortSha = (sha: string): string => sha.slice(0, 7);
const day = (at: string | null): string => (at === null ? "—" : at.slice(0, 10));

/**
 * The escape rate's rows, in the shape `perbo stops` prints its two in.
 *
 * The `n` cell carries two counts and never their sum: how many changes have
 * had their own fourteen days, and how many have not yet. Adding them would
 * make one number that is a rate's denominator on Monday and not on Tuesday
 * without saying which day it is — the thing `SCP-217` exists to stop. Of the
 * due ones, how many were actually read to the end of the window is the rate's
 * denominator, and it is inside the same bracket as what the rate counts.
 */
export function escapesRows(summary: ReturnType<typeof summariseEscapes>, due: DueCounts): string[][] {
  const n = (successes: number, noun: string): string =>
    `${due.due} due (${summary.closed} read, ${successes} ${noun}), ${due.not_yet_due} not yet due` +
    (summary.stale > 0 ? `, ${summary.stale} stale` : "") +
    (summary.not_observed > 0 ? `, ${summary.not_observed} not observed` : "");
  return [
    [
      `escape rate (reverted, ${ESCAPE_WINDOW_DAYS}d)`,
      pct(summary.revert_rate.point),
      bounds(summary.revert_rate),
      n(summary.reverted, "reverted"),
    ],
    [
      `escape rate (same path, ${ESCAPE_WINDOW_DAYS}d)`,
      pct(summary.same_path_rate.point),
      bounds(summary.same_path_rate),
      n(summary.same_path, "re-touched"),
    ],
  ];
}

/** One line per merged ticket, then the commits and paths behind each column. */
export function renderEscapeRows(rows: readonly EscapeRow[], now: Date): string {
  const table: string[][] = [
    ["ticket", "population", "merge", "merged", "fourteen days", "reverted", "same path"],
    ...rows.map((row) => [
      row.ticket_key,
      row.dogfood ? "dogfood" : "partner",
      row.merge_commit === null ? "—" : shortSha(row.merge_commit),
      day(row.merged_at),
      escapeReading(row, now),
      row.status === "observed" ? (row.reverted ? "yes" : "no") : "—",
      row.status === "observed" ? (row.same_path_touched ? "yes" : "no") : "—",
    ]),
  ];
  const columns = table[0]!.length;
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...table.map((row) => row[column]!.length)),
  );
  const lines: string[] = [];
  for (const [index, row] of table.entries()) {
    lines.push(
      row
        .map((cell, column) => (column < columns - 1 ? cell.padEnd(widths[column]!) : cell))
        .join("  ")
        .trimEnd(),
    );
    const source = index === 0 ? undefined : rows[index - 1];
    if (source === undefined) continue;
    for (const commit of source.reverts) {
      lines.push(
        `    reverted by ${shortSha(commit.sha)} ${commit.subject} — reverts ` +
          `${commit.reverts.map(shortSha).join(", ")}` +
          // A revert that names a merge commit usually touches the paths the
          // merge brought in; when it does, they are named here rather than
          // left to the same-path line, so the column is readable on its own.
          (commit.paths.length > 0 ? ` — ${commit.paths.join(", ")}` : ""),
      );
    }
    for (const commit of source.same_path) {
      lines.push(`    same path ${shortSha(commit.sha)} ${commit.subject} — ${commit.paths.join(", ")}`);
    }
    const reading = escapeReading(source, now);
    if (reading === "not yet due") {
      // The date, not just the fact: "not yet due" without the day it falls due
      // is a row nobody can plan a weekly read around.
      lines.push(
        `    not yet due until ${dueAt(source) ?? "—"} — fourteen days from its own merge on ` +
          `${day(source.merged_at)}`,
      );
    }
    if (reading === "stale") {
      // Due, and read by nobody since: what is on this row is not "nothing came
      // back" — it is "nobody has looked". Both the reach of the observation and
      // the command that extends it are named.
      lines.push(
        `    watched only to ${source.observed_through ?? "no time recorded"}, fell due ` +
          `${dueAt(source) ?? "—"}: \`perbo sync ${source.ticket_key}\``,
      );
    }
    if (reading === "not observed") {
      lines.push(`    no history read yet: \`perbo sync ${source.ticket_key}\``);
    }
  }
  return lines.join("\n");
}

export async function runEscapesCommand(input: {
  argv: string[];
  streams: Streams;
  cwd: string;
  now?: Date;
}): Promise<number> {
  const args = parseEscapesArgs(input.argv);
  const now = input.now ?? new Date();
  const dir = storeDir(resolve(input.cwd, args.repo), args.store);
  const rows = escapeRows(dir, input.streams, now);
  const escapes = summariseEscapes(rows);
  // Each change's own fourteen days against this clock, counted apart from the
  // rate: how many are due is a fact about merge dates, and how many of those
  // were read to the end of their window is a fact about the records.
  const due = countDueness(rows, now);
  // D-060's pair is not optional here either: an escape rate read on its own
  // says nothing about whether anything was ever stopped, and the two are
  // printed from one table or not at all.
  const decisions = readDecisions(dir, input.streams);
  const stops = summariseStops(readStopRecords(dir, input.streams, decisions));

  if (args.json) {
    input.streams.stdout(
      `${JSON.stringify(
        {
          window_days: ESCAPE_WINDOW_DAYS,
          // `read_at` is the clock every reading on this page was decided
          // against; without it a `not yet due` row cannot be told from a stale
          // one, and `due_at` below cannot be checked against anything.
          read_at: now.toISOString(),
          due,
          stops,
          escapes,
          // `status` stays the record contract's word for how far the
          // observation reached; `due` and `due_at` are this command's reading
          // of the fourteen days, and they are separate fields because they
          // answer separate questions.
          tickets: rows.map((row) => ({
            ...row,
            due: duenessOf(row, now) === "due",
            due_at: dueAt(row),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return EXIT_CODES.approve;
  }

  input.streams.stdout(
    `${renderMetricTable([METRIC_TABLE_HEADER, ...stopsRows(stops), ...escapesRows(escapes, due)])}\n`,
  );
  // Precision of stopping is a partner reading wherever it is printed, and this
  // command prints it in the same rows `perbo stops` does (D-058). What the
  // dogfood label cannot promise travels with it here for the same reason it
  // does there: a number quoted out of this table is quoted as a partner's.
  if (stops.precision.n > 0 || stops.dogfood_stops > 0) {
    input.streams.stdout(`${PARTNER_READING_CAVEAT}\n`);
  }
  input.streams.stdout(rows.length === 0 ? "\nno merged tickets yet\n" : `\n${renderEscapeRows(rows, now)}\n`);
  // The stops half of the table above counts the decisions taken here beside
  // the ones ticked on a pull request, so who took each is printed here too,
  // in the one shape `perbo stops` prints it in.
  const decided = renderDecisions(decisions);
  if (decided !== null) input.streams.stdout(`\n${decided}\n`);
  if (escapes.not_observed > 0) {
    input.streams.stderr(
      `${escapes.not_observed} merged ticket(s) have no escapes record in ${join(dir, "state")}: ` +
        "`perbo sync <KEY>` reads the history after the merge through git and gh; this command " +
        "never does.\n",
    );
  }
  if (escapes.stale > 0) {
    // Out of the denominator, and said out loud: a window that closed after the
    // last sync is unread history, not a ticket that survived.
    input.streams.stderr(
      `${escapes.stale} merged ticket(s) have a record that stops short of their ${ESCAPE_WINDOW_DAYS}-day ` +
        "window — synced while it was still open, or from a checkout behind the default branch — and " +
        "are out of the rate until `perbo sync <KEY>` reads the rest.\n",
    );
  }
  return EXIT_CODES.approve;
}
