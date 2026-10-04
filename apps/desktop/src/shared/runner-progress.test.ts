import { describe, expect, it } from "vitest";
import { spokenLine, tallyLine, type Tally } from "@perbo/contracts/browser";
import { furthestAt, overTheTicket, readStage, runnerProgress, runnerStages, runnerTally, spokenByAttempt, WHEEL_STEPS, wheelFill, wheelStep } from "./runner-progress.js";

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

describe("readStage, stage by stage", () => {
  /** Each stage the runner announces, as it prints it, with the words that make it one. */
  const STAGES = [
    { word: "worktree", line: "worktree /tmp/w on perbo/1 at 1234567" },
    { word: "executing", line: "executing" },
    { word: "sealing the change set", line: "sealing the change set" },
    { word: "check", line: "check Unit tests: pnpm test --filter x" },
    { word: "review round", line: "review round 1" },
    { word: "verifying closures", line: "verifying closures, round 2" },
    { word: "remediation round", line: "remediation round 2 of at most 6" },
    { word: "resolving the base conflict", line: "resolving the base conflict on 3 file(s)" },
    { word: "pull request", line: "pull request https://github.com/o/r/pull/9" },
  ];

  for (const { word, line } of STAGES) {
    it(`reads "${word}" only where the runner's own line starts with it`, () => {
      expect(line).toContain(word);
      // The runner's own line, at the indent the CLI prints it with.
      expect(readStage(`  ${line}`)).not.toBeNull();
      // An agent saying the same line is the agent's words.
      expect(readStage(spokenLine("executor", line)!)).toBeNull();
      expect(readStage("  " + spokenLine("reviewer", line)!)).toBeNull();
      // The same words further along a line: a command the executor ran, as Codex's line names it.
      expect(readStage(`Codex ${line}`)).toBeNull();
      expect(readStage(`  Codex echo ${line}`)).toBeNull();
    });
  }

  it("reads no stage where a line that ends with the stage goes on past it", () => {
    for (const line of [
      "executing the plan",
      "sealing the change set now",
      "review round 1 again",
      "verifying closures, round 2 of 3",
      "remediation round 2 of at most 6 left",
      "resolving the base conflict on 3 file(s) by hand",
      "pull request https://github.com/o/r/pull/9 is open",
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

describe("overTheTicket", () => {
  it("counts a verification announced again within one round once, and the next round's as the next pass", () => {
    expect(
      overTheTicket([
        { kind: "worktree" },
        { kind: "review", round: 0 },
        { kind: "remediation", round: 1 },
        { kind: "verify", round: 1 },
        // The same round's verification taken again: a transport retry.
        { kind: "verify", round: 1 },
        { kind: "remediation", round: 2 },
        { kind: "verify", round: 2 },
      ]),
    ).toEqual([
      { kind: "worktree" },
      { kind: "review", round: 0 },
      { kind: "remediation", round: 1 },
      { kind: "verify", round: 1 },
      { kind: "verify", round: 1 },
      { kind: "remediation", round: 2 },
      { kind: "verify", round: 2 },
    ]);
  });
});

describe("runnerProgress", () => {
  /**
   * The wheel's six stages follow the loop (D-129): the checks are part of the
   * execution, a run's first review is the review, and each later review and
   * closure verification is a verification, said with its pass.
   */
  it("reads six stages in the loop's order, the checks within the execution and a later review a verification", () => {
    expect(WHEEL_STEPS).toEqual(["contract", "execution", "review", "refinement", "verification", "completed"]);
    let log = "  worktree /w on b at c\n  executing\n";
    const seen: [number | undefined, string | undefined][] = [];
    for (const line of [
      "  check Tests: pnpm test",
      "  review round 0",
      "  remediation round 1 of at most 6",
      "  check Tests: pnpm test",
      "  review round 1",
      "  remediation round 2 of at most 6",
      "  verifying closures, round 2",
    ]) {
      log += line + "\n";
      const wheel = runnerProgress(log);
      seen.push([wheel?.stage, wheel?.title]);
    }
    expect(seen).toEqual([
      [2, "Running deterministic checks"],
      [3, "Independent review"],
      [4, "Refining the change"],
      [2, "Running deterministic checks"],
      [5, "Verification"],
      [4, "Refining the change, round 2"],
      [5, "Verification 2"],
    ]);
    // The furthest stage the lines reached, which the wheel shows: never back.
    expect(furthestAt(runnerStages(log.split("  review round 1")[0]!).map(({ stage }) => stage))).toBe(4);
    expect(furthestAt(runnerStages(log).map(({ stage }) => stage))).toBe(5);
    expect(furthestAt(runnerStages(log + "  worktree /w on b at c\n  executing\n").map(({ stage }) => stage))).toBe(5);
    expect(furthestAt([])).toBeNull();
  });

  it("fills equal slices: the contract none, each stage a fifth more, completed the whole", () => {
    expect(WHEEL_STEPS.map((_step, at) => wheelFill(at + 1))).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(wheelStep("completed")).toBe(6);
  });

  it("leaves the wheel where it was for a stage that has no place on it", () => {
    const checked = "  worktree /w on b at c\n  executing\n  check Tests: pnpm test\n";
    expect(runnerProgress(checked + "  sealing the change set\n")?.stage).toBe(2);
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

describe("spokenByAttempt", () => {
  it("files each turn under the attempt it was said in, and the turns before the first start the log holds apart", () => {
    const log = [
      `  ${spokenLine("reviewer", "The end of an attempt whose start was cut.")}`,
      "  remediation round 1 of at most 6",
      `  ${spokenLine("executor", "Refining.")}`,
      "  review round 1",
      `  ${spokenLine("reviewer", "Still open.")}`,
      "  resolving the base conflict on 2 file(s)",
      `  ${spokenLine("executor", "executing")}`,
      "  executing",
      `  ${spokenLine("executor", "Starting over.")}`,
    ].join("\n");
    const words = (turns: { words: string }[]): string[] => turns.map(({ words }) => words);
    const { before, attempts } = spokenByAttempt(log);
    expect(words(before)).toEqual(["The end of an attempt whose start was cut."]);
    expect(attempts.map(({ start, said }) => [start, words(said)])).toEqual([
      [{ kind: "remediation", round: 1 }, ["Refining.", "Still open."]],
      [{ kind: "conflict" }, ["executing"]],
      [{ kind: "executing" }, ["Starting over."]],
    ]);
  });
});
