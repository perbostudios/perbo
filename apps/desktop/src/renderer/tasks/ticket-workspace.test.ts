// @vitest-environment jsdom
import { describe, expect, expectTypeOf, it } from "vitest";
import { TicketStateSchema } from "@perbo/contracts";
import { homeOrder, homeRows, homeTally, homeTone, projectTicket, unseenAttention } from "./ticket-workspace.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Job } from "../../shared/protocol.js";

async function fixture() {
  const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  workspace.jobs = [];
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  const detail = structuredClone(await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }));
  detail.ticket = row.ticket;
  const job: Job = { id: crypto.randomUUID(), repoId: row.repoId, key: row.ticket.key, resultKey: null, kind: "run", state: "failed", label: "Run", startedAt: "2026-09-09T09:00:00.000Z", endedAt: "2026-09-09T09:01:00.000Z", log: "", error: "CLI exited with code 2", result: null };
  return { workspace, row, detail, job };
}
/**
 * A run under way for a ticket mid-loop, and nothing for any other: a ticket
 * mid-loop with nothing running it is a run that stopped.
 */
const underway = (state: string, job: Job): Job[] =>
  ["provisioning", "executing", "verifying", "independent_review"].includes(state)
    ? [{ ...job, state: "running", endedAt: null, error: null }]
    : [];
