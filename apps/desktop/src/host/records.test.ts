import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Ticket } from "@perbo/contracts";
import {
  diffSummary,
  ledgerFor,
  listBundles,
  readAttempts,
  readLatestDraftEdit,
  summariseTicket,
  type StoredAttempt,
} from "./records.js";
import { InterviewEditSchema } from "../shared/protocol.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const ticket = (
  state: Ticket["state"],
  updated: string,
  branch: string | null = null,
): Ticket =>
  ({
    ticket_id: "ticket_1",
    key: "PRB-1",
    state,
    updated_at: updated,
    delivery: {
      branch,
      pull_request_url: null,
      pull_request_number: null,
      state: "none",
      observed_at: null,
      opened_by: null,
    },
  }) as unknown as Ticket;
const attempt = (
  id: string,
  at: string,
  cost: { cost_micros?: number; cost_basis?: string } | null,
  reason = "completed",
): StoredAttempt => ({
  attempt_id: id,
  created_at: at,
  branch: "ayo/task",
  usage: cost === null ? undefined : { ...cost, wall_clock_ms: 1000 },
  termination: { reason },
});

describe("retained records the desktop reads directly", () => {
  it("sums only priced attempts of the month, counts early stops, and averages over fully priced merged tickets", () => {
    const ledger = ledgerFor(
      [
        {
          ticket: ticket("merged", "2026-09-05T10:00:00.000Z"),
          attempts: [
            attempt("att_1", "2026-09-03T10:00:00.000Z", {
              cost_micros: 1_500_000,
            }),
            // D-096: a stall is the stop a run has by default, and it counts
            // the way a ceiling the repository set does.
            attempt(
              "att_2",
              "2026-09-04T10:00:00.000Z",
              { cost_micros: 500_000, cost_basis: "transport_reported" },
              "stalled",
            ),
            // A second early stop on the same ticket is still one ticket stopped.
            attempt(
              "att_2b",
              "2026-09-04T12:00:00.000Z",
              { cost_micros: 250_000 },
              "cost_ceiling_exceeded",
            ),
          ],
        },
        {
          ticket: ticket("merged", "2026-09-06T10:00:00.000Z"),
          attempts: [
            attempt("att_3", "2026-09-06T09:00:00.000Z", {
              cost_micros: 0,
              cost_basis: "unavailable",
            }),
          ],
        },
        {
          ticket: ticket("pr_open", "2026-08-30T10:00:00.000Z"),
          attempts: [
            attempt("att_4", "2026-08-30T09:00:00.000Z", {
              cost_micros: 9_000_000,
            }),
          ],
        },
        {
          ticket: ticket("plan_review", "2026-09-01T10:00:00.000Z"),
          attempts: [],
        },
      ],
      "2026-09",
    );
    expect(ledger).toEqual({
      month: "2026-09",
      spentMicros: 2_250_000,
      pricedAttempts: 3,
      unpricedAttempts: 1,
      ticketsRun: 2,
      ticketsMerged: 2,
      stoppedShort: 1,
      averageMergedMicros: 2_250_000,
    });
  });

  it("reads a diff's totals through the same size and hash checks as retained output, and caches by hash", () => {
    const root = mkdtempSync(join(tmpdir(), "perbo-records-"));
    temporary.push(root);
    const objects = join(root, "objects");
    mkdirSync(objects);
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      "-old",
      "+new",
      "+more",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const sha256 = createHash("sha256").update(diff).digest("hex");
    writeFileSync(join(objects, sha256), diff);
    const artifact = {
      name: "change.diff",
      sha256,
      bytes: Buffer.byteLength(diff),
    };
    expect(diffSummary(objects, artifact)).toEqual({
      totals: { files: 2, additions: 3, deletions: 2 },
      note: null,
    });
    // A tampered object is refused by its hash; the cached total for the true hash is untouched.
    const forged = "a".repeat(64);
    writeFileSync(join(objects, forged), diff);
    expect(
      diffSummary(objects, { ...artifact, sha256: forged }).totals,
    ).toBeNull();
    const linked = join(objects, "b".repeat(64));
    symlinkSync(join(objects, sha256), linked);
    expect(
      diffSummary(objects, { ...artifact, sha256: "b".repeat(64) }),
    ).toMatchObject({
      totals: null,
      note: expect.stringMatching(/could not be read/),
    });
    expect(diffSummary(objects, artifact).totals).toEqual({
      files: 2,
      additions: 3,
      deletions: 2,
    });
  });

  it("summarises a ticket from its attempts record and the latest execution bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "perbo-records-"));
    temporary.push(root);
    const store = join(root, ".perbo");
    mkdirSync(join(store, "state"), { recursive: true });
    mkdirSync(join(store, "bundles", "bundles"), { recursive: true });
    mkdirSync(join(store, "bundles", "objects"), { recursive: true });
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    const sha256 = createHash("sha256").update(diff).digest("hex");
    writeFileSync(join(store, "bundles", "objects", sha256), diff);
    writeFileSync(
      join(store, "state", "ticket_1.attempts.json"),
      JSON.stringify({
        ticket_id: "ticket_1",
        attempts: [
          {
            attempt_id: "att_a",
            branch: "ayo/first",
            created_at: "2026-09-01T00:00:00.000Z",
            usage: { cost_micros: 100, wall_clock_ms: 5 },
            extra: true,
          },
          {
            attempt_id: "att_b",
            branch: "ayo/first",
            created_at: "2026-09-02T00:00:00.000Z",
            usage: {
              cost_micros: 0,
              cost_basis: "unavailable",
              wall_clock_ms: 5,
            },
          },
        ],
      }),
    );
    writeFileSync(
      join(store, "bundles", "bundles", "bundle_1.json"),
      JSON.stringify({
        bundle_id: "bundle_0000000000000001",
        kind: "execution",
        subject_id: "att_b",
        ticket_id: "ticket_1",
        artifacts: [
          {
            name: "change.diff",
            sha256,
            bytes: Buffer.byteLength(diff),
            retained: true,
          },
        ],
      }),
    );
    writeFileSync(
      join(store, "bundles", "bundles", "broken.json"),
      "{not json",
    );
    const record = readAttempts(join(store, "state", "ticket_1.attempts.json"));
    expect(record.error).toBeNull();
    const bundles = listBundles(join(store, "bundles", "bundles"));
    expect(bundles).toHaveLength(1);
    expect(
      summariseTicket({
        ticket: ticket("pr_open", "2026-09-02T00:00:00.000Z"),
        attempts: record.attempts,
        attemptsError: null,
        bundles,
        objectsDirectory: join(store, "bundles", "objects"),
      }),
    ).toEqual({
      branch: "ayo/first",
      attempts: 2,
      latestAttemptAt: "2026-09-02T00:00:00.000Z",
      costMicros: 100,
      costBasis: "unpriced",
      diff: { files: 1, additions: 1, deletions: 1 },
      note: null,
    });
    expect(readAttempts(join(store, "state", "missing.attempts.json"))).toEqual(
      { attempts: [], error: null },
    );
    writeFileSync(join(store, "state", "ticket_2.attempts.json"), "nope");
    expect(
      readAttempts(join(store, "state", "ticket_2.attempts.json")).error,
    ).toMatch(/could not be read/);
  });
});

