import { randomUUID } from "node:crypto";
import { busyMessage, exclusiveJob, isLive, journal, lane } from "../../shared/jobs.js";
import { logTail, redact, requireSuccess } from "../process.js";
import type { Cli } from "../cli.js";
import type { Changes } from "../changes.js";
import type { ContractEditing, EditingOwner } from "../../shared/contract-editing.js";
import type { ProcessResult } from "../process.js";
import type { Profile, RegisteredRepository } from "../profile/store.js";
import type { WorkspaceReads } from "../workspace-reads.js";
import type { Job } from "../../shared/protocol.js";

/** What a running job is given: its cancellation, and the CLI in its own repository. */
export interface JobContext {
  signal: AbortSignal;
  invoke(args: string[]): Promise<ProcessResult>;
}
export type JobOperation = (job: Job, context: JobContext) => Promise<void>;

export interface JobRunnerDeps {
  profile: Profile;
  changes: Changes;
  reads: WorkspaceReads;
  cli: Cli;
  editing: Pick<ContractEditing, "started" | "settled">;
  /** The power hold, which follows whether a run is live. */
  liveChanged(): void;
  /** A stage the loop reported while the job was running. */
  progressed(job: Job): void;
  /** The outcome, once the receipt is saved. */
  settled(job: Job): Promise<void>;
}

/** Long enough for a loop that runs overnight; the ceilings that matter are the runner's. */
const COMMAND_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** Progress is persisted at most this often; every progress change is still told. */
const SAVE_INTERVAL_MS = 1500;

/**
 * Every command this host runs, and what running one means for the rest of it.
 *
 * Planning runs beside a run (D-101): only the exclusive lane refuses a second
 * job, and within a repository the admissions take turns, because the ticket
 * store hands out a key by scanning what it holds.
 */
export class JobRunner {
  private readonly deps: JobRunnerDeps;
  /** Every command still running, by job id. */
  private readonly active = new Map<
    string,
    { job: Job; controller: AbortController; done: Promise<void> }
  >();
  /**
   * The tail of each repository's admissions. The ticket store hands out a key
   * by scanning what it holds, so two `admit` processes over one store return
   * the same key and the second overwrites the first; within a repository they
   * take turns. Planning still runs beside a run, beside an edit, and beside
   * planning in another repository.
   */
  private readonly admissions = new Map<string, Promise<void>>();

  constructor(deps: JobRunnerDeps) {
    this.deps = deps;
  }

  /** The jobs still tracked, in either lane. */
  live(): Job[] {
    return [...this.active.values()].map((entry) => entry.job);
  }

  /** Settles when this job has, however it ends; at once for one no longer tracked. */
  settled(jobId: string): Promise<void> {
    return this.active.get(jobId)?.done ?? Promise.resolve();
  }

