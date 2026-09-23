import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { Notices } from "./notifications.js";
import { attemptsPath } from "./repository/layout.js";
import { SettingsSchema } from "../shared/protocol.js";
import type { HostIO } from "./service.js";
import type { Job, Settings } from "../shared/protocol.js";
import type { RegisteredRepository } from "./profile/store.js";
import type { Ticket } from "@perbo/contracts";

const scratchDirectory = createScratch("perbo-notices-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const repoId = "80000000-0000-4000-8000-000000000001";
const settings = SettingsSchema.parse({});
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(join(path, ".perbo", "state"), { recursive: true });
  return { id: repoId, name: "checkout", path };
}
const ticket = (over: Record<string, unknown> = {}): Ticket =>
  ({
    key: "PRB-1",
    ticket_id: "ticket_1",
    state: "ready",
    delivery: { pull_request_url: null },
    ...over,
  }) as unknown as Ticket;
const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "80000000-0000-4000-8000-00000000000a",
    repoId,
    key: "PRB-1",
    kind: "run",
    label: "Run engineering loop",
    state: "completed",
    startedAt: "2026-09-19T09:00:00.000Z",
    endedAt: "2026-09-19T09:05:00.000Z",
    log: "",
    error: null,
    resultKey: null,
    result: null,
    ...over,
  }) as Job;
function notices(
  repo: RegisteredRepository,
  over: { settings?: Settings; ticket?: Ticket } = {},
) {
  const shown: { title: string; body: string; silent: boolean | undefined }[] = [];
  const io = {
    notify: (title: string, body: string, options?: { silent: boolean }) => {
      shown.push({ title, body, silent: options?.silent });
    },
  } as unknown as HostIO;
  return {
    shown,
    notices: new Notices({
      io,
      settings: () => over.settings ?? settings,
      repositories: () => [repo],
      tickets: { list: () => Promise.resolve({ tickets: [over.ticket ?? ticket()] }) },
    }),
  };
}
/** Writes the attempts record the outcome is read from. */
function attempts(repo: RegisteredRepository, reason: string | null): void {
  writeFileSync(
    attemptsPath(repo, "ticket_1"),
    JSON.stringify({
      ticket_id: "ticket_1",
      attempts: [
        {
          attempt_id: "att_1",
          created_at: "2026-09-19T09:00:00.000Z",
          ...(reason ? { termination: { reason, detail: "" } } : {}),
        },
      ],
    }),
  );
}
const on = (over: Partial<Settings["notifyOn"]>): Settings => ({
  ...settings,
  notifyOn: { ...settings.notifyOn, ...over },
});

describe("a stage the loop reported", () => {
  it("says it once per stage, and not again for the same one", () => {
    const w = notices(repository(), { settings: on({ stage: true }) });
    const running = job({ state: "running", log: "executing" });
    w.notices.stage(running);
    w.notices.stage(running);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]?.title).toContain("PRB-1");
    w.notices.stage(job({ state: "running", log: "review round 1" }));
    expect(w.shown).toHaveLength(2);
  });

  it("says nothing where the person asked not to be told", () => {
    const w = notices(repository(), { settings: on({ stage: false }) });
    w.notices.stage(job({ state: "running", log: "executing" }));
    expect(w.shown).toEqual([]);
  });

  it("says nothing for a command that is not a run", () => {
    const w = notices(repository(), { settings: on({ stage: true }) });
    w.notices.stage(job({ kind: "sync", log: "executing" }));
    expect(w.shown).toEqual([]);
  });

  it("is silent unless the person asked for a sound", () => {
    const repo = repository();
    const loud = notices(repo, {
      settings: { ...on({ stage: true }), notifySound: true },
    });
    loud.notices.stage(job({ state: "running", log: "executing" }));
    expect(loud.shown[0]?.silent).toBe(false);
    const quiet = notices(repo, {
      settings: { ...on({ stage: true }), notifySound: false },
    });
    quiet.notices.stage(job({ state: "running", log: "executing" }));
    expect(quiet.shown[0]?.silent).toBe(true);
  });
});

describe("the outcome", () => {
  it("says a run stopped at a ceiling, from the recorded reason", async () => {
    const repo = repository();
    attempts(repo, "stalled");
    const w = notices(repo, { settings: on({ ceiling: true }) });
    await w.notices.outcome(job());
    expect(w.shown[0]?.title).toContain("the agent went quiet");
  });

  it("says a task needs a decision where the ticket is waiting on one", async () => {
    const repo = repository();
    attempts(repo, null);
    const w = notices(repo, {
      settings: on({ decision: true }),
      ticket: ticket({ state: "changes_requested" }),
    });
    await w.notices.outcome(job());
    expect(w.shown[0]?.title).toContain("needs a decision");
  });

  it("says the review finished, and whether the pull request is open", async () => {
    const repo = repository();
    attempts(repo, null);
    const open = notices(repo, {
      settings: on({ review: true }),
      ticket: ticket({
        state: "pr_open",
        delivery: { pull_request_url: "https://github.com/perbo/perbo/pull/1" },
      }),
    });
    await open.notices.outcome(job());
    expect(open.shown[0]?.body).toContain("The merge is yours.");
    const ready = notices(repo, { settings: on({ review: true }), ticket: ticket({ state: "ready" }) });
    await ready.notices.outcome(job());
    expect(ready.shown[0]?.body).toContain("ready to review");
  });

  it("says the loop stopped where the job failed, with its error", async () => {
    const repo = repository();
    attempts(repo, null);
    const w = notices(repo, { settings: on({ review: true }) });
    await w.notices.outcome(job({ state: "failed", error: "CLI exited with code 2." }));
    expect(w.shown[0]?.body).toBe("CLI exited with code 2.");
  });

  it("says nothing for a command that is not a run, or one with no ticket", async () => {
    const repo = repository();
    attempts(repo, "stalled");
    const w = notices(repo, { settings: on({ ceiling: true, review: true }) });
    await w.notices.outcome(job({ kind: "sync" }));
    await w.notices.outcome(job({ key: null }));
    expect(w.shown).toEqual([]);
  });

  it("says nothing where the person asked for none of the four", async () => {
    const repo = repository();
    attempts(repo, "stalled");
    const w = notices(repo, {
      settings: on({ ceiling: false, decision: false, review: false, stage: false }),
    });
    await w.notices.outcome(job());
    expect(w.shown).toEqual([]);
  });
});
