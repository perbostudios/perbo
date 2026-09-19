#!/usr/bin/env node
// Reads a fresh regression-suite run beside the score this repository recorded
// and prints what moved: metric, recorded, now, delta, and whether the gate
// still holds. Exits 1 naming any gated metric that no longer meets its
// threshold, so a reviewer change that makes the reviewer worse fails the job
// that ran it rather than being noticed later.
//
// Usage: node regression-delta.mjs <fresh-result> <recorded-score> [--summary]
//        node regression-delta.mjs <fresh-result> --record > regression-score.json
//
// `--summary` renders the gated rows a second time, as a markdown table, and
// appends it to the file `GITHUB_STEP_SUMMARY` names — the job's own summary
// page, which is where a contributor reads a run without opening its log.
//
// <fresh-result> is the harness's own `summary.json`, or the `--out` directory
// holding it, or a file already in the recorded score's shape.
// <recorded-score> is `.github/regression-score.json`.
//
// A score carries `rows` beside its metrics: one row per review, naming the
// fixture, its class, whether the run's answer for it was the expected one,
// what the review cost and whether the harness cut it short. A metric is a
// proportion, and a proportion that moves says only that some fixtures changed
// their answer, not which — so the rows are what makes a regression a named
// fixture a reader can open rather than a percentage. `--record` therefore
// needs the run's `runs.json` as well as its `summary.json`, and refuses a
// result directory that has no `runs.json` rather than recording a score whose
// rows are silently absent.
//
// `--record` is the other end of the same mechanism: it prints the score file
// a maintainer replaces `.github/regression-score.json` with after re-running
// the suite. It lives here rather than in a second script so that the names a
// score is recorded under and the names a delta joins on are produced by one
// function — two implementations of that rule would agree until the day they
// did not, and the failure would look like a metric that vanished.
//
// Two things this deliberately does not do. It does not re-derive a score from
// artifacts — the harness is the only thing that scores a run, and a second
// scorer that disagreed with it would be worse than no second opinion. And it
// does not fail on a metric nobody measured: an `n` of zero on either side is
// printed as unmeasured, because a row with no denominator is a question the
// run did not ask, not an answer that got worse. Whether an empty denominator
// is itself a fault is the harness's judgement and is made in its own summary.

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Identifiers that belong to the private working tree — the decision register,
 * the backlog, the architecture records. A metric name may carry one in a
 * trailing note; the note is for maintainers and does not travel.
 */
const INTERNAL_ID = /\bSCP-\d{3}\b|\bD-0\d{2}\b|\bADR-\d{4}\b|\b(?:PRB|AYO)-\d+\b/;

/**
 * The public name of a metric: its name with any parenthetical that cites an
 * internal identifier dropped, whole.
 *
 * Applied to both sides before they are joined, so the recorded score and a
 * fresh run agree on what a row is called without either of them carrying an
 * identifier a reader here cannot follow. Whether a row gates is carried by its
 * own `threshold` field, not by the words in its name, so nothing a comparison
 * needs is lost with the note.
 */
export function publicMetricName(name) {
  const withoutNotes = name.replace(/\s*\([^()]*\)/g, (note) => (INTERNAL_ID.test(note) ? "" : note));
  return withoutNotes.replace(new RegExp(INTERNAL_ID.source, "g"), "").replace(/\s+/g, " ").trim();
}

/**
 * A row's reading — the two recall readings, `"mechanism"` or `"anchor-OR"`
 * — or `null` when the row is neither: most rows are not a recall figure and
 * never carry the field. Passed through as the harness wrote it; no default
 * is applied here. `compare` below is what falls back to the recorded side's
 * definition when the fresh side carries none.
 */
function definitionOf(metric) {
  return metric.definition === "mechanism" || metric.definition === "anchor-OR" ? metric.definition : null;
}

