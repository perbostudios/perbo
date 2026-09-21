import { describe, expect, it } from "vitest";
import { wilsonInterval } from "@perbo/contracts";
import {
  ESCAPE_WINDOW_DAYS,
  TICKET_ESCAPES_SCHEMA_VERSION,
  classifyEscapes,
  escapeRow,
  escapeStatus,
  revertedCommits,
  summariseEscapes,
  type ObservedCommit,
  type TicketEscapes,
} from "./record.js";

/**
 * The arithmetic behind `perbo escapes` (SCP-145): which later commit counts,
 * which window it counts in, and the rate the two columns produce — never one
 * rate over both.
 */

const MERGED = "2026-08-01T00:00:00.000Z";
const merge = { sha: "a".repeat(40), subject: "Merge pull request #7 from ayo/thing" };
const branchCommit = { sha: "b".repeat(40), subject: "the change itself" };

const later = (over: Partial<ObservedCommit>): ObservedCommit => ({
  sha: "c".repeat(40),
  subject: "unrelated",
  body: "",
  committed_at: "2026-08-02T00:00:00.000Z",
  paths: [],
  ...over,
});

const classify = (commits: ObservedCommit[]) =>
  classifyEscapes({
    merge,
    branch_commits: [branchCommit],
    changed_paths: ["src/auth.ts", "src/token.ts"],
    later: commits,
    merged_at: MERGED,
  });

