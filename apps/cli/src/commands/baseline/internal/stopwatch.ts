import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The partner's direct-agent baseline (D-038, SCP-080).
 *
 * E1 compares Perbo's wall clock against "the user's current workflow": the
 * same partner, agent-direct, from "start work" to "pull request opened",
 * pauses excluded. That number has to be captured **before** first use — a
 * partner who has already run a ticket through the loop cannot go back and
 * time the workflow they had — so the file records whether it was, and never
 * pretends afterwards.
 *
 * Nothing here is a ticket. The entries are stopwatch readings a person takes
 * on their own work, and the only invariant the schema enforces is that a
 * reading is closed once and closed with a reason.
 */

export const BASELINE_SCHEMA_VERSION = 1;

/** D-038's comparison is against a median, and ten is where it wants that median taken. */
export const BASELINE_COMPARISON_MINIMUM = 10;

export const BASELINE_OUTCOMES = ["completed", "abandoned"] as const;
export const BaselineOutcomeSchema = z.enum(BASELINE_OUTCOMES);
export type BaselineOutcome = (typeof BASELINE_OUTCOMES)[number];

export const BaselineEntrySchema = z.strictObject({
  id: z.string().regex(/^bl_[0-9a-f]{12}$/, "baseline id must look like bl_<hex>"),
  title: z.string().min(1),
  /** `owner/repo#412` where the work has a home elsewhere; null when it does not. */
  ref: z.string().min(1).nullable(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  /** Set while a pause is open; cleared by resume, stop and abandon. */
  paused_at: z.iso.datetime().nullable(),
  /** Every closed pause, summed. */
  paused_ms: z.number().int().min(0),
  /** Wall clock minus pauses. Null until the entry ends. */
  elapsed_ms: z.number().int().min(0).nullable(),
  pull_request_url: z.string().min(1).nullable(),
  outcome: BaselineOutcomeSchema.nullable(),
  note: z.string().nullable(),
});
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;

export const BaselineFileSchema = z.strictObject({
  schema_version: z.literal(BASELINE_SCHEMA_VERSION),
  /**
   * False from the first `start` that finds a ticket already admitted. It
   * never goes back to true: the fact it records is about the past.
   */
  captured_before_first_use: z.boolean(),
  entries: z.array(BaselineEntrySchema),
});
export type BaselineFile = z.infer<typeof BaselineFileSchema>;

export const EMPTY_BASELINE_FILE: BaselineFile = {
  schema_version: BASELINE_SCHEMA_VERSION,
  captured_before_first_use: true,
  entries: [],
};

export class BaselineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineStateError";
  }
}

export function baselineId(seed: string): string {
  return `bl_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 12)}`;
}

/** The one entry still running, if any. */
export function openBaseline(file: BaselineFile): BaselineEntry | null {
  return file.entries.find((entry) => entry.ended_at === null) ?? null;
}

/**
 * Wall clock minus pauses, as of `now`. A pause still open counts up to `now`
 * as paused, so a reading taken mid-pause does not include the pause.
 */
export function baselineElapsedMs(entry: BaselineEntry, now: Date): number {
  const end = entry.ended_at ? Date.parse(entry.ended_at) : now.getTime();
  const openPause = entry.paused_at ? end - Date.parse(entry.paused_at) : 0;
  return Math.max(0, end - Date.parse(entry.started_at) - entry.paused_ms - openPause);
}

function requireOpen(file: BaselineFile, verb: string): BaselineEntry {
  const open = openBaseline(file);
  if (!open) {
    throw new BaselineStateError(`nothing to ${verb}: no baseline entry is open`);
  }
  return open;
}

function replace(file: BaselineFile, entry: BaselineEntry): BaselineFile {
  return {
    ...file,
    entries: file.entries.map((existing) => (existing.id === entry.id ? entry : existing)),
  };
}

export function startBaseline(
  file: BaselineFile,
  input: { title: string; ref?: string | null; now: Date; ticketsExist: boolean },
): BaselineFile {
  const open = openBaseline(file);
  if (open) {
    throw new BaselineStateError(
      `a baseline entry is already open: "${open.title}" (${open.id}). ` +
        "Stop or abandon it before starting another",
    );
  }
  const started_at = input.now.toISOString();
  const entry = BaselineEntrySchema.parse({
    id: baselineId(`${started_at}|${input.title}`),
    title: input.title,
    ref: input.ref ?? null,
    started_at,
    ended_at: null,
    paused_at: null,
    paused_ms: 0,
    elapsed_ms: null,
    pull_request_url: null,
    outcome: null,
    note: null,
  } satisfies BaselineEntry);
  return {
    ...file,
    // Recorded, not refused: a late baseline is still a number, it just is not
    // the one D-038 asked for, and the file says so.
    captured_before_first_use: file.captured_before_first_use && !input.ticketsExist,
    entries: [...file.entries, entry],
  };
}

