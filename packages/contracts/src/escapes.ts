import { z } from "zod";
import { TicketIdSchema } from "./ids.js";
import { TicketKeySchema } from "./ticket.js";
import { wilsonInterval, type WilsonInterval } from "./stops.js";

/**
 * Post-merge escapes: what merged and was then undone or reworked within
 * fourteen days (`SCP-145`, the coordinator's change 2 of 2026-09-02).
 *
 * On a repository where the reviewer stops nothing there is no precision-of-
 * stopping reading at all, and the weekly read still needs a headline. This is
 * it, and it is the nearest local proxy for the E3 outcome
 * [D-038](../../../docs/11-open-decisions.md) asks for: of the tickets whose
 * change merged, how many were reverted, and how many had one of their paths
 * touched again, inside fourteen days of the merge.
 *
 * The two are **separate columns and are never summed**. Same-path-within-
 * fourteen-days over-counts on a hot file — a second ticket editing the same
 * module is normal work, not an escape — and a revert is the strict signal. A
 * commit is usually in both, because reverting a change touches its paths, so
 * adding them would double-count the one case everybody agrees about.
 *
 * Everything here is arithmetic over a record `perbo sync` wrote from local
 * `git` and `gh`. Nothing in this module reads a repository or a network.
 */

/** Fourteen days, in D-038's words and A10's column. */
export const ESCAPE_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const ShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/, "a commit sha");

/** A later commit on the default branch, and why it is on the ticket's row. */
export const EscapeCommitSchema = z.strictObject({
  sha: ShaSchema,
  subject: z.string(),
  committed_at: z.iso.datetime(),
  /**
   * For a revert: the ticket's commits it names. For a same-path commit: the
   * ticket's paths it touched again. Both are named rather than counted,
   * because a rate nobody can trace back to a commit is not evidence.
   */
  reverts: z.array(ShaSchema).default([]),
  paths: z.array(z.string().min(1)).default([]),
});
export type EscapeCommit = z.infer<typeof EscapeCommitSchema>;

export const TICKET_ESCAPES_SCHEMA_VERSION = 2;

/**
 * The default branch as the collecting checkout saw it, and whether that view
 * was current.
 *
 * A record says what a `git log` found up to some point in the branch's
 * history, and it is evidence of "nothing came back" only as far as that point
 * reaches. `refreshed` is true when the branch was brought up to date from its
 * remote at `observed_at` — or when there is no remote it could be behind — and
 * false when the fetch did not happen or did not succeed, in which case the
 * newest commit the checkout held is as far as the observation reaches.
 */
export const ObservedHeadSchema = z.strictObject({
  sha: ShaSchema,
  committed_at: z.iso.datetime(),
  refreshed: z.boolean(),
});
export type ObservedHead = z.infer<typeof ObservedHeadSchema>;

/**
 * One ticket's escape record, `<store>/state/<ticket_id>.escapes.json`.
 *
 * Written whole on every sync from what `git` and `gh` reported, so it is
 * idempotent for the same reason the stops record is; `first_seen_at` is the
 * one thing kept across rewrites. Labels only: shas, subjects, paths and
 * times, never a diff and never a file's contents.
 */
export const TicketEscapesSchema = z.strictObject({
  schema_version: z.literal(TICKET_ESCAPES_SCHEMA_VERSION),
  ticket_id: TicketIdSchema,
  ticket_key: TicketKeySchema,
  pull_request_url: z.string().min(1).nullable(),
  pull_request_number: z.number().int().positive().nullable(),
  /** The branch the change merged into; the history walked is this branch's. */
  default_branch: z.string().min(1),
  merge_commit: ShaSchema,
  merge_subject: z.string(),
  merged_at: z.iso.datetime(),
  /** The commits the merge brought in. A revert may name any of them. */
  branch_commits: z.array(z.strictObject({ sha: ShaSchema, subject: z.string() })),
  /** What the merge changed on the default branch: the sealed change set as merged. */
  changed_paths: z.array(z.string().min(1)),
  window_days: z.number().int().positive(),
  window_closes_at: z.iso.datetime(),
  /**
   * The branch tip this observation reached. Nothing about whether the window
   * is open is stored — that is a fact about now, not about the observation,
   * and a stored one goes wrong the moment the clock moves past it.
   */
  observed_head: ObservedHeadSchema,
  reverts: z.array(EscapeCommitSchema),
  same_path: z.array(EscapeCommitSchema),
  first_seen_at: z.iso.datetime(),
  observed_at: z.iso.datetime(),
});
export type TicketEscapes = z.infer<typeof TicketEscapesSchema>;

/** A later commit as `git log` reports it, before anything is decided about it. */
export interface ObservedCommit {
  sha: string;
  subject: string;
  body: string;
  committed_at: string;
  paths: readonly string[];
}

export interface TicketCommit {
  sha: string;
  subject: string;
}

const shaMatches = (a: string, b: string): boolean =>
  a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/** `Revert "…"`, including `Revert "Revert "…""`: the outermost quoted subject. */
