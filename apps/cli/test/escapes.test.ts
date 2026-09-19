import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  TicketEscapesSchema,
  TicketSchema,
  escapeStatus,
  wilsonInterval,
  type Ticket,
  type TicketEscapes,
} from "@perbo/contracts";
import { TicketDeliveryStateSchema, type TicketDeliveryState } from "@perbo/runner";
import type { Streams } from "../src/admit.js";
import { baselinePath } from "../src/baseline.js";
import {
  EscapeCollectionError,
  escapesPath,
  readMergeFacts,
  runEscapesCommand,
  type MergeFacts,
} from "../src/escapes.js";
import { runSyncCommand } from "../src/sync.js";
import { idsFor, readTicket, storeDir, writeTicket } from "../src/tickets.js";

/**
 * `perbo escapes` (SCP-145) over a real git history: one merge reverted, one
 * whose paths were touched again inside fourteen days, one touched again after
 * them, and one nobody went near. The history is built with `git`; nothing in
 * this file stands in for it.
 */

/**
 * Every case here builds a repository and syncs it, which is dozens of real
 * `git` processes; vitest's five seconds is a measure of how busy the machine
 * is rather than of whether the command works.
 */
const GIT_FIXTURE_TIMEOUT_MS = 60_000;
const scratch = mkdtempSync(join(tmpdir(), "perbo-escapes-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitEnv = (at?: string) => ({
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}),
});

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

interface Fixture {
  repo: string;
  dir: string;
  git: (at: string | undefined, ...args: string[]) => string;
  /** The merge commit of each ticket's branch, by ticket key. */
  merges: Record<string, string>;
}

/** A repository with one merge per ticket, each landed on `main` with `--no-ff`. */
function fixture(name: string, tickets: ReadonlyArray<{ key: string; file: string; mergedAt: string }>): Fixture {
  const repo = join(scratch, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv() });
  const git = (at: string | undefined, ...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv(at) });
  writeFileSync(join(repo, "README.md"), "base\n");
  git(undefined, "add", ".");
  git("2026-07-01T00:00:00Z", "commit", "-qm", "base");
  const merges: Record<string, string> = {};
  for (const ticket of tickets) {
    const branch = `ayo/${ticket.key}`;
    git(undefined, "checkout", "-q", "-b", branch);
    writeFileSync(join(repo, ticket.file), `${ticket.key} change\n`);
    git(undefined, "add", ".");
    git(ticket.mergedAt, "commit", "-qm", `${ticket.key}: the change itself`);
    git(undefined, "checkout", "-q", "main");
    git(ticket.mergedAt, "merge", "-q", "--no-ff", branch, "-m", `Merge pull request for ${ticket.key}`);
    merges[ticket.key] = git(undefined, "rev-parse", "HEAD").trim();
  }
  return { repo, dir: storeDir(repo, null), git, merges };
}

/**
 * A clone of one, as a developer's own checkout: the same history, its own
 * `origin`, and no more of the default branch than it had when it was cloned.
 */
function clone(from: Fixture, name: string): Fixture {
  const repo = join(scratch, name);
  execFileSync("git", ["clone", "-q", from.repo, repo], { env: gitEnv() });
  return {
    repo,
    dir: storeDir(repo, null),
    git: (at: string | undefined, ...args: string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv(at) }),
    merges: from.merges,
  };
}

const readRecord = (fixtureAt: Fixture, ticket: Ticket): TicketEscapes =>
  TicketEscapesSchema.parse(JSON.parse(readFileSync(escapesPath(fixtureAt.dir, ticket.ticket_id), "utf8")));

/** A ticket sitting at `pr_open`, as `sync` finds one whose pull request has just merged. */
function ticketAt(fixtureAt: Fixture, key: string, branch: string, number: number): Ticket {
  const at = "2026-07-01T00:00:00.000Z";
  const ids = idsFor(key, new Date(at));
  const ticket = TicketSchema.parse({
    schema_version: 1,
    ticket_id: ids.ticket_id,
    key,
    title: `${key} does a thing`,
    state: "pr_open",
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: fixtureAt.repo,
    plan_id: ids.plan_id,
    plan_version: 1,
    approved_at: at,
    admitted_at: at,
    updated_at: at,
    admission: { elapsed_ms: 1, criteria_source: "typed", criteria_count: 1 },
    delivery: {
      branch,
      pull_request_url: `https://github.com/o/r/pull/${number}`,
      pull_request_number: number,
      state: "open",
      observed_at: at,
    },
    history: [{ at, from: null, to: "plan_review", note: "admitted" }],
  });
  writeTicket(fixtureAt.dir, ticket);
  return ticket;
}

const delivery = (ticket: Ticket, observed_at: string): TicketDeliveryState =>
  TicketDeliveryStateSchema.parse({
    ticket_id: ticket.ticket_id,
    branch: ticket.delivery.branch,
    pull_request_url: ticket.delivery.pull_request_url,
    pull_request_number: ticket.delivery.pull_request_number,
    state: "merged",
    merge_state: null,
    checks: [],
    observed: true,
    human_review_verdicts: [],
    finding_outcomes: {},
    candidate_missed_recall: 0,
    reverted_by: null,
    fixed_by: null,
    attempts: [],
    observed_at,
    stop_answers: [],
  });

/**
 * `sync` for one ticket. `gh` is stood in for — it is the one thing a fixture
 * repository has no GitHub to answer — and it answers with the merge commit
 * this fixture's own `git` reports. Everything after that is real `git`.
 *
 * With `real`, nothing is injected in its place: `readMergeFacts` runs the `gh`
 * that is on PATH, which is what the test that shadows `gh` needs.
 */
const sync = (
  fixtureAt: Fixture,
  ticket: Ticket,
  mergedAt: string,
  observedAt: string,
  options: { real?: boolean; streams?: Streams } = {},
) =>
  runSyncCommand({
    argv: [ticket.key, "--repo", fixtureAt.repo],
    streams: options.streams ?? capture(),
    cwd: fixtureAt.repo,
    now: new Date(observedAt),
    poll: () => Promise.resolve(delivery(ticket, observedAt)),
    ...(options.real === true
      ? {}
      : {
          mergeFacts: (): MergeFacts => ({
            default_branch: "main",
            merge_commit: fixtureAt.merges[ticket.key]!,
            merged_at: mergedAt,
            branch_commits: [],
            pull_request_url: ticket.delivery.pull_request_url,
            pull_request_number: ticket.delivery.pull_request_number,
          }),
        }),
  });

