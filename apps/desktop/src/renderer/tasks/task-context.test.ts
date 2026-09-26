import { describe, expect, it } from "vitest";
import { spokenLine, tallyLine, type Tally } from "@perbo/contracts/browser";
import { costLabel, loopSteps, loopTally, runEnding, StageLog } from "./task-context.js";
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

describe("loopSteps", () => {
  const run = (log: string, state: Job["state"] = "running"): Job => ({
    id: "run-1",
    repoId: "repo",
    key: "PRB-1",
    kind: "run",
    label: "Run engineering loop",
    state,
    startedAt: "2026-09-24T02:00:00.000Z",
    endedAt: state === "running" ? null : "2026-09-24T02:30:00.000Z",
    log,
    error: null,
    resultKey: null,
    result: null,
  });
  const steps = (job: Job, log: StageLog, now: string, history: Parameters<typeof loopSteps>[0]["history"] = []) =>
    loopSteps({ history, jobs: [job], active: job.state === "running" ? job : undefined, attempts: [], log, now });

  it("keeps a stage the log's tail has since cut, and times only the stages that arrived after it", () => {
    const log = new StageLog();
    expect(steps(run("  worktree /w on b at c\n  executing\n"), log, "2026-09-24T02:01:00.000Z")).toEqual([
      { text: "Executing", reason: null, at: null },
      { text: "Provisioning the worktree", reason: null, at: null },
    ]);
    // The tail no longer holds the worktree line.
    const cut = run("  executing\n  sealing the change set\n  sealing the change set\n");
    expect(steps(cut, log, "2026-09-24T02:05:00.000Z").map(({ text, at }) => [text, at])).toEqual([
      ["Sealing the change set", "2026-09-24T02:05:00.000Z"],
      ["Sealing the change set", "2026-09-24T02:05:00.000Z"],
      ["Executing", null],
      ["Provisioning the worktree", null],
    ]);
  });

  it("counts a review's findings once a later stage followed or the run ended, and never before", () => {
    const review = "  review round 0\n  reviewer says: One.\n  finding: check Tests failed once and passed on its re-run\n";
    const reason = (job: Job) => steps(job, new StageLog(), "2026-09-24T02:10:00.000Z")[0]!.reason;
    expect(reason(run(review))).toBeNull();
    expect(reason(run(review, "completed"))).toBe("The review left 2 findings open.");
    const later = steps(run(review + "  remediation round 1 of at most 6\n"), new StageLog(), "2026-09-24T02:10:00.000Z");
    expect(later.map(({ text, reason: why }) => [text, why])).toEqual([
      ["Refinement round 1", null],
      ["Review round 1", "The review left 2 findings open."],
    ]);
  });

  it("says a run's delivery from the ticket's move to pr_open where no log of it is read, before the move itself", () => {
    const history = [
      { at: "2026-09-23T02:00:00.000Z", from: "independent_review", to: "pr_open", note: "pull request opened" },
      { at: "2026-09-23T03:00:00.000Z", from: "pr_open", to: "changes_requested", note: "" },
      { at: "2026-09-23T04:00:00.000Z", from: "ready", to: "pr_open", note: "handed off" },
    ] as Parameters<typeof loopSteps>[0]["history"];
    const job = { ...run("", "completed"), kind: "edit" };
    expect(steps(job, new StageLog(), "2026-09-24T02:10:00.000Z", history).map(({ text }) => text)).toEqual([
      "handed off",
      "changes requested",
      "pull request opened",
      "Opening the pull request",
    ]);
  });
});

/** A run of the ticket: live while `endedAt` is null. */
const runJob = (id: string, startedAt: string, log: string, endedAt: string | null = null): Job => ({
  id,
  repoId: "repo",
  key: "PRB-1",
  kind: "run",
  label: "Run engineering loop",
  state: endedAt === null ? "running" : "completed",
  startedAt,
  endedAt,
  log,
  error: null,
  resultKey: null,
  result: null,
});

type Usage = { input: number; output: number; micros: number; basis?: string; partial?: boolean };

/**
 * An attempt on record, reviewed, with its commands, the paths its change set
 * holds, and the usage its execution and review bundles record.
 */
