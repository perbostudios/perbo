import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PARTNER_READING_CAVEAT,
  STOP_VERDICTS_SCHEMA_VERSION,
  reconcileStopVerdicts,
  type ObservedStop,
  type StopVerdict,
  type StopVerdicts,
} from "@perbo/contracts";
import { parseStopAnswers } from "@perbo/runner";
import { UsageError } from "../src/args.js";
import type { Streams } from "../src/admit.js";
import { HIDING_WARNING, parseStopsArgs, runStopsCommand } from "../src/stops.js";

/**
 * `perbo stops` over fake stops files: the exact numbers, the interval, and
 * the D-060 rule that precision is never printed without its companion.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-stops-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

const key = (c: string) => c.repeat(64);
const stop = (c: string, answer: "endorse" | "override" | "conflict" | null, at: string): StopVerdict => ({
  finding_key: key(c),
  rule_id: `rule.${c}`,
  routing: "blocks",
  answer,
  answered_at: answer === null ? null : at,
  // What the reconciler attributes an answer to when nothing else signs it.
  answered_by: answer === null ? null : "person",
  first_seen_at: at,
});

const record = (
  n: number,
  at: string,
  stops: StopVerdicts["stops"],
  over: Partial<StopVerdicts> = {},
): StopVerdicts => ({
  schema_version: STOP_VERDICTS_SCHEMA_VERSION,
  ticket_id: `ticket_${n}`,
  ticket_key: `AYO-${n}`,
  pull_request_url: `https://github.com/o/r/pull/${n}`,
  stops,
  shown_to_person: stops.length > 0,
  first_seen_at: at,
  observed_at: at,
  ...over,
});

function store(name: string, records: readonly StopVerdicts[], extra: Record<string, string> = {}): string {
  const repo = join(scratch, name);
  const state = join(repo, ".perbo", "state");
  mkdirSync(state, { recursive: true });
  for (const one of records) {
    writeFileSync(join(state, `${one.ticket_id}.stops.json`), `${JSON.stringify(one, null, 2)}\n`);
  }
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(state, file), body);
  return repo;
}

const D1 = "2026-09-01T00:00:00.000Z";
const D3 = "2026-09-03T00:00:00.000Z";

// AYO-1: endorsed and overridden stops — endorsed, because any endorsed stop
// endorses the change. AYO-2: one overridden, one unanswered, one conflict —
// overridden. AYO-3: a pull request on which nothing was shown.
const three = [
  record(1, D1, [stop("a", "endorse", D1), stop("b", "override", D1)]),
  record(2, D1, [stop("c", "override", D1), stop("d", null, D1), stop("e", "conflict", D1)]),
  record(3, D3, []),
];

describe("perbo stops", () => {
  it("prints precision of stopping beside the companion, as one table", async () => {
    const repo = store("three", three);
    const streams = capture();
    expect(await runStopsCommand({ argv: ["--repo", repo], streams, cwd: repo })).toBe(0);
    const out = streams.out.join("");
    expect(out).toMatch(/precision of stopping\s+50%\s+\[9–91\]\s+2 changes with an answer \(1 endorsed, 1 overridden\)/);
    expect(out).toMatch(/person shown something\s+67%\s+\[21–94\]\s+3 changes with a pull request or a decision \(2 shown\)/);
    expect(out).toMatch(/unanswered stops\s+1\s+5 stops across 3 changes/);
    expect(out).toMatch(/conflicting answers\s+1/);
    expect(out).not.toContain(HIDING_WARNING);
  });

  it("emits the same numbers as JSON", async () => {
    const repo = store("three-json", three);
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo });
    const parsed = JSON.parse(streams.out.join("")) as {
      since: string | null;
      before: null;
      widened_by_hiding: boolean;
      summary: { precision: { point: number; low: number; high: number; n: number }; companion: { n: number }; conflicts: number };
    };
    expect(parsed.since).toBeNull();
    expect(parsed.before).toBeNull();
    expect(parsed.widened_by_hiding).toBe(false);
    expect(parsed.summary.precision.n).toBe(2);
    expect(parsed.summary.precision.point).toBe(0.5);
    expect(parsed.summary.precision.low).toBeCloseTo(0.0945, 3);
    expect(parsed.summary.precision.high).toBeCloseTo(0.9055, 3);
    expect(parsed.summary.companion.n).toBe(3);
    expect(parsed.summary.conflicts).toBe(1);
  });

  it("says so when precision rose while fewer people were shown anything (--since)", async () => {
    const repo = store("since-widened", [
      record(1, D1, [stop("a", "override", D1)]),
      record(2, D1, [stop("b", "endorse", D1)]),
      record(3, D3, [stop("c", "endorse", D3)]),
      record(4, D3, []),
    ]);
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--since", "2026-09-02"], streams, cwd: repo });
    const out = streams.out.join("");
    expect(out).toMatch(/precision of stopping\s+100%/);
    expect(out).toContain("before it: precision 50% [9–91] n=2 · shown 100% [34–100] n=2");
    expect(out).toContain(HIDING_WARNING);
  });

  it("stays quiet under --since when the companion did not fall", async () => {
    const repo = store("since-quiet", three);
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--since=2026-09-02T00:00:00Z"], streams, cwd: repo });
    expect(streams.out.join("")).not.toContain(HIDING_WARNING);
    expect(streams.out.join("")).toContain("before it: precision 50% [9–91] n=2");
  });

  it("names an unreadable file and counts the rest", async () => {
    const repo = store("unreadable", three, { "ticket_bad.stops.json": "{not json" });
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo], streams, cwd: repo });
    expect(streams.err.join("")).toContain("ticket_bad.stops.json");
    expect(streams.out.join("")).toMatch(/3 changes with a pull request or a decision/);
  });

  it("says where to start when nothing has been synced", async () => {
    const repo = store("empty", []);
    const streams = capture();
    expect(await runStopsCommand({ argv: ["--repo", repo], streams, cwd: repo })).toBe(0);
    expect(streams.out.join("")).toMatch(/precision of stopping\s+—/);
    expect(streams.err.join("")).toContain("perbo sync");
  });

  it("refuses a --since that is not a date, and an option it does not know", () => {
    expect(() => parseStopsArgs(["--since", "yesterday"])).toThrow(UsageError);
    expect(() => parseStopsArgs(["--all"])).toThrow(UsageError);
    expect(parseStopsArgs(["--since", "2026-09-02"]).since).toBe("2026-09-02T00:00:00.000Z");
  });
});

/**
 * SCP-206: `--arm` reads the unattended row per arm.
 *
 * The registration's first metric is "unattended merges, 20 tickets, per arm",
 * and the two arms' records live side by side in one store — so without a
 * filter the printed share is a number about both at once, which is not the
 * number the registration asks for. The default is unchanged: no flag reads
 * every ticket, exactly as it did.
 */