  start(
    options: {
      repo: RegisteredRepository;
      key: string | null;
      kind: string;
      label: string;
      owner?: EditingOwner | undefined;
      /**
       * On the job from the moment it exists, so the attempt that carries on
       * after a stop publishes as this one was going to, even when the stop
       * came before the operation started.
       */
      publish?: boolean | undefined;
    },
    operation: JobOperation,
  ): Job {
    const { repo, key, kind, label, owner, publish } = options;
    const blocking = lane(kind) === "exclusive" ? exclusiveJob(this.live()) : undefined;
    if (blocking) throw new Error(busyMessage(blocking.label));
    const controller = new AbortController();
    const job: Job = {
      id: randomUUID(),
      repoId: repo.id,
      key,
      kind,
      label,
      state: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      log: "",
      error: null,
      resultKey: null,
      result: null,
      ...(owner ? { editing: owner } : {}),
      ...(publish === undefined ? {} : { publish }),
    };
    // The journal never drops a live command: cancelling one and saving its
    // editing receipt both need its record.
    this.deps.profile.state.jobs = journal([...this.deps.profile.state.jobs, job], (entry) =>
      this.active.has(entry.id),
    );
    const admits = kind === "draft" || kind === "admit";
    const ahead = admits ? this.admissions.get(repo.id) : undefined;
    // Reserve the job's place synchronously, before operation can yield or another IPC request can enter.
    const done = (ahead ?? Promise.resolve())
      .then(() => {
        if (controller.signal.aborted) throw new Error("Command cancelled before starting");
        return operation(job, {
          signal: controller.signal,
          invoke: (args) => this.invoke(job, repo, args, controller.signal),
        });
      })
      .then(() => {
        job.state = controller.signal.aborted ? "cancelled" : "completed";
      })
      .catch((error: unknown) => {
        job.error = redact(error instanceof Error ? error.message : String(error));
        job.state = controller.signal.aborted ? "cancelled" : "failed";
      })
      .finally(async () => {
        job.endedAt = new Date().toISOString();
        this.deps.reads.invalidate(repo.id);
        try {
          await this.deps.editing.settled(job);
          this.deps.changes.changed(true, {
            kind: "records",
            repoId: repo.id,
            key: job.resultKey ?? key,
            job,
          });
          this.deps.liveChanged();
          await this.deps.settled(job);
        } catch (error) {
          job.error = `Could not save the command status: ${redact(String(error))}`;
          job.state = "failed";
          this.deps.changes.changed(false, {
            kind: "records",
            repoId: repo.id,
            key: job.resultKey ?? key,
            job,
          });
          this.deps.liveChanged();
        } finally {
          // Held until the receipt is saved and the outcome told, so a
          // shutdown awaits it; the job is no longer live by then, so it is
          // in nobody's way, and a stop no longer reaches it.
          this.active.delete(job.id);
        }
      });
    this.active.set(job.id, { job, controller, done });
    if (admits) {
      this.admissions.set(repo.id, done);
      void done.then(() => {
        if (this.admissions.get(repo.id) === done) this.admissions.delete(repo.id);
      });
    }
    try {
      if (owner) this.deps.editing.started(owner, job);
      this.deps.changes.changed(true, { kind: "progress", job });
      this.deps.liveChanged();
    } catch (error) {
      controller.abort();
      throw error;
    }
    return job;
  }

  cancel(jobId: string): null {
    const entry = this.active.get(jobId);
    // A finished job stays tracked while its receipt is saved; it is not one
    // a stop can reach, and marking it stopping would leave it there for good.
    if (!entry || !isLive(entry.job)) throw new Error("That command is no longer active.");
    entry.job.state = "stopping";
    entry.controller.abort();
    this.deps.changes.changed(true, { kind: "progress", job: entry.job });
    return null;
  }

  /** Every command is cancelled, and its receipt awaited, before the app closes. */
  async shutdown(): Promise<void> {
    const running = [...this.active.values()];
    for (const entry of running) entry.controller.abort();
    await Promise.all(running.map((entry) => entry.done));
  }

  /**
   * One invocation of the CLI for a job: its output becomes the job's log as it
   * arrives, persisted no more often than the interval, and its stdout the
   * job's result where it is JSON.
   */
  private async invoke(
    job: Job,
    repo: RegisteredRepository,
    args: string[],
    signal: AbortSignal,
  ): Promise<ProcessResult> {
    const result = await this.deps.cli.run(args, repo, {
      signal,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onOutput: (output) => {
        if (job.log === output) return;
        job.log = output;
        this.deps.changes.changed(
          Date.now() - this.deps.profile.lastSave > SAVE_INTERVAL_MS,
          { kind: "progress", job },
        );
        this.deps.progressed(job);
      },
    });
    job.log = logTail(redact([result.stderr, result.stdout].filter(Boolean).join("\n")));
    requireSuccess(result);
    if (result.stdout.trim()) {
      try {
        job.result = JSON.parse(result.stdout);
      } catch {
        job.result = null;
      }
    }
    return result;
  }
}
