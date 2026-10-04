import { describe, expect, it } from "vitest";
import { gateClosedNote, spokenLine, tallyLine, type Tally } from "@perbo/contracts/browser";
import { RUN_VERDICTS } from "@perbo/contracts";
import { costLabel, loopSteps, loopTally, outcomeSentence, runEnding, StageLog } from "./task-context.js";
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
    runEnding([job()], attempt({ termination, ceilings, reviewDecision: null }));

  it("says nothing of a command that neither failed, was cut off, nor was a run that was stopped", () => {
    expect(runEnding([job({ state: "completed", error: null })], attempt())).toBeNull();
    expect(runEnding([job({ kind: "publish", label: "Publish", state: "cancelled" })], attempt())).toBeNull();
    expect(runEnding([], undefined)).toBeNull();
  });

  it("says a command Perbo closed on in the message it stored", () => {
    const cut = job({
      state: "interrupted",
      error: "Perbo closed before the command reported an outcome. Refresh the ticket from its CLI records before starting again.",
    });
    expect(runEnding([cut], attempt())).toEqual({
      job: cut,
      title: "The run ended",
      sentence: "Perbo closed while the run was going.",
      reason: cut.error,
      log: cut.error,
      byPerson: false,
      reasons: [{ text: "Perbo closed while the run was going.", detail: cut.error }],
    });
  });

  /**
   * A review that asked for changes or put a decision to the person is a pause,
   * which the host completes (`RUN_VERDICTS`). A run that failed with such a
   * review on record failed for its command's own reason, which is what it says.
   */
  it("never says a run stopped because its review asked for changes or put a decision to the person", () => {
    for (const decision of ["changes_requested", "escalate"]) {
      const ended = runEnding([job({ error: "error: gh is not signed in" })], attempt({ reviewDecision: decision }));
      expect(ended).toMatchObject({ sentence: "The run failed after the loop recorded its attempt.", reason: "gh is not signed in" });
      expect(JSON.stringify(ended)).not.toMatch(/requested changes|escalated|put to you/);
    }
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
    expect(runEnding([failed], attempt({ reviewDecision: "approve" }))).toEqual({
      job: failed,
      title: "The run ended",
      sentence: "The review approved the change, and the run failed after it.",
      reason: "the pull request could not be opened: gh is not signed in\nPRB-1 is now failed",
      log: failed.error,
      byPerson: false,
      reasons: [
        {
          text: "The review approved the change, and the run failed after it.",
          detail: "the pull request could not be opened: gh is not signed in\nPRB-1 is now failed",
        },
      ],
    });
  });

  it("carries a failure that is not the loop's own verdict in the command's words", () => {
    const refused = job({ error: "PRB-14 was not touched: the run did not start because this machine is missing something it needs" });
    // The attempt on record is an earlier run's, from before this command started.
    const earlier = attempt({ startedAt: "2026-09-23T23:36:20.000Z" });
    expect(runEnding([refused], earlier)).toEqual({
      job: refused,
      title: "The run ended",
      sentence: "The run ended before the loop recorded an attempt.",
      reason: refused.error,
      log: refused.error,
      byPerson: false,
      reasons: [{ text: "The run ended before the loop recorded an attempt.", detail: refused.error }],
    });
    // The CLI's own lines, where it marks them: each blocking check and what it did about them.
    const preflight = job({
      error: "  ✗ codex    not found\n  blocking  agent_binary_missing: the coding agent `codex` is not on PATH\n" +
        "           fix: install `codex`\nPRB-14 was not touched: the run did not start",
    });
    expect(runEnding([preflight], earlier)?.reason).toBe(
      "agent_binary_missing: the coding agent `codex` is not on PATH\nPRB-14 was not touched: the run did not start",
    );
    const edit = job({ kind: "edit", label: "Save contract edits", error: "The contract changed since you opened it." });
    expect(runEnding([edit], attempt())).toMatchObject({
      title: "Save contract edits failed",
      sentence: "The contract changed since you opened it.",
      log: "The contract changed since you opened it.",
    });
  });
});

/**
 * The reasons the stopped page lists, one line each, read from the same
 * records as the loop page's ended card, with the whole of each behind an `i`.
 */
