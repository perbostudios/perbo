import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loopSteps, loopTally, StageLog } from "../../renderer/tasks/task-context.js";
import type { Job } from "../../shared/protocol.js";
import { attemptViews, ReportSchema } from "./reads.js";

/**
 * One real run, captured: the stderr `perbo run` printed — which is the job's
 * log the desktop reads while the run goes — and the `perbo inspect --json`
 * report of the records that run left, from the CLI's own run of a ticketless
 * contract over the runner's loop with a scripted executor, reviewer and
 * closure verifier: round 0 executed, sealed, checked and reviewed, and one
 * remediation round sealed, checked and verified closed.
 */
const captured = JSON.parse(
  readFileSync(new URL("../../renderer/tasks/fixtures/recorded-run.json", import.meta.url), "utf8"),
) as { log: string; report: unknown };

describe("the loop page, live from the run's log and rebuilt from its records", () => {
  const attempts = attemptViews(ReportSchema.parse(captured.report));
  const job = (state: Job["state"]): Job =>
    ({
      id: "job-1",
      repoId: "repo",
      key: "PRB-1",
      kind: "run",
      label: "Run engineering loop",
      state,
      startedAt: "2026-09-27T00:37:00.000Z",
      endedAt: state === "running" ? null : "2026-09-27T00:38:00.000Z",
      log: captured.log,
      error: null,
      resultKey: null,
      result: null,
    }) as Job;
  const live = job("running");
  const ended = job("completed");

  it("lists the same stages, in the same order and with the same detail, once the run has ended", () => {
    const shown = (steps: ReturnType<typeof loopSteps>) => steps.map(({ text, reason }) => ({ text, reason }));
    const during = loopSteps({ history: [], jobs: [live], active: live, attempts: [], log: new StageLog(), now: "2026-09-27T00:37:40.000Z" });
    const after = loopSteps({ history: [], jobs: [ended], active: undefined, attempts, log: new StageLog(), now: "2026-09-27T00:39:00.000Z" });
    expect(attempts).toHaveLength(2);
    expect(shown(during).map(({ text }) => text).reverse()).toEqual([
      "Provisioning the worktree",
      "Executing",
      "Sealing the change set",
      "Running check unit",
      "Review round 1",
      "Refinement round 1",
      "Sealing the change set",
      "Running check unit",
      "Verifying closures",
    ]);
    // The same list: every stage, and a review round's count of what it left open.
    // A check's result is on its record and not on the line announcing it, so
    // the rebuilt list carries it behind the `i` where the live one has none.
    expect(shown(after).map(({ text }) => text)).toEqual(shown(during).map(({ text }) => text));
    expect(shown(after).map(({ text, reason }) => (text.startsWith("Running check") ? null : reason))).toEqual(
      shown(during).map(({ reason }) => reason),
    );
    expect(shown(during).find(({ text }) => text === "Review round 1")?.reason).toBe("The review left one finding open.");
    for (const { text, reason } of shown(after).filter(({ text }) => text.startsWith("Running check")))
      expect(reason, text).toMatch(/^Result: passed\./);
  });

  it("counts the same commands, files and spend once the run has ended as its last tally did", () => {
    expect(loopTally({ jobs: [ended], active: undefined, attempts })).toEqual(
      loopTally({ jobs: [live], active: live, attempts: [] }),
    );
  });
});
