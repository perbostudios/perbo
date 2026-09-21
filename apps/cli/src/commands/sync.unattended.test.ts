import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, TICKET_SCHEMA_VERSION, TicketSchema, transition, type Ticket } from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { admitCommandLine } from "./admit.js";
import type { Streams } from "../streams.js";
import { makeAttempt } from "../test-support/attempt-fixture.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../test-support/spawn-timeout.js";
import { recordDelivery, runSyncCommand } from "./sync.js";
import { stopsCommandLine } from "./stops.js";
import { readContract, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { runCommandLine } from "../command-line/terminal.js";

/**
 * SCP-196: the loop's own success as a live number.
 *
 * Two halves. The first drives `perbo sync` against a fake `gh` that answers
 * `--json ...,commits`, the same way sync.mergeable.test.ts drives the
 * `mergeable` field it sits beside — proving `commits_outside_loop` is read
 * from each commit's own message rather than its author. The second drives
 * `perbo stops` over ticket and attempts fixtures written directly, proving
 * the share, the interval, `n` and the cost print, and that `--since` and
 * `--json` bound and shape the same numbers the other measures do.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-unattended-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

/* ------------------------------------------------------------------ *
 * `perbo sync`: `commits_outside_loop` read from `gh pr view --json commits`.
 * ------------------------------------------------------------------ */

const OUTCOME = "Search results are paginated.";
const PR = 71;
const url = `https://github.com/o/r/pull/${PR}`;

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** A `gh` on PATH that answers every invocation from one fixed body. */
function fakeGh(name: string, stdout: string): string {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const body = join(root, "stdout");
  writeFileSync(body, stdout);
  const script = join(root, "gh");
  writeFileSync(script, ["#!/bin/sh", `cat ${body}`, "exit 0", ""].join("\n"));
  chmodSync(script, 0o755);
  return root;
}

interface FakeCommit {
  oid: string;
  messageHeadline: string;
  messageBody: string;
}

const ghAnswer = (state: "OPEN" | "MERGED", commits: FakeCommit[]): string =>
  `${JSON.stringify({
    number: PR,
    url,
    state,
    body: "",
    mergeable: "MERGEABLE",
    mergeStateStatus: state === "OPEN" ? "CLEAN" : null,
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    commits,
  })}\n`;

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
});

/**
 * The `gh` on PATH, and the credential the sync reads GitHub through.
 *
 * `GH_TOKEN` is set rather than inherited: SCP-200 decides the credential path
 * before the read, so a suite that let the machine's own environment decide it
 * would ask `gh auth status` on one developer's machine and not on another's.
 */
const withGh = <T,>(bin: string, body: () => Promise<T>): Promise<T> => {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.GH_TOKEN = "test-token";
  delete process.env.GITHUB_TOKEN;
  return body();
};

/** A ticket sitting at `pr_open` behind a pull request the loop published. */
function publishedTicket(name: string): { repo: string; dir: string; branch: string } {
  const repo = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"], { env: gitIdentity });
  runCommandLine(admitCommandLine, {
    argv: [
      "--repo",
      repo,
      "--outcome",
      OUTCOME,
      "--criterion",
      "A second page is reachable. :: a paging test",
      "--path",
      "packages/search/**",
      "--approve",
    ],
    streams: capture(),
    cwd: repo,
  });
  const dir = storeDir(repo, null);
  const branch = branchName({
    ticket_key: "PRB-1",
    ticket_id: readTicket(dir, "PRB-1").ticket_id,
    outcome: readContract(dir, "PRB-1").outcome,
  });

  const at = new Date("2026-09-04T09:00:00.000Z");
  let ticket: Ticket = readTicket(dir, "PRB-1");
  ticket = transition(ticket, "provisioning", "run started", at);
  ticket = transition(ticket, "executing", "1 attempt executed", at);
  ticket = transition(ticket, "verifying", "no deterministic checks are configured", at);
  ticket = transition(ticket, "independent_review", "reviewed independently", at);
  ticket = recordDelivery(ticket, { workspace: { branch }, pull_request: { url, number: PR } }, at);
  ticket = transition(ticket, "pr_open", "approved; a human merges it", at);
  writeTicket(dir, ticket);
  return { repo, dir, branch };
}

const NOW = new Date("2026-09-04T10:00:00.000Z");