describe("ticket workspace projection", () => {
  it("colours a Home row by where its journey stands", async () => {
    const { workspace, row, detail, job } = await fixture();
    const green = ["pr_open", "merged", "closed", "done", "deployed", "observing"];
    const red = ["failed", "cancelled", "inconclusive", "rolled_back", "plan_invalid"];
    const tones = Object.fromEntries(TicketStateSchema.options.map((state) => {
      row.ticket.state = state;
      workspace.jobs = underway(state, job);
      return [state, projectTicket(workspace, row, detail).tone];
    }));
    expect(tones).toEqual(Object.fromEntries(TicketStateSchema.options.map((state) => [
      state,
      green.includes(state) ? "green" : red.includes(state) ? "red" : state === "changes_requested" ? "yellow" : null,
    ])));
    // A decision the loop is already acting on is not one waiting for the person.
    row.ticket.state = "changes_requested";
    workspace.jobs = [{ ...job, state: "running" }];
    expect(projectTicket(workspace, row, detail).tone).toBeNull();
  });

  it.each(["pr_open", "changes_requested", "provisioning"] as const)("honours canonical %s after a nonzero process exit", async (state) => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = state;
    row.ticket.delivery.pull_request_url = null;
    workspace.jobs = [job];
    const before = structuredClone({ workspace, row, detail });
    const result = projectTicket(workspace, row, detail);
    expect(result.primary.label).toBe(state === "pr_open" ? "Review result" : state === "changes_requested" ? "Answer" : "See the stopped run");
    expect(result.recoverable).toBe(state === "provisioning");
    expect({ workspace, row, detail }).toEqual(before);
  });

  it("qualifies job identity by repository and includes result ownership", async () => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = "pr_open";
    const other = { ...job, repoId: crypto.randomUUID(), state: "running" as const };
    workspace.jobs = [other];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: true, active: undefined, resultReady: true });
    workspace.jobs.push({ ...job, key: null, resultKey: row.ticket.key, state: "stopping" });
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: true, resultReady: false, primary: { label: "See the stopped run" }, screen: "stopped" });
    expect(projectTicket(workspace, row, detail, "output").screen).toBe("output");
  });

  it("does not use an older PR or review as evidence that a later failed attempt passed", async () => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = "failed";
    row.ticket.delivery.pull_request_url = "https://github.com/example/repo/pull/1";
    workspace.jobs = [job];
    detail.attempts.push({ ...detail.attempts[0]!, id: "later", review: null, reviewDecision: null, checks: [], verification: null });
    const result = projectTicket(workspace, row, detail);
    expect(result).toMatchObject({ resultReady: false, recoverable: true, evidence: { ready: false, verified: null, kind: "not-retained" } });
    expect(result.primary.label).toBe("See the stopped run");
  });

  it("distinguishes unloaded, stale and absent evidence", async () => {
    const { workspace, row, detail } = await fixture();
    expect(projectTicket(workspace, row).evidence).toMatchObject({ kind: "unloaded", verified: null });
    detail.attempts = [];
    expect(projectTicket(workspace, row, detail).evidence).toMatchObject({ kind: "not-retained", verified: null });
    detail.contract.version++;
    expect(projectTicket(workspace, row, detail).evidence).toMatchObject({ kind: "stale", ready: false });
  });

  it("recognises closure verification without manufacturing a fresh criterion review", async () => {
    const { workspace, row, detail } = await fixture();
    row.ticket.state = "pr_open";
    row.ticket.delivery.pull_request_url = null;
    const prior = detail.attempts[0]!;
    detail.attempts.push({ ...prior, id: "closure", review: null, reviewDecision: null, checks: [{ name: "test", status: "passed", detail: "" }], verification: { all_closed: true, deterministic_failure: null, open_keys: [], per_finding: [{ finding_key: "finding", status: "closed", pointer: "src/result.ts:2" }] } });
    const result = projectTicket(workspace, row, detail);
    expect(result).toMatchObject({ primary: { label: "Review result" }, evidence: { kind: "closure", ready: true, verified: null, review: undefined, priorReview: prior.review, closuresVerified: true } });
    expect(projectTicket(workspace, row, detail, "output").screen).toBe("output");
  });

  it("watches the exclusive command on a ticket, and is not held up by planning elsewhere (SCP-335)", async () => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = "executing";
    const live = { ...job, state: "running" as const, error: null, endedAt: null };
    const planning = { ...live, id: crypto.randomUUID(), kind: "edit", label: "Update task contract" };
    const run = { ...live, id: crypto.randomUUID(), label: "Run engineering loop", log: "  worktree /tmp/w on ayo/task at 123\n  executing\n" };
    // Planning on another ticket is not something this one waits for.
    workspace.jobs = [{ ...planning, key: "PRB-999" }];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: false, active: undefined });
    // A run is, and the loop watches the run rather than the edit that started before it.
    workspace.jobs = [planning, run];
    const result = projectTicket(workspace, row, detail);
    expect(result.busy).toBe(true);
    expect(result.active?.id).toBe(run.id);
    expect(result.observed).not.toBeNull();
  });

  it("holds a contract's deletion while any command runs in its repository, and not for another repository's (SCP-335)", async () => {
    const { workspace, row, detail, job } = await fixture();
    const live = { ...job, state: "running" as const, error: null, endedAt: null };
    const planning = { ...live, id: crypto.randomUUID(), kind: "edit", label: "Update task contract", key: "PRB-999" };
    workspace.jobs = [planning];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: false, held: true });
    workspace.jobs = [{ ...planning, repoId: crypto.randomUUID() }];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: false, held: false });
  });

  /**
   * ADR-0034 calls this projection a pure function over a repository-qualified
   * ticket, its jobs and, optionally, its detail. Which adapter answered is
   * none of those, and a ticket mid-run with nothing running it needs recovery
   * whoever said so.
   */
  it("reads a ticket the same way whichever host answered", async () => {
    expectTypeOf<Parameters<typeof projectTicket>[0]>().not.toHaveProperty("mode");
    expectTypeOf<Parameters<typeof projectTicket>[1]>().not.toHaveProperty("summary");
    const { row, detail } = await fixture();
    row.ticket.state = "executing";
    const result = projectTicket({ jobs: [], refreshingRepos: [] }, row, detail);
    expect(result.recoverable).toBe(true);
    expect(result.primary.label).toBe("See the stopped run");
  });

  it("withholds recovery while a completed command's canonical records are being refreshed", async () => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = "provisioning";
    workspace.jobs = [job];
    expect(projectTicket(workspace, row, detail, "auto", true)).toMatchObject({ recoverable: false, attention: false, primary: { label: "Watch" } });
    expect(projectTicket(workspace, row, detail).recoverable).toBe(true);
    row.ticket.state = "pr_open";
    expect(projectTicket(workspace, row, detail, "loop", true)).toMatchObject({ resultReady: false, screen: "loop", evidence: { ready: false } });
  });
});