/** A written record, as `sync` leaves one behind. */
const record = (over: Partial<TicketEscapes> = {}): TicketEscapes => ({
  schema_version: TICKET_ESCAPES_SCHEMA_VERSION,
  ticket_id: "ticket_0000000000000001",
  ticket_key: "AYO-1",
  pull_request_url: null,
  pull_request_number: null,
  default_branch: "main",
  merge_commit: merge.sha,
  merge_subject: merge.subject,
  merged_at: MERGED,
  branch_commits: [branchCommit],
  changed_paths: ["src/auth.ts"],
  window_days: ESCAPE_WINDOW_DAYS,
  window_closes_at: "2026-08-15T00:00:00.000Z",
  observed_head: { sha: "f".repeat(40), committed_at: "2026-08-20T00:00:00.000Z", refreshed: true },
  reverts: [],
  same_path: [],
  first_seen_at: MERGED,
  observed_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("what counts as a revert", () => {
  it("reads the trailer git writes, by sha prefix in either direction", () => {
    expect(
      revertedCommits({ subject: "anything", body: `This reverts commit ${merge.sha}.` }, [merge]),
    ).toEqual([merge.sha]);
    expect(
      revertedCommits({ subject: "anything", body: "This reverts commit aaaaaaa." }, [merge]),
    ).toEqual([merge.sha]);
  });

  it("reads a Revert \"…\" subject quoting the merge or one of its commits", () => {
    expect(revertedCommits({ subject: `Revert "${merge.subject}"`, body: "" }, [merge])).toEqual([
      merge.sha,
    ]);
    expect(
      revertedCommits({ subject: `Revert "${branchCommit.subject}"`, body: "" }, [merge, branchCommit]),
    ).toEqual([branchCommit.sha]);
  });

  it("does not claim a revert of somebody else's commit", () => {
    expect(
      revertedCommits({ subject: 'Revert "another ticket"', body: "This reverts commit deadbeef." }, [
        merge,
        branchCommit,
      ]),
    ).toEqual([]);
  });
});

describe("the fourteen-day window", () => {
  it("counts a commit on the last day and not the one after it", () => {
    const inside = later({
      sha: "d".repeat(40),
      committed_at: "2026-08-15T00:00:00.000Z",
      paths: ["src/auth.ts"],
    });
    const outside = later({
      sha: "e".repeat(40),
      committed_at: "2026-08-15T00:00:00.001Z",
      paths: ["src/auth.ts"],
    });
    const result = classify([inside, outside]);
    expect(result.window_closes_at).toBe("2026-08-15T00:00:00.000Z");
    expect(result.same_path.map((commit) => commit.sha)).toEqual([inside.sha]);
  });

  it("is open or closed against now, never against the moment the record was written", () => {
    // Written on day eight, when the window still had six days to run.
    const early = record({ observed_at: "2026-08-09T00:00:00.000Z" });
    expect(escapeStatus(early, "2026-08-09T00:00:00.000Z")).toBe("window open");
    expect(escapeStatus(early, "2026-08-14T23:59:59.999Z")).toBe("window open");
    // A year later that same file must not still be reading `window open`: the
    // window closed, nobody looked, and the record is stale rather than clean.
    expect(escapeStatus(early, "2027-08-09T00:00:00.000Z")).toBe("stale");
    // Synced again after the window closed, it is evidence at last.
    expect(escapeStatus(record({ observed_at: "2026-08-15T00:00:00.000Z" }), "2027-01-01T00:00:00.000Z")).toBe(
      "observed",
    );
  });

  it("reaches no further than a checkout that was never brought up to date", () => {
    // The fetch did not happen, so the newest commit in the clone — day two —
    // is as far as this observation is evidence, whatever its timestamp says.
    const behind = record({
      observed_at: "2026-09-01T00:00:00.000Z",
      observed_head: { sha: "f".repeat(40), committed_at: "2026-08-03T00:00:00.000Z", refreshed: false },
    });
    expect(escapeStatus(behind, "2026-09-01T00:00:00.000Z")).toBe("stale");
    const row = escapeRow({
      ticket: { ticket_id: "ticket_0000000000000001", key: "AYO-1" },
      record: behind,
      dogfood: true,
      now: "2026-09-01T00:00:00.000Z",
    });
    expect(row.observed_through).toBe("2026-08-03T00:00:00.000Z");
    expect(summariseEscapes([row])).toMatchObject({ closed: 0, stale: 1, merged: 1 });

    // The same clone, fetched: it saw the branch as it stood at `observed_at`.
    const fetched = record({
      observed_at: "2026-09-01T00:00:00.000Z",
      observed_head: { sha: "f".repeat(40), committed_at: "2026-08-03T00:00:00.000Z", refreshed: true },
    });
    expect(escapeStatus(fetched, "2026-09-01T00:00:00.000Z")).toBe("observed");
  });

  it("keeps what a stale or open record found while leaving it out of the rate", () => {
    const found = record({
      observed_at: "2026-08-09T00:00:00.000Z",
      reverts: [
        { sha: "d".repeat(40), subject: "Revert", committed_at: "2026-08-02T00:00:00.000Z", reverts: [merge.sha], paths: [] },
      ],
    });
    const row = escapeRow({
      ticket: { ticket_id: "ticket_0000000000000001", key: "AYO-1" },
      record: found,
      dogfood: true,
      now: "2027-01-01T00:00:00.000Z",
    });
    expect(row.status).toBe("stale");
    expect(row.reverts).toHaveLength(1);
    // Reported, so the reader sees it; not counted, because the denominator it
    // would join is a denominator nobody has read to the end.
    expect(row.reverted).toBe(false);
    expect(summariseEscapes([row]).reverted).toBe(0);
  });

  it("names the paths of the change that were touched again, and no others", () => {
    const commit = later({ paths: ["src/token.ts", "README.md"], committed_at: "2026-08-03T00:00:00.000Z" });
    expect(classify([commit]).same_path).toEqual([
      {
        sha: commit.sha,
        subject: "unrelated",
        committed_at: "2026-08-03T00:00:00.000Z",
        reverts: [],
        paths: ["src/token.ts"],
      },
    ]);
  });

  it("puts a revert in both columns rather than choosing one, which is why they are never summed", () => {
    const revert = later({
      subject: `Revert "${merge.subject}"`,
      body: `This reverts commit ${merge.sha}.`,
      paths: ["src/auth.ts"],
    });
    const result = classify([revert]);
    expect(result.reverts).toHaveLength(1);
    expect(result.reverts[0]?.reverts).toEqual([merge.sha]);
    expect(result.same_path).toHaveLength(1);
    const summary = summariseEscapes([
      escapeRow({
        ticket: { ticket_id: "ticket_0000000000000001", key: "AYO-1" },
        record: record({
          window_closes_at: result.window_closes_at,
          reverts: result.reverts,
          same_path: result.same_path,
        }),
        dogfood: true,
        now: "2026-09-01T00:00:00.000Z",
      }),
    ]);
    // One ticket, one escape in each column — not two escapes out of one.
    expect(summary.closed).toBe(1);
    expect(summary.reverted).toBe(1);
    expect(summary.same_path).toBe(1);
    expect(summary.revert_rate.n).toBe(1);
    expect(summary.same_path_rate.n).toBe(1);
  });
});

describe("the rate", () => {
  const row = (over: Partial<ReturnType<typeof escapeRow>>) => ({
    ...escapeRow({
      ticket: { ticket_id: "ticket_000000000000000f", key: "AYO-9" },
      record: null,
      dogfood: true,
      now: "2026-09-01T00:00:00.000Z",
    }),
    ...over,
  });

  it("is the Wilson interval over the tickets whose window has closed", () => {
    const rows = [
      row({ status: "observed", reverted: true, same_path_touched: true }),
      row({ status: "observed", reverted: false, same_path_touched: true }),
      row({ status: "observed", reverted: false, same_path_touched: false }),
      row({ status: "window open" }),
      row({ status: "stale" }),
      row({ status: "not observed" }),
    ];
    const summary = summariseEscapes(rows);
    expect(summary.merged).toBe(6);
    expect(summary.closed).toBe(3);
    expect(summary.window_open).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.not_observed).toBe(1);
    expect(summary.revert_rate).toEqual(wilsonInterval(1, 3));
    expect(summary.same_path_rate).toEqual(wilsonInterval(2, 3));
  });

  it("has no value at all rather than zero when nothing has closed", () => {
    const summary = summariseEscapes([row({ status: "window open" })]);
    expect(summary.closed).toBe(0);
    expect(Number.isNaN(summary.revert_rate.point)).toBe(true);
    expect(Number.isNaN(summary.same_path_rate.point)).toBe(true);
  });

  it("never counts an open window as a survivor", () => {
    const summary = summariseEscapes([
      row({ status: "window open", reverted: true, same_path_touched: true }),
      row({ status: "observed", reverted: false, same_path_touched: false }),
    ]);
    expect(summary.closed).toBe(1);
    expect(summary.reverted).toBe(0);
  });
});