const recordedAttempt = (input: {
  id: string;
  run: number;
  startedAt: string;
  commands: number;
  paths: string[];
  execution: Usage;
  review?: Usage;
}): AttemptView => {
  const bundle = (kind: string, subject_id: string, usage: Usage, extra: Record<string, unknown> = {}) => ({
    kind,
    subject_id,
    created_at: new Date(Date.parse(input.startedAt) + 60_000).toISOString(),
    inputs: { round_kind: "execute", ...extra },
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cost_micros: usage.micros,
      cost_basis: usage.basis ?? "transport_reported",
      ...(usage.partial ? { cost_partial: true } : {}),
      wall_clock_ms: 30_000,
    },
  });
  return {
    id: input.id,
    run: input.run,
    round: 0,
    startedAt: input.startedAt,
    outcome: "review approve",
    termination: "completed: ",
    model: "m",
    costMicros: input.execution.micros,
    costBasis: "transport_reported",
    partial: false,
    ceilings: [{ resource: "attempt_commands", used: input.commands, ceiling: null, hit: false }],
    review: null,
    reviewDecision: "approve",
    changes: input.paths.map((path) => ({ path, change_kind: "modified", additions: 1, deletions: 0 })),
    checks: [],
    verification: null,
    bundles: [
      bundle("execution", input.id, input.execution),
      ...(input.review ? [bundle("review", `rev_${input.id}`, input.review)] : []),
    ],
  } as unknown as AttemptView;
};

const tally = (over: Partial<Tally>): string =>
  "  " +
  tallyLine({ commands: 0, files: 0, input_tokens: 0, output_tokens: 0, micros: 0, unpriced: 0, partial: 0, ...over });

describe("loopTally", () => {
  const FIRST = "2026-09-24T01:00:00.000Z";
  const SECOND = "2026-09-24T02:00:00.000Z";
  /** The first run, on record: two paths, 1,000 tokens and $1.00 across its execution and review. */
  const firstRun = recordedAttempt({
    id: "att_1",
    run: 1,
    startedAt: "2026-09-24T01:00:05.000Z",
    commands: 7,
    paths: ["src/a.ts", "src/b.ts"],
    execution: { input: 800, output: 100, micros: 900_000 },
    review: { input: 90, output: 10, micros: 100_000, basis: "provider_list_estimate" },
  });

  it("starts a ticket with nothing on record at zero, before its run has tallied anything", () => {
    const live = runJob("run-1", FIRST, "  worktree /w on b at c\n  executing\n");
    expect(loopTally({ jobs: [live], active: live, attempts: [] })).toEqual({
      commands: 0,
      files: 0,
      tokens: "0 tokens",
      dollars: "$0.00",
    });
  });

  it("moves each figure with the live run's latest tally, and reads none from an agent's words or a tool call", () => {
    const log = [
      "  executing",
      tally({ commands: 1, files: 1, input_tokens: 400, output_tokens: 20, unpriced: 1 }),
      "  " + spokenLine("executor", tally({ commands: 99, files: 99, micros: 99_000_000 }).trim())!,
    ].join("\n");
    const live = runJob("run-1", FIRST, log);
    // The provider has priced nothing yet: the tokens stand alone.
    expect(loopTally({ jobs: [live], active: live, attempts: [] })).toEqual({
      commands: 1,
      files: 1,
      tokens: "420 tokens",
      dollars: null,
    });
    const later = runJob(
      "run-1",
      FIRST,
      log + "\n  Codex ls src\n" + tally({ commands: 3, files: 2, input_tokens: 900, output_tokens: 60, micros: 1_230_000 }) + "\n",
    );
    expect(loopTally({ jobs: [later], active: later, attempts: [] })).toEqual({
      commands: 3,
      files: 2,
      tokens: "960 tokens",
      dollars: "$1.23",
    });
  });

  it("needs only the latest tally line, however much of the log's head was cut", () => {
    const early = [tally({ commands: 1, input_tokens: 10 }), tally({ commands: 2, input_tokens: 20 })];
    const latest = tally({ commands: 3, files: 1, input_tokens: 30, output_tokens: 5, micros: 2_000_000 });
    const whole = [...early, "  executor says: " + "words ".repeat(50), latest, "  sealing the change set"].join("\n");
    const cut = whole.slice(whole.indexOf(latest) - 1);
    const read = (log: string) => {
      const live = runJob("run-1", FIRST, log);
      return loopTally({ jobs: [live], active: live, attempts: [] });
    };
    expect(cut).not.toContain(early[0]!.trim());
    expect(read(cut)).toEqual(read(whole));
    expect(read(cut)).toEqual({ commands: 3, files: 1, tokens: "35 tokens", dollars: "$2.00" });
  });

  it("adds a second run's live figures to the first run's records, and once it ends its records come to the same", () => {
    const first = runJob("run-1", FIRST, "", "2026-09-24T01:30:00.000Z");
    // The second run: its first attempt recorded a partial charge, and the
    // attempt it runs now is not priced yet; one of its paths is new.
    const live = runJob(
      "run-2",
      SECOND,
      tally({ commands: 5, files: 1, input_tokens: 300, output_tokens: 30, micros: 250_000, unpriced: 1, partial: 1 }),
    );
    const during = loopTally({ jobs: [first, live], active: live, attempts: [firstRun] });
    expect(during).toEqual({
      commands: 7 + 5,
      files: 3,
      tokens: "1,330 tokens",
      dollars: "at least $1.25",
    });
    // The second run's own attempts, as the records hold them once it has ended.
    const second = [
      recordedAttempt({
        id: "att_2",
        run: 2,
        startedAt: "2026-09-24T02:00:05.000Z",
        commands: 2,
        paths: ["src/a.ts", "src/c.ts"],
        execution: { input: 200, output: 20, micros: 250_000, partial: true },
      }),
      recordedAttempt({
        id: "att_3",
        run: 2,
        startedAt: "2026-09-24T02:10:05.000Z",
        commands: 3,
        paths: ["src/c.ts"],
        execution: { input: 100, output: 10, micros: 0, basis: "unavailable" },
      }),
    ];
    // A run that parks writes what it has so far to the records: its log still says it all.
    expect(loopTally({ jobs: [first, live], active: live, attempts: [firstRun, second[0]!] })).toEqual(during);
    const ended = { ...live, state: "completed" as const, endedAt: "2026-09-24T02:30:00.000Z" };
    // Before the records are read again, the ended run's log stands in.
    expect(loopTally({ jobs: [first, ended], active: undefined, attempts: [firstRun] })).toEqual(during);
    expect(loopTally({ jobs: [first, ended], active: undefined, attempts: [firstRun, ...second] })).toEqual(during);
  });
});

