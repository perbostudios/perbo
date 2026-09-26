import { describe, expect, it } from "vitest";
import { costLabel, runEnding } from "./task-context.js";
import type { AttemptView, Job } from "../../shared/protocol.js";

describe("costLabel", () => {
  it("calls a total all-in only where every component of it is priced", () => {
    expect(costLabel({ cost: { micros: 1_230_000, partial: false, unavailable: 0 } })).toBe("$1.23");
    expect(costLabel({ cost: { micros: 1_230_000, partial: true, unavailable: 1 } })).toBe(
      "at least $1.23",
    );
  });

  it("shows no figure where nothing in the run is priced", () => {
    expect(costLabel({ cost: { micros: 0, partial: true, unavailable: 1 } })).toBe("Unavailable");
  });
});

describe("runEnding", () => {
  const job = (overrides: Partial<Job> = {}): Job => ({
    id: "job-1",
    repoId: "repo",
    key: "PRB-1",
    kind: "run",
    label: "Run engineering loop",
    state: "failed",
    startedAt: "2026-09-24T02:17:34.000Z",
    endedAt: "2026-09-24T02:20:02.000Z",
    log: "the whole run log",
    error: "the whole run log",
    resultKey: null,
    result: null,
    ...overrides,
  });
  const attempt = (overrides: Partial<AttemptView> = {}): AttemptView =>
    ({
      id: "att_1",
      run: 1,
      round: 0,
      startedAt: "2026-09-24T02:17:38.000Z",
      outcome: "review changes_requested",
      termination: "completed: the attempt ran to its end",
      ceilings: [],
      review: null,
      reviewDecision: "changes_requested",
      ...overrides,
    }) as AttemptView;
  const terminated = (termination: string, ceilings: AttemptView["ceilings"] = []) =>
    runEnding([job()], attempt({ termination, ceilings, reviewDecision: null }), "failed");

  it("says nothing of a command that neither failed nor was cut off", () => {
    expect(runEnding([job({ state: "completed", error: null })], attempt(), "pr_open")).toBeNull();
    expect(runEnding([job({ state: "cancelled" })], attempt(), "cancelled")).toBeNull();
    expect(runEnding([], undefined, "ready")).toBeNull();
  });

  it("says a command Perbo closed on in the message it stored", () => {
    const cut = job({
      state: "interrupted",
      error: "Perbo closed before the command reported an outcome. Refresh the ticket from its CLI records before starting again.",
    });
    expect(runEnding([cut], attempt(), "executing")).toEqual({
      job: cut,
      title: "The run ended",
      sentence: "Perbo closed before the command reported an outcome.",
      reason: cut.error,
      log: cut.error,
    });
  });

  it("reads the review's verdict off the attempt the run recorded, and not the log", () => {
    expect(runEnding([job()], attempt(), "changes_requested")).toMatchObject({
      title: "The run ended",
      sentence: "The review requested changes.",
      log: null,
    });
  });

  it("gives the review's open findings, in its own statements, as the fuller reason", () => {
    const findings = [
      { statement: "The letter names no date.", status: "open", blocking: true },
      { statement: "A typo in the greeting.", status: "open", blocking: false },
      { statement: "Already fixed.", status: "closed", blocking: true },
    ];
    const ended = runEnding(
      [job()],
      attempt({ review: { decision: "changes_requested", findings } as unknown as AttemptView["review"] }),
      "changes_requested",
    );
    expect(ended?.reason).toBe(
      "The independent review read the change against the contract and asked for changes to 2 things:\n" +
        "1. The letter names no date. (holds the merge)\n" +
        "2. A typo in the greeting.",
    );
  });

  it("says the agent changed nothing, rather than that it was terminated", () => {
    expect(terminated("no_changes: the branch is where it started")).toMatchObject({
      sentence: "The agent made no change to the branch.",
      log: null,
    });
  });

  it("names what the guard refused in words, and keeps the command as it was recorded", () => {
    const ended = terminated(
      "prohibited_action: external_communication: sending mail: grep -icE 'e-?mail' my_letter.md",
    );
    expect(ended?.sentence).toBe("The attempt was terminated: the guard refused an external communication.");
    expect(ended?.reason).toBe(
      "The guard refused the command `grep -icE 'e-?mail' my_letter.md`: it read it as sending mail, " +
        "which is an external communication.\nSo it ended the attempt.",
    );
  });

  it("presents each refusal recorded, split where the next one starts rather than inside a command", () => {
    const ended = terminated(
      "prohibited_action: write_outside_worktree: a redirect to /tmp/out_1: echo a > /tmp/out_1; ls; " +
        "destructive_git: rewriting history: git push --force",
    );
    expect(ended?.sentence).toBe(
      "The attempt was terminated: the guard refused a write outside the worktree and a destructive git operation.",
    );
    expect(ended?.reason.split("\n")).toEqual([
      "The guard refused the command `echo a > /tmp/out_1; ls`: it read it as a redirect to /tmp/out_1, which is a write outside the worktree.",
      "The guard refused the command `git push --force`: it read it as rewriting history, which is a destructive git operation.",
      "So it ended the attempt.",
    ]);
  });

  it("says a stall as a hang, in minutes, and offers no limit to raise", () => {
    const ended = terminated("stalled: no tool activity for 612000ms", [
      { resource: "attempt_stall_ms", used: 612_000, ceiling: 600_000, hit: true },
    ]);
    expect(ended?.sentence).toBe("The attempt stalled for 10 minutes, past its 10-minute limit.");
    expect(ended?.reason).toMatch(/^The agent showed no tool activity for 10 minutes/);
    expect(ended?.reason).toMatch(/a hang rather than a limit on the work/);
    expect(ended?.reason).not.toMatch(/raise/i);
  });

  it("says the time an attempt ran in minutes against its limit", () => {
    const ended = terminated("wall_clock_exceeded: would reach 3900000", [
      { resource: "attempt_wall_clock_ms", used: 3_900_000, ceiling: 3_600_000, hit: true },
    ]);
    expect(ended?.sentence).toBe("The attempt ran for 65 minutes, past its 60-minute limit.");
    expect(ended?.reason).toMatch(/`attempt_wall_clock_ms`; raise it there/);
  });

  it("says what an attempt cost in dollars against its limit", () => {
    const ended = terminated("cost_ceiling_exceeded: would reach 6120000", [
      { resource: "attempt_cost_micros", used: 6_120_000, ceiling: 5_000_000, hit: true },
    ]);
    expect(ended?.sentence).toBe("The attempt cost $6.12 against its $5.00 limit.");
  });

  it("gives a refinement round's turn limit a sentence of its own", () => {
    expect(terminated("round_iteration_ceiling_exceeded: would reach 31")?.sentence).toBe(
      "A refinement round took more turns than a round may.",
    );
  });

  it("carries a failure after an approving review in the command's own words", () => {
    const failed = job({
      error: "review approve\nerror: the pull request could not be opened: gh is not signed in\nPRB-1 is now failed",
    });
    expect(runEnding([failed], attempt({ reviewDecision: "approve" }), "ready")).toEqual({
      job: failed,
      title: "The run ended",
      sentence: "The review approved the change, and the run failed after it.",
      reason: "the pull request could not be opened: gh is not signed in\nPRB-1 is now failed",
      log: failed.error,
    });
  });

  it("says an escalation as the verdict it is, with the findings put to the person behind the i", () => {
    const findings = [{ statement: "Which queue takes a bounce?", status: "open", blocking: true }];
    const ended = runEnding(
      [job()],
      attempt({ reviewDecision: "escalate", review: { decision: "escalate", findings } as unknown as AttemptView["review"] }),
      "changes_requested",
    );
    expect(ended).toMatchObject({ sentence: "The review escalated the change to you.", log: null });
    expect(ended?.reason).toMatch(/put to you one thing:\n1\. Which queue takes a bounce\? \(holds the merge\)$/);
  });

  it("says findings left open by refinement as the verdict it is, listing them", () => {
    const findings = [{ statement: "The date is still missing.", status: "open", blocking: true }];
    const ended = runEnding(
      [job()],
      attempt({
        outcome: "1 closure(s) still open",
        reviewDecision: null,
        review: { decision: "changes_requested", findings } as unknown as AttemptView["review"],
      }),
      "failed",
    );
    // The review on record asked for changes, so that is its verdict; with no
    // decision on the attempt, the closures are what it says.
    expect(ended?.log).toBeNull();
    const closures = runEnding(
      [job()],
      attempt({ outcome: "1 closure(s) still open", reviewDecision: null, review: null }),
      "failed",
    );
    expect(closures).toMatchObject({ sentence: "Refinement ended with findings still open.", log: null });
    expect(closures?.reason).toBe("The refinement rounds ended with 1 closure(s) still open; the review on the ticket lists them.");
  });

  it("carries a failure that is not the loop's own verdict in the command's words", () => {
    const refused = job({ error: "PRB-14 was not touched: the run did not start because this machine is missing something it needs" });
    // The attempt on record is an earlier run's, from before this command started.
    const earlier = attempt({ startedAt: "2026-09-23T23:36:20.000Z" });
    expect(runEnding([refused], earlier, "ready")).toEqual({
      job: refused,
      title: "The run ended",
      sentence: "The run ended before the loop recorded an attempt.",
      reason: refused.error,
      log: refused.error,
    });
    // The CLI's own lines, where it marks them: each blocking check and what it did about them.
    const preflight = job({
      error: "  ✗ codex    not found\n  blocking  agent_binary_missing: the coding agent `codex` is not on PATH\n" +
        "           fix: install `codex`\nPRB-14 was not touched: the run did not start",
    });
    expect(runEnding([preflight], earlier, "ready")?.reason).toBe(
      "agent_binary_missing: the coding agent `codex` is not on PATH\nPRB-14 was not touched: the run did not start",
    );
    const edit = job({ kind: "edit", label: "Save contract edits", error: "The contract changed since you opened it." });
    expect(runEnding([edit], attempt(), "plan_review")).toMatchObject({
      title: "Save contract edits failed",
      sentence: "The contract changed since you opened it.",
      log: "The contract changed since you opened it.",
    });
  });
});
