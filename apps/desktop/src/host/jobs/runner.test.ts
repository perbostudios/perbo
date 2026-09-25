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
import type { RegisteredRepository } from "../profile/store.js";

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
  return { jobs, profile, told, logs, order, runs, started, changes };
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
  it("refuses a second job in the exclusive lane, by the label of the one running", async () => {
    const w = runner();
    const first = pending();
    w.jobs.start({ repo, key: "PRB-1", kind: "run", label: "Run engineering loop" }, first.operation);
    await first.started;
    expect(() =>
      w.jobs.start({ repo, key: "PRB-2", kind: "run", label: "Run engineering loop" }, first.operation),
    ).toThrow(/Run engineering loop/);
    first.finish();
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

  it("aborts every lane, and marks each job it closed cancelled", async () => {
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
    expect(jobs.map((job) => job.state)).toEqual(["cancelled", "cancelled"]);
    expect(w.jobs.live()).toEqual([]);
  });
});