const REVERTED_SUBJECT = /^Revert\s+"([\s\S]*)"\s*$/;
/** What `git revert` writes into the body, for a plain commit and for a merge. */
const REVERTS_TRAILER = /This reverts commit ([0-9a-f]{7,40})/g;

/**
 * Which of the ticket's commits a later commit says it reverts.
 *
 * Both forms `git revert` produces, because a person reverting through the
 * GitHub UI gets one and a person reverting on the command line gets the
 * other: the `This reverts commit <sha>` trailer, matched by sha prefix in
 * either direction so an abbreviated sha still resolves, and a `Revert "…"`
 * subject quoting the subject of the merge or of one of its commits.
 */
export function revertedCommits(
  commit: Pick<ObservedCommit, "subject" | "body">,
  targets: readonly TicketCommit[],
): string[] {
  const named = new Set<string>();
  for (const [, sha] of commit.body.matchAll(REVERTS_TRAILER)) {
    for (const target of targets) if (shaMatches(target.sha, sha!)) named.add(target.sha);
  }
  const quoted = REVERTED_SUBJECT.exec(commit.subject)?.[1];
  if (quoted !== undefined && quoted !== "") {
    // A target with no subject is one the checkout could not name (a squashed
    // branch's commit); it matches by sha and never by an empty subject.
    for (const target of targets) if (target.subject !== "" && target.subject === quoted) named.add(target.sha);
  }
  return [...named];
}

export interface EscapeClassification {
  window_closes_at: string;
  reverts: EscapeCommit[];
  same_path: EscapeCommit[];
}

/**
 * The two columns, from the merge and the commits that landed after it.
 *
 * `later` is every commit on the default branch after the merge commit; this
 * decides which of them are inside the window and which of the two columns
 * each belongs in. A commit can be in both — a revert touches the paths it
 * reverts — and that is the reason the columns are never added together.
 */
export function classifyEscapes(args: {
  merge: TicketCommit;
  branch_commits: readonly TicketCommit[];
  changed_paths: readonly string[];
  later: readonly ObservedCommit[];
  merged_at: string;
  window_days?: number;
}): EscapeClassification {
  const days = args.window_days ?? ESCAPE_WINDOW_DAYS;
  const merged = Date.parse(args.merged_at);
  const closes = new Date(merged + days * DAY_MS).toISOString();
  const targets = [args.merge, ...args.branch_commits];
  const touched = new Set(args.changed_paths);
  const reverts: EscapeCommit[] = [];
  const same_path: EscapeCommit[] = [];
  for (const commit of args.later) {
    const at = Date.parse(commit.committed_at);
    if (!(at > merged && at <= Date.parse(closes))) continue;
    const named = revertedCommits(commit, targets);
    const paths = commit.paths.filter((path) => touched.has(path));
    const base = {
      sha: commit.sha,
      subject: commit.subject,
      committed_at: new Date(at).toISOString(),
    };
    if (named.length > 0) reverts.push({ ...base, reverts: named, paths });
    if (paths.length > 0) same_path.push({ ...base, reverts: [], paths });
  }
  return { window_closes_at: closes, reverts, same_path };
}

/** The record to write, from what was observed and what was written last time. */
export function buildTicketEscapes(args: {
  previous: TicketEscapes | null;
  ticket: { ticket_id: string; key: string };
  pull_request_url: string | null;
  pull_request_number: number | null;
  default_branch: string;
  merge: TicketCommit;
  merged_at: string;
  branch_commits: readonly TicketCommit[];
  changed_paths: readonly string[];
  later: readonly ObservedCommit[];
  observed_head: ObservedHead;
  observed_at: string;
  window_days?: number;
}): TicketEscapes {
  const classified = classifyEscapes(args);
  return TicketEscapesSchema.parse({
    schema_version: TICKET_ESCAPES_SCHEMA_VERSION,
    ticket_id: args.ticket.ticket_id,
    ticket_key: args.ticket.key,
    pull_request_url: args.pull_request_url,
    pull_request_number: args.pull_request_number,
    default_branch: args.default_branch,
    merge_commit: args.merge.sha,
    merge_subject: args.merge.subject,
    merged_at: args.merged_at,
    branch_commits: args.branch_commits.map((commit) => ({ sha: commit.sha, subject: commit.subject })),
    changed_paths: [...args.changed_paths],
    window_days: args.window_days ?? ESCAPE_WINDOW_DAYS,
    window_closes_at: classified.window_closes_at,
    observed_head: args.observed_head,
    reverts: classified.reverts,
    same_path: classified.same_path,
    first_seen_at: args.previous?.first_seen_at ?? args.observed_at,
    observed_at: args.observed_at,
  });
}

/**
 * What a ticket's row says.
 *
 * Three of the four are not zero, and none of them is allowed to become zero
 * by being counted. `window open` is a merge from inside the last fourteen
 * days, which has not yet had the chance to be reverted. `stale` is a record
 * whose observation stopped short of the window it is supposed to cover — the
 * sync ran while the window was still open and never ran again, or it ran
 * against a checkout that was behind the default branch. `not observed` is a
 * merged ticket no sync has read the history for at all. Each of the three
 * names the command that fixes it; only `observed` is evidence.
 */