describe("stops --arm reads the unattended row for one arm", () => {
  const mergedTicket = (n: number, arm: "loop" | "direct", outside: boolean) => ({
    schema_version: 1,
    ticket_id: `ticket_0${n}abcdef`,
    key: `AYO-${n}`,
    title: "Search results are paginated.",
    state: "merged",
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: `plan_0${n}abcdef`,
    plan_version: 1,
    approved_at: D1,
    admitted_at: D1,
    updated_at: D3,
    admission: { elapsed_ms: 10, criteria_source: "typed", criteria_count: 1 },
    delivery: {
      branch: arm === "direct" ? `direct/perbo-${n}/paging` : `ayo/AYO-${n}/paging`,
      pull_request_url: `https://github.com/o/r/pull/${n}`,
      pull_request_number: n,
      state: "merged",
      observed_at: D3,
      opened_by: arm,
      mergeable: null,
      commits_outside_loop: outside,
      github_credential: null,
      arm,
    },
    history: [
      { at: D1, from: null, to: "plan_review", note: "admitted" },
      { at: D3, from: "pr_open", to: "merged", note: "merged" },
    ],
  });

  /** Two arms in one store: the loop's merge attended, the direct arm's not. */
  const twoArms = (name: string): string => {
    const repo = store(name, []);
    const tickets = join(repo, ".perbo", "tickets");
    mkdirSync(tickets, { recursive: true });
    writeFileSync(join(tickets, "AYO-1.json"), `${JSON.stringify(mergedTicket(1, "loop", true), null, 2)}\n`);
    writeFileSync(join(tickets, "AYO-2.json"), `${JSON.stringify(mergedTicket(2, "direct", false), null, 2)}\n`);
    return repo;
  };

  const read = async (repo: string, argv: readonly string[]) => {
    const streams = capture();
    const code = await runStopsCommand({
      argv: ["--repo", repo, "--json", ...argv],
      streams,
      cwd: repo,
    });
    return { code, json: JSON.parse(streams.out.join("")) as {
      unattended_merges: { merged: number; unattended: number; attended: number };
      arm?: string | null;
    } };
  };

  it("reads only the direct arm's merges under --arm direct", async () => {
    const { json } = await read(twoArms("arm-direct"), ["--arm", "direct"]);
    expect(json.unattended_merges.merged).toBe(1);
    expect(json.unattended_merges.unattended).toBe(1);
    expect(json.unattended_merges.attended).toBe(0);
    expect(json.arm).toBe("direct");
  });

  it("reads only the loop's under --arm loop", async () => {
    const { json } = await read(twoArms("arm-loop"), ["--arm", "loop"]);
    expect(json.unattended_merges.merged).toBe(1);
    expect(json.unattended_merges.unattended).toBe(0);
    expect(json.unattended_merges.attended).toBe(1);
  });

  it("reads every ticket with no flag, exactly as it did", async () => {
    const { json } = await read(twoArms("arm-none"), []);
    expect(json.unattended_merges.merged).toBe(2);
    expect(json.arm ?? null).toBeNull();
  });

  it("refuses an arm that is not one of the two", () => {
    expect(() => parseStopsArgs(["--arm", "codex"])).toThrow(UsageError);
  });
});

