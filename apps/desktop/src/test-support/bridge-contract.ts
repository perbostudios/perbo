import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { busyMessage, lane } from "../shared/jobs.js";
import { ChangeSchema, INTERVIEW_NEEDS_A_TITLE } from "../shared/protocol.js";
import type { Change, DesktopBridge, Job } from "../shared/protocol.js";

/**
 * One adapter of the desktop's request protocol, set up far enough to be asked
 * the questions below. The host answers over a repository on disk and the
 * sample host over records in memory; neither is told which it is.
 */
export interface ContractSubject {
  bridge: DesktopBridge;
  repoId: string;
  /** A ticket nobody has approved, with no attempt behind it. */
  unapprovedKey: string;
  /** A ticket a run may be started on. */
  runnableKey: string;
  /** Start a run on `key` and hold it live; the job it resolves to is the one running. */
  startHeldRun(key: string): Promise<Job>;
  /** Every change the subject pushed while the suite ran. */
  changes: Change[];
  dispose(): Promise<void>;
}

const UNKNOWN_KEY = "PRB-9999999";

/**
 * What answering the desktop's protocol means, run against every adapter that
 * claims to ([D-120](../../../../docs/11-open-decisions.md)).
 *
 * The cases are the promises a screen is written against — a refusal is a
 * refusal, a snapshot's rows name repositories it also carries, one command in
 * the exclusive lane at a time — and not the wording of a message the two
 * adapters are free to spell differently. Where the wording is the protocol's
 * own, declared once in `src/shared/`, it is compared as written.
 */
