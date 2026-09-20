import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES, TICKET_SCHEMA_VERSION, TicketSchema, wilsonInterval, type Ticket } from "@perbo/contracts";
import { GithubCredentialError, TicketDeliveryStateSchema, type TicketDeliveryState } from "@perbo/runner";
import type { Streams } from "../streams.js";
import { runStopsCommand } from "./stops.js";
import { runSyncCommand } from "./sync.js";
import { readTicket, storeDir, writeTicket } from "../store/tickets.js";

/**
 * SCP-203: `perbo sync --all-merged` reads every merged ticket's pull
 * request once and fills `commits_outside_loop` and `github_credential` —
 * the SCP-196/SCP-200 fields that did not exist when this store's first
 * sixteen merges last synced, which is why `unattended merges` reads
 * "16 not yet decided" today.
 *
 * Every fixture ticket is written straight to the store the way the `stops`
 * half of unattended.test.ts does it, not through `perbo admit`: nothing
 * here needs a real `git` repository, only a ticket store shaped like the
 * live one, so no test spawns a process and none declares a spawn deadline.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-all-merged-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

function fixtureStore(name: string): string {
  const repo = join(scratch, name);
  mkdirSync(join(repo, ".perbo", "tickets"), { recursive: true });
  mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
  return repo;
}

/** One merged (or not) ticket, written the way the live store shapes one. */
function fixtureTicket(input: {
  key: string;
  ticket_id: string;
  state: Ticket["state"];
  delivery_state: "none" | "open" | "closed" | "merged";
  opened_by: "loop" | "hand_off" | null;
  commits_outside_loop: boolean | null;
  branch?: string | null;
}): Ticket {
  const at = "2026-09-01T00:00:00.000Z";
  return TicketSchema.parse({
    schema_version: TICKET_SCHEMA_VERSION,
    ticket_id: input.ticket_id,
    key: input.key,
    title: "Fixture ticket",
    state: input.state,
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_fixture0001",
    plan_version: 1,
    approved_at: at,
    admitted_at: at,
    updated_at: at,
    admission: { elapsed_ms: 100, criteria_source: "typed", criteria_count: 1 },
    delivery: {
      branch: input.branch === undefined ? `ayo/${input.key.toLowerCase()}/branch` : input.branch,
      pull_request_url: `https://github.com/o/r/pull/${input.ticket_id}`,
      pull_request_number: 1,
      state: input.delivery_state,
      observed_at: at,
      opened_by: input.opened_by,
      mergeable: null,
      commits_outside_loop: input.commits_outside_loop,
      github_credential: null,
    },
    history: [
      { at, from: null, to: "plan_review", note: "admitted" },
      ...(input.state === "merged" ? [{ at, from: "pr_open" as const, to: "merged" as const, note: "merged" }] : []),
    ],
  });
}

const NOW = new Date("2026-09-04T12:00:00.000Z");

/** A `pollPullRequest`-shaped answer, defaulted to a clean merged read. */
const observed = (over: Partial<TicketDeliveryState> & { pull_request_number: number }): TicketDeliveryState =>
  TicketDeliveryStateSchema.parse({
    ticket_id: "t",
    branch: "b",
    pull_request_url: `https://github.com/o/r/pull/${over.pull_request_number}`,
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
    observed_at: "2026-09-04T11:00:00.000Z",
    stop_answers: [],
    ...over,
  });