/* ------------------------------------------------------------------ *
 * The bar the two numbers are read against, and the population they
 * are read over.
 * ------------------------------------------------------------------ */

/** A finding key: 64 hex characters, distinct per change. */
const hexKey = (n: number): string => n.toString(16).padStart(64, "0");

/** One change, answered by whoever each of its stops names, through the writer `sync` uses. */
const change = (n: number, observed: readonly ObservedStop[]): StopVerdicts =>
  reconcileStopVerdicts({
    previous: null,
    ticket: { ticket_id: `ticket_${String(n).padStart(4, "0")}`, key: `AYO-${n}` },
    pull_request_url: `https://github.com/o/r/pull/${n}`,
    observed,
    observed_at: "2026-09-05T09:00:00.000Z",
  });

const answeredStop = (n: number, answer: "endorse" | "override", by?: "person" | "stand_in"): ObservedStop => ({
  finding_key: hexKey(n),
  rule_id: "auth.token_never_expires",
  routing: "blocks",
  answer,
  ...(by === undefined ? {} : { answered_by: by }),
});

const read = async (name: string, records: readonly StopVerdicts[]): Promise<string> => {
  const repo = store(name, records);
  const streams = capture();
  expect(await runStopsCommand({ argv: ["--repo", repo], streams, cwd: repo })).toBe(0);
  return streams.out.join("");
};

/**
 * `perbo stops` judged against D-060's bar.
 *
 * The bar is ≥70% of stops endorsed with the 95% Wilson interval wholly on one
 * side of it, read at live n. Nine unanimous endorsed stops is the smallest
 * population whose lower bound clears it, so below a population that could
 * resolve a pass the command says the reading cannot resolve rather than
 * printing one — and a population that could resolve one and does not is a
 * fail, whether its interval sits below the bar or spans it.
 *
 * Every record here is written by `reconcileStopVerdicts`, the same function
 * `perbo sync` writes the store's records with. What is asserted is the text
 * the command prints.
 */
