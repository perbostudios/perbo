import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, HAND_OFF_NOTE, OPENER_UNKNOWN_NOTE, transition, type Ticket } from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { ListJsonSchema, listCommandLine, parseAdmitArgs, runAdmitCommand } from "./admit.js";
import type { Streams } from "../streams.js";
import { buildInspectReport } from "./inspect.js";
import { recordDelivery, runSyncCommand } from "./sync.js";
import { readContract, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { runCommandLine } from "../command-line/terminal.js";

/**
 * SCP-173: `perbo sync` on a `failed` ticket whose branch carries a pull
 * request the **loop** opened.
 *
 * SCP-157 read every pull request on a failed ticket's branch as a person
 * finishing what the loop could not, because at the time nothing else could
 * have put one there. A ticket that reached `changes_requested` behind a
 * published pull request and was then re-run can: the re-run failing leaves
 * the loop's own pull request exactly where it was. The ticket's delivery
 * record names it, and that record is the whole of the difference.
 *
 * `gh` is faked as a binary on PATH, the same way sync.handoff.test.ts does it.
 *
 * Every case spawns real `git` and `gh` processes, so each carries an explicit
 * timeout (SCP-246, in SCP-191's style) rather than vitest's five-second
 * default: on a machine also running gates and mutant attempts, that work can
 * outrun five seconds on its own.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-loop-pr-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OUTCOME = "Search results are paginated.";

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function repository(name: string): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "base"], { env: gitIdentity });
  return dir;
}

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

const admitArgv = (repo: string) => [
  "--repo",
  repo,
  "--outcome",
  OUTCOME,
  "--criterion",
  "A second page is reachable. :: a paging test",
  "--path",
  "packages/search/**",
  "--approve",
];

/** A `gh` on PATH that answers every invocation from a fixed file. */
function fakeGh(name: string, answer: { stdout: string; stderr?: string; code?: number }): string {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const stdoutFile = join(root, "stdout");
  const stderrFile = join(root, "stderr");
  writeFileSync(stdoutFile, answer.stdout);
  writeFileSync(stderrFile, answer.stderr ?? "");
  const script = join(root, "gh");
  writeFileSync(
    script,
    ["#!/bin/sh", `cat ${stdoutFile}`, `cat ${stderrFile} >&2`, `exit ${answer.code ?? 0}`, ""].join("\n"),
  );
  chmodSync(script, 0o755);
  return root;
}

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

const url = (number: number) => `https://github.com/o/r/pull/${number}`;

const ghAnswer = (number: number, state: "OPEN" | "CLOSED" | "MERGED"): string =>
  `${JSON.stringify({
    number,
    url: url(number),
    state,
    body: "",
    mergeStateStatus: state === "OPEN" ? "CLEAN" : null,
    statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviews: [],
    comments: [],
  })}\n`;

/** The pull request the loop published on the round that ended in changes_requested. */
const LOOP_PR = 41;

/**
 * A ticket the loop published a pull request for, then re-ran, and the re-run
 * failed: the shape AYO-18 has in the live store.
 *
 * Every step goes through the functions the loop itself uses — `recordDelivery`
 * for the delivery record and `transition` for the walk — so the record this
 * ends with is the record a run of that shape actually leaves, including the
 * failed re-run's own `recordDelivery`, which observed no pull request.
 */
function publishedTicket(name: string): { repo: string; dir: string; ticket: Ticket; branch: string } {
  const repo = repository(name);
  runAdmitCommand({ args: parseAdmitArgs(admitArgv(repo)), streams: capture(), cwd: repo });
  const dir = storeDir(repo, null);
  const branch = branchName({
    ticket_key: "PRB-1",
    ticket_id: readTicket(dir, "PRB-1").ticket_id,
    outcome: readContract(dir, "PRB-1").outcome,
  });

  // Run one: escalated, which publishes (D-065) and leaves the ticket in
  // changes_requested with the loop's pull request on its record.
  const first = new Date("2026-09-01T09:00:00.000Z");
  let ticket = readTicket(dir, "PRB-1");
  ticket = transition(ticket, "provisioning", "run started", first);
  ticket = transition(ticket, "executing", "1 attempt executed", first);
  ticket = transition(ticket, "verifying", "6 deterministic checks ran", first);
  ticket = transition(ticket, "independent_review", "reviewed independently", first);
  ticket = recordDelivery(
    ticket,
    { workspace: { branch }, pull_request: { url: url(LOOP_PR), number: LOOP_PR } },
    first,
  );
  ticket = transition(ticket, "changes_requested", "the gate closed: escalated", first);
  writeTicket(dir, ticket);

  return { repo, dir, ticket, branch };
}

/**
 * Run two: a re-run that failed before it could produce anything. It opened no
 * pull request, so it says nothing about the one that is still open.
 */
function failTheReRun(dir: string, branch: string, at = new Date("2026-09-02T09:00:00.000Z")): Ticket {
  let ticket = readTicket(dir, "PRB-1");
  ticket = transition(ticket, "ready", "new attempt after changes_requested", at);
  ticket = transition(ticket, "provisioning", "run started", at);
  ticket = transition(ticket, "executing", "1 attempt executed", at);
  ticket = transition(ticket, "verifying", "no deterministic checks are configured", at);
  ticket = recordDelivery(ticket, { workspace: { branch }, pull_request: null }, at);
  ticket = transition(ticket, "failed", "the attempt did not complete: no_changes", at);
  writeTicket(dir, ticket);
  return ticket;
}

function reRunFailedTicket(name: string): { repo: string; dir: string; ticket: Ticket; branch: string } {
  const published = publishedTicket(name);
  return { ...published, ticket: failTheReRun(published.dir, published.branch) };
}

const NOW = new Date("2026-09-03T10:00:00.000Z");

const lastPullRequestRow = (ticket: Ticket) =>
  ticket.history.filter((entry) => entry.to === "pr_open").at(-1)!;

describe("ac_1 — the loop's own pull request outlives a failed re-run", () => {
  it("keeps the pull request the loop opened on the record when the re-run opens none", () => {
    const { ticket } = reRunFailedTicket("record-survives");
    expect(ticket.state).toBe("failed");
    expect(ticket.delivery).toMatchObject({
      pull_request_number: LOOP_PR,
      pull_request_url: url(LOOP_PR),
      // The branch is the failed re-run's, and the pull request is still the
      // one the published round observed, dated when it was observed.
      observed_at: "2026-09-01T09:00:00.000Z",
    });
  }, 30_000);

  it("syncs to merged, crediting the loop with the pull request and marking no hand-off", async () => {
    const { repo, dir, ticket: before } = reRunFailedTicket("loop-merged");
    const gh = fakeGh("loop-merged", { stdout: ghAnswer(LOOP_PR, "MERGED") });
    const streams = capture();

    const code = await withGh(gh, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("merged");

    const written = after.history.slice(before.history.length);
    expect(written.map((entry) => ({ from: entry.from, to: entry.to }))).toEqual([
      { from: "failed", to: "pr_open" },
      { from: "pr_open", to: "merged" },
    ]);

    const opened = written[0]!;
    expect(opened.note).toContain("reconciled after the fact by `perbo sync`");
    expect(opened.note).toContain(url(LOOP_PR));
    expect(opened.note).toContain("the loop opened it");
    // Not a hand-off: not by the phrase a hand-off note carries, and not by
    // the marking `inspect` reads, which the row states rather than omits.
    expect(opened.note).not.toContain(HAND_OFF_NOTE);
    expect(opened.handed_off).toBe(false);
    // On the file too, not only on the object this process built.
    const stored = JSON.parse(readFileSync(join(dir, "tickets", "PRB-1.json"), "utf8")) as Ticket;
    expect(stored.history.some((entry) => entry.handed_off === true)).toBe(false);
  }, 30_000);

  it("walks only to pr_open when the loop's pull request is still open", async () => {
    const { repo, dir } = reRunFailedTicket("loop-open");
    const gh = fakeGh("loop-open", { stdout: ghAnswer(LOOP_PR, "OPEN") });

    const code = await withGh(gh, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("pr_open");
    expect(lastPullRequestRow(after)).toMatchObject({ from: "failed", to: "pr_open", handed_off: false });
  }, 30_000);
});

describe("ac_2 — a pull request the record has never seen is still a hand-off", () => {
  it("records the hand-off note and marking when the number on the branch is not the recorded one", async () => {
    const { repo, dir } = reRunFailedTicket("stranger-pr");
    const gh = fakeGh("stranger-pr", { stdout: ghAnswer(77, "MERGED") });

    const code = await withGh(gh, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("merged");

    const opened = lastPullRequestRow(after);
    expect(opened).toMatchObject({ from: "failed", to: "pr_open", handed_off: true });
    expect(opened.note).toContain(HAND_OFF_NOTE);
    expect(opened.note).toContain(url(77));
    // The marking is on the file, not only on the object this process built.
    const stored = JSON.parse(readFileSync(join(dir, "tickets", "PRB-1.json"), "utf8")) as Ticket;
    expect(lastPullRequestRow(stored).handed_off).toBe(true);
  }, 30_000);
});

describe("ac_2 — a pull request the record only ever saw as a stranger's stays one", () => {
  it("still calls it a hand-off when it is reopened after a sync recorded it closed", async () => {
    const { repo, dir } = reRunFailedTicket("stranger-reopened");
    const closed = fakeGh("stranger-closed", { stdout: ghAnswer(77, "CLOSED") });
    const merged = fakeGh("stranger-reopened", { stdout: ghAnswer(77, "MERGED") });

    // Sync one: a pull request nobody on this ticket opened, and closed, so
    // there is nothing to walk to. The record still takes the number, because
    // that is what `gh` says is on the branch.
    const first = await withGh(closed, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }),
    );
    expect(first).toBe(EXIT_CODES.approve);
    const between = readTicket(dir, "PRB-1");
    expect(between.state).toBe("failed");
    expect(between.delivery).toMatchObject({ pull_request_number: 77, state: "closed", opened_by: "hand_off" });

    // Sync two: the same number, now merged. The record names it — and says
    // whose it is, which is the difference between crediting the loop with a
    // stranger's pull request and not.
    const second = await withGh(merged, () =>
      runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T10:00:00.000Z"),
      }),
    );
    expect(second).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("merged");
    expect(lastPullRequestRow(after)).toMatchObject({ from: "failed", to: "pr_open", handed_off: true });
    expect(lastPullRequestRow(after).note).toContain(HAND_OFF_NOTE);
    expect(buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null }).handed_off).toBe(true);
  }, 30_000);

  it("remembers a stranger's number first seen on a ticket that was not failed yet", async () => {
    // The same loss, reached from the other side: a sync while the ticket is
    // `changes_requested` walks nothing either, and the number it writes to the
    // record is on it by the time the re-run fails.
    const { repo, dir, branch } = publishedTicket("stranger-before-failing");
    const stranger = fakeGh("stranger-before-failing", { stdout: ghAnswer(77, "OPEN") });

    await withGh(stranger, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }),
    );
    expect(readTicket(dir, "PRB-1")).toMatchObject({
      state: "changes_requested",
      delivery: { pull_request_number: 77, opened_by: "hand_off" },
    });

    failTheReRun(dir, branch, new Date("2026-09-04T09:00:00.000Z"));
    await withGh(stranger, () =>
      runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T10:00:00.000Z"),
      }),
    );

    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("pr_open");
    expect(lastPullRequestRow(after)).toMatchObject({ handed_off: true });
  }, 30_000);

  it("does not let a sync of the loop's own closed pull request change whose it is", async () => {
    const { repo, dir } = reRunFailedTicket("loop-closed-then-open");
    const closed = fakeGh("loop-closed", { stdout: ghAnswer(LOOP_PR, "CLOSED") });
    const open = fakeGh("loop-reopened", { stdout: ghAnswer(LOOP_PR, "OPEN") });

    await withGh(closed, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }),
    );
    expect(readTicket(dir, "PRB-1").delivery).toMatchObject({ state: "closed", opened_by: "loop" });

    await withGh(open, () =>
      runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T10:00:00.000Z"),
      }),
    );
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("pr_open");
    expect(lastPullRequestRow(after)).toMatchObject({ handed_off: false });
  }, 30_000);
});