describe("ac_1 — the sweep visits every ticket whose delivery is merged, once, and leaves a known answer alone", () => {
  it("polls only the tickets whose delivery reports merged, including one whose own state has not caught up", async () => {
    const repo = fixtureStore("visit-count");
    const dir = storeDir(repo, null);
    const mergedAndCaughtUp = fixtureTicket({
      key: "AYO-1",
      ticket_id: "ticket_1",
      state: "merged",
      delivery_state: "merged",
      opened_by: "loop",
      commits_outside_loop: null,
    });
    const stillOpen = fixtureTicket({
      key: "AYO-2",
      ticket_id: "ticket_2",
      state: "pr_open",
      delivery_state: "open",
      opened_by: "loop",
      commits_outside_loop: null,
    });
    const closedNoMerge = fixtureTicket({
      key: "AYO-3",
      ticket_id: "ticket_3",
      state: "changes_requested",
      delivery_state: "closed",
      opened_by: "hand_off",
      commits_outside_loop: null,
    });
    // AYO-10/AYO-18's shape in the live store: a person finished the ticket
    // by hand after the loop's own run had already left it `failed`, so the
    // delivery record reports `merged` while the ticket's own state does not.
    const handFinishedAfterFailure = fixtureTicket({
      key: "AYO-4",
      ticket_id: "ticket_4",
      state: "failed",
      delivery_state: "merged",
      opened_by: "hand_off",
      commits_outside_loop: null,
    });
    for (const ticket of [mergedAndCaughtUp, stillOpen, closedNoMerge, handFinishedAfterFailure]) {
      writeTicket(dir, ticket);
    }

    const calls: string[] = [];
    const code = await runSyncCommand({
      argv: ["--all-merged", "--repo", repo],
      streams: capture(),
      cwd: repo,
      now: NOW,
      poll: (call) => {
        calls.push(call.ticket_id);
        return Promise.resolve(observed({ pull_request_number: 1, commits_outside_loop: false }));
      },
    });

    expect(code).toBe(EXIT_CODES.approve);
    expect(calls.sort()).toEqual(["ticket_1", "ticket_4"]);
    expect(readTicket(dir, "AYO-1").delivery.commits_outside_loop).toBe(false);
    expect(readTicket(dir, "AYO-4").delivery.commits_outside_loop).toBe(false);
    // Untouched: the poll was never asked about either.
    expect(readTicket(dir, "AYO-2").delivery.commits_outside_loop).toBeNull();
    expect(readTicket(dir, "AYO-3").delivery.commits_outside_loop).toBeNull();
  });

  it("leaves a ticket with a known commits_outside_loop untouched, and only --force re-reads it", async () => {
    const repo = fixtureStore("skip-known");
    const dir = storeDir(repo, null);
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-1",
        ticket_id: "ticket_1",
        state: "merged",
        delivery_state: "merged",
        opened_by: "loop",
        commits_outside_loop: false,
      }),
    );

    let calls = 0;
    const poll = () => {
      calls += 1;
      return Promise.resolve(observed({ pull_request_number: 1, commits_outside_loop: true }));
    };

    const withoutForce = await runSyncCommand({
      argv: ["--all-merged", "--repo", repo],
      streams: capture(),
      cwd: repo,
      now: NOW,
      poll,
    });
    expect(withoutForce).toBe(EXIT_CODES.approve);
    expect(calls).toBe(0);
    expect(readTicket(dir, "AYO-1").delivery.commits_outside_loop).toBe(false);

    const withForce = await runSyncCommand({
      argv: ["--all-merged", "--force", "--repo", repo],
      streams: capture(),
      cwd: repo,
      now: NOW,
      poll,
    });
    expect(withForce).toBe(EXIT_CODES.approve);
    expect(calls).toBe(1);
    expect(readTicket(dir, "AYO-1").delivery.commits_outside_loop).toBe(true);
  });
});