describe("the reading against D-060's bar", () => {
  /** `endorsed` of `n` changes, each with one stop a person answered. */
  const population = (n: number, endorsed: number): StopVerdicts[] =>
    Array.from({ length: n }, (_, index) =>
      change(index + 1, [answeredStop(index + 1, index < endorsed ? "endorse" : "override")]),
    );

  it("passes on nine unanimous stops, whose interval resolves wholly at or above 70%", async () => {
    const out = await read("d060-pass", population(9, 9));
    expect(out).toMatch(/precision of stopping\s+100%\s+\[70–100\]\s+9 changes with an answer \(9 endorsed, 0 overridden\)/);
    expect(out).toContain("D-060 bar (precision of stopping ≥70%): PASS");
    expect(out).toContain("resolves wholly at or above 70%");
    expect(out).toContain("n=9 changes with a partner answer");
  });

  it("does not pass a larger population whose interval spans 70%", async () => {
    // 8 of 10 endorsed: 80% [49–94], which covers the bar without clearing it.
    const out = await read("d060-straddle", population(10, 8));
    expect(out).toMatch(/precision of stopping\s+80%\s+\[49–94\]/);
    expect(out).toContain("D-060 bar (precision of stopping ≥70%): FAIL");
    expect(out).toContain("spans 70% rather than resolving at or above it");
    expect(out).not.toContain("PASS");
  });

  it("fails a population whose interval resolves wholly below 70%", async () => {
    const out = await read("d060-fail", population(12, 4));
    expect(out).toContain("D-060 bar (precision of stopping ≥70%): FAIL");
    expect(out).toContain("resolves wholly below 70%");
    expect(out).not.toContain("PASS");
  });

  it("cannot resolve below nine unanimous stops, and prints no pass", async () => {
    const out = await read("d060-small", population(5, 5));
    expect(out).toContain("D-060 bar (precision of stopping ≥70%): CANNOT RESOLVE");
    expect(out).toContain(
      "below the 9 unanimous endorsed stops that are the smallest population whose 95% Wilson " +
        "lower bound clears 70%",
    );
    expect(out).not.toContain("PASS");
    expect(out).not.toContain("FAIL");
    // The numbers are still printed: what cannot resolve is the verdict, not
    // the reading, and precision is never shown without its companion.
    expect(out).toMatch(/precision of stopping\s+100%\s+\[57–100\]\s+5 changes with an answer \(5 endorsed, 0 overridden\)/);
    expect(out).toMatch(/person shown something\s+100%\s+\[57–100\]\s+5 changes with a pull request or a decision \(5 shown\)/);
  });

  it("says so on an empty store rather than passing or failing nothing", async () => {
    const out = await read("d060-empty", []);
    expect(out).toContain("D-060 bar (precision of stopping ≥70%): CANNOT RESOLVE");
    expect(out).toContain("n=0 changes with a partner answer");
  });

  it("carries the same verdict in --json", async () => {
    const repo = store("d060-json", population(9, 9));
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo });
    const parsed = JSON.parse(streams.out.join("")) as {
      d060: { verdict: string; bar: number; resolving_n: number; spans_bar: boolean };
    };
    expect(parsed.d060).toMatchObject({ verdict: "pass", bar: 0.7, resolving_n: 9, spans_bar: false });
  });
});

/**
 * A stop the AI stand-in answered is dogfood, and no number reported as a
 * partner's contains it (D-058). What the label cannot do is printed beside
 * what it did: it is self-declared, so an unsigned tick is counted as a
 * person's and the partner n is an upper bound.
 */