export function pauseBaseline(file: BaselineFile, now: Date): BaselineFile {
  const open = requireOpen(file, "pause");
  if (open.paused_at !== null) {
    throw new BaselineStateError(`"${open.title}" is already paused (since ${open.paused_at})`);
  }
  return replace(file, { ...open, paused_at: now.toISOString() });
}

export function resumeBaseline(file: BaselineFile, now: Date): BaselineFile {
  const open = requireOpen(file, "resume");
  if (open.paused_at === null) {
    throw new BaselineStateError(`"${open.title}" is not paused`);
  }
  const pause = Math.max(0, now.getTime() - Date.parse(open.paused_at));
  return replace(file, { ...open, paused_at: null, paused_ms: open.paused_ms + pause });
}

function close(
  file: BaselineFile,
  now: Date,
  outcome: BaselineOutcome,
  fields: { pull_request_url: string | null; note: string | null },
): BaselineFile {
  const open = requireOpen(file, outcome === "completed" ? "stop" : "abandon");
  // Stopping mid-pause closes the pause first, so the pause is excluded rather
  // than counted as work.
  const settled = open.paused_at === null ? open : resumeEntry(open, now);
  return replace(file, {
    ...settled,
    ended_at: now.toISOString(),
    elapsed_ms: baselineElapsedMs({ ...settled, ended_at: now.toISOString() }, now),
    outcome,
    ...fields,
  });
}

function resumeEntry(entry: BaselineEntry, now: Date): BaselineEntry {
  const pause = Math.max(0, now.getTime() - Date.parse(entry.paused_at!));
  return { ...entry, paused_at: null, paused_ms: entry.paused_ms + pause };
}

export function stopBaseline(
  file: BaselineFile,
  input: { now: Date; pull_request_url?: string | null; note?: string | null },
): BaselineFile {
  return close(file, input.now, "completed", {
    pull_request_url: input.pull_request_url ?? null,
    note: input.note ?? null,
  });
}

export function abandonBaseline(
  file: BaselineFile,
  input: { now: Date; reason?: string | null },
): BaselineFile {
  return close(file, input.now, "abandoned", {
    pull_request_url: null,
    note: input.reason ?? null,
  });
}

export interface BaselineSummary {
  entries: number;
  completed: number;
  abandoned: number;
  open: number;
  /** Over completed entries only. Null below one. */
  median_elapsed_ms: number | null;
  /** Nearest-rank 90th percentile over completed entries. Null below one. */
  p90_elapsed_ms: number | null;
  /** How many completed entries D-038's comparison still wants. */
  short_of_comparison: number;
}

/**
 * The median of a set of durations, to the millisecond, or null over nothing.
 *
 * One definition, used by the stopwatch's own summary and by the E1 ratio in
 * `e1/ledger.ts`, so a partner's median cannot mean one thing in the list and
 * another
 * in the comparison it is quoted in.
 */
export function medianMs(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  return n % 2 === 1
    ? sorted[(n - 1) / 2]!
    : Math.round((sorted[n / 2 - 1]! + sorted[n / 2]!) / 2);
}

export function summarizeBaseline(file: BaselineFile): BaselineSummary {
  const completed = file.entries
    .filter((entry) => entry.outcome === "completed" && entry.elapsed_ms !== null)
    .map((entry) => entry.elapsed_ms!)
    .sort((a, b) => a - b);
  const n = completed.length;
  const median = medianMs(completed);
  const p90 = n === 0 ? null : completed[Math.max(0, Math.ceil(0.9 * n) - 1)]!;
  return {
    entries: file.entries.length,
    completed: n,
    abandoned: file.entries.filter((entry) => entry.outcome === "abandoned").length,
    open: openBaseline(file) ? 1 : 0,
    median_elapsed_ms: median,
    p90_elapsed_ms: p90,
    short_of_comparison: Math.max(0, BASELINE_COMPARISON_MINIMUM - n),
  };
}
