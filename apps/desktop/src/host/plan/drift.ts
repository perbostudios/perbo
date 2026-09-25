import { DriftVerdictSchema, type DriftVerdict } from "@perbo/planning";
import { redact, requireSuccess } from "../process.js";
import {
  REREAD_COULD_NOT_START,
  turnMark,
  turnOverlapped,
  type TurnMark,
} from "../../shared/contract-editing.js";
import type { Cli } from "../cli.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { JobRunner } from "../jobs/runner.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { WorkspaceReads } from "../workspace-reads.js";
import type { Ticket } from "@perbo/contracts";
import type {
  EditingSession,
  InterviewEntry,
  Job,
  Settings,
  TaskModels,
} from "../../shared/protocol.js";

export interface DriftDeps {
  editing: Pick<ContractEditing, "read" | "landDrift" | "clearDrift" | "recordRead">;
  /** Every planning this host keeps, live or not. */
  sessions(): readonly EditingSession[];
  repository(id: string): RegisteredRepository;
  tickets: { list(repo: RegisteredRepository): Promise<{ tickets: Ticket[] }> };
  reads: Pick<WorkspaceReads, "invalidate">;
  jobs: Pick<JobRunner, "start" | "live" | "settled">;
  cli: Pick<Cli, "run">;
  /** The models this ticket drafts with: its own where the contract page chose them, else the settings'. */
  models(repoId: string, key: string): TaskModels | Settings;
  /** The planning's chat, which a reading lands in. */
  interview: {
    working(id: string): boolean;
    say(id: string, line: InterviewEntry["line"]): InterviewEntry | null;
    askingChanged(id: string): void;
  };
}

/**
 * The plan read against the spec it was drafted from
 * (D-128): `perbo drift`, which keeps its
 * verdict beside the ticket keyed by the spec's bytes and the plan's promise
 * texts, and runs a model only where one of the two has moved since the last
 * reading. A job because a model may run; planning-lane, because it is
 * planning (D-101).
 */
export class DriftReadings {
  private readonly deps: DriftDeps;
  /**
   * The plannings with a reading of their plan against the spec in flight:
   * from the moment one is asked for, before anything is awaited, until its
   * job has settled. Two readings of one planning at once would land on top of
   * each other, so a second asked for meanwhile is owed instead.
   */
  private readonly readings = new Set<string>();
  /** The plannings owed another reading once the one in flight settles. */
  private readonly rereadOwed = new Set<string>();
  /**
   * How many times each ticket's problems have been forgotten — dismissed or
   * approved past — so a reading that started before one and lands after it
   * knows the state it read is gone (D-128).
   */
  private readonly driftEpoch = new Map<string, number>();

  constructor(deps: DriftDeps) {
    this.deps = deps;
  }

  /**
   * The ticket a drift reading is of, and its repository, derived from the
   * session's own records: the session names itself and nothing else
   * (ADR-0023 §4).
   *
   * Refused where there is nothing to read — a planning thrown away, whose
   * work is being deleted, no spec yet, or no plan drafted from it — and on an
   * approved ticket, whose plan is frozen (ADR-0016): a finding there would
   * offer a change the interview may not make. The
   * approved case is the desktop's refusal and not the CLI's, because it is the
   * desktop that puts this reading on the way to the contract, and an approved
   * plan goes there without it.
   */
  private async target(id: string): Promise<{ repo: RegisteredRepository; key: string }> {
    const session = this.deps.editing.read(id);
    const repo = this.deps.repository(session.repoId);
    if (session.phase === "discarded")
      throw new Error("This planning has been thrown away, and its plan with it.");
    if (session.specSlug === null)
      throw new Error("Write the spec before reading it against the plan.");
    if (session.key === null)
      throw new Error("Draft a plan from the spec before reading the two against each other.");
    const key = session.key;
    const ticket = (await this.deps.tickets.list(repo)).tickets.find((entry) => entry.key === key);
    if (ticket?.approved_at)
      throw new Error(
        `${key} is approved, and what it promises was settled with it. The spec is no ` +
          "longer this page's to read it against.",
      );
    return { repo, key };
  }