describe("sync reads commits_outside_loop from gh, by message, not by author", () => {
  it("records no commit outside the loop when every commit carries the attempt trailer", async () => {
    const { repo, dir } = publishedTicket("all-loop");
    const streams = capture();

    const code = await withGh(
      fakeGh("all-loop", ghAnswer("MERGED", [
        { oid: "c1", messageHeadline: "PRB-1: pagination", messageBody: "Attempt: att_1\nBase: aaa\n" },
        { oid: "c2", messageHeadline: "PRB-1: merge main into the attempt branch", messageBody: "Attempt: att_1\nBase: bbb\n" },
      ])),
      () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("merged");
    expect(ticket.delivery.commits_outside_loop).toBe(false);
  });

  it("records a commit outside the loop when one carries no attempt trailer — never checking who git says wrote it", async () => {
    const { repo, dir } = publishedTicket("one-person-commit");
    const streams = capture();

    await withGh(
      fakeGh("one-person-commit", ghAnswer("MERGED", [
        { oid: "c1", messageHeadline: "PRB-1: pagination", messageBody: "Attempt: att_1\nBase: aaa\n" },
        // No trailer: a person's commit, pushed under the same author identity
        // the loop uses — the message is what tells them apart, not the name.
        { oid: "c2", messageHeadline: "fix the off-by-one the review missed", messageBody: "" },
      ])),
      () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(readTicket(dir, "PRB-1").delivery.commits_outside_loop).toBe(true);
  });

  it("leaves it null when gh names no commits to judge", async () => {
    const { repo, dir } = publishedTicket("no-commits-field");
    const streams = capture();

    await withGh(fakeGh("no-commits-field", ghAnswer("OPEN", [])), () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(readTicket(dir, "PRB-1").delivery.commits_outside_loop).toBeNull();
  });
}, SPAWN_TEST_TIMEOUT_MS);

/* ------------------------------------------------------------------ *
 * `perbo stops`: the share, the interval, `n`, and the cost — over ticket
 * and attempts records written directly, the way `apps/cli/src/commands/stops.test.ts`
 * writes stops records directly.
 * ------------------------------------------------------------------ */

const fixtureTicket = (input: {
  key: string;
  ticket_id: string;
  state: Ticket["state"];
  opened_by: "loop" | "hand_off" | null;
  commits_outside_loop: boolean | null;
  merged_at: string;
}): Ticket =>
  TicketSchema.parse({
    schema_version: TICKET_SCHEMA_VERSION,
    ticket_id: input.ticket_id,
    key: input.key,
    title: "Search results are paginated.",
    state: input.state,
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_fixture0001",
    plan_version: 1,
    approved_at: "2026-09-01T00:00:00.000Z",
    admitted_at: "2026-09-01T00:00:00.000Z",
    updated_at: input.merged_at,
    admission: { elapsed_ms: 100, criteria_source: "typed", criteria_count: 1 },
    delivery: {
      branch: `ayo/${input.key.toLowerCase()}/pagination`,
      pull_request_url: `https://github.com/o/r/pull/${input.ticket_id}`,
      pull_request_number: 1,
      state: input.state === "merged" ? "merged" : "open",
      observed_at: input.merged_at,
      opened_by: input.opened_by,
      mergeable: null,
      commits_outside_loop: input.commits_outside_loop,
    },
    history: [
      { at: "2026-09-01T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" },
      ...(input.state === "merged"
        ? [{ at: input.merged_at, from: "pr_open" as const, to: "merged" as const, note: "merged" }]
        : []),
    ],
  });

function fixtureStore(name: string): string {
  const repo = join(scratch, name);
  mkdirSync(join(repo, ".perbo", "tickets"), { recursive: true });
  mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
  return repo;
}

function writeAttempts(dir: string, ticket_id: string, attempts: ReturnType<typeof makeAttempt>[]): void {
  writeFileSync(
    join(dir, "state", `${ticket_id}.attempts.json`),
    `${JSON.stringify({ ticket_id, attempts }, null, 2)}\n`,
  );
}

const priced = (ticket_id: string, micros: number) =>
  makeAttempt({
    attempt_id: `att_${ticket_id}_${micros}`,
    ticket_id,
    created_at: "2026-09-01T00:00:00.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { cost_micros: micros, cost_basis: "transport_reported" },
    changeset_id: "cs_1",
    head_commit: "abc1234",
  });

describe("perbo stops prints D-076's number beside D-060's", () => {
  it("counts unattended and attended merges, with an interval and n, and the cost beside it", async () => {
    const repo = fixtureStore("unattended-basic");
    const dir = storeDir(repo, null);

    const unattended1 = fixtureTicket({
      key: "AYO-1",
      ticket_id: "ticket_1",
      state: "merged",
      opened_by: "loop",
      commits_outside_loop: false,
      merged_at: "2026-09-02T00:00:00.000Z",
    });
    const unattended2 = fixtureTicket({
      key: "AYO-2",
      ticket_id: "ticket_2",
      state: "merged",
      opened_by: "loop",
      commits_outside_loop: false,
      merged_at: "2026-09-02T00:00:00.000Z",
    });
    const attended = fixtureTicket({
      key: "AYO-3",
      ticket_id: "ticket_3",
      state: "merged",
      opened_by: "hand_off",
      commits_outside_loop: null,
      merged_at: "2026-09-02T00:00:00.000Z",
    });
    for (const ticket of [unattended1, unattended2, attended]) writeTicket(dir, ticket);

    writeAttempts(dir, "ticket_1", [priced("ticket_1", 2_500_000)]);
    writeAttempts(dir, "ticket_2", [priced("ticket_2", 1_500_000)]);
    // AYO-3 (hand-off, merged by a person) has no attempts record at all: the
    // loop never ran a completed attempt against it, and a merged ticket with
    // nothing recorded must not crash the reading.

    const streams = capture();
    const code = await runCommandLine(stopsCommandLine, { argv: ["--repo", repo], streams, cwd: repo });
    expect(code).toBe(EXIT_CODES.approve);
    const out = streams.out.join("");
    expect(out).toMatch(/unattended merges\s+67%\s+\[21–94\]\s+3 merged tickets with a known answer \(2 unattended, 1 attended\)/);
    expect(out).toMatch(
      /cost per merged ticket\s+\$1\.3333\s+3 merged tickets, 2 attempts, 2 cost components \(2 priced\)/,
    );
  });

  it("names an unpriced attempt rather than dropping it", async () => {
    const repo = fixtureStore("unattended-unpriced");
    const dir = storeDir(repo, null);
    const ticket = fixtureTicket({
      key: "AYO-1",
      ticket_id: "ticket_1",
      state: "merged",
      opened_by: "loop",
      commits_outside_loop: false,
      merged_at: "2026-09-02T00:00:00.000Z",
    });
    writeTicket(dir, ticket);
    writeAttempts(dir, "ticket_1", [
      makeAttempt({
        attempt_id: "att_unpriced",
        ticket_id: "ticket_1",
        created_at: "2026-09-01T00:00:00.000Z",
        termination: { reason: "completed", detail: "" },
        usage: { cost_micros: 0, cost_basis: "unavailable" },
        changeset_id: "cs_1",
        head_commit: "abc1234",
      }),
    ]);

    const streams = capture();
    await runCommandLine(stopsCommandLine, { argv: ["--repo", repo], streams, cwd: repo });
    expect(streams.out.join("")).toContain("AYO-1/att_unpriced");
  });

  it("emits the same numbers as JSON", async () => {
    const repo = fixtureStore("unattended-json");
    const dir = storeDir(repo, null);
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-1",
        ticket_id: "ticket_1",
        state: "merged",
        opened_by: "loop",
        commits_outside_loop: false,
        merged_at: "2026-09-02T00:00:00.000Z",
      }),
    );
    writeAttempts(dir, "ticket_1", [priced("ticket_1", 4_000_000)]);

    const streams = capture();
    await runCommandLine(stopsCommandLine, { argv: ["--repo", repo, "--json"], streams, cwd: repo });
    const parsed = JSON.parse(streams.out.join("")) as {
      unattended_merges: { merged: number; unattended: number; attended: number; unknown: number; share: { point: number; n: number } };
      merged_cost: { tickets: number; attempts: number; priced: number; micros: number };
    };
    expect(parsed.unattended_merges.merged).toBe(1);
    expect(parsed.unattended_merges.unattended).toBe(1);
    expect(parsed.unattended_merges.share.point).toBe(1);
    expect(parsed.merged_cost.tickets).toBe(1);
    expect(parsed.merged_cost.micros).toBe(4_000_000);
  });

  it("bounds the population by --since, reading each ticket's own merge time", async () => {
    const repo = fixtureStore("unattended-since");
    const dir = storeDir(repo, null);
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-1",
        ticket_id: "ticket_1",
        state: "merged",
        opened_by: "loop",
        commits_outside_loop: false,
        merged_at: "2026-09-01T00:00:00.000Z",
      }),
    );
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-2",
        ticket_id: "ticket_2",
        state: "merged",
        opened_by: "hand_off",
        commits_outside_loop: null,
        merged_at: "2026-09-03T00:00:00.000Z",
      }),
    );

    const streams = capture();
    await runCommandLine(stopsCommandLine, { argv: ["--repo", repo, "--since", "2026-09-02", "--json"], streams, cwd: repo });
    const parsed = JSON.parse(streams.out.join("")) as {
      unattended_merges: { merged: number; attended: number };
    };
    // Only AYO-2 merged inside the window; AYO-1 (before it) is excluded
    // entirely rather than counted as a miss.
    expect(parsed.unattended_merges.merged).toBe(1);
    expect(parsed.unattended_merges.attended).toBe(1);
  });

  it("does not crash when a ticket's attempts record is unreadable, and names it", async () => {
    const repo = fixtureStore("unattended-bad-attempts");
    const dir = storeDir(repo, null);
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-1",
        ticket_id: "ticket_1",
        state: "merged",
        opened_by: "loop",
        commits_outside_loop: false,
        merged_at: "2026-09-02T00:00:00.000Z",
      }),
    );
    writeFileSync(join(dir, "state", "ticket_1.attempts.json"), "{not json");

    const streams = capture();
    const code = await runCommandLine(stopsCommandLine, { argv: ["--repo", repo], streams, cwd: repo });
    expect(code).toBe(EXIT_CODES.approve);
    expect(streams.err.join("")).toContain("AYO-1");
    expect(streams.out.join("")).toMatch(/unattended merges\s+100%/);
  });
});
