import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DELIVERY_ARMS,
  EXIT_CODES,
  PARTNER_READING_CAVEAT,
  StopVerdictsSchema,
  judgeAgainstD060,
  summariseStops,
  summariseUnattendedMerges,
  widenedByHiding,
  type D060Reading,
  type StopVerdicts,
  type DeliveryArm,
  type IncompleteReviewPath,
  type StopsSummary,
  type Ticket,
  type UnattendedMergesSummary,
  type WilsonInterval,
} from "@perbo/contracts";
import { UsageError } from "../usage-error.js";
import type { Streams } from "../streams.js";
import {
  attemptsRecordSubject,
  buildReportForSubject,
  summariseMergedCost,
  type InspectReport,
  type InspectSubject,
  type MergedCostSummary,
} from "./inspect.js";
import {
  ESCAPE_WINDOW_DAYS,
  escapeRows,
  type EscapeRow,
} from "./escapes/index.js";
import { listChanges, storeDir, type SyncedChange } from "../store/tickets.js";
import {
  activeVerdicts,
  mergeLocalVerdicts,
  readLocalVerdictsOrWarn,
  verdictsPath,
  type LocalVerdict,
} from "./verdict/record.js";

/**
 * `perbo stops` — precision of stopping, measured live from pull requests
 * (D-060; founder decision 2026-09-02).
 *
 * Over every `<store>/state/*.stops.json` that `perbo sync` wrote: of the
 * changes with at least one answer, the share a person endorsed, with a 95%
 * Wilson interval — and always beside the companion D-060 makes non-optional,
 * the share of changes that reached a person — one with a pull request, or one
 * answered here with `perbo verdict` — on which they were shown anything at
 * all. Precision improves trivially when that share falls, and the pair is
 * what makes that visible. `--since` splits the changes at a date and
 * says so when precision rose while the companion fell; `--by-week` cuts the
 * window into ISO-8601 weeks and asks the same question of every consecutive
 * pair, so a fall that the total average hides is still said out loud.
 *
 * Under the table, the number read against the bar it exists for: **≥70% with
 * the 95% Wilson interval wholly on one side of it, at live n**. Nine unanimous
 * endorsed stops is the smallest population that can clear it, and below one
 * that could the command says the reading cannot resolve rather than printing a
 * pass. The population is the partner one: a stop the AI stand-in answered is
 * dogfood and is not in any number reported here as a partner reading
 * (D-058), and how many were left out is a row of the table rather than a
 * silent subtraction.
 *
 * SCP-196, beside it: D-076's bar, over the ticket store rather than the
 * stops files — of the tickets that merged, the share that merged from a
 * pull request the loop opened with no commit on it from outside the loop,
 * with the same kind of interval, and the cost per merged ticket that came
 * with them. `--since` bounds this the same way, by when each ticket's own
 * history says it merged.
 */

export interface StopsArgs {
  repo: string;
  store: string | null;
  json: boolean;
  /** ISO instant; changes first seen at or after it form the window. */
  since: string | null;
  /** Report the window per ISO-8601 week as well as in total. */
  byWeek: boolean;
  /**
   * SCP-206: read the unattended row for one arm only.
   *
   * The registration's first metric is a share per arm, and both arms' records
   * sit in one store — so without this the printed share is a number about both
   * at once, which is not the number it asks for. Null is every ticket, which
   * is what this command printed before a second arm existed.
   */
  arm: DeliveryArm | null;
}

export function parseStopsArgs(argv: readonly string[]): StopsArgs {
  const args: StopsArgs = { repo: ".", store: null, json: false, since: null, byWeek: false, arm: null };
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
      case "--by-week":
        args.byWeek = true;
        break;
      case "--arm": {
        const raw = value(++i, token);
        if (!(DELIVERY_ARMS as readonly string[]).includes(raw)) {
          throw new UsageError(`--arm requires one of ${DELIVERY_ARMS.join(", ")}, got '${raw}'`);
        }
        args.arm = raw as DeliveryArm;
        break;
      }
      case "--since": {
        const raw = value(++i, token);
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) throw new UsageError(`--since requires an ISO date, got '${raw}'`);
        args.since = new Date(ms).toISOString();
        break;
      }
      default:
        throw new UsageError(`unknown option '${token}' for stops`);
    }
  }
  return args;
}