describe("where a Home ticket stands", () => {
  it("sorts every state into a decision, a stop, the journey's end or none", async () => {
    const { workspace, row, job } = await fixture();
    const green = ["pr_open", "merged", "closed", "done", "deployed", "observing"];
    const red = ["failed", "cancelled", "inconclusive", "rolled_back", "plan_invalid"];
    const url = "https://github.com/example/repo/pull/1";
    for (const state of TicketStateSchema.options) {
      row.ticket.state = state;
      row.ticket.delivery.pull_request_url = null;
      workspace.jobs = underway(state, job);
      expect([state, homeTone(workspace, row)]).toEqual([
        state,
        green.includes(state) ? "green" : red.includes(state) ? "red" : state === "changes_requested" ? "yellow" : null,
      ]);
    }
    // An opened pull request is the journey's end, whether or not it is merged.
    row.ticket.state = "pr_open";
    row.ticket.delivery.pull_request_url = url;
    expect(homeTone(workspace, row)).toBe("green");
    expect(projectTicket(workspace, row).tone).toBe("green");
  });

  it("reads a run under way as none, a stop as red at once, and a decision being acted on as none", async () => {
    const { workspace, row, job } = await fixture();
    row.ticket.state = "executing";
    workspace.jobs = [{ ...job, state: "running", endedAt: null, error: null }];
    expect(homeTone(workspace, row)).toBeNull();
    workspace.jobs = [{ ...job, state: "stopping", endedAt: null, error: null }];
    expect(homeTone(workspace, row)).toBe("red");
    workspace.jobs = [];
    // Stranded mid-loop with nothing running for it: a stop outside the executor's window.
    expect(homeTone(workspace, row)).toBe("red");
    row.ticket.state = "changes_requested";
    workspace.jobs = [{ ...job, kind: "decide", state: "running", endedAt: null, error: null }];
    expect(homeTone(workspace, row)).toBeNull();
  });

  it("does not move while its repository's records are read again", async () => {
    const { workspace, row, job } = await fixture();
    row.ticket.state = "executing";
    workspace.jobs = [{ ...job, state: "cancelled" }];
    workspace.refreshingRepos = [row.repoId];
    // The projection waits for the read before offering the stopped page; the tone does not.
    expect(projectTicket(workspace, row).recoverable).toBe(false);
    expect(homeTone(workspace, row)).toBe("red");
    row.ticket.state = "changes_requested";
    workspace.jobs = [];
    expect(homeTone(workspace, row)).toBe("yellow");
    // A run that completed while its ticket still reads mid-loop is the record not yet read.
    row.ticket.state = "independent_review";
    workspace.jobs = [{ ...job, state: "completed", error: null }];
    expect(homeTone(workspace, row)).toBeNull();
    workspace.refreshingRepos = [];
    expect(homeTone(workspace, row)).toBe("red");
  });

  it("counts Home's tickets at each tone, and a decided merge as completed alone, leaving out the filed and the ones still being planned", async () => {
    const { workspace } = await fixture();
    const rows = homeRows(workspace);
    expect(rows.some((row) => row.ticket.state === "plan_review")).toBe(false);
    const tally = homeTally(workspace, rows);
    const decided = (row: (typeof rows)[number]): boolean => ["merged", "closed"].includes(row.ticket.state);
    expect(tally).toEqual({
      yellow: rows.filter((row) => homeTone(workspace, row) === "yellow").length,
      red: rows.filter((row) => homeTone(workspace, row) === "red").length,
      green: rows.filter((row) => homeTone(workspace, row) === "green" && !decided(row)).length,
      completed: rows.filter(decided).length,
    });
    // The sample: a decision; a stopped run and two tickets mid-run with
    // nothing running them; an open pull request; and a merge not yet filed.
    expect(tally).toEqual({ yellow: 1, red: 3, green: 1, completed: 1 });
  });
});

