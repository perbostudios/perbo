import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BaselineFileSchema, type BaselineFile } from "@perbo/contracts";
import { UsageError } from "../../usage-error.js";
import { parseBaselineArgs, runBaselineCommand } from "./index.js";
import { makeTicket } from "../../test-support/attempt-fixture.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-baseline-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function repo(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function baseline(dir: string, argv: string[], when: Date, isTTY = false) {
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

const readFile = (dir: string): BaselineFile =>
  BaselineFileSchema.parse(JSON.parse(readFileSync(join(dir, ".perbo", "baseline.json"), "utf8")));

describe("perbo baseline argument parsing", () => {
  it("needs a subcommand, a title for start, and only the flags that apply", () => {
    expect(() => parseBaselineArgs([])).toThrow(UsageError);
    expect(() => parseBaselineArgs(["begin"])).toThrow(UsageError);
    expect(() => parseBaselineArgs(["start"])).toThrow(/takes one title/);
    expect(() => parseBaselineArgs(["start", "a", "b"])).toThrow(/takes one title/);
    expect(() => parseBaselineArgs(["start", "a", "--pr", "u"])).toThrow(/--pr does not apply/);
    expect(() => parseBaselineArgs(["pause", "extra"])).toThrow(/no positional/);
    expect(parseBaselineArgs(["stop", "--pr=https://x/pull/1", "--note", "n"])).toMatchObject({
      command: "stop",
      pullRequest: "https://x/pull/1",
      note: "n",
    });
  });
});