/** Every readable stops record in the store; an unreadable one is named and stepped over. */
export function readStopVerdictFiles(dir: string, streams: Streams): StopVerdicts[] {
  const inside = join(dir, "state");
  if (!existsSync(inside)) return [];
  const unreadable: string[] = [];
  const files = readdirSync(inside)
    .filter((name) => name.endsWith(".stops.json"))
    .sort()
    .flatMap((name) => {
      try {
        return [StopVerdictsSchema.parse(JSON.parse(readFileSync(join(inside, name), "utf8")))];
      } catch (error) {
        unreadable.push(`${name} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
        return [];
      }
    });
  if (unreadable.length > 0) {
    // A store that shrank must never look like a small one.
    streams.stderr(
      `warning: ${unreadable.length} file(s) in ${inside} are not readable stops records and were ` +
        `skipped: ${unreadable.join(", ")}\n`,
    );
  }
  return files;
}

/**
 * Every stops record in the store, with the decisions taken at the command
 * line folded in (SCP-181).
 *
 * A stop answered by `perbo verdict` and a stop answered by ticking a box on
 * the pull request are the same person answering the same question about the
 * same finding key. Every reader of the number goes through here, so precision
 * of stopping is a number about the answers rather than about which of the two
 * ways they were given.
 */
export function readStopRecords(
  dir: string,
  streams: Streams,
  // Passed in by the two commands that also print the decisions, so an
  // unreadable verdicts file is named on stderr once rather than twice.
  decisions: readonly LocalVerdict[] = readDecisions(dir, streams),
): StopVerdicts[] {
  return mergeLocalVerdicts(readStopVerdictFiles(dir, streams), decisions);
}

/** The decisions this store holds, superseded rows included. */
export function readDecisions(dir: string, streams: Streams): LocalVerdict[] {
  return readLocalVerdictsOrWarn(dir, streams).verdicts;
}

/**
 * The decisions taken here, and who took each one (SCP-181).
 *
 * `null` where none were, so a store whose answers all came from pull requests
 * prints exactly what it printed before. Only the decisions in force are
 * listed: a superseded row is what somebody changed their mind about, and
 * `perbo inspect` is where the whole history of a key is read.
 *
 * The name is `decided_by` and nothing else. A row written before that field
 * existed carries none, and prints as its three columns with nothing after
 * them — a report that filled the gap with the account the machine was logged
 * in as, or with a dash, would be claiming to know something the record does
 * not say. The `--json` readings of both commands are aggregates and carry no
 * decisions; `perbo inspect --json` is where a machine reads them whole.
 */
export function renderDecisions(verdicts: readonly LocalVerdict[]): string | null {
  const standing = activeVerdicts(verdicts);
  if (standing.length === 0) return null;
  const rows = standing.map((verdict) => [
    verdict.review.ticket_key ?? verdict.review.ticket_id,
    verdict.finding_key.slice(0, 12),
    verdict.decision,
    ...(verdict.decided_by === undefined
      ? []
      : [`${verdict.decided_by.name} <${verdict.decided_by.email}>`]),
  ]);
  const columns = ["change", "finding", "decision"];
  // The column exists where at least one row fills it. A store whose decisions
  // all predate the field gets three columns and no empty fourth promising an
  // answer none of them has.
  if (rows.some((row) => row.length > columns.length)) columns.push("decided by");
  return renderTable([columns, ...rows]);
}

export const pct = (value: number): string => (Number.isNaN(value) ? "—" : `${Math.round(value * 100)}%`);
export const bounds = (interval: WilsonInterval): string =>
  Number.isNaN(interval.point)
    ? "—"
    : `[${Math.round(interval.low * 100)}–${Math.round(interval.high * 100)}]`;

/** The header every metric table carries, so two of them read as one shape. */
export const METRIC_TABLE_HEADER = ["metric", "value", "95% Wilson", "n"];

/**
 * Left-padded columns except the last, for however many columns the rows have.
 * Shared rather than copied, because `perbo escapes` prints its rate in this
 * table beside these rows and the per-week table prints the same figures a row
 * at a time: "the same table shape" has to be a fact about the code rather
 * than about how carefully three renderers were kept in step.
 */
export function renderTable(rows: readonly string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => (column < columns - 1 ? cell.padEnd(widths[column]!) : cell))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** The metric table: `renderTable` over rows that all carry {@link METRIC_TABLE_HEADER}'s columns. */
export const renderMetricTable = renderTable;

/** D-060's two numbers and their diagnostics, as table rows. */
export function stopsRows(summary: StopsSummary): string[][] {
  return [
    [
      "precision of stopping",
      pct(summary.precision.point),
      bounds(summary.precision),
      `${summary.precision.n} changes with an answer (${summary.endorsed} endorsed, ${summary.overridden} overridden)`,
    ],
    [
      "person shown something",
      pct(summary.companion.point),
      bounds(summary.companion),
      `${summary.companion.n} changes with a pull request or a decision (${summary.shown} shown)`,
    ],
    ["unanswered stops", String(summary.unanswered_stops), "", `${summary.stops} stops across ${summary.changes} changes`],
    ["conflicting answers", String(summary.conflicts), "", "both boxes ticked"],
    [
      // D-058: an AI's endorsement of a stop is not a person wanting to be
      // asked, so the stand-in's answers are not in the number above. The row
      // exists at zero as well, because "none were excluded" is the thing a
      // reader of a partner number needs to be told.
      "dogfood stops excluded",
      String(summary.dogfood_stops),
      "",
      "answered by an AI stand-in, outside the partner reading (D-058)" +
        (summary.dogfood_changes === 0
          ? ""
          : `; ${summary.dogfood_changes} change${summary.dogfood_changes === 1 ? "" : "s"} left the ` +
            "precision population with them"),
    ],
  ];
}

/** The two numbers as one table, so neither can be quoted without the other. */
export function renderStops(summary: StopsSummary): string {
  return renderMetricTable([METRIC_TABLE_HEADER, ...stopsRows(summary)]);
}

/**
 * What the partner reading left out, in the words every surface that prints a
 * partner number beside it uses (D-058). One phrase rather than three spellings,
 * so the exclusion reads as the same fact wherever it appears.
 */
export const excluded = (summary: StopsSummary): string =>
  `${summary.dogfood_stops} dogfood stop${summary.dogfood_stops === 1 ? "" : "s"} excluded`;

/**
 * The sentence for a verdict the exclusion itself produced (D-058).
 *
 * The dogfood label comes off a pull-request body, which is text anybody with
 * write access can edit, and the only thing it does is remove answers — so both
 * ways it can move a verdict are ways of removing the answers that were in the
 * way. Signing enough ticks as the stand-in's empties the partner population and
 * leaves `CANNOT RESOLVE` where a `FAIL` was available, which reads exactly like
 * a bar nobody has reached yet; signing the overrides away leaves a `PASS` the
 * remaining answers did not earn on their own. Either way the reading and the
 * verdict a person quotes are about the population that survived the label, and
 * the difference is worth a sentence.
 *
 * No threshold is picked and no exclusion is called suspicious: the comparison
 * is the counterfactual reading against this one, and its verdict is either the
 * same or it is not. Empty where nothing was excluded and where the exclusion
 * changed nothing about how the bar reads.
 */
function exclusionChangedTheVerdict(
  reading: D060Reading,
  summary: StopsSummary,
  pooled?: D060Reading,
): string {
  if (pooled === undefined || summary.dogfood_stops === 0) return "";
  if (pooled.verdict === reading.verdict) return "";
  return (
    `  the exclusion is what makes this ${reading.verdict.toUpperCase()} rather than ` +
    `${pooled.verdict.toUpperCase()}: with the ${summary.dogfood_stops} dogfood ` +
    `answer${summary.dogfood_stops === 1 ? "" : "s"} pooled back in — which would not be a partner ` +
    `reading, and is read here only to say what the exclusion did — n would be ${pooled.interval.n}.\n`
  );
}

/**
 * The reading against D-060's bar, in one line under the table.
 *
 * Three things it can say, and the difference between them is the whole point:
 *
 * - **PASS** — the 95% Wilson interval sits wholly at or above 70%. That is the
 *   bar as the Product Owner accepted it on 2026-09-01, and a point estimate
 *   never grants it.
 * - **FAIL** — the population could have resolved a pass and this one does not.
 *   The line says which kind: an interval that spans the bar has not cleared
 *   it, and one wholly below it is a different sentence about the same verdict.
 * - **CANNOT RESOLVE** — fewer changes than the smallest population any set of
 *   answers could pass on. Nine unanimous endorsed stops is that population;
 *   below it the reading is not evidence either way, and saying so is what
 *   D-060 asks for instead of a pass.
 *
 * `n` is the partner population: the stand-in's answers are already out of it,
 * and the row above says how many were taken out. What the exclusion cannot do
 * follows on its own line wherever the label had anything to say — the label is
 * self-declared, so `n` is an upper bound rather than a guarantee and the
 * exclusion can as easily have been claimed as earned, and a number quoted as a
 * partner reading is quoted with that said ({@link PARTNER_READING_CAVEAT}).
 * The line is printed whenever there is a partner answer to qualify **or**
 * anything was excluded — an emptied population is exactly the reading a person
 * most needs the caveat for. On an empty store nothing was claimed either way
 * and it is not printed.
 *
 * Where the verdict would have read differently with the excluded answers
 * pooled back in, that is said too, in as many words: a `CANNOT RESOLVE` the
 * exclusion produced must not read like one that is merely early, and a `PASS`
 * it produced must not read like one the answers earned. The pooled figure is
 * named as what it is — not a partner reading — so nothing invites quoting it
 * as one.
 */
export function renderD060(reading: D060Reading, summary: StopsSummary, pooled?: D060Reading): string {
  const bar = `${Math.round(reading.bar * 100)}%`;
  const head = `D-060 bar (precision of stopping ≥${bar}): ${reading.verdict.toUpperCase()}`;
  const population =
    `n=${reading.interval.n} change${reading.interval.n === 1 ? "" : "s"} with a partner answer` +
    (summary.dogfood_stops === 0 ? "" : `, ${excluded(summary)}`);
  const caveat =
    reading.interval.n === 0 && summary.dogfood_stops === 0 ? "" : `  ${PARTNER_READING_CAVEAT}\n`;
  if (reading.verdict === "cannot resolve") {
    return (
      `${head} — ${population}, below the ${reading.resolving_n} unanimous endorsed stops that are the ` +
      `smallest population whose 95% Wilson lower bound clears ${bar}. This reading neither passes nor ` +
      "fails the bar; it is not yet a reading.\n" +
      exclusionChangedTheVerdict(reading, summary, pooled) +
      caveat
    );
  }
  const interval = `95% Wilson ${bounds(reading.interval)}`;
  const where =
    reading.verdict === "pass"
      ? `${interval} resolves wholly at or above ${bar}`
      : reading.spans_bar
        ? `${interval} spans ${bar} rather than resolving at or above it`
        : `${interval} resolves wholly below ${bar}`;
  return (
    `${head} — ${where}, ${population}.\n` + exclusionChangedTheVerdict(reading, summary, pooled) + caveat
  );
}

/**
 * D-076's bar and its cost, as table rows beside `stopsRows`.
 *
 * `unattended merges` excludes `unknown` tickets from `n` the same way
 * precision excludes an unanswered stop — a legacy record with nothing decided
 * is not a third kind of "no" — and names the excluded count in its own
 * description rather than folding it into `n`, so a shrinking `n` never reads
 * as a rising share. `cost per merged ticket` has no interval of its own — it
 * is a sum divided by a count, not a share — so its middle column stays blank
 * the way `unanswered stops` above already does.
 */
export function unattendedRows(summary: UnattendedMergesSummary, cost: MergedCostSummary): string[][] {
  const n = summary.unattended + summary.attended;
  const perTicket = cost.tickets === 0 ? "—" : `$${(cost.micros / cost.tickets / 1_000_000).toFixed(4)}`;
  const unpriced =
    cost.unpriced_attempts.length === 0
      ? ""
      : `; unpriced: ${cost.unpriced_attempts.map((one) => `${one.ticket}/${one.attempt_id}`).join(", ")}`;
  return [
    [
      "unattended merges",
      pct(summary.share.point),
      bounds(summary.share),
      `${n} merged ticket${n === 1 ? "" : "s"} with a known answer (${summary.unattended} unattended, ` +
        `${summary.attended} attended)` + (summary.unknown > 0 ? `, ${summary.unknown} not yet decided` : ""),
    ],
    [
      "cost per merged ticket",
      perTicket,
      "",
      // `priced`/`unavailable` count cost *components* (execution, review,
      // closure verification) rather than attempts — one attempt can carry
      // up to three — so they are named separately from the attempt count to
      // keep "27 attempts" from reading as a ceiling on "47 priced".
      `${cost.tickets} merged ticket${cost.tickets === 1 ? "" : "s"}, ${cost.attempts} attempt${cost.attempts === 1 ? "" : "s"}, ` +
        `${cost.priced + cost.unavailable} cost component${cost.priced + cost.unavailable === 1 ? "" : "s"} ` +
        `(${cost.priced} priced${cost.unavailable > 0 ? `, ${cost.unavailable} unpriced` : ""})${unpriced}`,
    ],
  ];
}

/**
 * D-077's reversal trigger, over the merges the loop performed itself
 * (SCP-202 criterion 4).
 *
 * A count rather than a rate — "two in the measured twenty reopen this
 * decision" — and a count of the loop's **own** merges: a pull request a
 * person merged and then reverted says nothing about whether the loop should
 * merge, so the population is `delivery.merged_by` and not every merged
 * ticket. What charges a row is the escape record `perbo sync` already
 * writes, read here from files and nothing else.
 *
 * The two columns are named separately and never summed, for the reason
 * `perbo escapes` never sums them: a same-path commit inside fourteen days
 * over-counts on a hot file, and a revert is the strict signal. The headline
 * value is how many merges either column charged, because D-077's trigger is
 * "reverted, **or** charged at day fourteen".
 */
export interface LoopMergesSummary {
  /** Every merged ticket in the same population the share above reads. */
  merged: number;
  /** Of those, the ones the loop merged itself. */
  by_loop: number;
  /** The loop's merges whose fourteen days have closed and were watched. */
  closed: number;
  reverted: number;
  same_path: number;
  /** Charged by either column. Never the sum of the two. */
  undone: number;
  window_open: number;
  not_observed: number;
}

export function summariseLoopMerges(
  tickets: readonly Pick<Ticket, "ticket_id" | "state" | "delivery">[],
  rows: readonly EscapeRow[],
): LoopMergesSummary {
  const byTicket = new Map(rows.map((row) => [row.ticket_id, row]));
  const loop = tickets.filter((ticket) => ticket.delivery.merged_by !== null);
  const charged = loop.flatMap((ticket) => {
    const row = byTicket.get(ticket.ticket_id);
    return row === undefined ? [] : [row];
  });
  const closed = charged.filter((row) => row.status === "observed");
  return {
    merged: tickets.length,
    by_loop: loop.length,
    closed: closed.length,
    reverted: closed.filter((row) => row.reverted).length,
    same_path: closed.filter((row) => row.same_path_touched).length,
    undone: closed.filter((row) => row.reverted || row.same_path_touched).length,
    window_open: charged.filter((row) => row.status === "window open").length,
    // A merge with no escape record at all is not observed either: the count
    // is over the loop's merges, not over the records that happen to exist.
    not_observed: loop.length - closed.length - charged.filter((row) => row.status === "window open").length,
  };
}

/** D-077's count, as table rows beside the share it is read against. */
export function loopMergeRows(summary: LoopMergesSummary): string[][] {
  const merged = `${summary.by_loop} of ${summary.merged} merged ticket${summary.merged === 1 ? "" : "s"}`;
  return [
    ["merges the loop performed", String(summary.by_loop), "", merged],
    [
      `loop merges undone (${ESCAPE_WINDOW_DAYS}d)`,
      String(summary.undone),
      "",
      `${summary.closed} of the loop's merges with the window closed ` +
        `(${summary.reverted} reverted, ${summary.same_path} same path re-touched)` +
        (summary.window_open > 0 ? `, ${summary.window_open} window open` : "") +
        (summary.not_observed > 0 ? `, ${summary.not_observed} not observed` : ""),
    ],
  ];
}

/**
 * A review that could not resolve every criterion, and which way it reached its
 * end.
 *
 * It sits beside the numbers rather than in them because it is not a rate: it
 * is the short list of changes whose review left a criterion unjudged, and the
 * two paths cost a person the same interruption while saying opposite things
 * about the loop. One tried the executor on the finding that made the criterion
 * unjudgeable and asked only after the re-review; the other asked without a
 * round, because nothing the executor may be handed explained the criterion.
 * Printed as separate rows so an escalation that followed remediation is never
 * read as one that did not.
 */
export interface IncompleteReviewRow {
  change: string;
  path: IncompleteReviewPath;
}

/** What each path is, in the words the row prints. */
export const INCOMPLETE_REVIEW_SENTENCES: Record<IncompleteReviewPath, string> = {
  incomplete_remediated:
    "a remediation round ran on the findings the unresolved criteria rested on, and the re-review decided",
  incomplete_escalated: "no remediable cause: a person decided without a remediation round",
};

export function incompleteReviewRows(
  tickets: readonly Pick<Ticket, "key" | "delivery">[],
): IncompleteReviewRow[] {
  return tickets.flatMap((ticket) =>
    ticket.delivery.incomplete_review === null
      ? []
      : [{ change: ticket.key, path: ticket.delivery.incomplete_review }],
  );
}

/** The rows as a table, or null where no review in the store left a criterion unjudged. */
export function renderIncompleteReviews(rows: readonly IncompleteReviewRow[]): string | null {
  if (rows.length === 0) return null;
  return renderTable([
    ["change", "a criterion the review could not resolve"],
    ...rows.map((row) => [row.change, INCOMPLETE_REVIEW_SENTENCES[row.path]]),
  ]);
}

/** Every number `perbo stops` prints, in the one table D-060 and D-076 share. */
export function renderStopsAndUnattended(
  summary: StopsSummary,
  unattended: UnattendedMergesSummary,
  cost: MergedCostSummary,
  loop: LoopMergesSummary,
): string {
  return renderMetricTable([
    METRIC_TABLE_HEADER,
    ...stopsRows(summary),
    ...unattendedRows(unattended, cost),
    ...loopMergeRows(loop),
  ]);
}

/* ------------------------------------------------------------------ *
 * ISO-8601 weeks.
 *
 * Every stops record carries UTC instants, so the weeks are UTC weeks and the
 * arithmetic is epoch milliseconds throughout — no local midnight, no daylight
 * saving, no calendar object that means something different in Auckland.
 * ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Midnight UTC on the Monday of the ISO week containing `ms`. ISO weeks start
 * on Monday, so `getUTCDay()`'s Sunday-first numbering is rotated by one.
 */
export function isoWeekStart(ms: number): number {
  const midnight = Math.floor(ms / DAY_MS) * DAY_MS;
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - weekday * DAY_MS;
}

/**
 * The ISO week label — `2026-W01` — for an instant. The year is the ISO
 * *week-year*, which is the calendar year of the week's Thursday and so
 * differs from the calendar year around New Year: 2025-12-29 is `2026-W01`.
 */
export function isoWeekKey(ms: number): string {
  const thursday = isoWeekStart(ms) + 3 * DAY_MS;
  const weekYear = new Date(thursday).getUTCFullYear();
  // Week 1 is the one containing 4 January, by definition.
  const firstWeek = isoWeekStart(Date.UTC(weekYear, 0, 4));
  const week = Math.round((thursday - 3 * DAY_MS - firstWeek) / WEEK_MS) + 1;
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/** Every ISO week start from the one containing `from` through the one containing `to`. */
export function isoWeeksBetween(from: number, to: number): number[] {
  const starts: number[] = [];
  for (let start = isoWeekStart(from); start <= isoWeekStart(to); start += WEEK_MS) starts.push(start);
  return starts;
}

/** One ISO week of the window, whether or not any change fell in it. */
export interface StopsWeek {
  /** ISO week-year and week, `2026-W01`. */
  week: string;
  /** Midnight UTC on the week's Monday, and the instant the next week starts. */
  starts_at: string;
  ends_at: string;
  summary: StopsSummary;
  /** D-060's trigger against the week before this one in the same table. */
  widened_by_hiding: boolean;
}

/**
 * The window cut into ISO weeks, from the week `since` falls in (or the week
 * of the earliest change, when the whole record is the window) through the
 * current week. Weeks nothing fell in are kept, at n=0: a week that is missing
 * from the table reads as a week that was not measured, and the shape of the
 * movement is exactly what the table is for.
 *
 * The range also covers any change dated after `now`, so that every change in
 * the window lands in exactly one week and the weeks sum to the total.
 */
export function stopsByWeek(
  files: readonly StopVerdicts[],
  bounds_: { since: string | null; now: Date },
): StopsWeek[] {
  const seen = files.map((file) => Date.parse(file.first_seen_at));
  const from = bounds_.since !== null ? Date.parse(bounds_.since) : Math.min(...seen);
  if (!Number.isFinite(from)) return [];
  const to = Math.max(bounds_.now.getTime(), ...seen);
  const buckets = new Map<number, StopVerdicts[]>();
  for (const [index, file] of files.entries()) {
    const start = isoWeekStart(seen[index]!);
    buckets.set(start, [...(buckets.get(start) ?? []), file]);
  }
  const weeks: StopsWeek[] = [];
  for (const start of isoWeeksBetween(from, to)) {
    const summary = summariseStops(buckets.get(start) ?? []);
    const previous = weeks.at(-1);
    weeks.push({
      week: isoWeekKey(start),
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(start + WEEK_MS).toISOString(),
      summary,
      widened_by_hiding: previous !== undefined && widenedByHiding(previous.summary, summary),
    });
  }
  return weeks;
}

/**
 * The header of the per-week table; its columns are one week's worth of
 * {@link stopsRows}.
 *
 * The last column is the same exclusion the table above states once, said again
 * per week because each week's precision is its own partner reading (D-058) and
 * each week's `n` is its own denominator: a week the stand-in answered four
 * stops in is a week whose `n` fell by up to four, and a column that only
 * existed for the total would leave that as a shrinking number with nothing
 * beside it.
 */
export const WEEK_TABLE_HEADER = [
  "week",
  "precision of stopping",
  "95% Wilson",
  "n",
  "person shown something",
  "dogfood excluded",
];

/** One row of the per-week table, for a week or for the total beneath them. */
export function weekRow(label: string, summary: StopsSummary): string[] {
  return [
    label,
    pct(summary.precision.point),
    bounds(summary.precision),
    String(summary.precision.n),
    `${pct(summary.companion.point)} (n=${summary.companion.n})`,
    String(summary.dogfood_stops),
  ];
}

/**
 * The weeks and, in the same columns, the total they make up — so a week can
 * never be read without the number it is a part of, for the same reason
 * precision is never printed without its companion.
 */
export function renderStopsWeeks(weeks: readonly StopsWeek[], total: StopsSummary): string {
  return renderTable([
    WEEK_TABLE_HEADER,
    ...weeks.map((week) => weekRow(week.week, week.summary)),
    weekRow("total", total),
  ]);
}

/**
 * The window before `--since`, in one line.
 *
 * Its precision is a partner reading like every other one this command prints,
 * so what was taken out of it is named on the same line: the table's own
 * dogfood row is about the window, not about what came before it, and a
 * denominator that shrank silently here reads as a rate that rose.
 */
const brief = (summary: StopsSummary): string =>
  `precision ${pct(summary.precision.point)} ${bounds(summary.precision)} n=${summary.precision.n} · ` +
  `shown ${pct(summary.companion.point)} ${bounds(summary.companion)} n=${summary.companion.n}` +
  (summary.dogfood_stops === 0 ? "" : ` · ${excluded(summary)}`);

/** D-060's reversal trigger, in the words the decision uses. */
const HIDING_SENTENCE =
  "precision of stopping rose while the share of changes on which a person was " +
  "shown something fell — the gate widened by hiding findings, not by measuring better.";

export const HIDING_WARNING = `warning: ${HIDING_SENTENCE}`;

/** The same trigger between two consecutive weeks, naming the pair it read. */
export const weekHidingWarning = (from: string, to: string): string =>
  `warning ${from} → ${to}: ${HIDING_SENTENCE}`;

/**
 * A merged change, as `buildReportForSubject` needs it to roll its cost.
 *
 * SCP-284: a local run's cost is rolled through the resolver `inspect` itself
 * uses on a store with no ticket file — one answer to "what is this id",
 * rather than a second reading of the run record here.
 */
function mergedSubject(dir: string, change: SyncedChange): InspectSubject {
  return change.kind === "ticket"
    ? mergedTicketSubject(change.ticket)
    : attemptsRecordSubject(dir, change.ticket_id);
}

/** A merged ticket, as `buildReportForSubject` needs it to roll its cost. */
function mergedTicketSubject(ticket: Ticket): InspectSubject {
  return {
    kind: "ticket",
    ticket: ticket.key,
    ticket_id: ticket.ticket_id,
    outcome: ticket.title,
    contract_source: null,
    refusal: null,
    state: ticket.state,
    pull_request_url: ticket.delivery.pull_request_url,
    // Only the cost is read off this subject; a ticket file records no base.
    base: null,
    handed_off: ticket.delivery.opened_by === null ? null : ticket.delivery.opened_by === "hand_off",
    delivery_checks:
      ticket.delivery.checks_state === null
        ? null
        : { state: ticket.delivery.checks_state, checks: ticket.delivery.checks },
    admission: ticket.admission,
    source: ticket.source,
    // Only the cost is read off this subject; the queue is `inspect`'s to show.
    queue: null,
    // Not read here: this subject exists to roll a merged change's cost, and
    // whether the spec has moved since is a reading about work still to do.
    spec_staleness: null,
    runs_started: null,
    // The cost roll needs no graph, and reads no contract to find one.
    nodes: null,
    edges: null,
    approach_problem: null,
    size: null,
  };
}

export async function runStopsCommand(input: {
  argv: string[];
  streams: Streams;
  cwd: string;
  /** The instant the last week runs to; the clock, so a test can hold it still. */
  now?: Date;
}): Promise<number> {
  const args = parseStopsArgs(input.argv);
  const dir = storeDir(resolve(input.cwd, args.repo), args.store);
  const decisions = readDecisions(dir, input.streams);
  const files = readStopRecords(dir, input.streams, decisions);

  const since = args.since;
  const window = since === null ? files : files.filter((file) => file.first_seen_at >= since);
  const before = since === null ? null : summariseStops(files.filter((file) => file.first_seen_at < since));
  const summary = summariseStops(window);
  // D-060's bar, judged over the same window the table prints and over the
  // partner population `summariseStops` already narrowed to.
  const d060 = judgeAgainstD060(summary.precision);
  // The same bar over the population before the exclusion — not a partner
  // reading and never reported as one, read only so that a verdict the
  // exclusion itself produced can be told from one the answers earned.
  const d060PoolingDogfood = judgeAgainstD060(summary.pooled_precision);
  const widened = before !== null && widenedByHiding(before, summary);
  const weeks = args.byWeek ? stopsByWeek(window, { since, now: input.now ?? new Date() }) : null;

  // SCP-196: the loop's own number, beside D-060's. `--since` bounds the
  // population the same way it bounds the stops above — a ticket merged
  // before the window opened is not part of this reading — read from the
  // ticket's own history rather than `updated_at`, which a later, unrelated
  // sync would otherwise move.
  // SCP-206: `--arm` narrows every population below to one arm's records, so
  // each share reads as the registration states it — per arm, over the same
  // tickets. Without the flag every record counts, as it always did.
  // SCP-284: every change in the store, admitted or not. A run started with
  // `run --outcome` merges its own pull request and reaches a person the same
  // way a ticket's does, so it belongs in every population below; on a
  // repository that admitted nothing it is the only kind there is.
  const changes = listChanges(dir).filter(
    (change) => args.arm === null || change.delivery.arm === args.arm,
  );
  const mergedChanges = changes.filter((change) => {
    if (change.state !== "merged") return false;
    if (since === null) return true;
    const at = change.merged_at;
    return at !== null && at >= since;
  });
  const unattended = summariseUnattendedMerges(mergedChanges);
  // A ticket's attempts record failing to parse must not take the whole
  // reading down with it — named on stderr and left out of the cost, the same
  // rule `listTickets` and `readStopVerdictFiles` already follow for their
  // own stores.
  const mergedReports: InspectReport[] = [];
  for (const change of mergedChanges) {
    try {
      mergedReports.push(
        buildReportForSubject({
          storeDirectory: dir,
          subject: mergedSubject(dir, change),
          attempt: null,
          streams: input.streams,
        }),
      );
    } catch (error) {
      input.streams.stderr(
        `warning: ${change.key}'s attempts record could not be read and is left out of the cost ` +
          `per merged ticket: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
      );
    }
  }
  const cost = summariseMergedCost(mergedReports);
  // SCP-202: D-077's own count, over the same population. `escapeRows` reads
  // the records `perbo sync` wrote and nothing else — no `git`, no `gh` —
  // which is what lets this command stay the offline reading it has been.
  const loopMerges = summariseLoopMerges(mergedChanges, escapeRows(dir, input.streams, input.now ?? new Date()));

  // The reviews that left a criterion unjudged, over every ticket rather than
  // the merged ones: a change whose review could not resolve a criterion is
  // exactly the change that did not merge. `--since` bounds nothing here — it
  // buckets by when a change merged, and these did not.
  const incomplete = incompleteReviewRows(changes);

  if (args.json) {
    input.streams.stdout(
      `${JSON.stringify(
        {
          since,
          arm: args.arm,
          summary,
          d060,
          // The counterfactual, under a name that says what it is: the same
          // bar read over the population the exclusion took the dogfood
          // answers out of. It is not a partner reading, and it is here for
          // one question — whether `d060`'s verdict is the exclusion's or the
          // answers'.
          d060_pooling_dogfood: d060PoolingDogfood,
          // The same sentence the table prints under it: a consumer that reads
          // `summary.precision` out of this document is quoting a partner
          // number, and it travels with what the label cannot promise.
          partner_reading_caveat: PARTNER_READING_CAVEAT,
          before,
          widened_by_hiding: widened,
          unattended_merges: unattended,
          merged_cost: cost,
          loop_merges: loopMerges,
          incomplete_reviews: incomplete,
          ...(weeks === null ? {} : { weeks }),
        },
        null,
        2,
      )}\n`,
    );
    return EXIT_CODES.approve;
  }

  input.streams.stdout(`${renderStopsAndUnattended(summary, unattended, cost, loopMerges)}\n`);
  // Directly under the table the verdict is about, and before everything else
  // this command prints: the bar is what the first two rows are read against.
  input.streams.stdout(renderD060(d060, summary, d060PoolingDogfood));
  if (weeks !== null) input.streams.stdout(`\n${renderStopsWeeks(weeks, summary)}\n`);
  const unjudged = renderIncompleteReviews(incomplete);
  if (unjudged !== null) input.streams.stdout(`\n${unjudged}\n`);
  // After the tables the numbers are in, because this is what they are made
  // of: the decisions themselves, and who took each where the record says.
  const decided = renderDecisions(decisions);
  if (decided !== null) input.streams.stdout(`\n${decided}\n`);
  if (before !== null) {
    input.streams.stdout(`\nsince ${since}; before it: ${brief(before)}\n`);
  }
  if (widened) input.streams.stdout(`${HIDING_WARNING}\n`);
  (weeks ?? []).forEach((week, index, all) => {
    if (week.widened_by_hiding) input.streams.stdout(`${weekHidingWarning(all[index - 1]!.week, week.week)}\n`);
  });
  if (files.length === 0) {
    input.streams.stderr(
      `nothing recorded in ${join(dir, "state")} or ${verdictsPath(dir)} yet: \`perbo sync <KEY>\` ` +
        "reads the answers off a pull request once one is open, and `perbo verdict <review> " +
        "--endorse|--override <stop key>` records one here without one.\n",
    );
  }
  return EXIT_CODES.approve;
}
