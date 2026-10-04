import { afterEach, describe, expect, it } from "vitest";
import { createScratch } from "@perbo/test-support";
import { JobRunner, type JobOperation } from "./runner.js";
import { Changes } from "../changes.js";
import { Profile } from "../profile/store.js";
import { WorkspaceReads } from "../workspace-reads.js";
import type { Cli } from "../cli.js";
import type { Change, Job } from "../../shared/protocol.js";
import { runnerProgress, spokenWords } from "../../shared/runner-progress.js";
import { spokenLine } from "@perbo/contracts/browser";
import { LOG_TAIL_CHARS, type ProcessResult } from "../process.js";
import { CLOSED_MID_COMMAND, type RegisteredRepository } from "../profile/store.js";

const scratchDirectory = createScratch("perbo-runner-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const repo: RegisteredRepository = {
  id: "80000000-0000-4000-8000-000000000001",
  name: "checkout",
  path: "/checkout",
};
const other: RegisteredRepository = { ...repo, id: "80000000-0000-4000-8000-000000000002" };
const settle = (): Promise<void> => Promise.resolve();
/**
 * A runner over a real profile and change stream, with everything it tells
 * recorded. Its CLI prints `outputs` one after another, each the whole output
 * so far, as the process runner hands it on.
 */
function runner(
  result: ProcessResult = { code: 0, stdout: "", stderr: "", cancelled: false },
  outputs: readonly string[] = ["stage one"],
) {
  const directory = scratchDirectory();
  const profile = Profile.open(directory);
  const told: Change[] = [];
  /** Each progress change's log as it was when told: the job is one object, and it moves on. */
  const logs: string[] = [];
  const order: string[] = [];
  const runs: string[][] = [];
  const changes = new Changes({
    reads: new WorkspaceReads(),
    save: () => profile.save(),
    emit: (change) => {
      told.push(change);
      if (change.kind === "progress") logs.push(change.job.log);
      order.push(change.kind === "records" ? "records" : change.kind);
    },
  });
  const cli: Cli = {
    run: (args, _repo, options) => {
      runs.push(args);
      for (const output of outputs) options?.onOutput?.(output);
      return Promise.resolve(result);
    },
    spawn: () => {
      throw new Error("not spawned");
    },
  };
  const started: Job[] = [];
  const jobs = new JobRunner({
    profile,
    changes,
    reads: new WorkspaceReads(),
    cli,
    editing: {
      started: (_owner, job) => {
        started.push(job);
        return job as never;
      },
      settled: () => {
        order.push("editing.settled");
        return settle();
      },
    },
    liveChanged: () => order.push("power"),
    progressed: () => order.push("stage"),
    settled: () => {
      order.push("outcome");
      return settle();
    },
  });
  return { jobs, profile, told, logs, order, runs, started, changes, directory };
}
/** Waits until every job has settled, which is what the runner's own promises do. */
async function quiet(jobs: JobRunner): Promise<void> {
  for (let attempt = 0; attempt < 200 && jobs.live().length > 0; attempt += 1)
    await new Promise((done) => setTimeout(done, 2));
}
/** An operation that finishes when the test says so. */
function pending(): { operation: JobOperation; finish: () => void; started: Promise<void> } {
  let release!: () => void;
  let began!: () => void;
  const startedPromise = new Promise<void>((done) => {
    began = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  return {
    started: startedPromise,
    finish: release,
    operation: async () => {
      began();
      await gate;
    },
  };
}

describe("the lanes", () => {
  it("refuses a second exclusive job over the same ticket, by the label of the one running", async () => {
    const w = runner();
    const first = pending();
    w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, first.operation);
    await first.started;
    for (const kind of ["run", "decide", "publish"])
      expect(() =>
        w.jobs.start({ repo, key: "PRB-1", kind, label: "Another" }, first.operation),
      ).toThrow(/Run engineering loop is already running/);
    first.finish();
  });

  /** D-049: runs of different tickets go on at the same time. */
  it("runs another ticket's run, decision or publication beside a run", async () => {
    const w = runner();
    const first = pending();
    w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, first.operation);
    await first.started;
    const second = pending();
    const beside = w.jobs.start({ repo, key: "PRB-2", kind: "run", label: "Run engineering loop" }, second.operation);
    await second.started;
    const decided = w.jobs.start({ repo, key: "PRB-3", kind: "decide", label: "Run engineering loop" }, () => Promise.resolve());
    const elsewhere = w.jobs.start({ repo: other, key: "PRB-1", kind: "publish", label: "Open the pull request" }, () => Promise.resolve());
    expect([beside.state, decided.state, elsewhere.state]).toEqual(["running", "running", "running"]);
    expect(w.jobs.live().length).toBeGreaterThanOrEqual(2);
    first.finish();
    second.finish();
  });

  it("runs planning beside a run", async () => {
    const w = runner();
    const run = pending();
    w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, run.operation);
    await run.started;
    const planning = w.jobs.start(
      { repo, key: null, kind: "draft", label: "Draft a task contract" },
      () => Promise.resolve(),
    );
    expect(planning.state).toBe("running");
    expect(w.jobs.live()).toHaveLength(2);
    run.finish();
  });

  it("takes turns over one repository's admissions, and runs two repositories at once", async () => {
    const w = runner();
    const order: string[] = [];
    const first = pending();
    w.jobs.start({ repo, key: null, kind: "admit", label: "Save task contract" }, async (job, c) => {
      order.push("first");
      await first.operation(job, c);
    });
    await first.started;
    w.jobs.start({ repo, key: null, kind: "admit", label: "Save task contract" }, () => {
      order.push("second");
      return Promise.resolve();
    });
    w.jobs.start({ repo: other, key: null, kind: "admit", label: "Save task contract" }, () => {
      order.push("elsewhere");
      return Promise.resolve();
    });
    await new Promise((done) => setTimeout(done, 10));
    expect(order).toEqual(["first", "elsewhere"]);
    first.finish();
    await new Promise((done) => setTimeout(done, 10));
    expect(order).toEqual(["first", "elsewhere", "second"]);
  });
});