/** One comparable row, from either file's shape. */
function rowsOf(document) {
  if (!Array.isArray(document.metrics)) {
    throw new Error('expected a "metrics" array');
  }
  return document.metrics.map((metric) => {
    // The harness reports a proportion as {point, low, high, n}; a recorded
    // score keeps the point and the n and drops the rest.
    const value = metric.by_fixture ? metric.by_fixture.point : metric.value;
    const n = metric.by_fixture ? metric.by_fixture.n : metric.n;
    return {
      name: publicMetricName(metric.name),
      value: typeof value === "number" && Number.isFinite(value) ? value : null,
      n: typeof n === "number" ? n : 0,
      threshold: typeof metric.threshold === "number" ? metric.threshold : null,
      direction: metric.direction ?? null,
      definition: definitionOf(metric),
    };
  });
}

/**
 * A row's name with its reading beside it — `Blocking-defect recall, P1
 * (mechanism)` — for a table cell, never for the join key. `definition` is
 * `null` for a row that is not a recall figure, which prints the bare name
 * unchanged; a name that already carries its own tag (the anchor-OR
 * rows are named `<name> (anchor-OR)` outright) is never suffixed twice.
 */
function labelledName(name, definition) {
  if (!definition) return name;
  const suffix = `(${definition})`;
  return name.endsWith(suffix) ? name : `${name} ${suffix}`;
}

/** A `summary.json` inside a directory, or the file named directly. */
export function readResult(path) {
  const target = resolve(path);
  if (!existsSync(target)) throw new Error(`no such file or directory: ${target}`);
  const file = statSync(target).isDirectory() ? join(target, "summary.json") : target;
  if (!existsSync(file)) throw new Error(`no summary.json in ${target}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The run records of a result, from the directory holding them.
 *
 * `runs.json` is an array of run records, or — when a spend ceiling stopped the
 * run — the partial marker with the same array under `runs`. Both are read, so
 * a truncated run still yields the rows for the reviews it did reach; that the
 * run was truncated is the harness's own `not_a_measurement`, said once, in the
 * summary, and not restated here.
 *
 * Refuses when there is no `runs.json` beside the summary, naming the directory
 * and the file. The alternative is a score recorded with no rows in it, which
 * would read as thirty fixtures that all kept their answer.
 */
export function readRuns(path) {
  const target = resolve(path);
  if (!existsSync(target)) throw new Error(`no such file or directory: ${target}`);
  const directory = statSync(target).isDirectory() ? target : dirname(target);
  const file = join(directory, "runs.json");
  if (!existsSync(file)) {
    throw new Error(
      `no runs.json in ${directory}: a score's rows are one per review and only runs.json carries them`,
    );
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const runs = Array.isArray(parsed) ? parsed : parsed?.runs;
  if (!Array.isArray(runs)) throw new Error(`${file} is neither an array of runs nor an object with one`);
  return runs;
}

/**
 * One row per review: the fixture, its class, the run's answer for it, what it
 * cost and whether the harness cut it short.
 *
 * `caught` is the harness's own gated answer for that review, read from the
 * record rather than recomputed — `confirmed_detected` where attribution v2
 * wrote one, and the older `detected` where it did not, which is the same
 * choice `summariseCorpus` makes for the recall rows. On a defective fixture it
 * is whether the seeded defect was found; on a clean one it is whether the gate
 * stayed open. Either way it is "did this review answer this fixture the way
 * the fixture said it should", which is what a reader comparing two runs wants
 * a name for. A review that produced no score — it crashed, or the deadline
 * killed it — has no answer and reads null, which is not a miss.
 *
 * `cost` is the review's own reported cost in micros (millionths of a dollar),
 * as the artifact carries it, and null where the transport reported none.
 * `partial` is `"timeout"` where the harness killed the review at its deadline.
 *
 * A row is one fixture's answer at one repeat. The regression suite runs at one
 * repeat, so its rows are one per fixture; at more repeats a fixture takes one
 * row per repeat, in the order the run file holds them.
 *
 * The class is the fixture's, and the run record does not carry it — the
 * summary's `per_fixture` does, which is why this reads both files. A fixture
 * the summary does not mention reads a null class rather than being dropped: a
 * row with no class still names a fixture that changed its answer.
 */
export function fixtureRows(summary, runs) {
  const classes = new Map((summary.per_fixture ?? []).map((fixture) => [fixture.id, fixture.class ?? null]));
  return runs.map((record) => ({
    id: record.fixture_id ?? null,
    class: classes.get(record.fixture_id) ?? null,
    caught: record.score ? (record.score.confirmed_detected ?? record.score.detected ?? null) : null,
    cost: record.artifact?.cost_micros ?? null,
    partial: record.partial ?? null,
  }));
}