describe("runEnding's reasons", () => {
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
      outcome: "terminated",
      termination: "completed: the attempt ran to its end",
      ceilings: [],
      review: null,
      reviewDecision: null,
      ...overrides,
    }) as AttemptView;
  const reasons = (termination: string, overrides: Partial<AttemptView> = {}) =>
    runEnding([job()], attempt({ termination, ...overrides }))?.reasons;

  it("says the person's own stop, settled or still settling, whatever the attempt recorded as it was cut off", () => {
    for (const state of ["cancelled", "stopping"] as const) {
      const ended = runEnding([job({ state, error: null })], attempt({ termination: "cancelled: aborted" }));
      expect(ended?.byPerson).toBe(true);
      expect(ended?.reasons).toEqual([
        {
          text: "You stopped the run.",
          detail: "The run was stopped from this desktop while its attempt was going, and the work that attempt had done is kept.",
        },
      ]);
    }
    // Stopped before the loop recorded an attempt of it.
    const early = runEnding([job({ state: "cancelled" })], attempt({ startedAt: "2026-09-24T02:00:00.000Z" }));
    expect(early?.reasons).toEqual([
      { text: "You stopped the run.", detail: "The run was stopped from this desktop before the loop recorded an attempt of it." },
    ]);
    // A run that failed is not the person's stop, even where its attempt says cancelled.
    expect(runEnding([job()], attempt({ termination: "cancelled: aborted" }))?.byPerson).toBe(false);
  });

  it("names the ceiling reached", () => {
    expect(
      reasons("wall_clock_exceeded: would reach 3900000", {
        ceilings: [{ resource: "attempt_wall_clock_ms", used: 3_900_000, ceiling: 3_600_000, hit: true }],
      }),
    ).toEqual([
      {
        text: "The attempt ran for 65 minutes, past its 60-minute limit.",
        detail:
          "The attempt ran for 65 minutes, past its 60-minute limit. The runner stops an attempt at this limit, " +
          "which the repository's configuration sets as `attempt_wall_clock_ms`; raise it there to let a run go further.",
      },
    ]);
  });

  it("names the host the agent reached for that the repository does not list", () => {
    expect(reasons("unlisted_egress_host: registry.example.com is not on the resolved allow-list")).toEqual([
      {
        text: "The agent reached for registry.example.com, a host the repository does not list.",
        detail:
          "The runner ends an attempt whose agent reaches for a host outside the hosts the repository lists for its " +
          "executor. It recorded: registry.example.com is not on the resolved allow-list",
      },
    ]);
    expect(reasons("unlisted_egress_host: Command requested a host outside the network allow-list")?.[0]?.text).toBe(
      "The agent reached for a host the repository does not list.",
    );
    // Asked about, and nobody answered in time.
    expect(
      reasons(
        "unlisted_egress_host: registry.example.com is not on the resolved allow-list, and nobody answered whether to allow it within 20 minute(s)",
      )?.[0]?.text,
    ).toBe("The agent reached for registry.example.com, a host the repository does not list, and nobody answered whether to allow it.");
  });

  it("gives each command the guard refused a line of its own, with the command", () => {
    expect(
      reasons(
        "prohibited_action: write_outside_worktree: a redirect to /tmp/out_1: echo a > /tmp/out_1; ls; " +
          "destructive_git: rewriting history: git push --force",
      ),
    ).toEqual([
      {
        text: "The guard refused `echo a > /tmp/out_1; ls`, a write outside the worktree.",
        detail:
          "The guard refused the command `echo a > /tmp/out_1; ls`: it read it as a redirect to /tmp/out_1, " +
          "which is a write outside the worktree.\nSo it ended the attempt.",
      },
      {
        text: "The guard refused `git push --force`, a destructive git operation.",
        detail:
          "The guard refused the command `git push --force`: it read it as rewriting history, which is a destructive git operation.\nSo it ended the attempt.",
      },
    ]);
  });

  it("says a provider error, the executor's and the reviewer's", () => {
    expect(reasons("transport_unavailable: HTTP 529 overloaded")).toEqual([
      {
        text: "The model provider was unavailable, so the attempt ended without doing the work.",
        detail:
          "The provider kept answering that it could not take the request until the agent's retries ran out. It recorded: HTTP 529 overloaded",
      },
    ]);
    expect(reasons("agent_error: exited 1")?.[0]?.text).toBe("The agent exited with an error.");
    const unreached = runEnding(
      [job()],
      attempt({
        reviewDecision: "error",
        review: {
          decision: "error",
          findings: [],
          error: { kind: "provider_unavailable", message: "claude exited 1" },
        } as unknown as AttemptView["review"],
      }),
    );
    expect(unreached?.reasons).toEqual([
      { text: "The reviewer's model provider was unavailable, so the change was not reviewed.", detail: "claude exited 1" },
    ]);
  });

  /**
   * A run the CLI refused by a limit is said in Perbo's words: where the
   * number comes from — the repository's .perbo/config.json and its key, or
   * Perbo's default that key overrides — and never the CLI's line as it was.
   */
  it("says a run refused by the repository's limit on runs at once, and that another ticket's run was going (D-049)", () => {
    const refused = job({
      error:
        "the run was refused by a limit: concurrent_local_attempts would reach 2, above the limit of 1. " +
        "Raise limits.limits.concurrent_local_attempts in .perbo/config.json to allow it.",
    });
    const ended = runEnding([refused], undefined);
    expect(ended).toMatchObject({
      sentence:
        "The run did not start: this repository's configuration allows one run at a time on this machine, and a run of another ticket was going.",
      reason:
        "Runs of different tickets go side by side unless a repository's own configuration names a number. " +
        "This repository's .perbo/config.json sets limits.limits.concurrent_local_attempts to 1, and a run of another " +
        "ticket was going when this one was started, so it was refused before anything ran. Raise the number there, " +
        "or remove limits.limits.concurrent_local_attempts, to let runs go side by side.",
      log: null,
    });
    expect(ended?.reasons).toEqual([{ text: ended!.sentence, detail: ended!.reason }]);
    const three = job({ error: "the run was refused by a limit: concurrent_local_attempts would reach 4, above the limit of 3. Raise it." });
    expect(runEnding([three], undefined)?.sentence).toBe(
      "The run did not start: this repository's configuration allows 3 runs at a time on this machine, and 3 runs of other tickets were going.",
    );
  });

  it("says a repository that allows no runs at all, and blames no other ticket's run", () => {
    const zero = job({ error: "the run was refused by a limit: concurrent_local_attempts would reach 1, above the limit of 0. Raise it." });
    expect(runEnding([zero], undefined)).toMatchObject({
      sentence: "The run did not start: this repository's configuration allows no runs at all on this machine.",
      reason:
        "This repository's .perbo/config.json sets limits.limits.concurrent_local_attempts to 0, so no run starts on " +
        "this machine, whatever else is going. Raise the number there, or remove limits.limits.concurrent_local_attempts, to let runs start.",
    });
  });

  it("says every other limit refusal by what it bounds, and whose number it is", () => {
    const said = (line: string) => runEnding([job({ error: line })], undefined);
    // A number only the repository sets.
    expect(said("the run was refused by a limit: attempt_commands would reach 41, above the limit of 40. Raise it.")).toMatchObject({
      sentence: "The run was refused by a limit on the commands one attempt may run: it would reach 41 commands, above the limit of 40 commands.",
      reason:
        "This repository's .perbo/config.json sets limits.limits.attempt_commands to 40 commands. The run was refused " +
        "where it would have gone past it. Raise limits.limits.attempt_commands in .perbo/config.json to let a run go further.",
      log: null,
    });
    // A number that is Perbo's default unless the repository names it.
    expect(said("the run was refused by a limit: remediation_rounds would reach 7, above the limit of 6. Raise it.")).toMatchObject({
      sentence: "The run was refused by a limit on the refinement rounds one ticket may take: it would reach 7 rounds, above the limit of 6 rounds.",
      reason:
        "The limit is 6 rounds: Perbo's own unless this repository's .perbo/config.json names limits.limits.remediation_rounds, " +
        "which then sets it. The run was refused where it would have gone past it. Raise limits.limits.remediation_rounds " +
        "in .perbo/config.json to let a run go further.",
    });
    expect(said("the run was refused by a limit: ticket_cost_micros would reach 61000000, above the limit of 60000000. Raise it.")?.sentence).toBe(
      "The run was refused by a limit on what one ticket may spend: it would reach $61.00, above the limit of $60.00.",
    );
    // A kill switch, named by its key.
    expect(
      said("the run was refused by a limit: provider anthropic is disabled by kill switch. Clear the kill switch in the limits table to allow it."),
    ).toMatchObject({
      sentence: "The run was refused: a kill switch in this repository's configuration is on.",
      reason:
        "This repository's .perbo/config.json turns on limits.kill_switches.disabled_providers, which names the provider " +
        "anthropic. Turn it off there to let a run start.",
      log: null,
    });
    // A limit this does not know keeps the command's own words.
    expect(said("the run was refused by a limit: seats would reach 2, above the limit of 1. Raise it.")?.sentence).toBe(
      "The run ended before the loop recorded an attempt.",
    );
  });

  it("says an attempt that did not complete", () => {
    expect(reasons("workspace_error: the worktree could not be made")).toEqual([
      {
        text: "The attempt was terminated: workspace error.",
        detail: "The runner ended the attempt (workspace error). It recorded: the worktree could not be made.",
      },
    ]);
    const none = runEnding([job({ error: "error: the CLI could not start" })], undefined);
    expect(none?.reasons).toEqual([
      { text: "The run ended before the loop recorded an attempt.", detail: "the CLI could not start" },
    ]);
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
    loopSteps({ history, jobs: [job], active: job.state === "running" ? job : undefined, attempts: [], verdicts: [], log, now });

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
      ["Independent review", "The review left 2 findings open."],
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
  /** The commands the attempt was let run. */
  commands: number;
  paths: string[];
  execution: Usage;
  review?: Usage;
  /** The loop's round, counting from 0, and the kind of round its execution bundle records. */
  round?: number;
  kind?: "execute" | "remediate" | "resolve_conflict";
}): AttemptView => {
  const bundle = (kind: string, subject_id: string, usage: Usage, extra: Record<string, unknown> = {}) => ({
    kind,
    subject_id,
    created_at: new Date(Date.parse(input.startedAt) + 60_000).toISOString(),
    inputs: { round_kind: input.kind ?? "execute", ...extra },
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
    round: input.round ?? 0,
    startedAt: input.startedAt,
    outcome: "review approve",
    termination: "completed: ",
    model: "m",
    costMicros: input.execution.micros,
    costBasis: "transport_reported",
    partial: false,
    // One command more asked for than admitted: the guard refused one, which the strip does not count.
    ceilings: [{ resource: "attempt_commands", used: input.commands + 1, ceiling: null, hit: false }],
    admittedCommands: input.commands,
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

describe("loopSteps from the records", () => {
  it("numbers each refinement round over the ticket, not the run, and a round taken again as the same round", () => {
    const at = (minute: number) => `2026-09-24T01:${String(minute).padStart(2, "0")}:05.000Z`;
    const attempt = (id: string, run: number, round: number, kind: "execute" | "remediate" | "resolve_conflict", minute: number) =>
      recordedAttempt({ id, run, round, kind, startedAt: at(minute), commands: 1, paths: [], execution: { input: 1, output: 1, micros: 0 } });
    const attempts = [
      attempt("att_1", 1, 0, "execute", 0),
      // A conflict with the base takes a round of the loop and is no refinement.
      attempt("att_2", 1, 1, "resolve_conflict", 5),
      attempt("att_3", 1, 2, "remediate", 10),
      // The same round again, after a transport failure: still the first refinement.
      attempt("att_4", 1, 2, "remediate", 15),
      attempt("att_5", 1, 3, "remediate", 20),
      // The next run goes on counting where the ticket was.
      attempt("att_6", 2, 0, "execute", 30),
      attempt("att_7", 2, 1, "remediate", 35),
    ];
    const steps = loopSteps({ history: [], jobs: [], active: undefined, attempts, verdicts: [], log: new StageLog(), now: at(59) });
    expect(
      steps
        .map(({ text }) => text)
        .filter((text) => /^(Refinement|Resolving)/.test(text))
        .reverse(),
    ).toEqual([
      "Resolving a conflict with the base",
      "Refinement round 1",
      "Refinement round 1",
      "Refinement round 2",
      "Refinement round 3",
    ]);
  });
});

/**
 * PRB-15 after an answer: run 1 reviewed the change, refined it twice — the
 * first round verified, the second stalled — and the person answered three
 * findings; run 2 continued from the answer with a round scoped to it and
 * verified it. The steps follow the ticket's loop, not a run (D-129): one
 * review, the decision where it was taken, and the rounds and passes counted
 * over the ticket, each thing listed once whether the records or a log said it.
 */
describe("loopSteps over the ticket's loop", () => {
  const at = (hour: number, minute: number) => `2026-09-27T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:05.000Z`;
  const usage = { input: 1, output: 1, micros: 0 };
  const verified = (attempt: AttemptView): AttemptView => ({
    ...attempt,
    verification: { all_closed: true, deterministic_failure: null, open_keys: [], per_finding: [] },
  });
  const run1 = [
    recordedAttempt({ id: "att_1", run: 1, round: 0, kind: "execute", startedAt: at(10, 0), commands: 1, paths: [], execution: usage, review: usage }),
    verified(recordedAttempt({ id: "att_2", run: 1, round: 1, kind: "remediate", startedAt: at(10, 10), commands: 1, paths: [], execution: usage })),
    // The second round stalled: sealed and checked, and nothing verified it.
    recordedAttempt({ id: "att_3", run: 1, round: 2, kind: "remediate", startedAt: at(10, 20), commands: 1, paths: [], execution: usage }),
  ];
  const answered = ["approach", "let_it_decide", "ship_as_is"].map((choice, index) => ({
    finding_key: `stp_${index}`,
    decision: "decide",
    choice,
    note: choice === "approach" ? "Keep the old importer behind a flag." : "noted",
    decided_at: new Date(Date.parse(at(11, 0)) + index * 20_000).toISOString(),
    superseded_at: null,
  }));
  const run2 = verified(recordedAttempt({ id: "att_4", run: 2, round: 1, kind: "remediate", startedAt: at(11, 5), commands: 1, paths: [], execution: usage }));
  const words = (steps: ReturnType<typeof loopSteps>) => steps.map(({ text }) => text).reverse();
  const LOOP = [
    "Provisioning the worktree",
    "Executing",
    "Sealing the change set",
    "Independent review",
    "Refinement round 1",
    "Sealing the change set",
    "Verification",
    "Refinement round 2",
    "Sealing the change set",
    "You answered 3 findings",
    "Provisioning the worktree",
    "Refinement round 3",
    "Sealing the change set",
    "Verification 2",
  ];

  it("reads review, decision, refinement and verification from the records, with no second review", () => {
    const steps = loopSteps({
      history: [], jobs: [], active: undefined, attempts: [...run1, run2], verdicts: answered, log: new StageLog(), now: at(12, 0),
    });
    expect(words(steps)).toEqual(LOOP);
    expect(words(steps).filter((text) => text === "Independent review")).toHaveLength(1);
    // The answers behind the decision's `i`, in the words the person chose.
    expect(steps.find(({ text }) => text === "You answered 3 findings")?.reason).toBe(
      "1. Your approach: Keep the old importer behind a flag.\n2. Let it decide.\n3. Ship as it is.",
    );
  });

  it("lists the continued run's stages once, live from its log and then from its records", () => {
    const live: Job = {
      id: "run-2", repoId: "repo", key: "PRB-15", kind: "decide", label: "Run engineering loop", state: "running",
      startedAt: at(11, 4), endedAt: null, error: null, resultKey: null, result: null,
      log: "  worktree /w on b at c\n  remediation round 1 of at most 6\n  sealing the change set\n  verifying closures, round 1\n",
    };
    const during = loopSteps({
      history: [], jobs: [live], active: live, attempts: run1, verdicts: answered, log: new StageLog(), now: at(11, 30),
    });
    expect(words(during)).toEqual(LOOP);
    // Its attempt on record before the run has ended: listed from the record, and not from the log again.
    const recordedToo = loopSteps({
      history: [], jobs: [live], active: live, attempts: [...run1, run2], verdicts: answered, log: new StageLog(), now: at(11, 30),
    });
    expect(words(recordedToo)).toEqual(LOOP);
    const ended = { ...live, state: "completed" as const, endedAt: at(11, 40) };
    const after = loopSteps({
      history: [], jobs: [ended], active: undefined, attempts: [...run1, run2], verdicts: answered, log: new StageLog(), now: at(12, 0),
    });
    expect(words(after)).toEqual(LOOP);
  });

  it("goes on counting a round a continued run starts again at 1, where the stalled round before it was also 1", () => {
    const stalled = recordedAttempt({ id: "att_2", run: 1, round: 1, kind: "remediate", startedAt: at(10, 10), commands: 1, paths: [], execution: usage });
    const steps = loopSteps({
      history: [], jobs: [], active: undefined, attempts: [run1[0]!, stalled, run2], verdicts: answered, log: new StageLog(), now: at(12, 0),
    });
    expect(words(steps).filter((text) => text.startsWith("Refinement"))).toEqual(["Refinement round 1", "Refinement round 2"]);
  });

  it("counts a continued run that reviews its branch afresh as a verification of the ticket", () => {
    const fresh = recordedAttempt({ id: "att_4", run: 2, round: 0, kind: "execute", startedAt: at(11, 5), commands: 1, paths: [], execution: usage, review: usage });
    const steps = loopSteps({
      history: [], jobs: [], active: undefined, attempts: [...run1, fresh], verdicts: answered, log: new StageLog(), now: at(12, 0),
    });
    expect(words(steps).slice(-4)).toEqual(["Provisioning the worktree", "Executing", "Sealing the change set", "Verification 2"]);
    expect(words(steps).filter((text) => text === "Independent review")).toHaveLength(1);
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
      verdicts: [],
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
      verdicts: [],
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
      verdicts: [],
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

describe("how a run ended, in the steps", () => {
  /** The row the CLI writes on a ticket as a run ends, for each way it can end. */
  const ENDINGS = [
    ["approved; a human merges it", "The review approved the change; the merge is yours."],
    [gateClosedNote("changes_requested"), "The review asked for changes the loop could not make on its own."],
    [
      gateClosedNote("escalated"),
      "The run stopped for a person: the review escalated a finding, or the executor declined one as having no determinable practice.",
    ],
    [gateClosedNote("remediation_stalled"), "The refinement stalled: a round closed none of the findings it was given."],
    [gateClosedNote("remediation_exhausted"), "The refinement ran out of rounds or budget with findings still open."],
    ["the attempt did not complete: no_changes", "The agent made no change to the branch."],
    ["the attempt did not complete: terminated", "The attempt was terminated before it finished."],
  ] as const;

  it.each(ENDINGS)("says %s as a whole sentence in Perbo's words, never the outcome's name", (note, sentence) => {
    const [step] = loopSteps({
      history: [{ at: "2026-09-27T12:53:04.517Z", from: "independent_review", to: "changes_requested", note }],
      jobs: [],
      active: undefined,
      attempts: [],
      verdicts: [],
      log: new StageLog(),
      now: "2026-09-27T13:00:00.000Z",
    });
    expect(step!.text).toBe(sentence);
    expect(step!.text).not.toMatch(/^[a-z_]+$/);
    expect(step!.text).not.toMatch(/\b[a-z]+_[a-z_]+\b|the gate closed/);
  });

  it("says every verdict a run ends on for the person in words of its own", () => {
    for (const outcome of RUN_VERDICTS) {
      expect(outcomeSentence(outcome), outcome).not.toMatch(/^The run ended: /);
    }
  });
});

describe("a person's answers, in the steps", () => {
  it("lists a sitting once, at the time its last answer was given, each finding once in the words that stand, and never an endorsement", () => {
    const answer = (over: Record<string, unknown>) => ({
      review: { reference: "PRB-20" },
      finding_key: "e".repeat(64),
      decision: "decide",
      choice: "approach",
      note: "Add a test script that runs the suite.",
      decided_at: "2026-09-27T17:40:00.000Z",
      superseded_at: null,
      ...over,
    });
    const steps = loopSteps({
      history: [],
      jobs: [],
      active: undefined,
      attempts: [],
      log: new StageLog(),
      now: "2026-09-27T18:00:00.000Z",
      verdicts: [
        answer({}),
        answer({ finding_key: "a".repeat(64), choice: "ship_as_is", note: "Ship it.", decided_at: "2026-09-27T17:41:00.000Z" }),
        answer({ note: "An earlier answer.", superseded_at: "2026-09-27T17:40:00.000Z" }),
        answer({ decision: "endorse", choice: undefined }),
      ],
    });
    expect(steps.map(({ text, at }) => [text, at])).toEqual([["You answered 2 findings", "2026-09-27T17:41:00.000Z"]]);
    expect(steps[0]!.reason).toBe("1. Your approach: Add a test script that runs the suite.\n2. Ship as it is.");
  });
});