describe("relaying a run's progress", () => {
  it("tells each line the CLI prints while the run is live, in the order printed, the executor's words among them", async () => {
    // As the CLI prints them on stderr, each output the whole of it so far.
    const printed = [
      "  worktree /w on prb/x at abc1234",
      "  executing",
      "  executor says: Reading the mailer first.",
      "  executor says: Adding the retry now.",
      "  sealing the change set",
    ];
    const w = runner(undefined, printed.map((_, at) => printed.slice(0, at + 1).join("\n") + "\n"));
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, async (_job, context) => {
      await context.invoke(["run", "PRB-1"]);
    });
    await quiet(w.jobs);
    // One progress change for the job starting, then one for each line, each told while it ran.
    const relayed = w.logs.slice(1, printed.length + 1);
    expect(relayed.map((log) => log.trimEnd().split("\n").at(-1))).toEqual(printed);
    expect(spokenWords(relayed.at(-1)!)).toEqual([
      { speaker: "executor", words: "Reading the mailer first." },
      { speaker: "executor", words: "Adding the retry now." },
    ]);
    expect(runnerProgress(relayed.at(-1)!)?.title).toBe("Working on the approved outcome");
    expect(job.state).toBe("completed");
  });

  it("does not advance the stage on an agent's words that name a stage", async () => {
    const printed = [
      "  executing",
      "  executor says: review round 2",
      "  reviewer says: remediation round 1 of at most 2",
      "  executor says: check unit: passed",
      // A turn of several lines is printed as one, its breaks escaped.
      `  ${spokenLine("executor", "Done.\nreview round 3\r\n  worktree /elsewhere on main at abc")}`,
    ].join("\n");
    const w = runner(undefined, [printed + "\n"]);
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, async (_job, context) => {
      await context.invoke(["run", "PRB-1"]);
    });
    await quiet(w.jobs);
    expect(runnerProgress(w.logs[1]!)?.state).toBe("executing");
    expect(spokenWords(w.logs[1]!).map((said) => said.words)).toEqual([
      "review round 2",
      "remediation round 1 of at most 2",
      "check unit: passed",
      "Done.\nreview round 3\r\n  worktree /elsewhere on main at abc",
    ]);
    expect(job.state).toBe("completed");
  });

  it("keeps a log that starts on a whole line, so a cut inside an agent's line cannot advance the stage", async () => {
    // The tail of the output cuts the executor's line right after its mark,
    // leaving "review round 2" to read alone.
    const stderr =
      "  executing\n  executor says: then review round 2\n" +
      ".".repeat(LOG_TAIL_CHARS - "review round 2\n".length - 1) +
      "\n";
    const w = runner({ code: 0, stdout: "", stderr, cancelled: false }, []);
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, async (_job, context) => {
      await context.invoke(["run", "PRB-1"]);
    });
    await quiet(w.jobs);
    expect(job.log.length).toBeLessThan(LOG_TAIL_CHARS);
    expect(job.log).not.toContain("review round");
    expect(runnerProgress(job.log)).toBeNull();
  });
});