describe("what a failed ticket whose latest run produced nothing shows a reader", () => {
  it("names the pull request the earlier round published, dated when it was observed", () => {
    const { repo, dir } = reRunFailedTicket("reader-surfaces");
    const ticket = readTicket(dir, "PRB-1");

    // `inspect` first: the pull request is the one still open on the branch,
    // and no hand-off is claimed for it.
    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.state).toBe("failed");
    expect(report.pull_request_url).toBe(url(LOOP_PR));
    expect(report.handed_off).toBe(false);

    // `list --json` carries the record verbatim, so it is where the whole of it
    // is visible: open, at the number the loop opened, dated at the round that
    // observed it and not at the run that failed afterwards.
    const streams = capture();
    const code = runCommandLine(listCommandLine, { argv: ["--repo", repo, "--all", "--json"], streams, cwd: repo });
    expect(code).toBe(EXIT_CODES.approve);
    const listed = ListJsonSchema.parse(JSON.parse(streams.out.join("")));
    expect(listed.tickets).toHaveLength(1);
    expect(listed.tickets[0]!.delivery).toEqual({
      branch: ticket.delivery.branch,
      pull_request_url: url(LOOP_PR),
      pull_request_number: LOOP_PR,
      state: "open",
      observed_at: "2026-09-01T09:00:00.000Z",
      opened_by: "loop",
      // SCP-192/SCP-196: written by `perbo sync` from `gh`, and this record
      // was left by the loop's own run, which never asked either.
      mergeable: null,
      commits_outside_loop: null,
      // SCP-200: the fixture's `recordDelivery` names no credential, because
      // this record stands in for a run that opened the pull request rather
      // than for one this test drove.
      github_credential: null,
      // SCP-206: `recordDelivery` writes the loop's own arm, which is the only
      // one it is ever first-hand about.
      arm: "loop",
      // SCP-202: nothing merged this, and a run that opened a pull request is
      // not first-hand about a merge that has not happened.
      merged_by: null,
      // The re-run's review resolved its criteria, so it took neither of the
      // two paths an incomplete one takes.
      incomplete_review: null,
      // SCP-240: the fixture's `recordDelivery` was handed no reading of the
      // head's checks, which is what a record written before anything read
      // them holds — and `null` is not `green`.
      checks: [],
      checks_state: null,
    });
    // The ticket itself moved on at the failed re-run; the record did not, and
    // says so in its own timestamp rather than borrowing this one.
    expect(listed.tickets[0]!.updated_at).toBe("2026-09-02T09:00:00.000Z");
  }, 30_000);
});

