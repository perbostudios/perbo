import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { costLabel, loopSteps, loopTally, StageLog } from "../../renderer/tasks/task-context.js";
import type { Job } from "../../shared/protocol.js";
import { attemptViews, ReportSchema } from "./reads.js";

/**
 * One real run, captured: the stderr `perbo run` printed — which is the job's
 * log the desktop reads while the run goes — and the `perbo inspect --json`
 * report of the records that run left, from the CLI's own run of a ticketless
 * contract over the runner's loop with a scripted executor, reviewer and
 * closure verifier: round 0 executed, sealed, checked and reviewed, and one
 * remediation round sealed, checked and verified closed.
 *
 * `scripts/capture-recorded-run.mjs` makes it from the built CLI: run it after
 * `pnpm -r build` to write the fixture, and with `--check` to fail where the
 * fixture is not what the CLI now produces. The fixture is never edited by hand.
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
    const during = loopSteps({ history: [], jobs: [live], active: live, attempts: [], verdicts: [], log: new StageLog(), now: "2026-09-27T00:37:40.000Z" });
    const after = loopSteps({ history: [], jobs: [ended], active: undefined, attempts, verdicts: [], log: new StageLog(), now: "2026-09-27T00:39:00.000Z" });
    expect(attempts).toHaveLength(2);
    expect(shown(during).map(({ text }) => text).reverse()).toEqual([
      "Provisioning the worktree",
      "Executing",
      "Sealing the change set",
      "Running check unit",
      "Independent review",
      "Refinement round 1",
      "Sealing the change set",
      "Running check unit",
      "Verification",
    ]);
    // The same list: every stage, and a review round's count of what it left open.
    // A check's result is on its record and not on the line announcing it, so
    // the rebuilt list carries it behind the `i` where the live one has none.
    expect(shown(after).map(({ text }) => text)).toEqual(shown(during).map(({ text }) => text));
    expect(shown(after).map(({ text, reason }) => (text.startsWith("Running check") ? null : reason))).toEqual(
      shown(during).map(({ reason }) => reason),
    );
    expect(shown(during).find(({ text }) => text === "Independent review")?.reason).toBe("The review left one finding open.");
    for (const { text, reason } of shown(after).filter(({ text }) => text.startsWith("Running check")))
      expect(reason, text).toMatch(/^Result: passed\./);
  });

  it("shows the dollars `perbo inspect` totals over the same records, every call priced", () => {
    const total = ReportSchema.parse(captured.report).total_cost;
    expect(total.unavailable).toBe(0);
    expect(loopTally({ jobs: [ended], active: undefined, attempts }).dollars).toBe(
      costLabel({ cost: { micros: total.micros, partial: total.partial > 0, unavailable: total.unavailable } }),
    );
    expect(loopTally({ jobs: [live], active: live, attempts: [] }).dollars).toBe(
      loopTally({ jobs: [ended], active: undefined, attempts }).dollars,
    );
  });

  it("counts the same commands, files and spend once the run has ended as its last tally did", () => {
    expect(loopTally({ jobs: [ended], active: undefined, attempts })).toEqual(
      loopTally({ jobs: [live], active: live, attempts: [] }),
    );
  });
});

describe("the declines each attempt recorded", () => {
  it("carry to the page with their reasons from the attempt's own record, and from nowhere else (D-065)", () => {
    const report = structuredClone(captured.report) as { attempts: Array<Record<string, unknown>> };
    const declined = "a".repeat(64);
    const last = report.attempts.at(-1)!;
    // A decline the transcript reports and the record does not hold is not counted.
    last["declines"] = [{ finding_key: declined, reason: "read from the transcript" }];
    const unsaid = { ...(last["record"] as Record<string, unknown>) };
    delete unsaid["declines"];
    last["record"] = unsaid;
    expect(attemptViews(ReportSchema.parse(report)).at(-1)!.declines).toBeUndefined();
    last["record"] = { ...unsaid, declines: [{ finding_key: declined, reason: "as the loop recorded it" }] };
    const attempts = attemptViews(ReportSchema.parse(report));
    expect(attempts.at(-1)!.declines).toEqual([{ finding_key: declined, reason: "as the loop recorded it" }]);
    expect(attempts.slice(0, -1).every((attempt) => (attempt.declines ?? []).length === 0)).toBe(true);
  });
});