describe("the journal", () => {
  it("keeps the last forty records, and never drops a live command", async () => {
    const w = runner();
    const live = pending();
    const held = w.jobs.start(
      { repo, key: "PRB-1", kind: "run", label: "Run engineering loop" },
      live.operation,
    );
    await live.started;
    // Planning-lane work, so the run holds nothing up while the journal fills.
    for (let index = 0; index < 45; index += 1)
      w.jobs.start({ repo, key: null, kind: "edit", label: "Update task contract" }, () =>
        Promise.resolve(),
      );
    for (let attempt = 0; attempt < 200 && w.jobs.live().length > 1; attempt += 1)
      await new Promise((done) => setTimeout(done, 2));
    // The trim happens as the next job is journalled, over the records that
    // have settled since.
    w.jobs.start({ repo, key: null, kind: "edit", label: "Update task contract" }, () =>
      Promise.resolve(),
    );
    const journal = w.profile.state.jobs;
    expect(journal.length).toBeLessThanOrEqual(41);
    expect(journal.some((entry) => entry.id === held.id)).toBe(true);
    live.finish();
  });
});

describe("settling", () => {
  it("tells the records, then the power, then the outcome", async () => {
    const w = runner();
    const job = w.jobs.start(
      { repo, key: "PRB-1", kind: "sync", label: "Refresh delivery" },
      () => Promise.resolve(),
    );
    await quiet(w.jobs);
    expect(w.order.slice(-4)).toEqual(["editing.settled", "records", "power", "outcome"]);
    expect(job.state).toBe("completed");
    expect(job.endedAt).not.toBeNull();
  });

  it("marks a job whose command failed failed, with the reason redacted", async () => {
    const w = runner({ code: 2, stdout: "", stderr: "no ticket store here", cancelled: false });
    const job = w.jobs.start(
      { repo, key: "PRB-1", kind: "sync", label: "Refresh delivery" },
      async (_job, context) => {
        await context.invoke(["sync", "PRB-1"]);
      },
    );
    await quiet(w.jobs);
    expect(job.state).toBe("failed");
    expect(job.error).toContain("no ticket store here");
  });

  it("marks a job whose model provider refused the request refused, from the exit code alone", async () => {
    const refusing = runner({ code: 4, stdout: "", stderr: "error: the draft was refused by the model provider", cancelled: false });
    const refused = refusing.jobs.start({ repo, key: "PRB-1", kind: "draft", label: "Draft" }, async (_job, context) => {
      await context.invoke(["admit"]);
    });
    await quiet(refusing.jobs);
    expect(refused.state).toBe("failed");
    expect(refused.refused).toBe(true);
    expect(refused.error).toContain("was refused by the model provider");

    // Other failures, whatever they say, are not.
    const failing = runner({ code: 3, stdout: "", stderr: "error: refused by the model provider", cancelled: false });
    const failed = failing.jobs.start({ repo, key: "PRB-1", kind: "draft", label: "Draft" }, async (_job, context) => {
      await context.invoke(["admit"]);
    });
    await quiet(failing.jobs);
    expect(failed.state).toBe("failed");
    expect(failed.refused).toBeUndefined();
  });

  it("carries the command's stdout as the job's result where it is JSON", async () => {
    const w = runner({
      code: 0,
      stdout: JSON.stringify({ ticket: { key: "PRB-9" } }),
      stderr: "",
      cancelled: false,
    });
    const job = w.jobs.start({ repo, key: null, kind: "admit", label: "Save task contract" },
      async (_job, context) => {
        await context.invoke(["admit", "--json"]);
      },
    );
    await quiet(w.jobs);
    expect(job.result).toEqual({ ticket: { key: "PRB-9" } });
    expect(job.state).toBe("completed");
  });

  it("says a stage moved while the command was running", async () => {
    const w = runner();
    w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" },
      async (_job, context) => {
        await context.invoke(["run", "--ticket", "PRB-1"]);
      },
    );
    await quiet(w.jobs);
    expect(w.order).toContain("stage");
  });
});