describe("ac_3 — inspect reads the hand-off off the row, not off the edge", () => {
  it("reports handed_off false for the loop's pull request, whose row is still failed -> pr_open", async () => {
    const { repo, dir } = reRunFailedTicket("inspect-loop");
    const gh = fakeGh("inspect-loop", { stdout: ghAnswer(LOOP_PR, "MERGED") });
    await withGh(gh, () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }));

    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.handed_off).toBe(false);
    // The edge the old derivation read is still there, and still says nothing.
    expect(readTicket(dir, "PRB-1").history).toContainEqual(
      expect.objectContaining({ from: "failed", to: "pr_open" }),
    );
  }, 30_000);

  it("reports handed_off true for a pull request the record never saw", async () => {
    const { repo, dir } = reRunFailedTicket("inspect-handoff");
    const gh = fakeGh("inspect-handoff", { stdout: ghAnswer(77, "MERGED") });
    await withGh(gh, () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }));

    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.handed_off).toBe(true);
  }, 30_000);
});

describe("ac_4 — SCP-176: an opener neither the record nor the history can attribute is left unrecorded", () => {
  it("walks the failed ticket to pr_open and writes a note that says the opener is not recorded", async () => {
    const { repo, dir } = reRunFailedTicket("unrecorded-opener");
    // Simulate the shape a delivery record has from before SCP-173 decided
    // `opened_by`: the same pull request the published round observed, with
    // no opener on it — and this ticket's history never reached `pr_open` (it
    // went to `changes_requested` instead), so there is nothing else to
    // attribute it from.
    const before = readTicket(dir, "PRB-1");
    writeTicket(dir, { ...before, delivery: { ...before.delivery, opened_by: null } });
    const gh = fakeGh("unrecorded-opener", { stdout: ghAnswer(LOOP_PR, "OPEN") });

    const code = await withGh(gh, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("pr_open");

    const opened = lastPullRequestRow(after);
    expect(opened).not.toHaveProperty("handed_off");
    expect(opened.note).toContain(OPENER_UNKNOWN_NOTE);
    expect(opened.note).not.toContain(HAND_OFF_NOTE);
    // On the file too, not only on the object this process built.
    const stored = JSON.parse(readFileSync(join(dir, "tickets", "PRB-1.json"), "utf8")) as Ticket;
    expect(lastPullRequestRow(stored)).not.toHaveProperty("handed_off");

    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.handed_off).toBeNull();
  }, 30_000);
});