describe("ac_2 — one line per ticket, a closing count, and an unreadable pull request is skipped rather than failing the run", () => {
  it("prints id, opened_by and commits_outside_loop, and marks a pull request gh has no credential to read as unreadable", async () => {
    const repo = fixtureStore("print-and-skip");
    const dir = storeDir(repo, null);
    const readable = fixtureTicket({
      key: "AYO-1",
      ticket_id: "ticket_1",
      state: "merged",
      delivery_state: "merged",
      opened_by: "loop",
      commits_outside_loop: null,
    });
    const unreadable = fixtureTicket({
      key: "AYO-2",
      ticket_id: "ticket_2",
      state: "merged",
      delivery_state: "merged",
      opened_by: "loop",
      commits_outside_loop: null,
    });
    for (const ticket of [readable, unreadable]) writeTicket(dir, ticket);

    const streams = capture();
    const code = await runSyncCommand({
      argv: ["--all-merged", "--repo", repo],
      streams,
      cwd: repo,
      now: NOW,
      poll: (call) => {
        if (call.ticket_id === "ticket_2") {
          throw new GithubCredentialError("gh is not logged in and no GH_TOKEN is set");
        }
        return Promise.resolve(observed({ pull_request_number: 1, commits_outside_loop: false }));
      },
    });

    expect(code).toBe(EXIT_CODES.approve);
    const out = streams.out.join("");
    expect(out).toContain("AYO-1  loop  false\n");
    expect(out).toContain("AYO-2  unreadable: gh is not logged in and no GH_TOKEN is set\n");
    expect(out).toContain("2 merged tickets: 1 filled, 0 unchanged, 1 unreadable\n");
    // Skipped, not failed: the readable ticket's write still lands, the
    // unreadable one's record is exactly what it was before the run.
    expect(readTicket(dir, "AYO-1").delivery.commits_outside_loop).toBe(false);
    expect(readTicket(dir, "AYO-2")).toEqual(unreadable);
  });

  it("also treats a pull request `gh` could not be asked about (rather than refused outright) as unreadable, not failed", async () => {
    const repo = fixtureStore("gh-empty-answer");
    const dir = storeDir(repo, null);
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-1",
        ticket_id: "ticket_1",
        state: "merged",
        delivery_state: "merged",
        opened_by: "loop",
        commits_outside_loop: null,
      }),
    );

    const streams = capture();
    const code = await runSyncCommand({
      argv: ["--all-merged", "--repo", repo],
      streams,
      cwd: repo,
      now: NOW,
      poll: () => Promise.resolve(observed({ pull_request_number: 1, observed: false })),
    });

    expect(code).toBe(EXIT_CODES.approve);
    expect(streams.out.join("")).toContain("AYO-1  unreadable:");
    expect(streams.out.join("")).toContain("1 merged ticket: 0 filled, 0 unchanged, 1 unreadable\n");
    expect(readTicket(dir, "AYO-1").delivery.commits_outside_loop).toBeNull();
  });
});

describe("ac_3 — after the sweep, `perbo stops` prints the unattended-merges row with n = 16 and its Wilson interval", () => {
  it("fills every merged ticket's commits_outside_loop so the row reads a known share instead of \"not yet decided\"", async () => {
    const repo = fixtureStore("stops-row");
    const dir = storeDir(repo, null);

    // Sixteen merged tickets, none yet read against commits_outside_loop —
    // the shape SCP-196 left this store's first sixteen merges in.
    const tickets: Ticket[] = [];
    for (let i = 1; i <= 16; i += 1) {
      tickets.push(
        fixtureTicket({
          key: `AYO-${i}`,
          ticket_id: `ticket_${i}`,
          state: "merged",
          delivery_state: "merged",
          opened_by: i <= 5 ? "hand_off" : "loop",
          commits_outside_loop: null,
        }),
      );
    }
    for (const ticket of tickets) writeTicket(dir, ticket);

    const syncStreams = capture();
    const syncCode = await runSyncCommand({
      argv: ["--all-merged", "--repo", repo],
      streams: syncStreams,
      cwd: repo,
      now: NOW,
      poll: (call) =>
        Promise.resolve(
          observed({
            pull_request_number: 1,
            // Three of the eleven loop-opened pull requests carry a person's
            // commit; the rest merged with only the loop's own.
            commits_outside_loop: ["ticket_6", "ticket_7", "ticket_8"].includes(call.ticket_id),
          }),
        ),
    });
    expect(syncCode).toBe(EXIT_CODES.approve);
    expect(syncStreams.out.join("")).toContain("16 merged tickets: 16 filled, 0 unchanged, 0 unreadable\n");

    const stopsStreams = capture();
    const stopsCode = await runStopsCommand({ argv: ["--repo", repo], streams: stopsStreams, cwd: repo });
    expect(stopsCode).toBe(EXIT_CODES.approve);
    const out = stopsStreams.out.join("");

    expect(out).not.toContain("not yet decided");
    // 5 hand_off (always attended) + 3 loop pull requests with a person's
    // commit = 8 attended; the other 8 loop pull requests are unattended.
    expect(out).toMatch(/unattended merges\s+\d+%\s+\[\d+–\d+\]\s+16 merged tickets with a known answer \(8 unattended, 8 attended\)/);

    const expected = wilsonInterval(8, 16);
    expect(out).toContain(`[${Math.round(expected.low * 100)}–${Math.round(expected.high * 100)}]`);
  });
});