describe("loopSteps across runs", () => {
  it("lists every earlier run's stages from the records beside the live run's from its log, newest first", () => {
    const first = recordedAttempt({
      id: "att_1",
      run: 1,
      startedAt: "2026-09-24T01:00:05.000Z",
      commands: 1,
      paths: [],
      execution: { input: 1, output: 1, micros: 0 },
    });
    const earlier = recordedAttempt({
      id: "att_0",
      run: 0,
      startedAt: "2026-09-23T01:00:05.000Z",
      commands: 1,
      paths: [],
      execution: { input: 1, output: 1, micros: 0 },
    });
    const jobs = [
      runJob("run-0", "2026-09-23T01:00:00.000Z", "", "2026-09-23T01:30:00.000Z"),
      runJob("run-1", "2026-09-24T01:00:00.000Z", "", "2026-09-24T01:30:00.000Z"),
    ];
    const live = runJob("run-2", "2026-09-24T02:00:00.000Z", "  worktree /w on b at c\n  executing\n");
    const steps = loopSteps({
      history: [],
      jobs: [...jobs, live],
      active: live,
      attempts: [earlier, first],
      log: new StageLog(),
      now: "2026-09-24T02:05:00.000Z",
    });
    expect(steps.map(({ text, at }) => [text, at])).toEqual([
      ["Executing", null],
      ["Provisioning the worktree", null],
      ["Sealing the change set", "2026-09-24T01:00:35.000Z"],
      ["Executing", "2026-09-24T01:00:05.000Z"],
      ["Provisioning the worktree", "2026-09-24T01:00:05.000Z"],
      ["Sealing the change set", "2026-09-23T01:00:35.000Z"],
      ["Executing", "2026-09-23T01:00:05.000Z"],
      ["Provisioning the worktree", "2026-09-23T01:00:05.000Z"],
    ]);
    // Once the live run ends with nothing recorded yet, the same list stands.
    const ended = { ...live, state: "completed" as const, endedAt: "2026-09-24T02:30:00.000Z" };
    const after = loopSteps({
      history: [],
      jobs: [...jobs, ended],
      active: undefined,
      attempts: [earlier, first],
      log: new StageLog(),
      now: "2026-09-24T02:31:00.000Z",
    });
    expect(after.map(({ text }) => text)).toEqual(steps.map(({ text }) => text));
    // And once its attempt is on record, every run's stages come from the records.
    const third = recordedAttempt({
      id: "att_2",
      run: 2,
      startedAt: "2026-09-24T02:00:05.000Z",
      commands: 1,
      paths: [],
      execution: { input: 1, output: 1, micros: 0 },
    });
    const recorded = loopSteps({
      history: [],
      jobs: [...jobs, ended],
      active: undefined,
      attempts: [earlier, first, third],
      log: new StageLog(),
      now: "2026-09-24T02:31:00.000Z",
    });
    expect(recorded.map(({ text, at }) => [text, at])).toEqual([
      ["Sealing the change set", "2026-09-24T02:00:35.000Z"],
      ["Executing", "2026-09-24T02:00:05.000Z"],
      ["Provisioning the worktree", "2026-09-24T02:00:05.000Z"],
      ...steps.slice(2).map(({ text, at }) => [text, at]),
    ]);
  });
});