/** Whether a row's value clears its own threshold. Unmeasured and ungated rows have no answer. */
export function gateHolds(row) {
  if (row.threshold === null || row.direction === null) return null;
  if (row.n === 0 || row.value === null) return null;
  return row.direction === "at_least" ? row.value >= row.threshold : row.value <= row.threshold;
}

function format(value) {
  return (value === null ? "—" : value.toFixed(3)).padStart(8);
}

function formatDelta(before, after) {
  if (before === null || after === null) return "      —";
  const delta = after - before;
  return `${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(3)}`.padStart(7);
}

/** Whether a value moved the wrong way for its own direction. */
function worse(then, now, direction) {
  return direction === "at_least" ? now.value < then.value : now.value > then.value;
}

/**
 * The comparison, as rows to print and the gated metrics this change made
 * worse.
 *
 * What fails the job is a gate this change broke, not a gate that was already
 * below its threshold when the score was recorded. The suite is thirty
 * fixtures, and a corpus threshold set over the full corpus reads at an n the
 * suite does not reach — the recorded score says so, in the row, rather than
 * rounding it up to a pass. A rule that failed on any unmet threshold would
 * therefore fail every pull request from the first one onwards and stop
 * meaning anything. So: a gate that held and no longer holds fails, and a gate
 * that was already under its threshold fails if this change pushed it lower.
 * Coming back above the line is reported too, because that is the change most
 * worth seeing.
 *
 * Every row of the fresh run is reported, in the order the harness produced
 * them; a row the recorded score has never seen is printed as new rather than
 * silently skipped, because a metric added since the score was recorded is
 * exactly the case where a silent skip would hide a gate.
 */
export function compare(fresh, recorded) {
  const before = new Map(rowsOf(recorded).map((row) => [row.name, row]));
  const rows = [];
  const regressed = [];

  for (const now of rowsOf(fresh)) {
    const then = before.get(now.name) ?? null;
    const holds = gateHolds(now);
    const held = then === null ? null : gateHolds(then);
    const unmeasured = now.n === 0 || now.value === null || (then !== null && (then.n === 0 || then.value === null));
    // The row's own threshold, written the way it reads, whether or not the run
    // measured enough to answer it: a gated row nobody measured still has a bar,
    // and the summary table below names it rather than leaving the cell blank.
    const gated = now.threshold !== null && now.direction !== null;
    const bar = gated ? `${now.direction === "at_least" ? ">=" : "<="} ${now.threshold.toFixed(3)}` : "";
    // The two recall readings: read off the fresh side, which is the one
    // this run measured; a recorded score predating the tag falls back to it
    // only once the fresh side (or, failing that, the recorded side alone)
    // says this row is a recall figure at all — a row that is neither never
    // gains a tag here.
    const definition = now.definition ?? then?.definition ?? null;
    const name = labelledName(now.name, definition);

    let status;
    let broke = false;
    if (then === null) status = "not recorded before";
    else if (unmeasured) status = "unmeasured";
    else if (holds === null) status = "not gated";
    else if (holds && held) status = `holds (${bar})`;
    else if (holds && !held) status = `recovered (${bar})`;
    else if (held) {
      status = `REGRESSED (${bar})`;
      broke = true;
    } else if (worse(then, now, now.direction)) {
      status = `REGRESSED further (${bar})`;
      broke = true;
    } else {
      status = `below threshold, no worse (${bar})`;
    }

    if (broke) regressed.push({ ...now, name, recorded: then.value });

    rows.push({
      name,
      recorded: then === null || unmeasured ? null : then.value,
      now: unmeasured ? null : now.value,
      delta: then === null || unmeasured ? "      —" : formatDelta(then.value, now.value),
      n: now.n,
      status,
      gated,
      // Whether this row's own gate is met by the fresh value: the harness's
      // rule, not a second one — `null` where the run did not measure it.
      meets: holds,
      bar,
    });
  }

  return { rows, regressed };
}

