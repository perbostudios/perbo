// @vitest-environment jsdom
import { describe, expect, expectTypeOf, it } from "vitest";
import { projectTicket } from "../src/renderer/tasks/ticket-workspace.js";
import { sampleBridge } from "../src/sample-host/bridge.js";
import type { Job } from "../src/shared/protocol.js";

async function fixture() {
  const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  workspace.jobs = [];
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  const detail = structuredClone(await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }));
  detail.ticket = row.ticket;
  const job: Job = { id: crypto.randomUUID(), repoId: row.repoId, key: row.ticket.key, resultKey: null, kind: "run", state: "failed", label: "Run", startedAt: "2026-09-09T09:00:00.000Z", endedAt: "2026-09-09T09:01:00.000Z", log: "", error: "CLI exited with code 2", result: null };
  return { workspace, row, detail, job };
}
describe("ticket workspace projection", () => {
  it.each(["pr_open", "changes_requested", "provisioning"] as const)("honours canonical %s after a nonzero process exit", async (state) => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = state;
    row.ticket.delivery.pull_request_url = null;
    workspace.jobs = [job];
    const before = structuredClone({ workspace, row, detail });
    const result = projectTicket(workspace, row, detail);
    expect(result.primary.label).toBe(state === "pr_open" ? "Review result" : state === "changes_requested" ? "Answer" : "Review and recover");
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
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: true, resultReady: false, primary: { label: "Watch" }, screen: "loop" });
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
    expect(result.primary.label).toBe("Review and recover");
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
    expect(result.primary.label).toBe("Review and recover");
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