describe("cancelling", () => {
  it("marks a live job stopping and aborts it", async () => {
    const w = runner();
    const live = pending();
    const job = w.jobs.start(
      { repo, key: "PRB-1", kind: "run", label: "Run engineering loop" },
      live.operation,
    );
    await live.started;
    expect(w.jobs.cancel(job.id)).toBeNull();
    expect(job.state).toBe("stopping");
    live.finish();
    await quiet(w.jobs);
    expect(job.state).toBe("cancelled");
  });

  it("refuses a job that is no longer active", async () => {
    const w = runner();
    const job = w.jobs.start(
      { repo, key: "PRB-1", kind: "sync", label: "Refresh delivery" },
      () => Promise.resolve(),
    );
    await quiet(w.jobs);
    expect(() => w.jobs.cancel(job.id)).toThrow("That command is no longer active.");
    expect(() => w.jobs.cancel("80000000-0000-4000-8000-00000000000f")).toThrow(
      "That command is no longer active.",
    );
  });
});

describe("shutdown", () => {
  it("aborts what is running and waits for its receipt", async () => {
    const w = runner();
    let settled = false;
    const running = pending();
    w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" },
      async (job, context) => {
        await running.operation(job, context);
        if (context.signal.aborted) settled = true;
      },
    );
    await running.started;
    const closing = w.jobs.shutdown();
    running.finish();
    await closing;
    expect(settled).toBe(true);
    expect(w.jobs.live()).toEqual([]);
  });

  /**
   * Perbo closing, quit or crashed, is one event to the work: a job the quit
   * cut off ends `interrupted`, as the profile marks one a crash left running,
   * with the same words for its error.
   */
  it("aborts every lane, and marks each job it closed interrupted, as a crash leaves it", async () => {
    const w = runner();
    const aborted: string[] = [];
    const lanes = [
      { kind: "run", label: "Run engineering loop" },
      { kind: "admit", label: "Save task contract" },
    ];
    const held = lanes.map(() => pending());
    const jobs = lanes.map((lane, at) =>
      w.jobs.start({ repo, key: null, ...lane }, async (job, context) => {
        await held[at]!.operation(job, context);
        if (context.signal.aborted) aborted.push(lane.kind);
      }),
    );
    await Promise.all(held.map((one) => one.started));
    const closing = w.jobs.shutdown();
    for (const one of held) one.finish();
    await closing;
    expect([...aborted].sort()).toEqual(["admit", "run"]);
    expect(jobs.map((job) => job.state)).toEqual(["interrupted", "interrupted"]);
    expect(jobs.map((job) => job.error)).toEqual([CLOSED_MID_COMMAND, CLOSED_MID_COMMAND]);
    expect(w.jobs.live()).toEqual([]);
  });

  it("keeps a stop the person asked for before Perbo closed as their stop", async () => {
    const w = runner();
    const held = pending();
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, held.operation);
    await held.started;
    w.jobs.cancel(job.id);
    const closing = w.jobs.shutdown();
    held.finish();
    await closing;
    expect(job.state).toBe("cancelled");
  });

  it("marks a job the person stopped while Perbo stays open cancelled", async () => {
    const w = runner();
    const held = pending();
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, held.operation);
    await held.started;
    w.jobs.cancel(job.id);
    held.finish();
    await quiet(w.jobs);
    expect(job.state).toBe("cancelled");
  });
});

