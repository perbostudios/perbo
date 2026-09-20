import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  TICKET_SCHEMA_VERSION,
  TicketSchema,
  type IncompleteReviewPath,
  type Ticket,
} from "@perbo/contracts";
import type { Streams } from "../src/streams.js";
import { runStopsCommand } from "../src/stops.js";
import { writeTicket } from "../src/tickets.js";

/**
 * The two ways a review that could not resolve a criterion reaches a person,
 * told apart where the numbers about stopping are read.
 *
 * One of them spent a remediation round on the finding that made the criterion
 * unjudgeable and asked the person only after the re-review; the other asked at
 * once, because nothing the executor may be handed explained the criterion.
 * They cost a person the same interruption and say different things about the
 * loop, so `stops` prints them as different rows rather than as two
 * escalations.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-incomplete-review-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

const fixtureTicket = (input: {
  key: string;
  ticket_id: string;
  incomplete_review: IncompleteReviewPath;
}): Ticket =>
  TicketSchema.parse({
    schema_version: TICKET_SCHEMA_VERSION,
    ticket_id: input.ticket_id,
    key: input.key,
    title: "The baseline harness records each partner's ten timed tickets.",
    state: "changes_requested",
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_fixture0001",
    plan_version: 1,
    approved_at: "2026-09-04T00:00:00.000Z",
    admitted_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z",
    admission: { elapsed_ms: 100, criteria_source: "typed", criteria_count: 1 },
    delivery: {
      branch: `ayo/${input.key.toLowerCase()}/harness`,
      pull_request_url: "https://github.com/o/r/pull/409",
      pull_request_number: 409,
      state: "open",
      observed_at: "2026-09-05T00:00:00.000Z",
      opened_by: "loop",
      mergeable: null,
      commits_outside_loop: null,
      incomplete_review: input.incomplete_review,
    },
    history: [
      { at: "2026-09-04T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" },
    ],
  });

describe("`stops` over a store holding both kinds of incomplete review", () => {
  it("prints an escalation that followed remediation apart from one that did not", async () => {
    const repo = join(scratch, "store");
    mkdirSync(join(repo, ".perbo", "tickets"), { recursive: true });
    mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
    const dir = join(repo, ".perbo");
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-35",
        ticket_id: "ticket_efe2b3832d52792a",
        incomplete_review: "incomplete_remediated",
      }),
    );
    writeTicket(
      dir,
      fixtureTicket({
        key: "AYO-90",
        ticket_id: "ticket_aaaabbbbccccdddd",
        incomplete_review: "incomplete_escalated",
      }),
    );

    const streams = capture();
    const code = await runStopsCommand({ argv: ["--repo", repo], streams, cwd: process.cwd() });

    expect(code).toBe(EXIT_CODES.approve);
    const printed = streams.out.join("");
    const remediated = printed
      .split("\n")
      .find((line) => line.includes("AYO-35"));
    const atOnce = printed.split("\n").find((line) => line.includes("AYO-90"));
    expect(remediated).toBeDefined();
    expect(atOnce).toBeDefined();
    // Two rows, and neither reads as the other: one names the round that ran
    // before the person was asked, the other names its absence.
    expect(remediated).toContain("a remediation round ran");
    expect(atOnce).toContain("no remediable cause");
    expect(remediated).not.toEqual(atOnce);
  });

  it("says nothing about incomplete reviews where the store holds none", async () => {
    const repo = join(scratch, "empty");
    mkdirSync(join(repo, ".perbo", "tickets"), { recursive: true });
    mkdirSync(join(repo, ".perbo", "state"), { recursive: true });

    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo], streams, cwd: process.cwd() });

    expect(streams.out.join("")).not.toContain("incomplete review");
  });
});
