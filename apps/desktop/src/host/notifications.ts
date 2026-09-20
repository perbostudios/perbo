import { isEarlyStop, readAttempts } from "./records.js";
import { runnerProgress } from "../shared/runner-progress.js";
import { attemptsPath } from "./repository/layout.js";
import type { HostIO } from "./service.js";
import type { TicketReads } from "./tickets/reads.js";
import type { RegisteredRepository } from "./profile/store.js";
import type { Job, Settings } from "../shared/protocol.js";
import type { Ticket } from "@perbo/contracts";

export interface NoticeDeps {
  io: HostIO;
  settings(): Settings;
  repositories(): readonly RegisteredRepository[];
  tickets: Pick<TicketReads, "list">;
}

/**
 * The four moments a person asked to be interrupted for, and the stage a run
 * moved to while they were away.
 */
export class Notices {
  private readonly deps: NoticeDeps;
  /** The stage each job last reported, so one stage is announced once. */
  private readonly stages = new Map<string, string>();

  constructor(deps: NoticeDeps) {
    this.deps = deps;
  }

  private notify(title: string, body: string): void {
    this.deps.io.notify(title, body, { silent: !this.deps.settings().notifySound });
  }
  stage(job: Job): void {
    if (
      !this.deps.settings().notifyOn.stage ||
      !["run", "decide"].includes(job.kind)
    )
      return;
    const observed = runnerProgress(job.log);
    if (!observed || this.stages.get(job.id) === observed.title) return;
    this.stages.set(job.id, observed.title);
    this.notify(
      `${job.key ?? "Task"} · ${observed.title}`,
      "The loop moved to a new stage.",
    );
  }
  /** The four moments a person asked to be interrupted for, read from the recorded outcome rather than the process exit. */
  async outcome(job: Job): Promise<void> {
    this.stages.delete(job.id);
    const on = this.deps.settings().notifyOn;
    if (!["run", "decide"].includes(job.kind) || !job.key) return;
    const repo = this.deps.repositories().find((entry) => entry.id === job.repoId);
    if (!repo) return;
    let ticket: Ticket | undefined;
    try {
      ticket = (await this.deps.tickets.list(repo)).tickets.find(
        (entry) => entry.key === job.key,
      );
    } catch {
      return;
    }
    if (!ticket) return;
    const reason = readAttempts(
      attemptsPath(repo, ticket.ticket_id),
    ).attempts.at(-1)?.termination?.reason;
    if (on.ceiling && isEarlyStop(reason))
      this.notify(
        reason === "stalled"
          ? `${ticket.key} stopped: the agent went quiet`
          : `${ticket.key} stopped at a ceiling`,
        reason === "stalled"
          ? "No tool activity for the stall window, so the loop stopped it. Nothing was lost — " +
              "open the task to see what it had done and recover."
          : "The loop stopped and nothing was lost. Open the task to raise the ceiling or recover.",
      );
    else if (on.decision && ticket.state === "changes_requested")
      this.notify(
        `${ticket.key} needs a decision`,
        "The loop is paused until you answer.",
      );
    else if (
      on.review &&
      job.state === "completed" &&
      ["pr_open", "ready", "merged"].includes(ticket.state)
    )
      this.notify(
        `${ticket.key} · review finished`,
        ticket.delivery.pull_request_url
          ? "The pull request is open. The merge is yours."
          : "The result is ready to review.",
      );
    else if (on.review && job.state === "failed")
      this.notify(
        `${ticket.key} · the loop stopped`,
        job.error ?? "Open the task to inspect the cause.",
      );
  }
}