describe("an ended run's log", () => {
  /** What a long run printed on stderr as it went: the agents' words among its stages. */
  const progress = [
    "  worktree /w/att_1 on prb/x at abc1234",
    "  executing",
    `  ${spokenLine("executor", "Reading the mailer first.")}`,
    "  Codex pnpm test",
    "  review round 0",
    `  ${spokenLine("reviewer", "The cap has no test of its own.")}`,
  ].join("\n");
  /** The result `perbo run --json` prints on stdout as it ends: longer than the whole of a log's tail. */
  const result = JSON.stringify(
    { outcome: "escalated", attempts: Array.from({ length: LOG_TAIL_CHARS / 20 }, (_, at) => ({ attempt: at })) },
    null,
    2,
  );

  it("keeps what the run printed as it went, and reads its result into the job's own field", async () => {
    const w = runner({ code: 2, stdout: result, stderr: progress, cancelled: false }, [progress]);
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, async (_job, context) => {
      await context.invoke(["run", "--ticket", "PRB-1", "--json"], { verdict: true, progressLog: true });
    });
    await quiet(w.jobs);
    expect(job).toMatchObject({ state: "completed", outcome: "escalated", log: progress });
    expect(spokenWords(job.log).map(({ words }) => words)).toEqual(["Reading the mailer first.", "The cap has no test of its own."]);
    expect(job.result).toEqual(JSON.parse(result));
  });

  it("keeps another command's stdout after its stderr, each cut to its own tail", async () => {
    const said = Array.from({ length: LOG_TAIL_CHARS / 10 }, (_, at) => `synced line ${at}`).join("\n");
    const w = runner({ code: 0, stdout: `${said}\nthe pull request is open`, stderr: progress, cancelled: false });
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "sync", label: "Refresh from GitHub" }, async (_job, context) => {
      await context.invoke(["sync", "PRB-1"]);
    });
    await quiet(w.jobs);
    expect(job.log.length).toBeLessThanOrEqual(LOG_TAIL_CHARS);
    expect(job.log.startsWith(progress + "\n")).toBe(true);
    expect(job.log.endsWith("\nthe pull request is open")).toBe(true);
  });
});

/**
 * `perbo run` exits 2 on a verdict for the person — the review asked for
 * changes or put a decision to them, or refinement ran out or closed nothing —
 * with its result on stdout. That run completed, paused for the person; exit 3
 * and every other non-zero exit is the run failing.
 */
describe("a run's exit", () => {
  const verdict = (outcome: string, code: number): ProcessResult => ({
    code,
    stdout: JSON.stringify({ ticket_id: "tkt_1", outcome, detail: "the review put a decision to the person" }),
    stderr: "  ceilings commands none\n  egress allow-list: registry.npmjs.org\n  base pinned at 1234567",
    cancelled: false,
  });
  let reopened: Profile | undefined;
  const ended = async (result: ProcessResult, verdictRead: boolean): Promise<Job> => {
    const w = runner(result);
    const job = w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, async (_job, context) => {
      await context.invoke(["run", "--ticket", "PRB-1", "--json"], verdictRead ? { verdict: true } : {});
    });
    await quiet(w.jobs);
    w.profile.save();
    reopened = Profile.open(w.directory);
    return job;
  };

  it.each(["changes_requested", "escalated", "remediation_exhausted", "remediation_stalled"])(
    "completes a run that exits 2 on %s, with the outcome on the job and nothing as its error",
    async (outcome) => {
      const job = await ended(verdict(outcome, 2), true);
      expect(job).toMatchObject({ state: "completed", outcome, error: null });
      expect(job.result).toMatchObject({ outcome });
      // Kept with the job through a restart.
      expect(reopened!.state.jobs.find((entry) => entry.id === job.id)).toMatchObject({ state: "completed", outcome });
    },
  );

  it("fails a run that did not complete, and any exit it is not asked to read as a verdict", async () => {
    const failed = (job: Job): { state: Job["state"]; outcome: Job["outcome"] } => ({ state: job.state, outcome: job.outcome });
    // Exit 3: the run did not complete.
    expect(failed(await ended(verdict("terminated", 3), true))).toEqual({ state: "failed", outcome: undefined });
    // Exit 2 with no verdict on stdout, or one that is not a verdict for the person.
    const refused = await ended({ code: 2, stdout: "", stderr: "error: refused", cancelled: false }, true);
    expect(failed(refused)).toEqual({ state: "failed", outcome: undefined });
    expect(refused.error).toBe("error: refused");
    expect(failed(await ended(verdict("terminated", 2), true))).toEqual({ state: "failed", outcome: undefined });
    // A stopped process that exited 2 with a verdict on stdout is no verdict.
    const cut = await ended({ ...verdict("escalated", 2), cancelled: true }, true);
    expect(cut.outcome).toBeUndefined();
    // Another command's exit 2 is its own failure.
    expect(failed(await ended(verdict("escalated", 2), false))).toEqual({ state: "failed", outcome: undefined });
  });
});