export function describeBridgeContract(name: string, setup: () => Promise<ContractSubject>): void {
  describe(`${name} answers the desktop's protocol`, () => {
    let subject: ContractSubject;
    /** The run one case holds live and the next one stops. */
    let running: Job | null = null;
    beforeAll(async () => {
      subject = await setup();
    }, 120_000);
    afterAll(async () => {
      await subject.dispose();
    }, 120_000);

    it("refuses a request the protocol does not declare", async () => {
      await expect(
        subject.bridge.request({ kind: "nothing-like-this" } as never),
      ).rejects.toThrow();
    });

    it("carries a snapshot whose rows and jobs name what it also carries", async () => {
      const snapshot = await subject.bridge.request({ kind: "snapshot" });
      const repositories = snapshot.repositories.map((entry) => entry.id);
      expect(repositories).toContain(subject.repoId);
      for (const row of snapshot.tasks) expect(repositories).toContain(row.repoId);
      for (const job of snapshot.jobs) expect(lane(job.kind)).toBeDefined();
      // Nothing on the wire says which adapter answered, and no row carries a
      // reading of its own work that the records did not produce.
      expect("mode" in snapshot).toBe(false);
      for (const row of snapshot.tasks) expect("summary" in row).toBe(false);
    });

    it("carries a ticket's detail with nothing on it the records did not make", async () => {
      const detail = await subject.bridge.request({
        kind: "detail",
        repoId: subject.repoId,
        key: subject.unapprovedKey,
      });
      expect("sample" in detail).toBe(false);
    });

    it("answers a repository's own snapshot with that repository's rows and no others", async () => {
      const reply = await subject.bridge.request({
        kind: "repositorySnapshot",
        repoId: subject.repoId,
      });
      expect(reply.repository.id).toBe(subject.repoId);
      for (const row of reply.tasks) expect(row.repoId).toBe(subject.repoId);
    });

    it("refuses a save against a revision that has moved, and forgets a discarded draft", async () => {
      const opened = await subject.bridge.request({
        kind: "editingOpen",
        target: { kind: "fresh", repoId: subject.repoId },
      });
      const saved = await subject.bridge.request({
        kind: "editingSave",
        id: opened.id,
        revision: opened.revision,
        repoId: subject.repoId,
        form: opened.form,
      });
      expect(saved.revision).not.toBe(opened.revision);
      await expect(
        subject.bridge.request({
          kind: "editingSave",
          id: opened.id,
          revision: opened.revision,
          repoId: subject.repoId,
          form: opened.form,
        }),
      ).rejects.toThrow();
      await subject.bridge.request({
        kind: "editingDiscard",
        id: saved.id,
        revision: saved.revision,
      });
      const drafts = await subject.bridge.request({ kind: "drafts" });
      expect(drafts.some((draft) => draft.id === opened.id)).toBe(false);
    });

    it("writes down when a ticket's page opened and tells it on its own, refusing a ticket it does not hold", async () => {
      const { bridge, repoId, runnableKey } = subject;
      const entry = repoId + ":" + runnableKey;
      const before = new Date().toISOString();
      await bridge.request({ kind: "ticketOpened", repoId, key: runnableKey });
      const at = (await bridge.request({ kind: "snapshot" })).lastOpened?.[entry];
      expect(at !== undefined && at >= before).toBe(true);
      expect(
        subject.changes.some((change) => change.kind === "opened" && change.lastOpened[entry] === at),
      ).toBe(true);
      await expect(
        bridge.request({ kind: "ticketOpened", repoId, key: UNKNOWN_KEY }),
      ).rejects.toThrow();
    });

    it("refuses every read of a ticket it does not hold", async () => {
      const { bridge, repoId } = subject;
      await expect(bridge.request({ kind: "detail", repoId, key: UNKNOWN_KEY })).rejects.toThrow();
      await expect(bridge.request({ kind: "graphRead", repoId, key: UNKNOWN_KEY })).rejects.toThrow();
      await expect(bridge.request({ kind: "taskSummary", repoId, key: UNKNOWN_KEY })).rejects.toThrow();
      await expect(bridge.request({ kind: "output", repoId, key: UNKNOWN_KEY })).rejects.toThrow();
    });

    it("refuses an attempt that is not this ticket's", async () => {
      await expect(
        subject.bridge.request({
          kind: "output",
          repoId: subject.repoId,
          key: subject.unapprovedKey,
          attemptId: "attempt_no_such_thing",
        }),
      ).rejects.toThrow();
    });

    it("refuses to read a path nothing reads", async () => {
      await expect(
        subject.bridge.request({ kind: "explorerRead", repoId: subject.repoId, path: ".env" }),
      ).rejects.toThrow();
    });

    it("refuses an interview for a planning with no spec to write to", async () => {
      const opened = await subject.bridge.request({
        kind: "editingOpen",
        target: { kind: "fresh", repoId: subject.repoId },
      });
      await expect(
        subject.bridge.request({ kind: "interviewStart", repoId: subject.repoId, id: opened.id }),
      ).rejects.toThrow(new Error(INTERVIEW_NEEDS_A_TITLE));
      const current = await subject.bridge.request({ kind: "editingRead", id: opened.id });
      await subject.bridge.request({
        kind: "editingDiscard",
        id: current.id,
        revision: current.revision,
      });
    });

    it("refuses to stop a command that is not running", async () => {
      await expect(
        subject.bridge.request({ kind: "cancel", jobId: crypto.randomUUID() }),
      ).rejects.toThrow(new Error("That command is no longer active."));
    });

    it("refuses a second command in the exclusive lane, naming the one running", async () => {
      const { bridge, repoId, unapprovedKey } = subject;
      running = await subject.startHeldRun(subject.runnableKey);
      const held = running;
      const row = async () =>
        (await bridge.request({ kind: "snapshot" })).tasks.find(
          (entry) => entry.repoId === repoId && entry.ticket.key === unapprovedKey,
        )!;
      const before = await row();
      await expect(
        bridge.request({
          kind: "run",
          repoId,
          key: unapprovedKey,
          digest: (await bridge.request({ kind: "detail", repoId, key: unapprovedKey })).digest,
          publish: false,
          approve: true,
          resumeFrom: null,
        }),
      ).rejects.toThrow(new Error(busyMessage(held.label)));
      expect((await row()).ticket.state).toBe(before.ticket.state);
    });

    it("refuses to stop a command that has already stopped", async () => {
      const { bridge } = subject;
      const held = running!;
      await bridge.request({ kind: "cancel", jobId: held.id });
      for (let count = 0; count < 400; count++) {
        const job = (await bridge.request({ kind: "snapshot" })).jobs.find(
          (entry) => entry.id === held.id,
        );
        if (!job || !["running", "stopping"].includes(job.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await expect(bridge.request({ kind: "cancel", jobId: held.id })).rejects.toThrow(
        new Error("That command is no longer active."),
      );
    }, 30_000);

    it("pushes only changes the protocol declares", () => {
      expect(subject.changes.length).toBeGreaterThan(0);
      for (const change of subject.changes) expect(() => ChangeSchema.parse(change)).not.toThrow();
    });
  });
}