export const ESCAPE_STATUSES = ["observed", "window open", "stale", "not observed"] as const;
export type EscapeStatus = (typeof ESCAPE_STATUSES)[number];

/**
 * How far into the branch's history a record is evidence of "nothing came
 * back".
 *
 * A refreshed observation reaches its own instant: the branch was current at
 * `observed_at`, so the absence of a revert up to then is a fact. An
 * unrefreshed one reaches no further than the newest commit the checkout held,
 * because anything that landed after it was simply not in the clone.
 */
export function observedThrough(record: TicketEscapes): string {
  return record.observed_head.refreshed ? record.observed_at : record.observed_head.committed_at;
}

/**
 * A ticket's status now — never at collection time.
 *
 * Whether fourteen days have passed is a fact about the clock, and whether the
 * observation saw them is a fact about the record; storing either as a verdict
 * freezes a reading that goes wrong on the next day. So both are computed here,
 * from `window_closes_at`, `now` and how far the observation reached.
 */
export function escapeStatus(record: TicketEscapes, now: string): EscapeStatus {
  const closes = Date.parse(record.window_closes_at);
  if (Date.parse(now) < closes) return "window open";
  return Date.parse(observedThrough(record)) >= closes ? "observed" : "stale";
}

export interface EscapeRow {
  ticket_key: string;
  ticket_id: string;
  /**
   * D-058: a stand-in's numbers are dogfood numbers and are never pooled with
   * a partner's, so every row says which it is rather than leaving the reader
   * to remember.
   */
  dogfood: boolean;
  status: EscapeStatus;
  merge_commit: string | null;
  merged_at: string | null;
  window_closes_at: string | null;
  observed_at: string | null;
  /** How far the observation reaches; short of `window_closes_at` is `stale`. */
  observed_through: string | null;
  /** Counted only where the status is `observed`; both are false otherwise. */
  reverted: boolean;
  same_path_touched: boolean;
  reverts: EscapeCommit[];
  same_path: EscapeCommit[];
  changed_paths: string[];
}

/** One merged ticket's row, from its record and the clock — or from no record. */
export function escapeRow(args: {
  ticket: { ticket_id: string; key: string };
  record: TicketEscapes | null;
  dogfood: boolean;
  /** Now. The window is open or closed against this and nothing else. */
  now: string;
}): EscapeRow {
  const record = args.record;
  if (record === null) {
    return {
      ticket_key: args.ticket.key,
      ticket_id: args.ticket.ticket_id,
      dogfood: args.dogfood,
      status: "not observed",
      merge_commit: null,
      merged_at: null,
      window_closes_at: null,
      observed_at: null,
      observed_through: null,
      reverted: false,
      same_path_touched: false,
      reverts: [],
      same_path: [],
      changed_paths: [],
    };
  }
  const status = escapeStatus(record, args.now);
  return {
    ticket_key: args.ticket.key,
    ticket_id: args.ticket.ticket_id,
    dogfood: args.dogfood,
    status,
    merge_commit: record.merge_commit,
    merged_at: record.merged_at,
    window_closes_at: record.window_closes_at,
    observed_at: record.observed_at,
    observed_through: observedThrough(record),
    // What was found is reported whatever the status — a revert seen inside an
    // open window is real — but only an `observed` row is counted.
    reverted: status === "observed" && record.reverts.length > 0,
    same_path_touched: status === "observed" && record.same_path.length > 0,
    reverts: record.reverts,
    same_path: record.same_path,
    changed_paths: record.changed_paths,
  };
}

export interface EscapesSummary {
  /** Every ticket in the population: merged, whatever is known about it. */
  merged: number;
  /** Merged tickets whose fourteen days have closed and were watched. The denominator. */
  closed: number;
  window_open: number;
  /** Windows that closed while nobody was looking; another sync is what fixes them. */
  stale: number;
  not_observed: number;
  reverted: number;
  same_path: number;
  /** reverted / closed — the strict column. */
  revert_rate: WilsonInterval;
  /** same-path / closed — the loose one. Never added to the strict one. */
  same_path_rate: WilsonInterval;
}

export function summariseEscapes(rows: readonly EscapeRow[]): EscapesSummary {
  const closed = rows.filter((row) => row.status === "observed");
  const reverted = closed.filter((row) => row.reverted).length;
  const same_path = closed.filter((row) => row.same_path_touched).length;
  return {
    merged: rows.length,
    closed: closed.length,
    window_open: rows.filter((row) => row.status === "window open").length,
    stale: rows.filter((row) => row.status === "stale").length,
    not_observed: rows.filter((row) => row.status === "not observed").length,
    reverted,
    same_path,
    revert_rate: wilsonInterval(reverted, closed.length),
    same_path_rate: wilsonInterval(same_path, closed.length),
  };
}
