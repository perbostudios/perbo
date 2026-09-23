import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PARTNER_READING_CAVEAT, STOP_VERDICTS_SCHEMA_VERSION, type StopVerdicts } from "@perbo/contracts";
import { HIDING_WARNING, stopsCommandLine, weekHidingWarning } from "./stops.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

/**
 * `perbo stops --by-week` over fake stops files: the weeks the table prints,
 * the week nothing fell in, the widening test read between consecutive weeks,
 * the ISO week-year around New Year — and, because the flag is an addition and
 * not a change, the byte-for-byte output of a `--since` run without it.
 *
 * Every case runs the command over files on disk and reads what it printed;
 * the clock is passed in so "through the current week" is a fixed range.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-stops-week-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const key = (c: string) => c.repeat(64);
const stop = (
  c: string,
  answer: "endorse" | "override" | null,
  at: string,
  by: "person" | "stand_in" = "person",
) => ({
  finding_key: key(c),
  rule_id: `rule.${c}`,
  routing: "blocks" as const,
  answer,
  answered_at: answer === null ? null : at,
  answered_by: answer === null ? null : by,
  first_seen_at: at,
});

const record = (n: number, at: string, stops: StopVerdicts["stops"]): StopVerdicts => ({
  schema_version: STOP_VERDICTS_SCHEMA_VERSION,
  ticket_id: `ticket_${n}`,
  ticket_key: `AYO-${n}`,
  pull_request_url: `https://github.com/o/r/pull/${n}`,
  stops,
  shown_to_person: stops.length > 0,
  first_seen_at: at,
  observed_at: at,
});

function store(name: string, records: readonly StopVerdicts[]): string {
  const repo = join(scratch, name);
  const state = join(repo, ".perbo", "state");
  mkdirSync(state, { recursive: true });
  for (const one of records) {
    writeFileSync(join(state, `${one.ticket_id}.stops.json`), `${JSON.stringify(one, null, 2)}\n`);
  }
  return repo;
}

async function run(repo: string, argv: readonly string[], now: string): Promise<{ out: string; err: string; code: number }> {
  const streams = recordStreams();
  const code = await runCommandLine(stopsCommandLine, { argv: ["--repo", repo, ...argv], streams, cwd: repo, now: new Date(now) });
  return { out: streams.out(), err: streams.err(), code };
}

/** The per-week table as cells: the header row, one row per week, then the total. */
function weekTable(out: string): string[][] {
  const lines = out.split("\n");
  const start = lines.findIndex((line) => line.startsWith("week "));
  expect(start, `no per-week table in:\n${out}`).toBeGreaterThan(-1);
  const blank = lines.indexOf("", start);
  return lines.slice(start, blank === -1 ? undefined : blank).map((line) => line.split(/ {2,}/));
}

/** A week-pair warning names the two weeks it read; the total's own carries no pair. */
const WEEK_PAIR_WARNING = /^warning \d{4}-W\d{2} → /;

/** The same output with the per-week table and the week-pair warnings taken back out. */
function withoutWeeks(out: string): string {
  const lines = out.split("\n");
  const start = lines.findIndex((line) => line.startsWith("week "));
  const blank = lines.indexOf("", start);
  return [...lines.slice(0, start - 1), ...lines.slice(blank)]
    .filter((line) => !WEEK_PAIR_WARNING.test(line))
    .join("\n");
}

// Tuesday of ISO weeks 2026-W31 … 2026-W35.
const W31 = "2026-07-28T00:00:00.000Z";
const W32 = "2026-08-04T00:00:00.000Z";
const W33 = "2026-08-11T00:00:00.000Z";
const W34 = "2026-08-18T00:00:00.000Z";
const W35 = "2026-08-25T00:00:00.000Z";

