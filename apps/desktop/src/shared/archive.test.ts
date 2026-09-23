import { describe, expect, it } from "vitest";
import { TicketStateSchema } from "@perbo/contracts";
import { isArchivable, isFiled } from "./archive.js";
import type { Job, TaskRow } from "./protocol.js";

const row = (state: string): Pick<TaskRow, "repoId" | "ticket"> =>
  ({ repoId: "repo", ticket: { key: "PRB-1", state } }) as unknown as Pick<TaskRow, "repoId" | "ticket">;
const job = (state: Job["state"], kind: Job["kind"] = "run"): Job =>
  ({ id: "job", repoId: "repo", key: "PRB-1", resultKey: null, kind, state }) as Job;

describe("what may be archived", () => {
  it("files what finished and what stopped, and nothing the loop still carries", () => {
    const archivable = TicketStateSchema.options.filter((state) => isArchivable({ jobs: [] }, row(state)));
    // A loop state with nothing running for it is a run that stopped.
    expect(archivable).toEqual([
      "provisioning",
      "executing",
      "verifying",
      "independent_review",
      "merged",
      "closed",
      "done",
      "plan_invalid",
      "failed",
      "cancelled",
      "inconclusive",
      "rolled_back",
    ]);
  });

  it("files a run that stopped in a loop state, and never one still running", () => {
    for (const state of ["provisioning", "executing", "verifying", "independent_review"]) {
      expect(isArchivable({ jobs: [job("interrupted")] }, row(state))).toBe(true);
      // A loop state with nothing running for it is read as stopped.
      expect(isArchivable({ jobs: [] }, row(state))).toBe(true);
      expect(isArchivable({ jobs: [job("running")] }, row(state))).toBe(false);
      expect(isArchivable({ jobs: [job("stopping")] }, row(state))).toBe(false);
    }
    expect(isArchivable({ jobs: [job("running")] }, row("failed"))).toBe(false);
    expect(isArchivable({ jobs: [] }, row("pr_open"))).toBe(false);
  });

  it("files a merged ticket while a command other than its loop runs for it", () => {
    for (const kind of ["sync", "verdict"] as const)
      expect(isArchivable({ jobs: [job("running", kind)] }, row("merged"))).toBe(true);
    expect(isArchivable({ jobs: [job("running", "run")] }, row("merged"))).toBe(false);
    expect(isArchivable({ jobs: [job("running", "decide")] }, row("merged"))).toBe(false);
  });

  it("returns a filed ticket to Home while its loop runs again", () => {
    const snapshot = { archived: ["repo:PRB-1"] };
    expect(isFiled({ ...snapshot, jobs: [] }, row("failed"))).toBe(true);
    expect(isFiled({ ...snapshot, jobs: [job("running")] }, row("executing"))).toBe(false);
  });
});