describe("Home's order", () => {
  it("puts a merge still to decide first, then decisions, stops and running, and every decided merge last, each most recently opened first", async () => {
    const { workspace, row: template, job } = await fixture();
    /** A ticket in this state, admitted then, and opened then where it was. */
    const ticket = (name: string, state: string, admitted: string, opened: string | null) => {
      const row = structuredClone(template);
      row.ticket.key = "PRB-" + (900 + workspace.tasks.length);
      row.ticket.title = name;
      row.ticket.state = state as typeof row.ticket.state;
      row.ticket.admitted_at = `2026-09-0${admitted}T09:00:00.000Z`;
      row.ticket.delivery.pull_request_url = state === "pr_open" ? "https://github.com/example/repo/pull/1" : null;
      workspace.tasks.push(row);
      if (opened !== null) workspace.lastOpened = { ...workspace.lastOpened, [row.repoId + ":" + row.ticket.key]: `2026-09-2${opened}T09:00:00.000Z` };
      return row;
    };
    workspace.tasks = [];
    workspace.lastOpened = {};
    // Listed out of order on purpose: newest admitted first would read differently.
    const rows = [
      ticket("running", "executing", "9", "9"),
      ticket("stopped, never opened, admitted first", "failed", "1", null),
      ticket("decision, never opened", "changes_requested", "8", null),
      ticket("waiting on the merge, opened earlier", "pr_open", "7", "1"),
      ticket("stopped, opened", "failed", "2", "2"),
      ticket("stopped, never opened, admitted last", "cancelled", "6", null),
      ticket("decision, opened", "changes_requested", "3", "0"),
      ticket("merged, opened later", "merged", "4", "3"),
      ticket("closed without merge, opened last", "closed", "5", "8"),
    ];
    workspace.jobs = [{ ...job, key: rows[0]!.ticket.key, state: "running", endedAt: null, error: null }];
    expect(homeOrder(workspace, rows, "opened").map((row) => row.ticket.title)).toEqual([
      "waiting on the merge, opened earlier",
      "decision, opened",
      "decision, never opened",
      "stopped, opened",
      "stopped, never opened, admitted last",
      "stopped, never opened, admitted first",
      "running",
      // However recently opened, a decided merge stays under every other group.
      "closed without merge, opened last",
      "merged, opened later",
    ]);
    // Opening one moves it to the top of its colour, and nowhere else.
    workspace.lastOpened = { ...workspace.lastOpened, [rows[1]!.repoId + ":" + rows[1]!.ticket.key]: "2026-09-29T09:00:00.000Z" };
    expect(homeOrder(workspace, rows, "opened").map((row) => row.ticket.title).slice(3, 6)).toEqual([
      "stopped, never opened, admitted first",
      "stopped, opened",
      "stopped, never opened, admitted last",
    ]);
  });
  it("orders by group first and then by age, newest or oldest", async () => {
    const { workspace, row: template } = await fixture();
    workspace.tasks = [];
    workspace.jobs = [];
    const ticket = (name: string, state: string, updated: string) => {
      const row = structuredClone(template);
      row.ticket.key = "PRB-" + (900 + workspace.tasks.length);
      row.ticket.title = name;
      row.ticket.state = state as typeof row.ticket.state;
      row.ticket.updated_at = `2026-09-0${updated}T09:00:00.000Z`;
      workspace.tasks.push(row);
      return row;
    };
    const rows = [
      ticket("stopped, older", "failed", "1"),
      ticket("merged, older", "merged", "2"),
      ticket("decision", "changes_requested", "9"),
      ticket("stopped, newer", "failed", "5"),
      ticket("closed, newer", "closed", "6"),
      ticket("waiting on the merge", "pr_open", "3"),
    ];
    // Recently opened orders on openings, which these have none of, so the age decides here alone.
    workspace.lastOpened = { [rows[1]!.repoId + ":" + rows[1]!.ticket.key]: "2026-09-20T09:00:00.000Z" };
    const titles = (by: "newest" | "oldest") => homeOrder(workspace, rows, by).map((row) => row.ticket.title);
    expect(titles("newest")).toEqual(["waiting on the merge", "decision", "stopped, newer", "stopped, older", "closed, newer", "merged, older"]);
    expect(titles("oldest")).toEqual(["waiting on the merge", "decision", "stopped, older", "stopped, newer", "merged, older", "closed, newer"]);
  });
});

