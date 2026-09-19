import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E1LedgerSchema, type E1Ledger } from "@perbo/contracts";
import { UsageError } from "../src/args.js";
import { runBaselineCommand } from "../src/baseline.js";
import { parseE1Args } from "../src/e1.js";

/**
 * `perbo baseline open | time | seal | run | routing | result` end to end
 * (D-038, SCP-080).
 *
 * The harness is machinery a person types at, and the four things it has to
 * get right are all about order: ten before a seal, a seal before a product
 * run, thresholds before a measurement, and the stand-in's arm beside a
 * partner's rather than inside it. So these run the commands in the order a
 * partner's month actually goes, and assert on what the file holds and what
 * the person is told — a unit test of the rules is in
 * `packages/contracts/test/e1.test.ts`.
 *
 * Fail-first, measured 2026-09-05: with `apps/cli/src/e1.ts` moved out of the
 * tree this file does not collect.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-e1-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();

function repo(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function cli(dir: string, argv: string[], when: Date = at(10_000), isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBaselineCommand({
    argv: [...argv, "--repo", dir],
    streams: { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY },
    cwd: dir,
    now: () => when,
  });
  return { code, out: out.join(""), err: err.join("") };
}

const ledgerOf = (dir: string): E1Ledger =>
  E1LedgerSchema.parse(JSON.parse(readFileSync(join(dir, ".perbo", "e1.json"), "utf8")));

const OPEN = [
  "open",
  "--partner",
  "acme",
  "--agreed-on",
  "2026-08-25",
  "--agreed-with",
  "Rae Okonkwo, engineering lead",
  "--record",
  "https://example.invalid/agreements/acme.pdf",
];

/** The nth baseline reading: `minutes` on the clock from a start an hour apart. */
const timeArgs = (index: number, minutes: number, interrupted = 0) => [
  "time",
  "--partner",
  "acme",
  "--item",
  `ACME-${400 + index}`,
  "--title",
  `Ticket ${index}`,
  "--started",
  iso(index * 600),
  "--opened",
  iso(index * 600 + minutes),
  ...(interrupted ? ["--interruptions", String(interrupted)] : []),
];

const runArgs = (index: number, minutes: number, extra: string[] = []) => [
  "run",
  "--partner",
  "acme",
  "--item",
  `ACME-${400 + index}`,
  "--started",
  iso(20_000 + index * 600),
  "--opened",
  iso(20_000 + index * 600 + minutes),
  ...extra,
];

/** A partner with ten one-hour readings timed, and nothing sealed yet. */
async function timedTen(name: string): Promise<string> {
  const dir = repo(name);
  await cli(dir, OPEN);
  for (let index = 0; index < 10; index += 1) await cli(dir, timeArgs(index, 60));
  return dir;
}