  /**
   * Read the plan against its spec. The model is the ticket's own where the
   * contract page chose one, else the settings' — the same resolution drafting
   * the plan makes, since this is the drafter's reading of its own work.
   * `state` is the asker's fingerprint of what it asked about, recorded on the
   * planning once the reading lands of it, or null where it has none.
   */
  async check(id: string, state: string | null): Promise<Job> {
    // Whether the interview's turn is in flight as the reading starts, and the
    // last one sent: a turn overlapping the reading may still move what it
    // reads, and what it finds is then not put ({@link ContractEditing.landDrift}).
    const before = turnMark(this.deps.editing.read(id), this.deps.interview.working(id));
    const { repo, key } = await this.target(id);
    // The state the reading is of: a dismissal or an approval while it runs
    // moves this on, and what it finds is then about a plan the person has
    // gone past, and is recorded nowhere.
    const epoch = this.driftEpoch.get(repo.id + ":" + key) ?? 0;
    const job = this.deps.jobs.start(
      { repo, key, kind: "drift", label: "Read the plan against the spec" },
      async (job, run) => {
        const models = this.deps.models(repo.id, key);
        await run.invoke([
          "drift",
          key,
          "--provider",
          models.draftingProvider,
          "--model",
          models.executorModel,
          "--json",
        ]);
        // Parsed so the renderer holds a verdict and never the CLI's raw
        // stdout; a print that is not one fails the job rather than reaching a
        // card.
        const verdict = DriftVerdictSchema.parse(job.result);
        // And what the model said goes to the person redacted and flattened,
        // because it is the model's text about the spec and the plan, and a
        // secret either quoted would otherwise land in the record and on the
        // page. The model was held to each field's length as it wrote, and
        // nothing is cut to fit here: a word cut short is a sentence the
        // person reads as something it did not say. Redaction can empty a
        // field outright (a heading that was only escape codes), or lengthen
        // it past what the field holds (a short secret written as
        // `[redacted]`), and a card with no heading or no difference, or with
        // one cut short, is not one to put, so the reading fails rather than
        // showing it; a detail is the one field that may go, whole.
        const shown = (text: string): string => redact(text).replace(/\s+/g, " ").trim();
        const required = (text: string, cap: number, field: string): string => {
          const kept = shown(text);
          if (kept.length === 0)
            throw new Error(`The reading's ${field} did not survive redaction.`);
          if (kept.length > cap)
            throw new Error(
              `The reading's ${field} is longer than the ${cap} characters it may hold once a secret in it is ` +
                "redacted, and is not shown cut short.",
            );
          return kept;
        };
        const optional = (text: string | null, cap: number): string | null => {
          const kept = text === null ? "" : shown(text);
          return kept.length === 0 || kept.length > cap ? null : kept;
        };
        const landed = DriftVerdictSchema.parse({
          ...verdict,
          findings: verdict.findings.map((finding) => ({
            heading: required(finding.heading, 120, "heading"),
            difference: required(finding.difference, 600, "difference"),
            options: finding.options.map((option) => ({
              label: required(option.label, 200, "option"),
              detail: optional(option.detail, 600),
              recommended: option.recommended,
            })),
          })),
        });
        job.result = landed;
        await this.landed(id, repo, key, epoch, before, landed, state);
      },
    );
    // A reading is in flight for this planning from here until its job has
    // settled — however it ends — and a re-read owed meanwhile starts then.
    this.readings.add(id);
    const settled = (): void => this.settled(id);
    void this.deps.jobs.settled(job.id).then(settled, settled);
    return job;
  }

  /** A reading's job has settled: the next one owed to the planning starts. */
  private settled(id: string): void {
    this.readings.delete(id);
    if (this.rereadOwed.delete(id)) void this.reread(id);
  }

  /**
   * Land a reading on the planning it was of, as
   * {@link ContractEditing.landDrift} does.
   *
   * Nothing is recorded on a plan the person has gone past while the model
   * read: dismissed, or approved, and either way what it promises is settled
   * and a card would offer what the interview may not do (ADR-0016). The
   * ticket is read again for that, since the approval may be another
   * process's.
   *
   * The fields were redacted and held to their lengths as the verdict landed,
   * within what an asked line holds — a heading is shorter than a title, a
   * difference is a question's length, and the options are the interview's
   * own shape — so nothing is measured again here, and a line the record will
   * not hold is the chat's note rather than a throw out of the job.
   *
   * The state the asker read at is recorded only where no turn overlapped the
   * reading: a turn that moved the spec or the plan meanwhile means the
   * reading is not of that state.
   */
  private async landed(
    id: string,
    repo: RegisteredRepository,
    key: string,
    epoch: number,
    before: TurnMark,
    verdict: DriftVerdict,
    state: string | null,
  ): Promise<void> {
    if ((this.driftEpoch.get(repo.id + ":" + key) ?? 0) !== epoch) return;
    this.deps.reads.invalidate(repo.id);
    const ticket = (await this.deps.tickets.list(repo)).tickets.find((entry) => entry.key === key);
    if (ticket === undefined || ticket.approved_at) return;
    let session;
    try {
      session = this.deps.editing.read(id);
    } catch {
      // The planning has gone while the model was reading; there is nothing to
      // record it on.
      return;
    }
    const working = this.deps.interview.working(id);
    const overlapped = turnOverlapped(before, session, working);
    // A turn that ended before this landed may have owed nothing, having found
    // no record to read against, so this one's settling reads again: free
    // where nothing moved since, and it is what puts or resolves.
    if (overlapped && !working) this.rereadOwed.add(id);
    this.deps.editing.landDrift(
      id,
      verdict,
      overlapped,
      (line) => this.deps.interview.say(id, line),
      () => this.deps.interview.askingChanged(id),
    );
    if (state !== null && !overlapped) this.deps.editing.recordRead(id, state);
  }

