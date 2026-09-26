import { describe, expect, it } from "vitest";
import { spokenLine, tallyLine, type Tally } from "@perbo/contracts/browser";
import { readStage, runnerProgress, runnerStages, runnerTally } from "./runner-progress.js";

describe("readStage", () => {
  it("reads each stage the runner announces, and only the number or name the line states", () => {
    expect(
      [
        "  worktree /tmp/w on perbo/1 at 1234567",
        "  executing",
        "  remediation round 2 of at most 6",
        "  resolving the base conflict on 3 file(s)",
        "  sealing the change set",
        "  check Unit tests: pnpm test --filter x",
        "  review round 1",
        "  verifying closures, round 2",
        "  pull request https://github.com/o/r/pull/9",
      ].map(readStage),
    ).toEqual([
      { kind: "worktree" },
      { kind: "executing" },
      { kind: "remediation", round: 2 },
      { kind: "conflict" },
      { kind: "seal" },
      { kind: "check", name: "Unit tests" },
      { kind: "review", round: 1 },
      { kind: "verify", round: 2 },
      { kind: "delivery" },
    ]);
  });

  it("reads no stage in an agent's words, a tool call or the runner's other lines", () => {
    for (const line of [
      spokenLine("executor", "executing")!,
      spokenLine("executor", "I will check retry: first")!,
      spokenLine("reviewer", "review round 1")!,
      "Read packages/queue/retry.ts",
      "node n1 check Tests (files): pnpm test a.ts",
      "no open pull request on perbo/1: the re-level is pushed and nothing else is read",
      "ceilings commands 200",
    ])
      expect(readStage(line)).toBeNull();
  });
});

describe("runnerStages", () => {
  it("lists the stages in the order the log printed them, each review with the findings printed after it", () => {
    const log = [
      "  review round 0",
      "  " + spokenLine("reviewer", "One.")!,
      "  " + spokenLine("executor", "Not a finding.")!,
      "  finding: a check failed once",
      "  verifying closures, round 1",
    ].join("\n");
    expect(runnerStages(log)).toEqual([
      { stage: { kind: "review", round: 0 }, findings: 2, settled: true },
      { stage: { kind: "verify", round: 1 }, findings: 0, settled: false },
    ]);
  });
});

describe("runnerProgress", () => {
  it("leaves the wheel where it was for a stage that has no place on it", () => {
    const checked = "  worktree /w on b at c\n  executing\n  check Tests: pnpm test\n";
    expect(runnerProgress(checked + "  sealing the change set\n")?.stage).toBe(3);
    expect(runnerProgress(checked + "  pull request https://x/pull/1\n")?.title).toBe("Running deterministic checks");
  });
});

describe("runnerTally", () => {
  const tally = (commands: number): Tally => ({
    commands,
    files: 1,
    input_tokens: 10 * commands,
    output_tokens: commands,
    micros: 0,
    unpriced: 1,
    partial: 0,
  });

  it("reads the last tally the runner printed, and no agent's words or tool call that spells one", () => {
    const log = [
      "  executing",
      "  " + tallyLine(tally(1)),
      "  " + tallyLine(tally(2)),
      "  " + spokenLine("executor", tallyLine(tally(99)))!,
      "  Codex " + tallyLine(tally(98)),
      "  sealing the change set",
    ].join("\n");
    expect(runnerTally(log)).toEqual(tally(2));
    expect(runnerTally("  executing\n")).toBeNull();
    // Not a stage either.
    expect(readStage(tallyLine(tally(2)))).toBeNull();
  });
});