/** A score's rows collected per fixture, in the order the score holds them, or null if it has none. */
function answersByFixture(document) {
  if (!Array.isArray(document.rows)) return null;
  const answers = new Map();
  for (const row of document.rows) {
    const entry = answers.get(row.id) ?? { id: row.id, class: row.class ?? null, caught: [] };
    entry.class ??= row.class ?? null;
    entry.caught.push(row.caught ?? null);
    answers.set(row.id, entry);
  }
  return answers;
}

/**
 * The fixtures whose answer moved, by id and class.
 *
 * This is the question a metric delta cannot answer. P2 recall falling from
 * 0.933 to 0.867 says one of fifteen fixtures changed its mind; it does not say
 * which, and the fixture is the thing a reader can open, re-run and argue
 * about. So the rows are joined on the fixture id and every fixture whose
 * answer differs is named — in both directions, because a fixture that started
 * being caught is as much a change to explain as one that stopped.
 *
 * It does not fail the job. What fails a job is a gated metric this change made
 * worse, decided by `compare` exactly as before; a fixture that traded places
 * with another leaves recall where it was, and telling a contributor that is a
 * regression would be telling them something untrue. The fixtures a run gained
 * or lost outright are reported separately: those are a different suite, not a
 * different answer.
 */
export function compareFixtures(fresh, recorded) {
  const now = answersByFixture(fresh);
  const then = answersByFixture(recorded);
  const without = [];
  if (now === null) without.push("the fresh run");
  if (then === null) without.push("the recorded score");
  if (now === null || then === null) {
    return { comparable: false, without_rows: without, changed: [], only_fresh: [], only_recorded: [] };
  }

  const changed = [];
  const only_fresh = [];
  for (const fixture of now.values()) {
    const before = then.get(fixture.id);
    if (before === undefined) {
      only_fresh.push(fixture);
    } else if (!sameAnswer(before.caught, fixture.caught)) {
      changed.push({ id: fixture.id, class: fixture.class ?? before.class, recorded: before.caught, now: fixture.caught });
    }
  }
  const only_recorded = [...then.values()].filter((fixture) => !now.has(fixture.id));

  return { comparable: true, without_rows: without, changed, only_fresh, only_recorded };
}

function sameAnswer(before, after) {
  return before.length === after.length && before.every((value, index) => value === after[index]);
}

/** `true` / `false` / a missing answer, as words, and as a list when a fixture ran more than once. */
function answer(caught) {
  return caught.map((value) => (value === null ? "no answer" : value ? "caught" : "not caught")).join(", ");
}