describe("perbo stops --by-week", () => {
  it("prints every week in the window, in the total's columns, and n=0 for the week nothing fell in", async () => {
    // Three changes in three weeks, with 2026-W33 empty between them.
    const repo = store("gap", [
      record(1, W32, [stop("a", "endorse", W32)]),
      record(2, W34, [stop("b", "override", W34)]),
      record(3, W35, [stop("c", "endorse", W35)]),
    ]);
    const { out } = await run(repo, ["--since", "2026-08-03", "--by-week"], "2026-08-26T00:00:00.000Z");
    const [header, ...rows] = weekTable(out);

    expect(header).toEqual([
      "week",
      "precision of stopping",
      "95% Wilson",
      "n",
      "person shown something",
      "dogfood excluded",
    ]);
    expect(rows.map((row) => row[0])).toEqual(["2026-W32", "2026-W33", "2026-W34", "2026-W35", "total"]);
    // The empty week is present and says so, rather than going missing.
    expect(rows[1]).toEqual(["2026-W33", "—", "—", "0", "— (n=0)", "0"]);
    expect(rows[0]).toEqual(["2026-W32", "100%", "[21–100]", "1", "100% (n=1)", "0"]);
    expect(rows[2]).toEqual(["2026-W34", "0%", "[0–79]", "1", "100% (n=1)", "0"]);
    expect(rows[3]).toEqual(["2026-W35", "100%", "[21–100]", "1", "100% (n=1)", "0"]);

    // Same column shape as the total row, which carries the window's figures.
    const total = rows.at(-1)!;
    expect(total).toEqual(["total", "67%", "[21–94]", "3", "100% (n=3)", "0"]);
    for (const row of rows) expect(row).toHaveLength(total.length);
    expect(out).toMatch(/precision of stopping\s+67%\s+\[21–94\]\s+3 changes with an answer \(2 endorsed, 1 overridden\)/);
  });

  it("runs from the first change through the current week when there is no --since", async () => {
    const repo = store("no-since", [
      record(1, W32, [stop("a", "endorse", W32)]),
      record(2, W34, [stop("b", "endorse", W34)]),
    ]);
    const { out } = await run(repo, ["--by-week"], "2026-08-25T12:00:00.000Z");
    const [, ...rows] = weekTable(out);
    expect(rows.map((row) => row[0])).toEqual(["2026-W32", "2026-W33", "2026-W34", "2026-W35", "total"]);
  });

  it("reads the widening test between consecutive weeks, and leaves the total and the before-window alone", async () => {
    // Before the window: 1 of 2 endorsed, both shown. 2026-W32: 1 of 2
    // endorsed, both shown. 2026-W33: the only answer is an endorsement and
    // one of the two changes was shown nothing — precision up, companion down.
    const records = [
      record(1, W31, [stop("a", "override", W31)]),
      record(2, W31, [stop("b", "endorse", W31)]),
      record(3, W32, [stop("c", "endorse", W32)]),
      record(4, W32, [stop("d", "override", W32)]),
      record(5, W33, [stop("e", "endorse", W33)]),
      record(6, W33, []),
    ];
    const repo = store("widening", records);
    const argv = ["--since", "2026-08-03"];
    const { out } = await run(repo, [...argv, "--by-week"], "2026-08-12T00:00:00.000Z");

    expect(out).toContain(weekHidingWarning("2026-W32", "2026-W33"));
    // One pair trips it, and only that pair.
    expect(out.split("\n").filter((line) => WEEK_PAIR_WARNING.test(line))).toEqual([
      weekHidingWarning("2026-W32", "2026-W33"),
    ]);

    const [, ...rows] = weekTable(out);
    expect(rows).toEqual([
      ["2026-W32", "50%", "[9–91]", "2", "100% (n=2)", "0"],
      ["2026-W33", "100%", "[21–100]", "1", "50% (n=2)", "0"],
      ["total", "67%", "[21–94]", "3", "75% (n=4)", "0"],
    ]);

    // Everything the flag did not add is what the flag-less run prints.
    const plain = await run(store("widening-plain", records), argv, "2026-08-12T00:00:00.000Z");
    expect(withoutWeeks(out)).toBe(plain.out);
    expect(plain.out).toContain("before it: precision 50% [9–91] n=2 · shown 100% [34–100] n=2");
    expect(plain.out).toContain(HIDING_WARNING);
  });

  it("stays quiet between two weeks the companion did not fall between", async () => {
    const repo = store("quiet", [
      record(1, W32, [stop("a", "override", W32)]),
      record(2, W33, [stop("b", "endorse", W33)]),
    ]);
    const { out } = await run(repo, ["--since", "2026-08-03", "--by-week"], "2026-08-12T00:00:00.000Z");
    // Precision rose, 0% to 100%, but a person was shown something on both.
    expect(out.split("\n").filter((line) => WEEK_PAIR_WARNING.test(line))).toEqual([]);
  });

  it("keys the JSON weeks by ISO week-year across 31 December, and prints the same figures", async () => {
    // 2025-12-29 is the Monday of ISO week 2026-W01: two of these three
    // changes are in the same week and in different calendar years.
    const DEC = "2025-12-30T00:00:00.000Z";
    const JAN = "2026-01-01T00:00:00.000Z";
    const NEXT = "2026-01-05T00:00:00.000Z";
    const records = [
      record(1, DEC, [stop("a", "endorse", DEC)]),
      record(2, JAN, [stop("b", "endorse", JAN)]),
      record(3, NEXT, [stop("c", "override", NEXT)]),
    ];
    const argv = ["--since", "2025-12-29", "--by-week"];
    const now = "2026-01-06T00:00:00.000Z";
    const { out } = await run(store("boundary-json", records), [...argv, "--json"], now);
    const parsed = JSON.parse(out) as {
      weeks: {
        week: string;
        starts_at: string;
        ends_at: string;
        summary: { precision: { point: number; n: number }; companion: { point: number; n: number } };
        widened_by_hiding: boolean;
      }[];
    };

    expect(parsed.weeks.map((week) => week.week)).toEqual(["2026-W01", "2026-W02"]);
    expect(parsed.weeks[0]).toMatchObject({
      week: "2026-W01",
      starts_at: "2025-12-29T00:00:00.000Z",
      ends_at: "2026-01-05T00:00:00.000Z",
      widened_by_hiding: false,
    });
    expect(parsed.weeks[0]!.summary.precision).toMatchObject({ point: 1, n: 2 });
    expect(parsed.weeks[0]!.summary.companion).toMatchObject({ point: 1, n: 2 });
    expect(parsed.weeks[1]!.summary.precision).toMatchObject({ point: 0, n: 1 });
    expect(parsed.weeks[1]!.summary.companion).toMatchObject({ point: 1, n: 1 });

    // The table says the same thing about the same weeks.
    const table = await run(store("boundary-table", records), argv, now);
    const [, ...rows] = weekTable(table.out);
    expect(rows).toEqual([
      ["2026-W01", "100%", "[34–100]", "2", "100% (n=2)", "0"],
      ["2026-W02", "0%", "[0–79]", "1", "100% (n=1)", "0"],
      ["total", "67%", "[21–94]", "3", "100% (n=3)", "0"],
    ]);
  });

  it("prints the total on its own when nothing has been synced yet", async () => {
    const { out, err, code } = await run(store("nothing", []), ["--by-week"], "2026-08-26T00:00:00.000Z");
    expect(code).toBe(0);
    expect(weekTable(out)).toEqual([
      ["week", "precision of stopping", "95% Wilson", "n", "person shown something", "dogfood excluded"],
      ["total", "—", "—", "0", "— (n=0)", "0"],
    ]);
    expect(err).toContain("perbo sync");
  });

  /**
   * D-NEW-stand-in-dogfood, per week and before the window: every precision this command prints
   * is a partner reading, so every one of them says what it left out. A week's
   * `n` that fell because the stand-in answered four of its stops is a week
   * whose `n` fell for a reason, and the reason is a column rather than a
   * subtraction the reader has to guess at.
   */
  it("names the stand-in's stops per week and before the window, beside each n they left", async () => {
    const records = [
      // Before the window: one answer each, one of them the stand-in's.
      record(1, W31, [stop("a", "endorse", W31)]),
      record(2, W31, [stop("b", "endorse", W31, "stand_in")]),
      // 2026-W32: a person's endorsement, and two changes only the stand-in
      // answered — which leave the week's precision at n=1.
      record(3, W32, [stop("c", "endorse", W32)]),
      record(4, W32, [stop("d", "override", W32, "stand_in")]),
      record(5, W32, [stop("e", "endorse", W32, "stand_in")]),
      // 2026-W33: a person's override, and nothing excluded.
      record(6, W33, [stop("f", "override", W33)]),
    ];
    const { out } = await run(
      store("dogfood-weeks", records),
      ["--since", "2026-08-03", "--by-week"],
      "2026-08-12T00:00:00.000Z",
    );
    const [, ...rows] = weekTable(out);

    // 2026-W32 reads one change with a partner answer out of three, and says
    // the two stops that are not in it; the total says both of them again.
    expect(rows).toEqual([
      ["2026-W32", "100%", "[21–100]", "1", "100% (n=3)", "2"],
      ["2026-W33", "0%", "[0–79]", "1", "100% (n=1)", "0"],
      ["total", "50%", "[9–91]", "2", "100% (n=4)", "2"],
    ]);

    // The window before `--since` is a partner reading of its own: one of its
    // two answers was the stand-in's, and the line it prints on says so.
    expect(out).toContain(
      "before it: precision 100% [21–100] n=1 · shown 100% [34–100] n=2 · 1 dogfood stop excluded",
    );
  });

  it("takes --by-week as a flag, in either position", () => {
    expect(stopsCommandLine.read(["--by-week"]).input.byWeek).toBe(true);
    expect(stopsCommandLine.read(["--by-week", "--since", "2026-09-02"]).input).toMatchObject({
      byWeek: true,
      since: "2026-09-02T00:00:00.000Z",
    });
    expect(stopsCommandLine.read(["--since", "2026-09-02"]).input.byWeek).toBe(false);
  });

  it("prints, for --since without --by-week, exactly the bytes it printed before the flag existed", async () => {
    const repo = store("unchanged", [
      record(1, W31, [stop("a", "override", W31)]),
      record(2, W31, [stop("b", "endorse", W31)]),
      record(3, W32, [stop("c", "endorse", W32)]),
      record(4, W32, [stop("d", "override", W32)]),
      record(5, W33, [stop("e", "endorse", W33)]),
      record(6, W33, []),
    ]);
    const { out } = await run(repo, ["--since", "2026-08-03"], "2026-08-12T00:00:00.000Z");
    expect(out).toBe(
      "metric                     value  95% Wilson  n\n" +
        "precision of stopping      67%    [21–94]     3 changes with an answer (2 endorsed, 1 overridden)\n" +
        "person shown something     75%    [30–95]     4 changes with a pull request or a decision (3 shown)\n" +
        "unanswered stops           0                  3 stops across 4 changes\n" +
        "conflicting answers        0                  both boxes ticked\n" +
        "dogfood stops excluded     0                  answered by an AI stand-in, outside the " +
        "partner reading (D-NEW-stand-in-dogfood)\n" +
        // This store has no ticket store beside its stops records, so SCP-196's
        // and SCP-202's rows read n=0 — the flag under test still changed none
        // of the bytes above them, which is what this test is for.
        "unattended merges          —      —           0 merged tickets with a known answer (0 unattended, 0 attended)\n" +
        "cost per merged ticket     —                  0 merged tickets, 0 attempts, 0 cost components (0 priced)\n" +
        "merges the loop performed  0                  0 of 0 merged tickets\n" +
        "loop merges undone (14d)   0                  0 of the loop's merges with the window closed " +
        "(0 reverted, 0 same path re-touched)\n" +
        // Three changes cannot resolve the bar either way, which the line says
        // instead of printing a verdict this population could not carry.
        "D-060 bar (precision of stopping ≥70%): CANNOT RESOLVE — n=3 changes with a partner " +
        "answer, below the 9 unanimous endorsed stops that are the smallest population whose 95% " +
        "Wilson lower bound clears 70%. This reading neither passes nor fails the bar; it is not " +
        "yet a reading.\n" +
        // …and what the exclusion above it cannot promise, because the label is
        // self-declared in both directions and n=3 is a number somebody could
        // quote. The sentence is the one constant every surface prints, so this
        // golden fixes where it goes rather than restating it.
        `  ${PARTNER_READING_CAVEAT}\n` +
        "\n" +
        "since 2026-08-03T00:00:00.000Z; before it: precision 50% [9–91] n=2 · shown 100% [34–100] n=2\n" +
        "warning: precision of stopping rose while the share of changes on which a person was shown " +
        "something fell — the gate widened by hiding findings, not by measuring better.\n",
    );
  });
});