describe("the edit the chat cards", () => {
  /** One `perbo edit` record, as the command writes it. */
  const record = (summary: string, keys: string[]) => ({
    version: 1,
    ticket_key: "PRB-1",
    plan_version: 1,
    base: { outcome: "o", criteria: [], paths: [], prohibited: [] },
    edits: [
      {
        at: "2026-09-14T06:00:00.000Z",
        changes: ["node_2"],
        author: "interview",
        summary,
        keys,
        before: Object.fromEntries(keys.map((key) => [key, {}])),
        after: Object.fromEntries(keys.map((key) => [key, {}])),
        undone: false,
        replaced: false,
        undoes: null,
      },
    ],
  });

  it("clips a summary longer than a conversation line holds, rather than losing the line", () => {
    // `perbo edit` caps no summary: `set_node_paths` writes every glob it was
    // given, and a plan scoped to a few long ones runs past 300 characters.
    const root = mkdtempSync(join(tmpdir(), "perbo-draft-record-"));
    temporary.push(root);
    const path = join(root, "PRB-1.draft.json");
    const summary = `node_2 paths set to ${"packages/queue-deep-directory/**, ".repeat(12)}`;
    expect(summary.length).toBeGreaterThan(300);
    writeFileSync(path, JSON.stringify(record(summary, ["node:node_2"])));

    const edit = readLatestDraftEdit(path, "interview");
    expect(edit).not.toBeNull();
    expect(edit!.summary.length).toBe(300);
    expect(edit!.summary.startsWith("node_2 paths set to")).toBe(true);
    // And what comes back is a line the conversation can hold.
    expect(() => InterviewEditSchema.parse(edit)).not.toThrow();
  });

  it("clips the entity keys either side of an edit to what a line holds", () => {
    const root = mkdtempSync(join(tmpdir(), "perbo-draft-keys-"));
    temporary.push(root);
    const path = join(root, "PRB-1.draft.json");
    const keys = Array.from({ length: 240 }, (_, at) => `criterion:${"c".repeat(240)}${String(at)}`);
    writeFileSync(path, JSON.stringify(record("an edit", keys)));

    const edit = readLatestDraftEdit(path, "interview")!;
    expect(edit.before).toHaveLength(200);
    expect(edit.before.every((key) => key.length <= 200)).toBe(true);
    expect(() => InterviewEditSchema.parse(edit)).not.toThrow();
  });
});