describe("perbo baseline", () => {
  it("starts an entry before first use and refuses a second while it is open", async () => {
    const dir = repo("start");
    const started = await baseline(dir, ["start", "Paginate search", "--ref", "acme/api#412"], at(0));
    expect(started.code).toBe(0);
    expect(started.out).toMatch(/^started bl_[0-9a-f]{12} "Paginate search" at 2026-09-01T09:00:00.000Z/);
    expect(started.err).toBe("");
    const file = readFile(dir);
    expect(file.captured_before_first_use).toBe(true);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({
      title: "Paginate search",
      ref: "acme/api#412",
      ended_at: null,
      paused_at: null,
      paused_ms: 0,
      elapsed_ms: null,
      outcome: null,
    });

    await expect(baseline(dir, ["start", "Another"], at(1))).rejects.toThrow(
      /already open: "Paginate search" \(bl_[0-9a-f]{12}\)/,
    );
    expect(readFile(dir).entries).toHaveLength(1);
  });

  it("excludes pauses from the reading: 60 minutes on the clock, 5 paused, 55 elapsed", async () => {
    const dir = repo("pause");
    await baseline(dir, ["start", "Paginate search"], at(0));
    const paused = await baseline(dir, ["pause"], at(10));
    expect(paused.out).toContain("paused bl_");
    expect(paused.out).toContain("(10m so far)");
    expect(readFile(dir).entries[0]!.paused_at).toBe(at(10).toISOString());

    const resumed = await baseline(dir, ["resume"], at(15));
    expect(resumed.out).toContain("(5m paused in total)");
    expect(readFile(dir).entries[0]).toMatchObject({ paused_at: null, paused_ms: 300_000 });

    const stopped = await baseline(dir, ["stop", "--pr", "https://example.invalid/pull/418", "--note", "clean"], at(60));
    expect(stopped.out).toContain("completed bl_");
    expect(stopped.out).toContain("55m (5m paused)");
    expect(stopped.out).toContain("https://example.invalid/pull/418");
    expect(readFile(dir).entries[0]).toMatchObject({
      ended_at: at(60).toISOString(),
      paused_ms: 300_000,
      elapsed_ms: 3_300_000,
      pull_request_url: "https://example.invalid/pull/418",
      outcome: "completed",
      note: "clean",
    });
  });

  it("closes an open pause when stopped mid-pause, so the pause is not counted as work", async () => {
    const dir = repo("stop-mid-pause");
    await baseline(dir, ["start", "Paginate search"], at(0));
    await baseline(dir, ["pause"], at(20));
    await baseline(dir, ["stop"], at(30));
    expect(readFile(dir).entries[0]).toMatchObject({
      paused_at: null,
      paused_ms: 600_000,
      elapsed_ms: 1_200_000,
      outcome: "completed",
    });
  });

  it("refuses every transition that has no entry to apply to", async () => {
    const dir = repo("illegal");
    await expect(baseline(dir, ["pause"], at(0))).rejects.toThrow(/nothing to pause/);
    await expect(baseline(dir, ["resume"], at(0))).rejects.toThrow(/nothing to resume/);
    await expect(baseline(dir, ["stop"], at(0))).rejects.toThrow(/nothing to stop/);
    await expect(baseline(dir, ["abandon"], at(0))).rejects.toThrow(/nothing to abandon/);
    expect(existsSync(join(dir, ".perbo", "baseline.json"))).toBe(false);

    await baseline(dir, ["start", "Paginate search"], at(0));
    await expect(baseline(dir, ["resume"], at(1))).rejects.toThrow(/is not paused/);
    await baseline(dir, ["pause"], at(2));
    await expect(baseline(dir, ["pause"], at(3))).rejects.toThrow(/already paused/);
    // Each refusal is a UsageError, so the binary exits 1 rather than 3.
    await expect(baseline(dir, ["pause"], at(3))).rejects.toBeInstanceOf(UsageError);
  });

  it("abandons with a reason and keeps the reading", async () => {
    const dir = repo("abandon");
    await baseline(dir, ["start", "Paginate search"], at(0));
    const abandoned = await baseline(dir, ["abandon", "--reason", "blocked on a design question"], at(12));
    expect(abandoned.out).toContain('abandoned bl_');
    expect(abandoned.out).toContain("after 12m: blocked on a design question");
    expect(readFile(dir).entries[0]).toMatchObject({
      outcome: "abandoned",
      elapsed_ms: 720_000,
      note: "blocked on a design question",
      pull_request_url: null,
    });
    // Abandoned, so a new one may start.
    expect((await baseline(dir, ["start", "Next"], at(13))).code).toBe(0);
  });

  it("records that a ticket already existed rather than refusing", async () => {
    const dir = repo("late");
    mkdirSync(join(dir, ".perbo", "tickets"), { recursive: true });
    writeFileSync(
      join(dir, ".perbo", "tickets", "AYO-1.json"),
      JSON.stringify(makeTicket({ key: "AYO-1", ticket_id: "ticket_late0000001", repository_root: dir })),
    );
    const started = await baseline(dir, ["start", "Paginate search"], at(0));
    expect(started.code).toBe(0);
    expect(started.err).toContain("captured after first use");
    expect(readFile(dir).captured_before_first_use).toBe(false);
    // It never goes back to true.
    await baseline(dir, ["stop"], at(1));
    rmSync(join(dir, ".perbo", "tickets"), { recursive: true, force: true });
    await baseline(dir, ["start", "Later"], at(2));
    expect(readFile(dir).captured_before_first_use).toBe(false);
  });

  it("lists the count, median and p90, and says how far from ten it is", async () => {
    const dir = repo("list");
    for (const [index, minutes] of [10, 40, 20, 30].entries()) {
      const start = index * 100;
      await baseline(dir, ["start", `Ticket ${index}`], at(start));
      await baseline(dir, ["stop"], at(start + minutes));
    }
    await baseline(dir, ["start", "Abandoned"], at(500));
    await baseline(dir, ["abandon"], at(505));
    await baseline(dir, ["start", "Running"], at(600));

    const text = await baseline(dir, ["list"], at(610), true);
    expect(text.out).toContain("entries   6 · 4 completed · 1 abandoned · 1 open");
    expect(text.out).toContain("median    25m");
    expect(text.out).toContain("p90       40m");
    expect(text.out).toMatch(/running\s+10m\s+Running/);
    expect(text.out).toContain("the comparison wants 10 completed entries; 4 so far, 6 to go");

    const json = await baseline(dir, ["list", "--json"], at(610));
    const parsed = JSON.parse(json.out) as { summary: Record<string, number | null>; entries: unknown[] };
    expect(parsed.summary).toMatchObject({
      entries: 6,
      completed: 4,
      abandoned: 1,
      open: 1,
      median_elapsed_ms: 1_500_000,
      p90_elapsed_ms: 2_400_000,
      short_of_comparison: 6,
    });
  });

  it("names a file it cannot read rather than starting over it", async () => {
    const dir = repo("corrupt");
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    writeFileSync(join(dir, ".perbo", "baseline.json"), JSON.stringify({ schema_version: 1, entries: "no" }));
    await expect(baseline(dir, ["start", "x"], at(0))).rejects.toThrow(/baseline\.json is not a baseline record/);
  });
});