  /**
   * Read the plan against the spec again, once the interview has finished a
   * turn with a record of problems on the planning: the turn was the person's
   * answer to one, or a hand edit after a resolved round, and whether it closed
   * or re-opened one is what the next reading says. `perbo drift` prints the
   * verdict it holds without a model where neither the spec nor the plan
   * moved, so a turn that changed nothing costs nothing.
   *
   * Never over a reading already in flight for the planning — the pane asks for
   * one on arrival, and two would land on top of each other — but never lost
   * either: a turn that ends while one is running is owed its reading, which
   * starts as that one settles, and however many turns end meanwhile owe one
   * reading between them, since it reads the plan as it then stands. A reading
   * that cannot be started is said in the chat, because the page is waiting on
   * it.
   *
   * Never for a planning thrown away. Its chat is stopped as its work is
   * deleted, and that stop and the chat's exit both end a turn: a reading
   * started there runs `perbo drift` over files being removed, writes its
   * verdict back beside a ticket that has gone, and, still running as the
   * delete checks, holds the repository so the ticket is refused its delete.
   * Both deletes mark the planning thrown away before they stop its chat.
   */
  async reread(id: string): Promise<void> {
    let session;
    try {
      session = this.deps.editing.read(id);
    } catch {
      return;
    }
    if (session.drift === null || session.key === null || session.phase === "discarded") return;
    const key = session.key;
    const live = this.deps.jobs
      .live()
      .some((job) => job.kind === "drift" && job.repoId === session.repoId && job.key === key);
    if (this.readings.has(id) || live) {
      this.rereadOwed.add(id);
      return;
    }
    // In flight from here, before anything is awaited: the ticket is read
    // before the job starts, and a turn ending in that gap would otherwise
    // start a second reading over this one.
    this.readings.add(id);
    try {
      await this.check(id, null);
    } catch (error) {
      // No job, so nothing settles: the flag comes off here, and a reading owed
      // in the gap would fail the same way.
      this.readings.delete(id);
      this.rereadOwed.delete(id);
      this.deps.interview.say(id, {
        kind: "note",
        text: `${REREAD_COULD_NOT_START}: ${redact(error instanceof Error ? error.message : String(error))}`,
      });
    }
  }

  /**
   * The person went on to the contract with the findings open. Recorded on the
   * verdict at the current state, so the same reading is not put to them again
   * until the spec or the plan moves; the CLI refuses it where nothing has been
   * read at this state. Not a job: nothing runs but a write to the record, and
   * the page navigates on the answer.
   */
  async dismiss(id: string): Promise<null> {
    const { repo, key } = await this.target(id);
    requireSuccess(await this.deps.cli.run(["drift", key, "--dismiss", "--json"], repo));
    // And the problems the session held go with it: the person has gone on past
    // them, so the pane comes out of the rail and the ticket lands on the plan
    // again.
    this.forget(repo.id, key, id);
    return null;
  }

  /**
   * The problems over a ticket are forgotten — on one planning, or on every
   * planning over it — and a reading of it in flight is told so, since what it
   * finds is about a state the person has gone past.
   */
  forget(repoId: string, key: string, only: string | null): void {
    const at = repoId + ":" + key;
    this.driftEpoch.set(at, (this.driftEpoch.get(at) ?? 0) + 1);
    for (const session of this.deps.sessions())
      if (
        (only === null ? session.repoId === repoId && session.key === key : session.id === only) &&
        session.phase !== "discarded" &&
        session.drift !== null
      )
        this.deps.editing.clearDrift(session.id);
  }
}
