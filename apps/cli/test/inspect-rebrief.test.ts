import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ExecutionAttemptSchema, type ExecutionAttempt } from "@perbo/contracts";
import { buildInspectReport, renderInspect } from "../src/inspect.js";
import { makeAttempt, makeTicket } from "./attempt-fixture.js";

/**
 * D-096: `perbo inspect` says how often an attempt's brief was given back
 * after a compaction, so "the executor was re-briefed twice in this round" is
 * readable off the record rather than out of a transcript.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-rebrief-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_rebrief0001";
const ATTEMPT = "att_rebrief000001";

function store(reinjections: ExecutionAttempt["brief_reinjections"]): string {
  const repo = join(scratch, `repo-${reinjections.length}`);
  const dir = join(repo, ".perbo");
  mkdirSync(join(dir, "tickets"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(
    join(dir, "tickets", "AYO-1.json"),
    JSON.stringify(makeTicket({ key: "AYO-1", ticket_id: TICKET_ID, repository_root: repo })),
  );
  const attempt = ExecutionAttemptSchema.parse({
    ...makeAttempt({
      attempt_id: ATTEMPT,
      ticket_id: TICKET_ID,
      created_at: "2026-09-13T10:00:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: { wall_clock_ms: 40_000, cost_basis: "not_incurred" },
      changeset_id: "cs_rebrief0000001",
      head_commit: "b2c3d4e",
    }),
    brief_reinjections: reinjections,
  });
  writeFileSync(
    join(dir, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );
  return dir;
}

const rendered = (reinjections: ExecutionAttempt["brief_reinjections"]): string =>
  renderInspect(
    buildInspectReport({ storeDirectory: store(reinjections), key: "AYO-1", attempt: null }),
    { color: false, detail: false, version: "test" },
  );

describe("what inspect says about a re-briefed attempt (D-096)", () => {
  it("counts the times the brief went back, and says so on the attempt", () => {
    const lines = rendered([
      { target: null, mechanism: "session_start_hook", at: "2026-09-13T10:05:00.000Z" },
      {
        target: "a1068d4ecef4890c3",
        mechanism: "session_start_hook",
        at: "2026-09-13T10:20:00.000Z",
      },
    ]).split("\n");
    const brief = lines.find((line) => line.trimStart().startsWith("brief"));
    expect(brief).toBeDefined();
    expect(brief).toContain("2");
    expect(brief).toContain("compaction");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("says nothing where nothing compacted", () => {
    expect(rendered([])).not.toContain("compaction");
  });
});