describe("perbo stops excludes dogfood answers from the partner reading", () => {
  /** One change with a stop per answer, each naming who gave it. */
  const mixedChange = (
    n: number,
    answers: ReadonlyArray<["endorse" | "override", "person" | "stand_in"]>,
  ): StopVerdicts =>
    change(
      n,
      answers.map(([answer, by], index) => ({ ...answeredStop(n * 100 + index, answer, by) })),
    );

  /**
   * Six changes: two a person endorsed, one a person overrode, two the stand-in
   * answered alone, and one where the stand-in endorsed and a person overrode —
   * which is a partner override, because only the person's answer is read.
   */
  const mixed = [
    mixedChange(1, [["endorse", "person"]]),
    mixedChange(2, [["endorse", "person"]]),
    mixedChange(3, [["override", "person"]]),
    mixedChange(4, [["endorse", "stand_in"]]),
    mixedChange(5, [["endorse", "stand_in"]]),
    mixedChange(6, [
      ["endorse", "stand_in"],
      ["override", "person"],
    ]),
  ];

  /**
   * The two task-list lines one stop carries in a pull-request body, with the
   * answered box ticked and the line signed as the argument says.
   *
   * Written as body text and read back by `parseStopAnswers` — the same reader
   * `perbo sync` uses on what `gh` returns — because the question below is
   * what a body can do to a reading, and a body is where the answer is.
   */
  const stopLines = (finding_key: string, answer: "endorse" | "override", by: "unsigned" | "stand_in") =>
    (["endorse", "override"] as const)
      .map((box) => {
        const marker = `<!-- perbo:stop key=${finding_key} answer=${box} rule=auth.token_never_expires routing=blocks -->`;
        const signature = box !== answer || by === "unsigned" ? "" : ` <!-- perbo:answered-by who=${by} -->`;
        return `- [${box === answer ? "x" : " "}] ${box} this ${marker}${signature}`;
      })
      .join("\n");

  /**
   * Twelve changes, four endorsed and eight overridden — a population whose
   * interval resolves wholly below the bar, so it is a reading that fails
   * rather than one that could not be taken. Every tick is signed as the
   * argument says, and nothing else about the two runs differs.
   */
  const signedPopulation = (by: "unsigned" | "stand_in"): StopVerdicts[] =>
    Array.from({ length: 12 }, (_, index) =>
      change(index + 1, parseStopAnswers(stopLines(hexKey(index + 1), index < 4 ? "endorse" : "override", by))),
    );

  it("counts only the changes a person answered, and says how many stops it left out", async () => {
    const out = await read("dogfood-mixed", mixed);

    // Four changes with a person's answer — 1, 2, 3 and 6 — of which two are
    // endorsed. Not six, and not the 4 of 6 the pooled answers would give.
    expect(out).toMatch(/precision of stopping\s+50%\s+.*4 changes with an answer \(2 endorsed, 2 overridden\)/);
    // Three stops the stand-in answered, two of them the only answer their
    // change had.
    expect(out).toMatch(
      /dogfood stops excluded\s+3\s+answered by an AI stand-in, outside the partner reading \(D-058\); 2 changes left the precision population with them/,
    );
    expect(out).toContain("3 dogfood stops excluded");
  });

  it("says the partner n is an upper bound, because the label is self-declared", async () => {
    const out = await read("dogfood-caveat", mixed);
    expect(out).toContain(PARTNER_READING_CAVEAT);
    expect(out).toContain("n is an upper bound on the answers a person gave, not a guarantee");
  });

  it("qualifies a store nobody stood in for too, where an unsigned tick is the whole population", async () => {
    const out = await read("dogfood-none", [
      mixedChange(1, [["endorse", "person"]]),
      mixedChange(2, [["override", "person"]]),
    ]);
    expect(out).toMatch(/precision of stopping\s+50%\s+.*2 changes with an answer \(1 endorsed, 1 overridden\)/);
    // The row stands at zero — "none were excluded" is the thing a reader of a
    // partner number needs told — and says nothing about changes it took out.
    expect(out).toMatch(/dogfood stops excluded\s+0\s+answered by an AI stand-in, outside the partner reading \(D-058\)$/m);
    expect(out).not.toContain("left the precision population");
    expect(out).not.toContain("dogfood stops excluded,");
    // The caveat is about every partner number, not only the ones something was
    // taken out of: a store with no dogfood answers may be one nobody signed.
    expect(out).toContain(PARTNER_READING_CAVEAT);
  });

  it("prints no caveat where there is no partner number to overstate", async () => {
    expect(await read("dogfood-empty", [])).not.toContain(PARTNER_READING_CAVEAT);
  });

  it("says what the exclusion cost, where signing the whole population is what left the reading unresolved", async () => {
    // The label is read off a pull-request body, which anyone with write access
    // to the pull request can edit — the loop included. Signing every tick as
    // the stand-in's empties the partner population, and an emptied population
    // reads as CANNOT RESOLVE: exactly what a bar nobody has reached yet looks
    // like, and the opposite of what happened. So the line says which it is.
    const out = await read("dogfood-signed-away", signedPopulation("stand_in"));

    expect(out).toContain("D-060 bar (precision of stopping ≥70%): CANNOT RESOLVE");
    expect(out).toContain("n=0 changes with a partner answer, 12 dogfood stops excluded");
    expect(out).toContain(
      "the exclusion is what makes this CANNOT RESOLVE rather than FAIL: with the 12 dogfood " +
        "answers pooled back in — which would not be a partner reading, and is read here only to " +
        "say what the exclusion did — n would be 12.",
    );
    // And the caveat is printed at n=0 here, where the previous reading had
    // nothing to qualify: an emptied population is the reading a person most
    // needs told that the label can be claimed as well as earned.
    expect(out).toContain(PARTNER_READING_CAVEAT);
    expect(out).toContain("whoever can edit the body can sign ticks out of the partner population");
  });

  it("reads the same answers unsigned as the failure they are", async () => {
    // The control for the case above: identical ticks, identical answers, no
    // signatures. The bar resolves and it resolves against the loop — which is
    // what the signed reading would otherwise have hidden behind "not yet".
    const out = await read("dogfood-signed-control", signedPopulation("unsigned"));

    expect(out).toContain("D-060 bar (precision of stopping ≥70%): FAIL");
    expect(out).toContain("resolves wholly below 70%");
    expect(out).toContain("n=12 changes with a partner answer");
    expect(out).not.toContain("the exclusion is what makes this");
    expect(out).toMatch(/dogfood stops excluded\s+0\s/);
  });

  it("says so where excluding the stand-in's answers is what makes the reading a pass", async () => {
    // The other way the same removal moves a verdict, and the one that matters
    // most for a bar somebody wants to report as met: nine changes a person
    // endorsed pass on their own, and four the stand-in overrode are gone from
    // the population that produced the pass. The label removes answers; which
    // answers it removes decides which way the verdict moves.
    const out = await read("dogfood-passes-by-exclusion", [
      ...Array.from({ length: 9 }, (_, index) =>
        change(index + 1, [answeredStop(index + 1, "endorse", "person")]),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        change(index + 10, [answeredStop(index + 10, "override", "stand_in")]),
      ),
    ]);

    expect(out).toContain("D-060 bar (precision of stopping ≥70%): PASS");
    expect(out).toContain("n=9 changes with a partner answer, 4 dogfood stops excluded");
    expect(out).toContain(
      "the exclusion is what makes this PASS rather than FAIL: with the 4 dogfood answers pooled " +
        "back in — which would not be a partner reading, and is read here only to say what the " +
        "exclusion did — n would be 13.",
    );
  });

  it("carries the pooled counterfactual, named as no partner reading, in --json", async () => {
    const repo = store("dogfood-signed-json", signedPopulation("stand_in"));
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo });
    const parsed = JSON.parse(streams.out.join("")) as {
      d060: { verdict: string };
      d060_pooling_dogfood: { verdict: string; interval: { n: number } };
      summary: { precision: { n: number }; pooled_precision: { n: number; successes: number } };
    };
    expect(parsed.d060.verdict).toBe("cannot resolve");
    expect(parsed.summary.precision.n).toBe(0);
    // The population as it stood before the exclusion, and the verdict it
    // carried: four endorsed of twelve, which fails the bar rather than
    // failing to reach it.
    expect(parsed.summary.pooled_precision).toMatchObject({ n: 12, successes: 4 });
    expect(parsed.d060_pooling_dogfood).toMatchObject({ verdict: "fail", interval: { n: 12 } });
  });

  it("reports the same population, and the same caveat, in --json", async () => {
    const repo = store("dogfood-json", mixed);
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo });
    const parsed = JSON.parse(streams.out.join("")) as {
      partner_reading_caveat: string;
      summary: {
        precision: { n: number; successes: number };
        dogfood_stops: number;
        dogfood_changes: number;
        stops: number;
      };
    };
    expect(parsed.summary.precision.n).toBe(4);
    expect(parsed.summary.precision.successes).toBe(2);
    expect(parsed.summary.dogfood_stops).toBe(3);
    expect(parsed.summary.dogfood_changes).toBe(2);
    // Nothing was dropped from the record's own diagnostics: seven stops exist
    // and seven are counted, whoever answered them.
    expect(parsed.summary.stops).toBe(7);
    expect(parsed.partner_reading_caveat).toBe(PARTNER_READING_CAVEAT);
  });
});
