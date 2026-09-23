import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  TICKET_SCHEMA_VERSION,
  TicketSchema,
  type DeliveryArm,
  type Ticket,
} from "@perbo/contracts";
import { stopsCommandLine } from "./stops.js";
import {
  ESCAPE_WINDOW_DAYS,
  TICKET_ESCAPES_SCHEMA_VERSION,
  TicketEscapesSchema,
  type EscapeCommit,
} from "./escapes/index.js";
import { storeDir, writeTicket } from "../store/tickets.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

/**
 * SCP-202 criterion 4: what the loop's own merges cost, beside the share that
 * says how many of them there were.
 *
 * D-077's reversal trigger is a count, not a rate — "two in the measured
 * twenty reopen this decision" — and it is a count of the loop's **own**
 * merges: a pull request a person merged and then reverted says nothing about
 * whether the loop should merge. So the population is `delivery.merged_by`,
 * and what charges a row is the escape record `perbo sync` already writes.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-loop-merges-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MERGED_AT = "2026-08-01T00:00:00.000Z";
const OBSERVED_AT = "2026-09-01T00:00:00.000Z";
const NOW = new Date("2026-09-04T00:00:00.000Z");

function fixtureStore(name: string): string {
  const repo = join(scratch, name);
  mkdirSync(join(repo, ".perbo", "tickets"), { recursive: true });
  mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
  return repo;
}

const fixtureTicket = (input: {
  key: string;
  ticket_id: string;
  merged_by: DeliveryArm | null;
}): Ticket =>
  TicketSchema.parse({
    schema_version: TICKET_SCHEMA_VERSION,
    ticket_id: input.ticket_id,
    key: input.key,
    title: "Search results are paginated.",
    state: "merged",
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_fixture0001",
    plan_version: 1,
    approved_at: "2026-07-01T00:00:00.000Z",
    admitted_at: "2026-07-01T00:00:00.000Z",
    updated_at: MERGED_AT,
    admission: { elapsed_ms: 100, criteria_source: "typed", criteria_count: 1 },
    delivery: {
      branch: `ayo/${input.key.toLowerCase()}/pagination`,
      pull_request_url: `https://github.com/o/r/pull/1`,
      pull_request_number: 1,
      state: "merged",
      observed_at: OBSERVED_AT,
      opened_by: "loop",
      mergeable: null,
      commits_outside_loop: false,
      merged_by: input.merged_by,
    },
    history: [
      { at: "2026-07-01T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" },
      { at: MERGED_AT, from: "pr_open", to: "merged", note: "merged" },
    ],
  });

/** One escape record whose fourteen days have closed and were watched. */
function writeEscapes(
  dir: string,
  ticket: Ticket,
  charge: { reverts?: EscapeCommit[]; same_path?: EscapeCommit[] },
): void {
  const record = TicketEscapesSchema.parse({
    schema_version: TICKET_ESCAPES_SCHEMA_VERSION,
    ticket_id: ticket.ticket_id,
    ticket_key: ticket.key,
    pull_request_url: ticket.delivery.pull_request_url,
    pull_request_number: ticket.delivery.pull_request_number,
    default_branch: "main",
    merge_commit: "aaaaaaa",
    merge_subject: `${ticket.key}: paginate`,
    merged_at: MERGED_AT,
    branch_commits: [{ sha: "bbbbbbb", subject: "paginate" }],
    changed_paths: ["packages/search/page.ts"],
    window_days: ESCAPE_WINDOW_DAYS,
    window_closes_at: "2026-08-15T00:00:00.000Z",
    observed_head: { sha: "ccccccc", committed_at: OBSERVED_AT, refreshed: true },
    reverts: charge.reverts ?? [],
    same_path: charge.same_path ?? [],
    first_seen_at: OBSERVED_AT,
    observed_at: OBSERVED_AT,
  });
  writeFileSync(
    join(dir, "state", `${ticket.ticket_id}.escapes.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

const revert: EscapeCommit = {
  sha: "ddddddd",
  subject: 'Revert "AYO-1: paginate"',
  committed_at: "2026-08-04T00:00:00.000Z",
  reverts: ["aaaaaaa"],
  paths: [],
};

const samePath: EscapeCommit = {
  sha: "eeeeeee",
  subject: "search: fix the page size",
  committed_at: "2026-08-05T00:00:00.000Z",
  reverts: [],
  paths: ["packages/search/page.ts"],
};

/**
 * Four merged tickets: three the loop merged — one reverted, one re-touched on
 * the same path, one clean — and one a person merged and then reverted, which
 * is not the loop's count and must not enter it.
 */
function populated(name: string): string {
  const repo = fixtureStore(name);
  const dir = storeDir(repo, null);

  const reverted = fixtureTicket({ key: "AYO-1", ticket_id: "ticket_1", merged_by: "loop" });
  const touched = fixtureTicket({ key: "AYO-2", ticket_id: "ticket_2", merged_by: "loop" });
  const clean = fixtureTicket({ key: "AYO-3", ticket_id: "ticket_3", merged_by: "loop" });
  const persons = fixtureTicket({ key: "AYO-4", ticket_id: "ticket_4", merged_by: null });
  for (const ticket of [reverted, touched, clean, persons]) writeTicket(dir, ticket);

  writeEscapes(dir, reverted, { reverts: [revert] });
  writeEscapes(dir, touched, { same_path: [samePath] });
  writeEscapes(dir, clean, {});
  writeEscapes(dir, persons, { reverts: [revert] });
  return repo;
}

describe("ac_4 — the loop's own merges are counted beside the unattended share", () => {
  it("prints how many the loop merged and how many of those were undone inside the window", async () => {
    const repo = populated("loop-merges-table");
    const streams = recordStreams();

    const code = await runCommandLine(stopsCommandLine, { argv: ["--repo", repo], streams, cwd: repo, now: NOW });
    expect(code).toBe(EXIT_CODES.approve);
    const out = streams.out();

    // Beside the unattended share, in the same table.
    expect(out).toContain("unattended merges");
    expect(out).toMatch(/merges the loop performed\s+3\s+3 of 4 merged tickets/);
    // A revert and a same-path commit are both charges against the loop's own
    // merge, and the row says which of the two each was: `escapes` never sums
    // its two columns, and neither does this.
    expect(out).toMatch(
      new RegExp(
        `loop merges undone \\(${ESCAPE_WINDOW_DAYS}d\\)\\s+2\\s+` +
          "3 of the loop's merges with the window closed \\(1 reverted, 1 same path re-touched\\)",
      ),
    );
  });

  it("reports the same counts in --json", async () => {
    const repo = populated("loop-merges-json");
    const streams = recordStreams();

    await runCommandLine(stopsCommandLine, { argv: ["--repo", repo, "--json"], streams, cwd: repo, now: NOW });
    const report = streams.json<{ loop_merges: Record<string, number> }>();

    expect(report.loop_merges).toEqual({
      merged: 4,
      by_loop: 3,
      closed: 3,
      reverted: 1,
      same_path: 1,
      undone: 2,
      window_open: 0,
      not_observed: 0,
    });
  });
});