/** The fixtures section printed under the metric table. */
function renderFixtures(fixtures) {
  if (!fixtures.comparable) {
    return (
      `\nfixtures: ${fixtures.without_rows.join(" and ")} carries no per-fixture rows, so no fixture can be ` +
      "named here. A score recorded by `--record` carries them."
    );
  }

  const lines = [];
  if (fixtures.changed.length === 0) {
    lines.push("\nfixtures: no fixture changed its answer.");
  } else {
    lines.push(`\nfixtures whose answer changed (${fixtures.changed.length}):\n`);
    for (const fixture of fixtures.changed) {
      lines.push(
        `  ${fixture.id} (${fixture.class ?? "class not recorded"}): ` +
          `${answer(fixture.recorded)} -> ${answer(fixture.now)}`,
      );
    }
  }
  for (const [label, listed] of [
    ["only in this run", fixtures.only_fresh],
    ["only in the recorded score", fixtures.only_recorded],
  ]) {
    if (listed.length > 0) {
      lines.push(`\nfixtures ${label} (${listed.length}): ${listed.map((fixture) => fixture.id).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function render(rows) {
  const width = Math.max(6, ...rows.map((row) => row.name.length));
  const lines = [
    `${"metric".padEnd(width)}  recorded       now    delta   n  gate`,
    `${"-".repeat(width)}  --------  --------  -------  --  ----`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.name.padEnd(width)}  ${format(row.recorded)}  ${format(row.now)}  ${row.delta}  ` +
        `${String(row.n).padStart(2)}  ${row.status}`,
    );
  }
  return lines.join("\n");
}

/** A markdown cell: a value to three places, or an em dash where there is none. */
function cell(value) {
  return value === null ? "—" : value.toFixed(3);
}

/** A metric name as one table cell — a pipe in a name would otherwise end it early. */
function escapeCell(text) {
  return text.replaceAll("|", "\\|");
}

/**
 * The delta as a markdown table, for the summary page of the job that ran it.
 *
 * The same comparison the text table above prints, rendered where a contributor
 * finds it without opening a log: one row per gated metric, carrying the value
 * the score recorded, the value this run produced, the movement between them,
 * and whether the row's own gate is met. Every cell is read off `compare`'s
 * rows rather than recomputed, so the summary and the log cannot disagree about
 * what moved.
 *
 * Gated rows only. The log prints all of them, and it should — a reported row
 * that moved is worth a reader's eye — but the summary page is the place a
 * contributor looks to answer one question, and the rows that decide it are the
 * gated ones. A gated row the run did not measure is still a row here, with its
 * bar named and its cells empty: a gate nobody measured is a question this run
 * did not ask, and dropping it would read as one it answered.
 *
 * `n` is a column because the score this compares against says to read it
 * first: these are thirty fixtures, not the full corpus, and a proportion over
 * five of them is a different statement from the same proportion over fifteen.
 *
 * The sentence under the table is the job's own outcome, said once. It is the
 * text below's conclusion in the same words, so a summary can never report a
 * pass for a run that failed.
 */
export function renderSummary(rows, { regressed, recorded, not_a_measurement }) {
  const gated = rows.filter((row) => row.gated);
  const lines = [
    "## Regression delta",
    "",
    `Against the score recorded on ${recorded.recorded_at ?? "an unstated date"} for corpus ` +
      `${recorded.corpus?.commit ?? "unstated"}. ${rows.length} metric(s) compared, ` +
      `${gated.length} of them gated.`,
    "",
  ];

  if (gated.length === 0) {
    lines.push("No metric in this run is gated, so this run has no gate to report.");
  } else {
    lines.push("| Metric | n | Recorded | Now | Movement | Gate |", "| --- | --- | --- | --- | --- | --- |");
    for (const row of gated) {
      const gate = row.meets === null ? "unmeasured" : row.meets ? "met" : "not met";
      lines.push(
        `| ${escapeCell(row.name)} | ${row.n} | ${cell(row.recorded)} | ${cell(row.now)} | ` +
          `${row.delta.trim()} | ${gate} (${row.bar}) |`,
      );
    }
  }

  lines.push("");
  if (not_a_measurement) {
    lines.push(`**This run is not a measurement** — ${not_a_measurement}. Its rows are printed, but they are not a pass.`);
  } else if (regressed.length === 0) {
    lines.push("No gated metric is worse than the recorded score.");
  } else {
    lines.push(`**${regressed.length} gated metric(s) moved the wrong way:**`, "");
    for (const row of regressed) {
      lines.push(
        `- ${row.name}: ${row.recorded.toFixed(3)} → ${row.value.toFixed(3)}, threshold ` +
          `${row.direction === "at_least" ? ">=" : "<="} ${row.threshold.toFixed(3)} (n=${row.n})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The recorded score for a finished run: the metric rows, the fixture rows, and
 * the facts that say what they are about. A score without its corpus commit,
 * its reviewer and its date is a number with nothing to compare it to.
 *
 * `runs` is the run file's records, so that `rows` is derived from the same run
 * the metrics were summarised from. Nothing here re-scores that run: each row
 * repeats an answer the harness already wrote, under a name a later delta can
 * join on.
 */
export function recordFrom(summary, runs, { corpus, reviewer, recorded_at, total_cost_usd, cost_basis, note }) {
  return {
    _comment: note,
    recorded_at,
    corpus,
    reviewer,
    suite: "regression",
    repeats: summary.repeats ?? null,
    fixture_count: summary.fixture_count ?? null,
    runs_attempted: summary.runs_attempted ?? null,
    runs_failed: summary.runs_failed ?? null,
    completeness: summary.completeness?.point ?? null,
    not_a_measurement: summary.not_a_measurement ?? null,
    total_cost_usd,
    cost_basis,
    metrics: rowsOf(summary).map((row) => ({ ...row, meets: gateHolds(row) })),
    rows: fixtureRows(summary, runs),
  };
}

/**
 * A result's document with its rows: its own, or the ones derived from the run
 * file beside it when it is a fresh `summary.json` rather than a recorded score.
 *
 * Best effort, where `--record` refuses. A score being recorded now can simply
 * be recorded with its rows, so a missing `runs.json` there is a fault worth
 * stopping for; here it costs the fixture section of one delta, and refusing
 * every run whose output directory was not kept whole would fail pull requests
 * over a section rather than over the reviewer.
 */
function withRows(document, path) {
  if (Array.isArray(document.rows)) return document;
  try {
    return { ...document, rows: fixtureRows(document, readRuns(path)) };
  } catch {
    return document;
  }
}

function main(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const record = argv.includes("--record");
  const summary = argv.includes("--summary");

  if (record && summary) {
    throw new Error("--record writes a score to stdout; there is no delta to summarise");
  }

  if (record) {
    if (positional.length !== 1) {
      throw new Error("Usage: regression-delta.mjs <fresh-result> --record");
    }
    const summary = readResult(positional[0]);
    const runs = readRuns(positional[0]);
    // The facts around the rows are the operator's to supply; this prints the
    // rows and leaves the rest as the nulls a maintainer must fill in, so a
    // score can never claim a corpus commit or a cost nobody stated.
    console.log(
      JSON.stringify(
        recordFrom(summary, runs, {
          corpus: { repository: null, commit: null, date: null },
          reviewer: { model: null, provider: null },
          recorded_at: null,
          total_cost_usd: null,
          cost_basis: null,
          note: null,
        }),
        null,
        2,
      ),
    );
    return 0;
  }

  if (positional.length !== 2) {
    throw new Error("Usage: regression-delta.mjs <fresh-result> <recorded-score> [--summary]");
  }
  const [freshPath, recordedPath] = positional;
  const fresh = withRows(readResult(freshPath), freshPath);
  const recorded = readResult(recordedPath);

  const { rows, regressed } = compare(fresh, recorded);
  const fixtures = compareFixtures(fresh, recorded);
  console.log(
    `regression-delta: ${rows.length} metric(s), against the score recorded on ` +
      `${recorded.recorded_at ?? "an unstated date"} for corpus ${recorded.corpus?.commit ?? "unstated"}.\n`,
  );
  console.log(render(rows));
  console.log(renderFixtures(fixtures));

  // The step summary is written before the exit is decided, so the run that
  // fails is the one whose table a contributor most needs to read. Where the
  // variable is unset — anyone running this by hand — there is no summary page
  // to write to, and the delta above is the whole output, unchanged.
  if (summary) {
    const markdown = renderSummary(rows, {
      regressed,
      recorded,
      not_a_measurement: fresh.not_a_measurement,
    });
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) {
      appendFileSync(stepSummary, markdown);
    } else {
      console.error("\nregression-delta: GITHUB_STEP_SUMMARY is unset, so there is no summary page to append to.");
    }
  }

  // A run the harness itself refuses to call a measurement — a spend ceiling
  // stopped it, or too many reviews produced no artifact — has no gate to
  // report. Its rows are still printed above; what they are not is a pass.
  if (fresh.not_a_measurement) {
    console.error(`\nregression-delta: this run is not a measurement — ${fresh.not_a_measurement}`);
    return 1;
  }

  if (regressed.length === 0) {
    console.log("\nregression-delta: no gated metric is worse than the recorded score.");
    return 0;
  }

  console.error(`\nregression-delta: ${regressed.length} gated metric(s) moved the wrong way:\n`);
  for (const row of regressed) {
    console.error(
      `  ${row.name}: ${row.recorded.toFixed(3)} -> ${row.value.toFixed(3)}, ` +
        `threshold ${row.direction === "at_least" ? ">=" : "<="} ${row.threshold.toFixed(3)} (n=${row.n})`,
    );
  }
  console.error(
    "\nA change to the reviewer carries its regression score. This one moved a gated metric the " +
      "wrong way; say why in the pull request, or fix it.",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`regression-delta: ${error.message}`);
    process.exitCode = 2;
  }
}