/**
 * A `gh` on PATH, ahead of any real one, answering `gh pr view --json …` with
 * one recorded payload and writing down the arguments it was given. A payload
 * of `null` is a `gh` that exits non-zero — an expired token, no network.
 *
 * This shadows the executable rather than replacing a function, so what runs is
 * the subprocess `sync` really spawns and the argument list it really passes.
 */
function fakeGh(name: string, payload: unknown) {
  const bin = join(scratch, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const argsFile = join(bin, "calls");
  const script =
    payload === null
      ? `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\necho 'gh: could not be asked' >&2\nexit 1\n`
      : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\ncat '${join(bin, "payload")}'\n`;
  if (payload !== null) {
    writeFileSync(join(bin, "payload"), typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  const withPath = (path: string | undefined): void => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  };
  return {
    /** Run `body` with this `gh` first on PATH; the real `git` stays reachable. */
    on: <T>(body: () => T): T => {
      const path = process.env.PATH;
      process.env.PATH = `${bin}${path === undefined ? "" : `:${path}`}`;
      try {
        return body();
      } finally {
        withPath(path);
      }
    },
    /** The same, held across an `await` — `sync` reaches `gh` after one. */
    during: async <T>(body: () => Promise<T>): Promise<T> => {
      const path = process.env.PATH;
      process.env.PATH = `${bin}${path === undefined ? "" : `:${path}`}`;
      try {
        return await body();
      } finally {
        withPath(path);
      }
    },
    calls: (): string[] =>
      existsSync(argsFile)
        ? readFileSync(argsFile, "utf8")
            .split("\n")
            .filter((line) => line !== "")
        : [],
  };
}

const MERGED_AT = "2026-08-01T00:00:00.000Z";
const OBSERVED_AT = "2026-09-15T00:00:00.000Z";
/**
 * When the report is read. Whether a window is open is a fact about now rather
 * than about the record, so every reading in this file says which now it means
 * — a test whose statuses depend on the day it runs proves nothing twice.
 */
const READ_AT = new Date("2026-09-16T00:00:00.000Z");

/**
 * The four cases, in one repository: `AYO-1` reverted, `AYO-2` touched again
 * on day three, `AYO-3` touched again on day thirty, `AYO-4` left alone.
 */
async function fourCases(name: string): Promise<Fixture & { rows: string; json: unknown }> {
  const plan = [
    { key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT },
    { key: "AYO-2", file: "two.txt", mergedAt: MERGED_AT },
    { key: "AYO-3", file: "three.txt", mergedAt: MERGED_AT },
    { key: "AYO-4", file: "four.txt", mergedAt: MERGED_AT },
  ];
  const f = fixture(name, plan);
  // A revert of AYO-1's merge, two days later.
  f.git("2026-08-03T00:00:00Z", "revert", "-m", "1", "--no-edit", f.merges["AYO-1"]!);
  // AYO-2's file touched again on day three: inside the window.
  writeFileSync(join(f.repo, "two.txt"), "AYO-2 change, reworked\n");
  f.git("2026-08-04T00:00:00Z", "commit", "-qam", "rework the thing AYO-2 did");
  // AYO-3's file touched again on day thirty: outside it.
  writeFileSync(join(f.repo, "three.txt"), "AYO-3 change, much later\n");
  f.git("2026-08-31T00:00:00Z", "commit", "-qam", "a month later, three.txt again");

  for (const [index, entry] of plan.entries()) {
    const ticket = ticketAt(f, entry.key, `ayo/${entry.key}`, index + 1);
    await sync(f, ticket, entry.mergedAt, OBSERVED_AT);
  }
  const table = capture();
  await runEscapesCommand({ argv: ["--repo", f.repo], streams: table, cwd: f.repo, now: READ_AT });
  const json = capture();
  await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams: json, cwd: f.repo, now: READ_AT });
  return { ...f, rows: table.out.join(""), json: JSON.parse(json.out.join("")) as unknown };
}

/** The instant `days` before the fixed clock every reading in this file is taken at. */
const daysBeforeRead = (days: number): string => new Date(READ_AT.getTime() - days * 86_400_000).toISOString();

/**
 * A store whose changes merged the given numbers of days before `READ_AT`, one
 * ticket each (`AYO-1` for the first number, and so on), every one synced at
 * the same clock the report is then read against — so what separates the rows
 * is their own merge dates and nothing else.
 */
async function mergedDaysBeforeRead(name: string, days: readonly number[]): Promise<Fixture> {
  const plan = days.map((ago, index) => ({
    key: `AYO-${index + 1}`,
    file: `${index + 1}.txt`,
    mergedAt: daysBeforeRead(ago),
  }));
  const f = fixture(name, plan);
  for (const [index, entry] of plan.entries()) {
    const ticket = ticketAt(f, entry.key, `ayo/${entry.key}`, index + 1);
    await sync(f, ticket, entry.mergedAt, READ_AT.toISOString());
  }
  return f;
}

/** The `escapes` table as text, and its rows and cells picked out by hand. */
async function readReport(f: Fixture): Promise<{
  text: string;
  line: (key: string) => string;
  detail: (prefix: string) => string;
  /** The `n` cell of a metric row: the last column of the metric table. */
  narrative: (metric: string) => string;
  json: JsonOutput;
}> {
  const table = capture();
  await runEscapesCommand({ argv: ["--repo", f.repo], streams: table, cwd: f.repo, now: READ_AT });
  const json = capture();
  await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams: json, cwd: f.repo, now: READ_AT });
  const text = table.out.join("");
  const lines = text.split("\n");
  return {
    text,
    line: (key) => lines.find((entry) => new RegExp(`^${key}\\b`).test(entry)) ?? "",
    detail: (prefix) => lines.find((entry) => entry.trim().startsWith(prefix)) ?? "",
    narrative: (metric) => (lines.find((entry) => entry.startsWith(metric)) ?? "").split(/ {2,}/).at(-1) ?? "",
    json: JSON.parse(json.out.join("")) as JsonOutput,
  };
}

interface JsonOutput {
  window_days: number;
  read_at: string;
  due: { due: number; not_yet_due: number; no_merge_date: number };
  stops: { precision: { n: number } };
  escapes: {
    merged: number;
    closed: number;
    window_open: number;
    stale: number;
    not_observed: number;
    reverted: number;
    same_path: number;
    revert_rate: { point: number; low: number; high: number; n: number };
    same_path_rate: { point: number; low: number; high: number; n: number };
  };
  tickets: Array<{
    ticket_key: string;
    dogfood: boolean;
    status: string;
    /** Whether this change's own fourteen days are up at `read_at`. */
    due: boolean;
    /** When they are up: the change's merge date plus fourteen days. */
    due_at: string | null;
    reverted: boolean;
    same_path_touched: boolean;
    observed_through: string | null;
    merge_commit: string | null;
    changed_paths: string[];
    reverts: Array<{ sha: string; subject: string; reverts: string[]; paths: string[] }>;
    same_path: Array<{ sha: string; subject: string; paths: string[] }>;
  }>;
}

describe("ac_1 — a revert column and a separate same-path column, over a real git history", () => {
  it("reports four merged tickets with the expected columns, commits and paths", async () => {
    const f = await fourCases("four-cases");
    const json = f.json as JsonOutput;
    const rows = new Map(json.tickets.map((row) => [row.ticket_key, row]));
    expect([...rows.keys()]).toEqual(["AYO-1", "AYO-2", "AYO-3", "AYO-4"]);
    expect(json.escapes.merged).toBe(4);
    expect(json.escapes.closed).toBe(4);

    const reverted = rows.get("AYO-1")!;
    expect(reverted.status).toBe("observed");
    expect(reverted.reverted).toBe(true);
    expect(reverted.merge_commit).toBe(f.merges["AYO-1"]);
    expect(reverted.changed_paths).toEqual(["one.txt"]);
    expect(reverted.reverts).toHaveLength(1);
    expect(reverted.reverts[0]!.subject).toBe('Revert "Merge pull request for AYO-1"');
    expect(reverted.reverts[0]!.reverts).toEqual([f.merges["AYO-1"]]);
    // The revert touched the path it reverted, so it is in both columns. That
    // is exactly why the two are never added together.
    expect(reverted.same_path_touched).toBe(true);
    expect(reverted.same_path[0]!.paths).toEqual(["one.txt"]);

    const reworked = rows.get("AYO-2")!;
    expect(reworked.reverted).toBe(false);
    expect(reworked.same_path_touched).toBe(true);
    expect(reworked.same_path).toHaveLength(1);
    expect(reworked.same_path[0]!.subject).toBe("rework the thing AYO-2 did");
    expect(reworked.same_path[0]!.paths).toEqual(["two.txt"]);
    expect(reworked.same_path[0]!.sha).toBe(
      f.git(undefined, "log", "-1", "--format=%H", "--grep=rework the thing AYO-2 did", "main").trim(),
    );

    const late = rows.get("AYO-3")!;
    expect(late.status).toBe("observed");
    expect(late.reverted).toBe(false);
    expect(late.same_path_touched).toBe(false);
    expect(late.same_path).toEqual([]);

    const untouched = rows.get("AYO-4")!;
    expect(untouched.reverted).toBe(false);
    expect(untouched.same_path_touched).toBe(false);

    // The columns are two, and the totals are never one.
    expect(json.escapes.reverted).toBe(1);
    expect(json.escapes.same_path).toBe(2);

    // The table names the same things the JSON does.
    expect(f.rows).toContain("AYO-1");
    expect(f.rows).toContain(`reverted by ${f.merges["AYO-1"]!.slice(0, 7)}`.slice(0, 12));
    expect(f.rows).toContain('Revert "Merge pull request for AYO-1"');
    expect(f.rows).toContain("rework the thing AYO-2 did");
    expect(f.rows).toContain("two.txt");
    // Each column's line names the later commit, what it did to the ticket's
    // work, and the paths — the merge itself is the row's own `merge` column.
    const line = (prefix: string) =>
      f.rows.split("\n").find((row) => row.trim().startsWith(prefix)) ?? "";
    expect(line("reverted by")).toContain(f.merges["AYO-1"]!.slice(0, 7));
    expect(line("reverted by")).toMatch(/— one\.txt$/);
    expect(line("same path")).toMatch(/— two\.txt$|— one\.txt$/);
    expect(f.rows.split("\n").filter((row) => row.trim().startsWith("reverted by"))).toHaveLength(1);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("sees a rework that arrives as a later merge, not only as a commit on the branch", async () => {
    // Every change in this repository lands as a merge commit, so a rework by a
    // second pull request is the ordinary case rather than an exotic one.
    const f = fixture("rework-by-merge", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    f.git(undefined, "checkout", "-q", "-b", "ayo/AYO-9");
    writeFileSync(join(f.repo, "one.txt"), "AYO-1 change, reworked by another pull request\n");
    f.git(undefined, "add", ".");
    f.git("2026-08-05T00:00:00Z", "commit", "-qm", "AYO-9: rework one.txt");
    f.git(undefined, "checkout", "-q", "main");
    f.git("2026-08-05T00:00:00Z", "merge", "-q", "--no-ff", "ayo/AYO-9", "-m", "Merge pull request for AYO-9");
    const rework = f.git(undefined, "rev-parse", "HEAD").trim();

    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await sync(f, ticket, MERGED_AT, OBSERVED_AT);
    const streams = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams, cwd: f.repo, now: READ_AT });
    const row = (JSON.parse(streams.out.join("")) as JsonOutput).tickets[0]!;
    expect(row.same_path_touched).toBe(true);
    expect(row.same_path.map((commit) => commit.sha)).toEqual([rework]);
    expect(row.same_path[0]!.paths).toEqual(["one.txt"]);
    expect(row.reverted).toBe(false);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("keeps the record when `gh` names a commit this checkout does not have", async () => {
    // A squash or rebase merge deletes the head branch, and `gh` still lists
    // its commits; they are not objects here. That is not a ticket nobody
    // reverted, and the merge is readable regardless.
    const f = fixture("absent-commit", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    f.git("2026-08-03T00:00:00Z", "revert", "-m", "1", "--no-edit", f.merges["AYO-1"]!);
    const absent = "9".repeat(40);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await runSyncCommand({
      argv: [ticket.key, "--repo", f.repo],
      streams: capture(),
      cwd: f.repo,
      now: new Date(OBSERVED_AT),
      poll: () => Promise.resolve(delivery(ticket, OBSERVED_AT)),
      mergeFacts: (): MergeFacts => ({
        default_branch: "main",
        merge_commit: f.merges["AYO-1"]!,
        merged_at: MERGED_AT,
        branch_commits: [absent],
        pull_request_url: ticket.delivery.pull_request_url,
        pull_request_number: ticket.delivery.pull_request_number,
      }),
    });
    const record = JSON.parse(readFileSync(escapesPath(f.dir, ticket.ticket_id), "utf8")) as {
      branch_commits: Array<{ sha: string; subject: string }>;
      reverts: Array<{ reverts: string[] }>;
    };
    // The sha is kept, so a `This reverts commit <sha>` trailer still matches;
    // only the subject nobody could read is empty.
    expect(record.branch_commits).toContainEqual({ sha: absent, subject: "" });
    expect(record.reverts[0]!.reverts).toEqual([f.merges["AYO-1"]]);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("finds a revert that landed on the default branch after this clone was last updated", async () => {
    // The ordinary case: the escape happened while the developer's checkout sat
    // where it was. Collection fetches before it reads, so the revert is on the
    // row rather than missing from a history nobody refreshed.
    const upstream = fixture("upstream-revert", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    const local = clone(upstream, "behind-clone");
    upstream.git("2026-08-03T00:00:00Z", "revert", "-m", "1", "--no-edit", upstream.merges["AYO-1"]!);
    const behind = local.git(undefined, "rev-parse", "refs/remotes/origin/main").trim();
    expect(behind).toBe(local.merges["AYO-1"]);

    const ticket = ticketAt(local, "AYO-1", "ayo/AYO-1", 1);
    await sync(local, ticket, MERGED_AT, OBSERVED_AT);

    const record = readRecord(local, ticket);
    expect(record.observed_head.refreshed).toBe(true);
    expect(record.observed_head.sha).toBe(upstream.git(undefined, "rev-parse", "main").trim());
    expect(record.reverts[0]!.reverts).toEqual([upstream.merges["AYO-1"]]);

    const streams = capture();
    await runEscapesCommand({ argv: ["--repo", local.repo, "--json"], streams, cwd: local.repo, now: READ_AT });
    const json = JSON.parse(streams.out.join("")) as JsonOutput;
    expect(json.tickets[0]!.status).toBe("observed");
    expect(json.tickets[0]!.reverted).toBe(true);
    expect(json.escapes.reverted).toBe(1);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("reports a checkout it could not refresh as unread history rather than as nothing came back", async () => {
    const upstream = fixture("upstream-unreachable", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    const local = clone(upstream, "unfetchable-clone");
    upstream.git("2026-08-03T00:00:00Z", "revert", "-m", "1", "--no-edit", upstream.merges["AYO-1"]!);
    // The remote cannot be reached from here — no network, a moved host.
    local.git(undefined, "remote", "set-url", "origin", join(scratch, "no-such-repository"));

    const ticket = ticketAt(local, "AYO-1", "ayo/AYO-1", 1);
    const streams = capture();
    await sync(local, ticket, MERGED_AT, OBSERVED_AT, { streams });
    expect(streams.err.join("")).toContain("git fetch origin main");

    const record = readRecord(local, ticket);
    // The revert is genuinely not in this clone, so the record cannot name it —
    // and it says how far it looked instead of implying it looked far enough.
    expect(record.reverts).toEqual([]);
    expect(record.observed_head.refreshed).toBe(false);
    expect(record.observed_head.sha).toBe(local.merges["AYO-1"]);
    expect(record.observed_head.committed_at).toBe(MERGED_AT);

    const json = capture();
    await runEscapesCommand({ argv: ["--repo", local.repo, "--json"], streams: json, cwd: local.repo, now: READ_AT });
    const parsed = JSON.parse(json.out.join("")) as JsonOutput;
    expect(parsed.tickets[0]!.status).toBe("stale");
    expect(parsed.tickets[0]!.observed_through).toBe(MERGED_AT);
    // Out of the denominator: a rate that counted this ticket as a survivor
    // would be reporting the state of a clone rather than of the branch.
    expect(parsed.escapes.closed).toBe(0);
    expect(parsed.escapes.stale).toBe(1);
    expect(parsed.escapes.revert_rate.n).toBe(0);

    const table = capture();
    await runEscapesCommand({ argv: ["--repo", local.repo], streams: table, cwd: local.repo, now: READ_AT });
    expect(table.out.join("")).toContain("`perbo sync AYO-1`");
    expect(table.err.join("")).toContain("behind the default branch");

    // Reachable again, the same command closes the gap and the revert appears.
    local.git(undefined, "remote", "set-url", "origin", upstream.repo);
    await sync(local, ticket, MERGED_AT, "2026-09-17T00:00:00.000Z");
    const after = capture();
    await runEscapesCommand({
      argv: ["--repo", local.repo, "--json"],
      streams: after,
      cwd: local.repo,
      now: new Date("2026-09-18T00:00:00.000Z"),
    });
    const healed = JSON.parse(after.out.join("")) as JsonOutput;
    expect(healed.tickets[0]!.status).toBe("observed");
    expect(healed.tickets[0]!.reverted).toBe(true);
  }, GIT_FIXTURE_TIMEOUT_MS);
});

describe("ac_2 — sync writes the record; escapes reads it and nothing else", () => {
  it("writes byte-identical escapes.json on a second sync, apart from the observation time", async () => {
    const f = fixture("idempotent", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    f.git("2026-08-03T00:00:00Z", "revert", "-m", "1", "--no-edit", f.merges["AYO-1"]!);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await sync(f, ticket, MERGED_AT, OBSERVED_AT);
    const first = readFileSync(escapesPath(f.dir, ticket.ticket_id), "utf8");
    await sync(f, ticket, MERGED_AT, "2026-09-20T00:00:00.000Z");
    const second = readFileSync(escapesPath(f.dir, ticket.ticket_id), "utf8");

    expect(second).not.toBe(first);
    expect(second.replace(/"observed_at": "[^"]+"/, "T")).toBe(first.replace(/"observed_at": "[^"]+"/, "T"));
    // The one thing kept across rewrites is when the record first appeared.
    expect(JSON.parse(second)).toMatchObject({ first_seen_at: OBSERVED_AT, observed_at: "2026-09-20T00:00:00.000Z" });
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("succeeds with every git, gh and network call stubbed to fail", async () => {
    const f = fixture("offline", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await sync(f, ticket, MERGED_AT, OBSERVED_AT);

    const bin = join(scratch, "failing-bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["git", "gh"]) {
      const path = join(bin, name);
      writeFileSync(path, "#!/bin/sh\necho 'no' >&2\nexit 1\n");
      chmodSync(path, 0o755);
    }
    const path = process.env.PATH;
    const fetched = globalThis.fetch;
    process.env.PATH = bin;
    globalThis.fetch = (() => {
      throw new Error("the network is not available to `perbo escapes`");
    }) as typeof fetch;
    try {
      const streams = capture();
      const code = await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams, cwd: f.repo, now: READ_AT });
      expect(code).toBe(0);
      const json = JSON.parse(streams.out.join("")) as JsonOutput;
      expect(json.tickets.map((row) => row.ticket_key)).toEqual(["AYO-1"]);
      expect(json.tickets[0]!.status).toBe("observed");
      expect(json.escapes.closed).toBe(1);
    } finally {
      process.env.PATH = path;
      globalThis.fetch = fetched;
    }
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("collects through the real `gh` and `git` processes when nothing is injected", async () => {
    const f = fixture("through-gh", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    f.git("2026-08-03T00:00:00Z", "revert", "-m", "1", "--no-edit", f.merges["AYO-1"]!);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    const gh = fakeGh("through-gh", {
      number: 1,
      url: "https://github.com/o/r/pull/1",
      state: "MERGED",
      mergedAt: MERGED_AT,
      mergeCommit: { oid: f.merges["AYO-1"]! },
      baseRefName: "main",
      commits: [{ oid: f.git(undefined, "rev-parse", `${f.merges["AYO-1"]!}^2`).trim() }],
    });

    // `gh` is shadowed on PATH and `git` is not: the history after the merge is
    // read by the git this fixture was built with, through a real subprocess.
    await gh.during(() => sync(f, ticket, MERGED_AT, OBSERVED_AT, { real: true }));

    expect(gh.calls()).toEqual([
      `pr view 1 --json number,url,state,mergedAt,mergeCommit,baseRefName,commits`,
    ]);
    const record = JSON.parse(readFileSync(escapesPath(f.dir, ticket.ticket_id), "utf8")) as {
      merge_commit: string;
      default_branch: string;
      changed_paths: string[];
      reverts: Array<{ reverts: string[] }>;
    };
    expect(record.merge_commit).toBe(f.merges["AYO-1"]);
    expect(record.default_branch).toBe("main");
    expect(record.changed_paths).toEqual(["one.txt"]);
    expect(record.reverts[0]!.reverts).toEqual([f.merges["AYO-1"]]);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("asks `gh` for the merge and tells `no merged pull request` apart from `gh could not answer`", () => {
    const merged = fakeGh("facts-merged", {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: "MERGED",
      mergedAt: "2026-08-01T00:00:00Z",
      mergeCommit: { oid: "f".repeat(40) },
      baseRefName: "trunk",
      commits: [{ oid: "e".repeat(40) }, { oid: "d".repeat(40) }],
    });
    const facts = merged.on(() =>
      readMergeFacts({ repositoryRoot: scratch, branch: "ayo/AYO-1", pull_request_number: 7 }),
    );
    expect(facts).toEqual({
      default_branch: "trunk",
      merge_commit: "f".repeat(40),
      merged_at: "2026-08-01T00:00:00.000Z",
      branch_commits: ["e".repeat(40), "d".repeat(40)],
      pull_request_url: "https://github.com/o/r/pull/7",
      pull_request_number: 7,
    });
    expect(merged.calls()).toEqual(["pr view 7 --json number,url,state,mergedAt,mergeCommit,baseRefName,commits"]);

    // A pull request that is open is an answer, and the answer is "nothing has
    // merged". With no number on the ticket, the branch is what `gh` is asked.
    const byBranch = fakeGh("facts-branch", { number: 7, state: "OPEN", mergedAt: null, mergeCommit: null });
    expect(
      byBranch.on(() =>
        readMergeFacts({ repositoryRoot: scratch, branch: "ayo/AYO-1", pull_request_number: null }),
      ),
    ).toBeNull();
    expect(byBranch.calls()[0]).toContain("pr view ayo/AYO-1 --json");

    // An unanswered `gh` is not an answered "nothing merged", and the two must
    // not write the same record: one throws, the other returns null.
    const failing = fakeGh("facts-failing", null);
    expect(() =>
      failing.on(() =>
        readMergeFacts({ repositoryRoot: scratch, branch: "ayo/AYO-1", pull_request_number: 7 }),
      ),
    ).toThrow(EscapeCollectionError);
    const unparseable = fakeGh("facts-unparseable", "not json at all");
    expect(() =>
      unparseable.on(() =>
        readMergeFacts({ repositoryRoot: scratch, branch: "ayo/AYO-1", pull_request_number: 7 }),
      ),
    ).toThrow(EscapeCollectionError);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("leaves the previous record alone when `gh` cannot be asked", async () => {
    const f = fixture("gh-silent", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await sync(f, ticket, MERGED_AT, OBSERVED_AT);
    const written = readFileSync(escapesPath(f.dir, ticket.ticket_id), "utf8");

    const silent = fakeGh("gh-silent-bin", null);
    const streams = capture();
    await silent.during(() =>
      runSyncCommand({
        argv: [ticket.key, "--repo", f.repo],
        streams,
        cwd: f.repo,
        now: new Date("2026-09-20T00:00:00.000Z"),
        poll: () => Promise.resolve(delivery(ticket, "2026-09-20T00:00:00.000Z")),
      }),
    );
    expect(readFileSync(escapesPath(f.dir, ticket.ticket_id), "utf8")).toBe(written);
    expect(streams.err.join("")).toContain("unchanged");
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("reads `not yet due` for a ticket merged eight days ago, never zero", async () => {
    const mergedAt = "2026-09-07T00:00:00.000Z";
    const f = fixture("window-open", [{ key: "AYO-1", file: "one.txt", mergedAt }]);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await sync(f, ticket, mergedAt, OBSERVED_AT);

    const streams = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams, cwd: f.repo, now: READ_AT });
    const json = JSON.parse(streams.out.join("")) as JsonOutput;
    expect(json.tickets[0]!.status).toBe("window open");
    expect(json.tickets[0]!.due).toBe(false);
    expect(json.tickets[0]!.due_at).toBe("2026-09-21T00:00:00.000Z");
    expect(json.due).toEqual({ due: 0, not_yet_due: 1, no_merge_date: 0 });
    expect(json.escapes.window_open).toBe(1);
    expect(json.escapes.closed).toBe(0);
    // No value at all, rather than a zero rate over an empty denominator.
    expect(json.escapes.revert_rate.n).toBe(0);

    const table = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo], streams: table, cwd: f.repo, now: READ_AT });
    expect(table.out.join("")).toContain("not yet due");
    expect(table.out.join("")).toContain("not yet due until 2026-09-21T00:00:00.000Z");
    expect(table.out.join("")).not.toMatch(/AYO-1.*\bno\b/);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("stops reading `not yet due` once the fourteen days are up on a record nobody refreshed", async () => {
    // Synced on day eight and never again. The eight-day-old reading is not a
    // fourteen-day one, and the day the window closes it stops being either.
    const mergedAt = "2026-09-07T00:00:00.000Z";
    const f = fixture("frozen-window", [{ key: "AYO-1", file: "one.txt", mergedAt }]);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await sync(f, ticket, mergedAt, OBSERVED_AT);
    const closes = readRecord(f, ticket).window_closes_at;
    expect(closes).toBe("2026-09-21T00:00:00.000Z");

    const read = async (now: string): Promise<JsonOutput> => {
      const streams = capture();
      await runEscapesCommand({
        argv: ["--repo", f.repo, "--json"],
        streams,
        cwd: f.repo,
        now: new Date(now),
      });
      return JSON.parse(streams.out.join("")) as JsonOutput;
    };

    const open = await read("2026-09-20T23:59:59.000Z");
    expect(open.tickets[0]!.status).toBe("window open");
    expect(open.due).toEqual({ due: 0, not_yet_due: 1, no_merge_date: 0 });
    const late = await read("2026-11-01T00:00:00.000Z");
    expect(late.tickets[0]!.status).toBe("stale");
    // Due, and read by nobody since: it is counted as due and it is not in the
    // rate, which is why the two figures are printed apart.
    expect(late.tickets[0]!.due).toBe(true);
    expect(late.due).toEqual({ due: 1, not_yet_due: 0, no_merge_date: 0 });
    expect(late.tickets[0]!.observed_through).toBe(OBSERVED_AT);
    expect(late.escapes.closed).toBe(0);
    expect(late.escapes.window_open).toBe(0);
    expect(late.escapes.stale).toBe(1);
    expect(late.read_at).toBe("2026-11-01T00:00:00.000Z");

    // And it says so, with the command that fixes it — the same courtesy the
    // never-synced ticket already got.
    const table = capture();
    await runEscapesCommand({
      argv: ["--repo", f.repo],
      streams: table,
      cwd: f.repo,
      now: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(table.out.join("")).toContain(`watched only to ${OBSERVED_AT}, fell due ${closes}`);
    expect(table.out.join("")).toContain("`perbo sync AYO-1`");
    expect(table.err.join("")).toContain("stops short of their 14-day window");

    // Synced again after the window closed, the same ticket is evidence.
    await sync(f, ticket, mergedAt, "2026-11-01T00:00:00.000Z");
    const refreshed = await read("2026-11-02T00:00:00.000Z");
    expect(refreshed.tickets[0]!.status).toBe("observed");
    expect(refreshed.escapes.closed).toBe(1);
    expect(refreshed.escapes.stale).toBe(0);
  }, GIT_FIXTURE_TIMEOUT_MS);
});

describe("ac_3 — the rate, its interval and its n, in the stops table", () => {
  it("prints the Wilson interval packages/contracts computes, beside the two stops rows", async () => {
    const f = await fourCases("interval");
    const json = f.json as JsonOutput;
    const revert = wilsonInterval(1, 4);
    const samePath = wilsonInterval(2, 4);
    expect(json.escapes.revert_rate).toEqual(revert);
    expect(json.escapes.same_path_rate).toEqual(samePath);

    const printed = (interval: { low: number; high: number }) =>
      `[${Math.round(interval.low * 100)}–${Math.round(interval.high * 100)}]`;
    expect(f.rows).toContain(printed(revert));
    expect(f.rows).toContain(printed(samePath));
    expect(f.rows).toContain(`${Math.round(revert.point * 100)}%`);
    expect(f.rows).toContain("4 due (4 read, 1 reverted), 0 not yet due");
    expect(f.rows).toContain("4 due (4 read, 2 re-touched), 0 not yet due");

    // The escape rate and D-060's pair are one table, printed together or not
    // at all: a rate quoted without them says nothing about what was stopped.
    const table = f.rows.slice(0, f.rows.indexOf("\n\n"));
    for (const row of [
      "precision of stopping",
      "person shown something",
      "escape rate (reverted, 14d)",
      "escape rate (same path, 14d)",
    ]) {
      expect(table).toContain(row);
    }
    expect(json.stops).toBeDefined();
    expect(json.window_days).toBe(14);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("prints both halves of the table on a store with no stops answers at all", async () => {
    const f = fixture("no-stops", [{ key: "AYO-1", file: "one.txt", mergedAt: MERGED_AT }]);
    const ticket = ticketAt(f, "AYO-1", "ayo/AYO-1", 1);
    await sync(f, ticket, MERGED_AT, OBSERVED_AT);
    const streams = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo], streams, cwd: f.repo, now: READ_AT });
    const out = streams.out.join("");
    expect(out).toContain("precision of stopping");
    expect(out).toContain("person shown something");
    expect(out).toContain("escape rate (reverted, 14d)");
  }, GIT_FIXTURE_TIMEOUT_MS);
});

describe("ac_4 — the stand-in partner's merged tickets are the first population", () => {
  it("lists every merged ticket of a store with no partner baseline and marks each dogfood", async () => {
    const f = await fourCases("ac4-dogfood");
    const parsed = f.json as JsonOutput;

    // D-058's label follows D-038's baseline: a store holding a partner's
    // comparison, captured before their first ticket, is a partner's store and
    // its rows are not dogfood. This store holds no such file, which is what
    // the stand-in's own store looks like.
    expect(existsSync(baselinePath(f.dir))).toBe(false);

    // The population is every merged ticket and nothing else.
    expect([...parsed.tickets.map((row) => row.ticket_key)].sort()).toEqual(["AYO-1", "AYO-2", "AYO-3", "AYO-4"]);
    for (const row of parsed.tickets) expect(readTicket(f.dir, row.ticket_key).state).toBe("merged");

    for (const key of ["AYO-3", "AYO-4"]) {
      const row = parsed.tickets.find((entry) => entry.ticket_key === key);
      expect(row, `${key} is merged in this store and belongs in the population`).toBeDefined();
      // D-058: a stand-in's numbers are dogfood numbers, never a partner's.
      expect(row!.dogfood).toBe(true);

      // And the row says what is known about its window, from the record on
      // disk — never a zero standing in for it.
      const path = escapesPath(f.dir, readTicket(f.dir, key).ticket_id);
      const expected = escapeStatus(
        TicketEscapesSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
        READ_AT.toISOString(),
      );
      expect(expected).toBe("observed");
      expect(row!.status).toBe(expected);

      const line = f.rows.split("\n").find((entry) => new RegExp(`^${key}\\b`).test(entry));
      expect(line, `${key} has a row in the table`).toBeDefined();
      expect(line).toContain("dogfood");
      expect(line).toContain("due");
      expect(line).not.toContain("not yet due");
    }
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("marks the rows partner, not dogfood, once the store holds a baseline captured before first use", async () => {
    const f = await fourCases("ac4-partner");
    mkdirSync(dirname(baselinePath(f.dir)), { recursive: true });
    writeFileSync(
      baselinePath(f.dir),
      JSON.stringify({
        schema_version: 1,
        captured_before_first_use: true,
        entries: [
          {
            id: "bl_0123456789ab",
            title: "the partner's first comparison",
            ref: null,
            started_at: "2026-07-01T00:00:00.000Z",
            ended_at: "2026-07-01T01:00:00.000Z",
            paused_at: null,
            paused_ms: 0,
            elapsed_ms: 3_600_000,
            pull_request_url: null,
            outcome: null,
            note: null,
          },
        ],
      }),
    );

    const table = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo], streams: table, cwd: f.repo, now: READ_AT });
    const json = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams: json, cwd: f.repo, now: READ_AT });
    const parsed = JSON.parse(json.out.join("")) as JsonOutput;

    expect(parsed.tickets).toHaveLength(4);
    for (const row of parsed.tickets) expect(row.dogfood).toBe(false);
    const line = table.out.join("").split("\n").find((entry) => /^AYO-3\b/.test(entry));
    expect(line).toBeDefined();
    expect(line).toContain("partner");
    expect(line).not.toContain("dogfood");
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("keeps the rows dogfood when the store's baseline was captured after first use", async () => {
    const f = await fourCases("ac4-late-baseline");
    mkdirSync(dirname(baselinePath(f.dir)), { recursive: true });
    // D-038: a comparison started once a ticket was already admitted is not a
    // partner's before-first-use baseline, whatever it holds — this is the
    // stand-in's own store on a machine where `perbo baseline` was used late.
    writeFileSync(
      baselinePath(f.dir),
      JSON.stringify({
        schema_version: 1,
        captured_before_first_use: false,
        entries: [
          {
            id: "bl_00000000abcd",
            title: "a comparison started after the first ticket",
            ref: null,
            started_at: "2026-08-20T00:00:00.000Z",
            ended_at: "2026-08-20T01:00:00.000Z",
            paused_at: null,
            paused_ms: 0,
            elapsed_ms: 3_600_000,
            pull_request_url: null,
            outcome: null,
            note: null,
          },
        ],
      }),
    );

    const json = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams: json, cwd: f.repo, now: READ_AT });
    const parsed = JSON.parse(json.out.join("")) as JsonOutput;
    expect(parsed.tickets).toHaveLength(4);
    for (const row of parsed.tickets) expect(row.dogfood).toBe(true);
  }, GIT_FIXTURE_TIMEOUT_MS);
});

describe("ac_4 / SCP-157 — a hand-off reconciliation counts toward the merged population", () => {
  it("counts a failed ticket a person merged by hand in escapes' merged tally", async () => {
    const f = fixture("handoff", [{ key: "AYO-9", file: "nine.txt", mergedAt: MERGED_AT }]);
    const at = "2026-07-01T00:00:00.000Z";
    const ids = idsFor("AYO-9", new Date(at));
    const branch = "ayo/AYO-9";
    const ticket = TicketSchema.parse({
      schema_version: 1,
      ticket_id: ids.ticket_id,
      key: "AYO-9",
      title: "AYO-9 does a thing",
      // The loop's own attempt is why this ticket says `failed` at all — no
      // pull request on it yet, which is what `recordDelivery` leaves behind
      // for an attempt that never opened one.
      state: "failed",
      priority: "normal",
      labels: [],
      depends_on: [],
      source: { kind: "none", reference: null, url: null, title_at_admission: null },
      repository_root: f.repo,
      plan_id: ids.plan_id,
      plan_version: 1,
      approved_at: at,
      admitted_at: at,
      updated_at: at,
      admission: { elapsed_ms: 1, criteria_source: "typed", criteria_count: 1 },
      delivery: { branch, pull_request_url: null, pull_request_number: null, state: "none", observed_at: at },
      history: [
        { at, from: null, to: "plan_review", note: "admitted" },
        { at, from: "plan_review", to: "ready", note: "contract approved" },
        { at, from: "ready", to: "provisioning", note: "run started" },
        { at, from: "provisioning", to: "failed", note: "the attempt did not complete: terminated" },
      ],
    });
    writeTicket(f.dir, ticket);

    const PR_URL = "https://github.com/o/r/pull/99";
    await runSyncCommand({
      argv: ["AYO-9", "--repo", f.repo],
      streams: capture(),
      cwd: f.repo,
      now: new Date(OBSERVED_AT),
      poll: () =>
        Promise.resolve(
          TicketDeliveryStateSchema.parse({
            ticket_id: ticket.ticket_id,
            branch,
            pull_request_url: PR_URL,
            pull_request_number: 99,
            state: "merged",
            merge_state: null,
            checks: [],
            observed: true,
            human_review_verdicts: [],
            finding_outcomes: {},
            candidate_missed_recall: 0,
            reverted_by: null,
            fixed_by: null,
            attempts: [],
            observed_at: OBSERVED_AT,
            stop_answers: [],
          }),
        ),
      mergeFacts: (): MergeFacts => ({
        default_branch: "main",
        merge_commit: f.merges["AYO-9"]!,
        merged_at: MERGED_AT,
        branch_commits: [],
        pull_request_url: PR_URL,
        pull_request_number: 99,
      }),
    });

    const after = readTicket(f.dir, "AYO-9");
    expect(after.state).toBe("merged");
    expect(after.history.map((entry) => entry.to)).toContain("pr_open");

    // No code change to `escapes` for this: it already reads every ticket
    // whose `state` is `merged`, whatever route got it there.
    const json = capture();
    await runEscapesCommand({ argv: ["--repo", f.repo, "--json"], streams: json, cwd: f.repo, now: READ_AT });
    const report = JSON.parse(json.out.join("")) as JsonOutput;
    expect(report.escapes.merged).toBe(1);
    expect(report.tickets.map((row) => row.ticket_key)).toContain("AYO-9");
  }, GIT_FIXTURE_TIMEOUT_MS);
});

describe("SCP-217 — each change's fourteen days are read from its own merge date", () => {
  it("calls thirteen days not yet due with its date, and fourteen and fifteen due", async () => {
    // One clock, three merges, three different distances from it. Nothing here
    // depends on the day the test runs, and nothing is passed by hand: the
    // window's start is each change's own merge and its end is fourteen days on.
    const f = await mergedDaysBeforeRead("due-by-merge-date", [15, 14, 13]);
    const read = await readReport(f);
    const rows = new Map(read.json.tickets.map((row) => [row.ticket_key, row]));

    // Thirteen days: still inside its own fourteen. Not yet due, and the day it
    // falls due is printed rather than left for the reader to work out.
    const notYet = rows.get("AYO-3")!;
    expect(notYet.due).toBe(false);
    expect(notYet.due_at).toBe("2026-09-17T00:00:00.000Z");
    expect(Date.parse(notYet.due_at!) - Date.parse(daysBeforeRead(13))).toBe(14 * 86_400_000);
    expect(read.line("AYO-3")).toContain("not yet due");
    expect(read.detail("not yet due until")).toContain("2026-09-17T00:00:00.000Z");
    expect(read.detail("not yet due until")).toContain("2026-09-03");

    // Fourteen days exactly is due — the boundary belongs to the count, not to
    // the waiting room — and fifteen has been due for a day.
    for (const [key, mergedDaysAgo] of [
      ["AYO-2", 14],
      ["AYO-1", 15],
    ] as const) {
      const row = rows.get(key)!;
      expect(row.due, `${key} merged ${mergedDaysAgo} days before the clock`).toBe(true);
      expect(row.due_at).toBe(new Date(Date.parse(daysBeforeRead(mergedDaysAgo)) + 14 * 86_400_000).toISOString());
      expect(read.line(key)).toMatch(/\bdue\b/);
      expect(read.line(key)).not.toContain("not yet due");
    }

    expect(read.json.due).toEqual({ due: 2, not_yet_due: 1, no_merge_date: 0 });
    // The two that are due are the two the rate is read over; the third is not
    // in the denominator and is not a zero in it either.
    expect(read.json.escapes.closed).toBe(2);
    expect(read.json.escapes.revert_rate.n).toBe(2);
  }, GIT_FIXTURE_TIMEOUT_MS);

  it("prints the due count and the not-yet-due count as two labelled figures, never one total", async () => {
    const f = await mergedDaysBeforeRead("due-and-not-yet-due", [20, 5]);
    const read = await readReport(f);

    for (const metric of ["escape rate (reverted, 14d)", "escape rate (same path, 14d)"]) {
      const cell = read.narrative(metric);
      expect(cell, metric).toContain("1 due");
      expect(cell, metric).toContain("1 not yet due");
      // One of each, and never "2 merged tickets": a count that adds a change
      // whose fourteen days are up to one that has been merged five days is a
      // count of neither thing.
      expect(cell, metric).not.toMatch(/\b2\b/);
    }
    expect(read.json.due).toEqual({ due: 1, not_yet_due: 1, no_merge_date: 0 });
  }, GIT_FIXTURE_TIMEOUT_MS);
});
