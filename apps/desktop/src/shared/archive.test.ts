import { describe, expect, it } from "vitest";
import { TICKET_STATES, TicketStateSchema } from "@perbo/contracts";
import { isArchivable, isCalledOff, isFiled, isMergeDecided, isPreLoop, notArchivable, notCallable } from "./archive.js";
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
      "deployed",
      "observing",
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

  it("keeps a completed ticket on Home until its merge is decided, then files it", () => {
    // Green while its pull request waits on the person's merge decision, and
    // nothing to file: the decision is still to be made.
    expect(isArchivable({ jobs: [] }, row("pr_open"))).toBe(false);
    // Merged, or closed without merge: decided, and filed from Home like a stop.
    expect(isArchivable({ jobs: [] }, row("merged"))).toBe(true);
    expect(isArchivable({ jobs: [] }, row("closed"))).toBe(true);
  });

  it("names the merge decision when refusing an open pull request, and the loop otherwise", () => {
    expect(notArchivable("PRB-1", "pr_open")).toBe(
      "PRB-1 waits on the merge decision. Archive it once its pull request is merged or closed, or its merge is called off.",
    );
    expect(notArchivable("PRB-1", "executing")).toBe(
      "PRB-1 is still in its loop. Archive it once it has finished or its run has stopped.",
    );
  });

  it("files a merged ticket while a command other than its loop runs for it", () => {
    for (const kind of ["sync", "verdict"] as const)
      expect(isArchivable({ jobs: [job("running", kind)] }, row("merged"))).toBe(true);
    expect(isArchivable({ jobs: [job("running", "run")] }, row("merged"))).toBe(false);
    expect(isArchivable({ jobs: [job("running", "decide")] }, row("merged"))).toBe(false);
  });

  it("counts a merge called off as decided, and files its pull request left open", () => {
    // Home offers no Archive for a pull request whose merge is still to be decided.
    expect(isMergeDecided({}, row("pr_open"))).toBe(false);
    expect(isArchivable({ jobs: [] }, row("pr_open"))).toBe(false);
    expect(isFiled({ archived: ["repo:PRB-1"], jobs: [] }, row("pr_open"))).toBe(false);
    // Don't merge, recorded, is the decision.
    const calledOff = { calledOff: ["repo:PRB-1"] };
    expect(isCalledOff(calledOff, row("pr_open"))).toBe(true);
    expect(isMergeDecided(calledOff, row("pr_open"))).toBe(true);
    expect(isArchivable({ ...calledOff, jobs: [] }, row("pr_open"))).toBe(true);
    expect(isFiled({ ...calledOff, archived: ["repo:PRB-1"], jobs: [] }, row("pr_open"))).toBe(true);
    expect(isFiled({ ...calledOff, archived: [], jobs: [] }, row("pr_open"))).toBe(false);
    // Another ticket's call-off decides nothing of this one.
    expect(isMergeDecided({ calledOff: ["repo:PRB-2", "other:PRB-1"] }, row("pr_open"))).toBe(false);
    // A loop that runs again has the merge to decide once more.
    expect(isArchivable({ ...calledOff, jobs: [job("running")] }, row("pr_open"))).toBe(false);
    // A call-off speaks only for a pull request left open.
    expect(isCalledOff(calledOff, row("executing"))).toBe(false);
    expect(notCallable("PRB-1")).toBe("PRB-1 has no open pull request, so there is no merge to call off.");
  });

  it("returns a filed ticket to Home while its loop runs again", () => {
    const snapshot = { archived: ["repo:PRB-1"] };
    expect(isFiled({ ...snapshot, jobs: [] }, row("failed"))).toBe(true);
    expect(isFiled({ ...snapshot, jobs: [job("running")] }, row("executing"))).toBe(false);
  });
});

describe("what Home shows and what the picker shows", () => {
  const row = (state: string) =>
    ({ repoId: "repo-1", repository: "test", ticket: { key: "PRB-1", state } }) as unknown as Parameters<
      typeof isPreLoop
    >[0];

  it("keeps a plan nobody has approved off Home, because it is still being planned", () => {
    expect(isPreLoop(row("plan_review"))).toBe(true);
    expect(isPreLoop(row("draft"))).toBe(true);
    expect(isPreLoop(row("specifying"))).toBe(true);
  });

  it("keeps the loop's own work on Home, from the moment approval starts it", () => {
    // `ready` is approved and queued, which is the loop carrying it. If this
    // ever reads true, Home has hidden work that is actually running.
    for (const state of ["ready", "provisioning", "executing", "verifying", "pr_open", "merged", "done"])
      expect(isPreLoop(row(state)), state).toBe(false);
  });

  it("puts every state Home refuses into the picker, so no ticket is nowhere", () => {
    // Home and the picker are one split, not two filters: a state absent from
    // both is a ticket a person cannot reach at all. The picker lists what
    // isPreLoop says Home does not.
    const refused = TICKET_STATES.filter((state) => isPreLoop(row(state)));
    // Exactly the states the picker restores. Widen PRE_LOOP_STATES without
    // widening what the picker lists and this fails, which is the only way a
    // ticket ends up on neither surface.
    expect([...refused]).toEqual(["draft", "specifying", "plan_review"]);
    expect(refused.length).toBeLessThan(TICKET_STATES.length);
  });

  it("leaves a ticket that died before it ran on Home, which is the only place it is visible", () => {
    // `plan_invalid` is terminal and was approved, so it is not planning to
    // resume; hiding it would leave a dead ticket nowhere (D-103).
    expect(isPreLoop(row("plan_invalid"))).toBe(false);
  });
});