describe("a Home ticket's claim on the person", () => {
  /** A ticket moved into `state` at `moved`, opened at `opened` where it was. */
  async function claim(state: string, moved: string, opened: string | null) {
    const { workspace, row, job } = await fixture();
    workspace.tasks = [row];
    row.ticket.state = state as typeof row.ticket.state;
    row.ticket.delivery.pull_request_url = "https://github.com/example/repo/pull/1";
    row.ticket.history = [
      { at: "2026-09-01T09:00:00.000Z", from: null, to: "ready", note: "approved" },
      { at: moved, from: "ready", to: row.ticket.state, note: "moved" },
    ];
    row.ticket.updated_at = moved;
    workspace.lastOpened = opened === null ? {} : { [row.repoId + ":" + row.ticket.key]: opened };
    return { workspace, row, job };
  }
  it.each(["changes_requested", "failed", "pr_open"])("is owed by %s until the ticket is opened after it came to stand there", async (state) => {
    const fresh = await claim(state, "2026-09-10T09:00:00.000Z", null);
    expect(unseenAttention(fresh.workspace, fresh.row)).toBe(true);
    const before = await claim(state, "2026-09-10T09:00:00.000Z", "2026-09-09T09:00:00.000Z");
    expect(unseenAttention(before.workspace, before.row)).toBe(true);
    const after = await claim(state, "2026-09-10T09:00:00.000Z", "2026-09-10T09:05:00.000Z");
    expect(unseenAttention(after.workspace, after.row)).toBe(false);
    // Coming to stand there again after that opening owes it again.
    after.row.ticket.history.push({ at: "2026-09-11T09:00:00.000Z", from: after.row.ticket.state, to: after.row.ticket.state, note: "again" });
    expect(unseenAttention(after.workspace, after.row)).toBe(true);
  });
  it.each(["merged", "closed", "done"])("is never owed by a ticket whose merge is decided (%s), opened or not", async (state) => {
    const { workspace, row } = await claim(state, "2026-09-10T09:00:00.000Z", null);
    expect(homeTone(workspace, row)).toBe("green");
    expect(unseenAttention(workspace, row)).toBe(false);
  });
  it("is never owed by a ticket the loop is running", async () => {
    const { workspace, row, job } = await claim("executing", "2026-09-10T09:00:00.000Z", null);
    workspace.jobs = [{ ...job, state: "running", endedAt: null, error: null }];
    expect(unseenAttention(workspace, row)).toBe(false);
  });
  it("dates a run that stopped short from when it ended, not from when its ticket last moved", async () => {
    const { workspace, row, job } = await claim("executing", "2026-09-10T09:00:00.000Z", "2026-09-10T09:30:00.000Z");
    workspace.jobs = [{ ...job, startedAt: "2026-09-10T09:00:00.000Z", endedAt: "2026-09-10T10:00:00.000Z" }];
    expect(homeTone(workspace, row)).toBe("red");
    expect(unseenAttention(workspace, row)).toBe(true);
    workspace.lastOpened = { [row.repoId + ":" + row.ticket.key]: "2026-09-10T10:01:00.000Z" };
    expect(unseenAttention(workspace, row)).toBe(false);
  });
});