describe("baseline harness arguments", () => {
  it("takes flags only where they apply, and needs a partner everywhere but the result", () => {
    expect(() => parseE1Args(["seal"])).toThrow(/needs --partner/);
    expect(() => parseE1Args(["seal", "--partner", "acme", "--defect", "x"])).toThrow(
      /--defect does not apply to baseline seal/,
    );
    expect(() => parseE1Args(["time", "--partner", "acme", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseE1Args(["run", "--partner", "acme", "extra"])).toThrow(/takes flags, not/);
    expect(parseE1Args(["result", "--json"])).toMatchObject({ subject: null, json: true });
    expect(parseE1Args(["open", "--partner=acme", "--agent"])).toMatchObject({
      subject: "acme",
      arm: "agent_direct",
    });
  });

  it("reads a date as a day and a timestamp as itself, and refuses anything else", async () => {
    const dir = repo("dates");
    await cli(dir, OPEN);
    expect(ledgerOf(dir).subjects[0]!.thresholds.agreed_at).toBe("2026-08-25T00:00:00.000Z");
    await expect(cli(dir, [...timeArgs(0, 60).slice(0, -1), "not-a-date"])).rejects.toThrow(
      /--opened takes an ISO date or timestamp/,
    );
  });
});

describe("ten timed tickets, then a seal", () => {
  it("counts down to ten, seals with a digest, and refuses everything afterwards", async () => {
    const dir = repo("seal");
    await cli(dir, OPEN);
    for (let index = 0; index < 9; index += 1) await cli(dir, timeArgs(index, 60));
    const tenth = await cli(dir, timeArgs(9, 60));
    expect(tenth.out).toContain("10 of 10: seal it before this partner's first run");

    const ledger = ledgerOf(dir);
    expect(ledger.subjects[0]!.tickets).toHaveLength(10);
    expect(ledger.subjects[0]!.seal).toBeNull();

    const sealed = await cli(dir, ["seal", "--partner", "acme"]);
    expect(sealed.out).toContain("sealed acme's baseline");
    expect(sealed.out).toContain("10 tickets, median 1h");
    expect(sealed.out).toMatch(/digest sha256:[0-9a-f]{64}/);
    expect(ledgerOf(dir).subjects[0]!.seal!.work_item_ids).toHaveLength(10);

    await expect(cli(dir, timeArgs(11, 30))).rejects.toThrow(/cannot take another ticket/);
    await expect(cli(dir, ["seal", "--partner", "acme"])).rejects.toThrow(/cannot be sealed again/);
  });

  it("says how many are still to come, and will not seal short of ten", async () => {
    const dir = repo("short");
    await cli(dir, OPEN);
    const first = await cli(dir, timeArgs(0, 90, 20));
    expect(first.out).toContain("timed ACME-400 \"Ticket 0\": 1h 10m (1h 30m on the clock, 20m interrupted)");
    expect(first.out).toContain("1 of 10; 9 to go before it can be sealed");
    await expect(cli(dir, ["seal", "--partner", "acme"])).rejects.toThrow(
      /holds 1 of 10 tickets; a baseline is complete at ten/,
    );
    // The interruption is subtracted in the file, not only in the sentence.
    expect(ledgerOf(dir).subjects[0]!.tickets[0]).toMatchObject({
      wall_clock_ms: 90 * 60_000,
      interruption_ms: 20 * 60_000,
      elapsed_ms: 70 * 60_000,
      source: "reported",
    });
  });

  it("takes a reading from the stopwatch rather than making a person retype it", async () => {
    const dir = repo("from-stopwatch");
    await cli(dir, OPEN);
    await cli(dir, ["start", "Paginate search", "--ref", "acme/api#412"], at(0));
    await cli(dir, ["pause"], at(10));
    await cli(dir, ["resume"], at(25));
    await cli(dir, ["stop", "--pr", "https://example.invalid/pull/412"], at(75));
    const stopwatch = JSON.parse(
      readFileSync(join(dir, ".perbo", "baseline.json"), "utf8"),
    ) as { entries: [{ id: string }] };

    const timed = await cli(dir, [
      "time",
      "--partner",
      "acme",
      "--from",
      stopwatch.entries[0]!.id,
      "--item",
      "ACME-412",
    ]);
    expect(timed.out).toContain("timed ACME-412 \"Paginate search\": 1h (1h 15m on the clock, 15m interrupted)");
    expect(ledgerOf(dir).subjects[0]!.tickets[0]).toMatchObject({
      source: "stopwatch",
      stopwatch_id: stopwatch.entries[0]!.id,
      elapsed_ms: 60 * 60_000,
    });

    await cli(dir, ["start", "Still going"], at(200));
    const open = JSON.parse(readFileSync(join(dir, ".perbo", "baseline.json"), "utf8")) as {
      entries: { id: string }[];
    };
    await expect(
      cli(dir, ["time", "--partner", "acme", "--from", open.entries[1]!.id, "--item", "ACME-413"]),
    ).rejects.toThrow(/is still running: only a completed reading is a baseline ticket/);
    await expect(
      cli(dir, ["time", "--partner", "acme", "--from", "bl_000000000000", "--item", "ACME-414"]),
    ).rejects.toThrow(/no stopwatch entry bl_000000000000/);
  });
});

describe("a product run", () => {
  it("is refused until the baseline is sealed", async () => {
    const dir = await timedTen("unsealed");
    await expect(cli(dir, runArgs(0, 30))).rejects.toThrow(
      /is not sealed \(10 of 10 tickets\), and a product run recorded before it is sealed/,
    );
    await expect(cli(dir, runArgs(0, 30))).rejects.toBeInstanceOf(UsageError);
    await cli(dir, ["seal", "--partner", "acme"]);
    expect((await cli(dir, runArgs(0, 30))).out).toContain("ratio 0.50× over 1 of 10");
  });

  it("records the confounders beside the ratio and keeps them out of it", async () => {
    const dir = await timedTen("confounders");
    await cli(dir, ["seal", "--partner", "acme"]);
    for (let index = 0; index < 9; index += 1) await cli(dir, runArgs(index, 30));
    const withFriction = await cli(dir, [
      ...runArgs(9, 30, [
        "--friction",
        "45",
        "--defect",
        "the reset token stayed valid after use :: https://example.invalid/pull/9#r1",
      ]),
    ]);
    expect(withFriction.out).toContain("ratio 0.50× over 10 of 10");

    const run = ledgerOf(dir).subjects[0]!.runs[9]!;
    expect(run.admission_friction_ms).toBe(45 * 60_000);
    expect(run.elapsed_ms).toBe(30 * 60_000);
    expect(run.defects_caught).toEqual([
      {
        work_item_id: "ACME-409",
        summary: "the reset token stayed valid after use",
        evidence: "https://example.invalid/pull/9#r1",
        recorded_at: at(10_000).toISOString(),
      },
    ]);
  });

  it("records work that is not one of the ten, and says it is no part of the ratio", async () => {
    const dir = await timedTen("stranger");
    await cli(dir, ["seal", "--partner", "acme"]);
    await cli(dir, runArgs(0, 30));
    const stranger = await cli(dir, [
      "run",
      "--partner",
      "acme",
      "--item",
      "ACME-999",
      "--started",
      iso(30_000),
      "--opened",
      iso(30_600),
    ]);
    expect(stranger.out).toContain("ACME-999 is not one of the sealed ten: recorded, and no part of the ratio");
    const result = await cli(dir, ["result", "--partner", "acme", "--json"]);
    const parsed = JSON.parse(result.out) as {
      partners: [{ ratio: { ratio: number; excluded_work_item_ids: string[] } }];
    };
    expect(parsed.partners[0]!.ratio.ratio).toBe(0.5);
    expect(parsed.partners[0]!.ratio.excluded_work_item_ids).toEqual(["ACME-999"]);
  });

  it("takes an abandonment with its reason and no pull request", async () => {
    const dir = await timedTen("abandoned");
    await cli(dir, ["seal", "--partner", "acme"]);
    const abandoned = await cli(dir, [
      "run",
      "--partner",
      "acme",
      "--item",
      "ACME-400",
      "--started",
      iso(20_000),
      "--abandoned",
      "gave up on the loop and finished it by hand",
    ]);
    expect(abandoned.out).toContain("abandoned mid-flow: gave up on the loop");
    await expect(
      cli(dir, [...runArgs(1, 30), "--abandoned", "both at once"]),
    ).rejects.toThrow(/an abandoned run has no pull request/);
    await expect(cli(dir, runArgs(0, 30))).rejects.toThrow(/already has a product run/);
  });
});

describe("the result", () => {
  it("reads the ratio, the confounders and the verdict, and holds nothing back", async () => {
    const dir = await timedTen("result");
    await cli(dir, ["seal", "--partner", "acme"]);
    for (let index = 0; index < 10; index += 1) {
      await cli(
        dir,
        runArgs(index, 30, index === 0 ? ["--defect", "an unbounded query"] : []),
      );
    }
    const unmeasured = await cli(dir, ["result"], at(10_000), true);
    expect(unmeasured.out).toContain("verdict     incomplete");
    expect(unmeasured.out).toContain("voluntary routing has not been observed");

    await cli(dir, [
      "routing",
      "--partner",
      "acme",
      "--period",
      "weeks 3-4",
      "--eligible",
      "20",
      "--voluntary",
      "13",
      "--on-request",
      "2",
    ]);
    const text = await cli(dir, ["result"], at(10_000), true);
    expect(text.out).toContain("ratio       0.50× over 10 of 10 (product 30m against 1h on the same tickets)");
    expect(text.out).toContain("voluntary routing 65% (13/20)");
    expect(text.out).toContain("recorded beside the ratio, never inside it");
    expect(text.out).toContain("verdict     pass");
    expect(text.out).toContain("cohort      1 of 1 partner(s) pass");
  });

  it("names a partner it does not have rather than printing an empty report", async () => {
    const dir = repo("missing");
    await cli(dir, OPEN);
    await expect(cli(dir, ["result", "--partner", "beta"])).rejects.toThrow(
      /no baseline is open for beta/,
    );
    const empty = await cli(repo("nothing"), ["result"], at(10_000), true);
    expect(empty.out).toContain("no baseline is open here yet");
  });
});

describe("the agent-direct arm", () => {
  it("is reported on its own and never inside a partner's numbers", async () => {
    const dir = await timedTen("arms");
    await cli(dir, ["seal", "--partner", "acme"]);
    await cli(dir, [
      "open",
      "--partner",
      "stand-in",
      "--agent",
      "--agreed-on",
      "2026-08-25T00:00:00.000Z",
      "--agreed-with",
      "the founder, for the AI stand-in",
      "--record",
      "https://example.invalid/stand-in-agreement.md",
    ]);
    const opened = await cli(dir, ["result"], at(10_000), true);
    expect(opened.out).toContain("AGENT-DIRECT (reported on its own; no part of any partner's number)");
    expect(opened.out).toContain(
      "an agent-direct baseline: its own result, never pooled with a partner's",
    );
    // One partner in the cohort, and the stand-in is not the second.
    expect(opened.out).toContain("cohort      0 of 1 partner(s) pass");

    const json = JSON.parse((await cli(dir, ["result", "--json"])).out) as {
      partners: { subject_id: string }[];
      agent_direct: { subject_id: string; counts_toward_e1: boolean }[];
      cohort: { partners: number };
    };
    expect(json.partners.map((one) => one.subject_id)).toEqual(["acme"]);
    expect(json.agent_direct[0]).toMatchObject({ subject_id: "stand-in", counts_toward_e1: false });
    expect(json.cohort.partners).toBe(1);
  });
});

describe("the thresholds", () => {
  it("are agreed with a date before the first measurement, and refuse a reading before them", async () => {
    const dir = repo("thresholds");
    await cli(dir, [
      "open",
      "--partner",
      "acme",
      "--agreed-on",
      "2026-09-02",
      "--agreed-with",
      "Rae Okonkwo",
      "--record",
      "https://example.invalid/a.pdf",
      "--ratio-ten",
      "0.9",
    ]);
    expect(ledgerOf(dir).subjects[0]!.thresholds.ratio_by_ticket_10).toBe(0.9);
    // `timeArgs(0, …)` starts on 2026-09-01, a day before the agreement.
    await expect(cli(dir, timeArgs(0, 60))).rejects.toThrow(
      /before the thresholds acme agreed at 2026-09-02T00:00:00.000Z/,
    );
    await expect(cli(dir, OPEN)).rejects.toThrow(/already has a baseline/);
  });

  it("refuses a ledger on disk that no longer adds up rather than reading past it", async () => {
    const dir = await timedTen("corrupt");
    const path = join(dir, ".perbo", "e1.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      subjects: [{ tickets: [{ elapsed_ms: number }] }];
    };
    raw.subjects[0].tickets[0].elapsed_ms = 1;
    rmSync(path);
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    (await import("node:fs")).writeFileSync(path, JSON.stringify(raw));
    await expect(cli(dir, ["result"])).rejects.toThrow(/e1\.json is not an E1 ledger/);
  });
});
