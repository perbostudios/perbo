// @vitest-environment jsdom
import { describe, expect, expectTypeOf, it } from "vitest";
import { TicketStateSchema } from "@perbo/contracts";
import { COMPLETED, homeOrder, homeRows, homeTally, homeTone, judgedReview, projectTicket, stageOf, unseenAttention } from "./ticket-workspace.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import { egressQuestionLine, egressSettledLine } from "@perbo/contracts";
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
    // The same key in another repository is another ticket, whose run holds nothing of this one's.
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: false, active: undefined, resultReady: true });
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
    expect(result).toMatchObject({ resultReady: false, recoverable: true, evidence: { ready: false, kind: "not-retained" } });
    // Its criteria still read as the review on record left them; nothing says the attempt passed.
    expect(result.evidence.review?.review_id).toBe(detail.attempts[0]!.review!.review_id);
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

  it("recognises closure verification, reading the criteria from the review before it rather than a fresh one", async () => {
    const { workspace, row, detail } = await fixture();
    row.ticket.state = "pr_open";
    row.ticket.delivery.pull_request_url = null;
    const prior = detail.attempts[0]!;
    detail.attempts.push({ ...prior, id: "closure", review: null, reviewDecision: null, checks: [{ name: "test", status: "passed", detail: "" }], verification: { all_closed: true, deterministic_failure: null, open_keys: [], per_finding: [{ finding_key: "finding", status: "closed", pointer: "src/result.ts:2" }] } });
    const result = projectTicket(workspace, row, detail);
    expect(result).toMatchObject({ primary: { label: "Review result" }, evidence: { kind: "closure", ready: true, priorReview: prior.review, closuresVerified: true } });
    expect(result.evidence.review?.review_id).toBe(prior.review!.review_id);
    expect(result.evidence.review?.coverage).toEqual(prior.review!.coverage);
    expect(projectTicket(workspace, row, detail, "output").screen).toBe("output");
  });

  it("watches the exclusive command on a ticket, and is not held up by planning elsewhere (SCP-335)", async () => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = "executing";
    const live = { ...job, state: "running" as const, error: null, endedAt: null };
    const planning = { ...live, id: crypto.randomUUID(), kind: "edit", label: "Update task contract" };
    const run = { ...live, id: crypto.randomUUID(), label: "Run engineering loop", log: "  worktree /tmp/w on ayo/task at 123\n  executing\n" };
    // Planning on another ticket is not something this one waits for, and
    // neither is another ticket's run (D-049).
    workspace.jobs = [{ ...planning, key: "PRB-999" }];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: false, active: undefined });
    workspace.jobs = [{ ...run, key: "PRB-999" }];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ busy: false, active: undefined });
    // A run is, and the loop watches the run rather than the edit that started before it.
    workspace.jobs = [planning, run];
    const result = projectTicket(workspace, row, detail);
    expect(result.busy).toBe(true);
    expect(result.active?.id).toBe(run.id);
    expect(result.observed).not.toBeNull();
  });

  it("holds a contract's deletion while a command runs for this ticket, and not for another ticket's or another repository's (D-129)", async () => {
    const { workspace, row, detail, job } = await fixture();
    const live = { ...job, state: "running" as const, error: null, endedAt: null };
    const planning = { ...live, id: crypto.randomUUID(), kind: "edit", label: "Update task contract", key: row.ticket.key };
    workspace.jobs = [planning];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ held: true });
    workspace.jobs = [{ ...planning, key: null, resultKey: row.ticket.key }];
    expect(projectTicket(workspace, row, detail), "the command that produced it").toMatchObject({ held: true });
    const other = { ...live, id: crypto.randomUUID(), kind: "run", label: "Run engineering loop", key: "PRB-999" };
    workspace.jobs = [other, { ...planning, key: "PRB-998" }];
    expect(projectTicket(workspace, row, detail), "another ticket's run").toMatchObject({ held: false });
    workspace.jobs = [{ ...planning, repoId: crypto.randomUUID() }];
    expect(projectTicket(workspace, row, detail)).toMatchObject({ held: false });
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

  /**
   * The wheel of a stopped run stays at the stage the run had reached: from
   * the stage lines its log printed, and from the attempts on record where the
   * log holds none — never back at the contract, where the state a stop leaves
   * the ticket at would put it.
   */
  it("keeps the wheel at the furthest stage a run stopped after its second review had reached", async () => {
    const { workspace, row, detail, job } = await fixture();
    const reviewed = detail.attempts[0]!;
    if (reviewed.review === null) throw new Error("the fixture's first attempt must carry its review");
    // The second review is the runner's round 1, after a refinement round: a verification.
    const second = { ...reviewed, id: "second", round: 1, bundles: [], verification: null };
    detail.attempts = [reviewed, second];
    const log =
      "  worktree /tmp/w on ayo/task at 123\n  executing\n  sealing the change set\n  check test: passed\n  review round 0\n" +
      "  remediation round 1 of at most 6\n  sealing the change set\n  check test: passed\n  review round 1\n";
    for (const state of ["failed", "independent_review"] as const) {
      row.ticket.state = state;
      // Stopped by the person, and ended on its own.
      for (const ended of ["cancelled", "failed"] as const) {
        workspace.jobs = [{ ...job, state: ended, log }];
        expect(projectTicket(workspace, row, detail).stage, `${state}, ${ended}, from the log`).toBe(5);
        workspace.jobs = [{ ...job, state: ended, log: "" }];
        expect(projectTicket(workspace, row, detail).stage, `${state}, ${ended}, from the records`).toBe(5);
      }
    }
    // Stopped after the refinement round's checks and before its review: the refinement.
    detail.attempts = [reviewed, { ...second, review: null, reviewDecision: null }];
    expect(projectTicket(workspace, row, detail).stage).toBe(4);
    // Nothing on record says: the stage the ticket's state names.
    workspace.jobs = [];
    detail.attempts = [];
    row.ticket.state = "verifying";
    expect(projectTicket(workspace, row, detail).stage).toBe(2);
  });

  /**
   * Within one ticket's journey the wheel never goes back (D-129): it shows the
   * furthest stage the ticket reached over every run, from the records and
   * every run's log, and what the loop is doing now is its title's to say.
   */
  it("never moves the wheel back within a ticket's journey", async () => {
    const { workspace, row, detail, job } = await fixture();
    const reviewed = detail.attempts[0]!;
    if (reviewed.review === null) throw new Error("the fixture's first attempt must carry its review");
    detail.attempts = [reviewed];
    const first = { ...job, id: "run-1", state: "completed" as const, error: null, outcome: "escalated" as const,
      log: "  worktree /tmp/w on ayo/task at 123\n  executing\n  check test: passed\n  review round 0\n" };
    const read = (state: string, continued: Partial<Job>) => {
      row.ticket.state = state as typeof row.ticket.state;
      workspace.jobs = [first, { ...job, id: "run-2", kind: "decide", state: "running", endedAt: null, error: null, ...continued }];
      return projectTicket(workspace, row, detail);
    };
    // Continued after a decision at the review: no stage line yet, then the worktree again.
    const early = read("provisioning", { log: "" });
    expect(early.stage).toBe(3);
    const materialising = read("provisioning", { log: "  worktree /tmp/w on ayo/task at 123\n" });
    expect(materialising.stage).toBe(3);
    expect(materialising.observed?.title).toBe("Materialising the worktree");
    // A refinement round, then its verification.
    const refining = "  worktree /tmp/w on ayo/task at 123\n  remediation round 1 of at most 6\n";
    expect(read("executing", { log: refining }).stage).toBe(4);
    const verified = refining + "  verifying closures, round 1\n";
    expect(read("independent_review", { log: verified }).stage).toBe(5);
    // A second refinement round after the verification keeps the verification, and says the round.
    const again = read("executing", { log: verified + "  remediation round 2 of at most 6\n" });
    expect(again.stage).toBe(5);
    expect(again.observed?.title).toBe("Refining the change, round 2");
    // Before the records are read, the earlier run's log alone keeps the review.
    const unread = { ...detail, attempts: [] };
    workspace.jobs = [first, { ...job, id: "run-2", kind: "decide", state: "running", endedAt: null, error: null, log: "" }];
    row.ticket.state = "provisioning";
    expect(projectTicket(workspace, row, unread).stage).toBe(3);
    workspace.jobs = [first, { ...job, id: "run-2", kind: "decide", state: "running", endedAt: null, error: null, log: verified + "  remediation round 2 of at most 6\n" }];
    // Read again from the journal after a restart, which marks the live run interrupted: the same stage.
    const restarted = JSON.parse(JSON.stringify({ ...workspace, jobs: workspace.jobs.map((each) => ({ ...each, state: "interrupted" })) }));
    expect(projectTicket(restarted, row, detail).stage).toBe(5);
  });

  it("offers Continue the task only after the person's own stop, taken or still settling, or Perbo closing", async () => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = "failed";
    const offered = Object.fromEntries(
      (["cancelled", "stopping", "failed", "interrupted"] as const).map((state) => {
        workspace.jobs = [{ ...job, state }];
        return [state, projectTicket(workspace, row, detail).continuable];
      }),
    );
    expect(offered).toEqual({ cancelled: true, stopping: true, failed: false, interrupted: true });
    // No run on record, and a later command of another kind: the run's own stop is what counts.
    workspace.jobs = [];
    expect(projectTicket(workspace, row, detail).continuable).toBe(false);
    workspace.jobs = [{ ...job, state: "cancelled" }, { ...job, id: "export", kind: "export", label: "Export", state: "completed" }];
    expect(projectTicket(workspace, row, detail).continuable).toBe(true);
    workspace.jobs = [{ ...job, state: "cancelled" }, { ...job, id: "again", state: "failed" }];
    expect(projectTicket(workspace, row, detail).continuable).toBe(false);
  });

  /**
   * A run the CLI ended on a verdict for the person completed, paused for
   * them: yellow from the moment it ends, through the window where the records
   * still say the stage the run started at, and never red; a run that did not
   * complete is a failure and a stop.
   */
  it("reads a run ended on a verdict as paused for the person, yellow across the refresh window and never red", async () => {
    const { workspace, row, detail, job } = await fixture();
    const read = (state: string, jobs: Job[], refreshing: boolean) => {
      row.ticket.state = state as typeof row.ticket.state;
      workspace.jobs = jobs;
      workspace.refreshingRepos = refreshing ? [row.repoId] : [];
      return projectTicket(workspace, row, detail);
    };
    const running = { ...job, state: "running" as const, endedAt: null, error: null };
    const verdict = { ...job, state: "completed" as const, error: null, outcome: "escalated" as const };
    // Running; ended, as the CLI's stage lines left the records; the records read; read again.
    const window = [
      read("provisioning", [running], false),
      read("provisioning", [verdict], true),
      read("provisioning", [verdict], false),
      read("changes_requested", [verdict], true),
      read("changes_requested", [verdict], false),
    ];
    expect(window.map((each) => each.tone)).toEqual([null, "yellow", "yellow", "yellow", "yellow"]);
    for (const each of window.slice(1)) {
      // A decision is no stage: the loop waits at the review that asked it.
      expect(each).toMatchObject({ recoverable: false, paused: true, deciding: true, stage: 3 });
      expect(each.screen).not.toBe("stopped");
    }
    // Once nothing is being read, the card's way in is the answer.
    for (const each of [window[2]!, window[4]!]) expect(each.primary).toEqual({ label: "Answer", view: "decisions" });
    // Exit 3: the run did not complete, and it is a stop.
    const failed = read("provisioning", [{ ...job, state: "failed" }], false);
    expect(failed).toMatchObject({ tone: "red", recoverable: true, paused: false, screen: "stopped" });
    // A run that completed on no verdict for the person is not a pause.
    expect(read("provisioning", [{ ...verdict, outcome: undefined }], true).paused).toBe(false);
    // A verdict run whose ticket has since moved on is not a pause.
    expect(read("pr_open", [verdict], false)).toMatchObject({ paused: false, tone: "green" });
    // A journey that ended is completed, whatever the loop's last stage line named.
    const reviewed = { ...verdict, outcome: undefined, log: "  executing\n  check test: passed\n  review round 1\n" };
    for (const state of ["pr_open", "merged", "closed"]) expect(read(state, [reviewed], false).stage, state).toBe(COMPLETED);
    // A local run finished with nothing to merge on GitHub: completed too.
    row.ticket.delivery.pull_request_url = null;
    expect(read("pr_open", [reviewed], false).stage).toBe(COMPLETED);
    // And one whose review on record approved it with nothing left to refine, the ticket still ready.
    const approving = structuredClone(detail);
    const last = approving.attempts.at(-1)!;
    last.reviewDecision = "approve";
    last.review = { ...last.review!, decision: "approve", findings: [] };
    row.ticket.state = "ready";
    workspace.jobs = [reviewed];
    workspace.refreshingRepos = [];
    expect(projectTicket(workspace, row, approving)).toMatchObject({ resultReady: true, stage: COMPLETED });
    expect(projectTicket(workspace, row, detail).stage).not.toBe(COMPLETED);
    // A loop stopped after its second review sits at the verification.
    expect(read("failed", [{ ...reviewed, state: "cancelled" }], false).stage).toBe(5);
  });

  /**
   * A run still going that waits on the person's answer about a host off the
   * allow-list is paused for them: yellow, the stage it asked at waiting on
   * them, until the answer is printed, when the loop carries on at that stage.
   */
  it("shows the stage a run waiting on an unlisted host's answer is at as waiting on the person, until it is answered", async () => {
    const { workspace, row, detail, job } = await fixture();
    row.ticket.state = "executing";
    // A first run, nothing on record yet.
    detail.attempts = [];
    const question = { key: "egq_0123456789abcdef", host: "registry.example.com", command: "curl https://registry.example.com" };
    const ran = "  worktree /tmp/w on ayo/task at 123\n  executing\n";
    const asked = ran + `  ${egressQuestionLine(question)}\n`;
    const read = (log: string, state: Job["state"] = "running") => {
      workspace.jobs = [{ ...job, state, endedAt: null, error: null, log }];
      return projectTicket(workspace, row, detail);
    };
    // Asked mid-execution: execution waits on the person.
    expect(read(asked)).toMatchObject({ asking: true, deciding: true, stage: 2, tone: "yellow" });
    expect(read(asked).primary).toEqual({ label: "Answer", view: "loop" });
    expect(read(asked + `  ${egressSettledLine(question, "allowed")}\n`)).toMatchObject({ asking: false, deciding: false, stage: 2, tone: null });
    expect(read(ran)).toMatchObject({ asking: false, deciding: false, stage: 2, tone: null });
    // Stopped while it waits: the stop, not the question.
    expect(read(asked, "stopping")).toMatchObject({ asking: false, tone: "red" });
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

describe("a ticket whose earlier run left a review on record", () => {
  it("is its loop page while a new run of it is live, whatever was asked, and offers the results once that run ended with its own review on record", async () => {
    const { workspace, row, detail, job } = await fixture();
    // The earlier run paused on its verdict, its review on record; Continue starts another.
    const earlier: Job = { ...job, state: "completed", error: null, outcome: "escalated" };
    const live: Job = { ...job, id: crypto.randomUUID(), state: "running", startedAt: "2026-09-09T10:00:00.000Z", endedAt: null, error: null };
    expect(detail.attempts.at(-1)!.review).not.toBeNull();
    workspace.jobs = [earlier, live];
    for (const state of ["changes_requested", "ready", "provisioning", "pr_open"] as const) {
      row.ticket.state = state;
      for (const requested of ["auto", "loop", "review", "called-off"] as const)
        expect([state, requested, projectTicket(workspace, row, detail, requested)]).toMatchObject([
          state,
          requested,
          { screen: "loop", resultReady: false, primary: { label: "Watch", view: "loop" } },
        ]);
    }
    // Another command on the ticket is no run: refreshing from GitHub keeps the review it was pressed on.
    workspace.jobs = [earlier, { ...live, kind: "sync", label: "Refresh from GitHub" }];
    expect(projectTicket(workspace, row, detail, "review").screen).toBe("review");
    // The run ended, and its own review is on record.
    workspace.jobs = [earlier, { ...live, state: "completed", endedAt: "2026-09-09T10:20:00.000Z" }];
    row.ticket.state = "ready";
    const reviewed = detail.attempts.at(-1)!;
    detail.attempts.push({
      ...reviewed,
      id: "continued",
      run: reviewed.run + 1,
      review: { ...reviewed.review!, decision: "approve", findings: [] },
      reviewDecision: "approve",
    });
    for (const requested of ["auto", "loop", "review"] as const)
      expect(projectTicket(workspace, row, detail, requested)).toMatchObject({
        screen: "review",
        resultReady: true,
        primary: { label: "Review result", view: "review" },
      });
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

  it("is yellow only where the record puts a question to the person, and a stop where it puts none", async () => {
    const { workspace, row, job } = await fixture();
    row.ticket.state = "changes_requested";
    const verdict = { ...job, state: "completed" as const, error: null, outcome: "remediation_stalled" as const };
    for (const jobs of [[], [verdict]]) {
      workspace.jobs = jobs;
      // Questions on the record, and a count not yet read, are a pause.
      for (const questions of [3, undefined]) {
        const counted = { ...row, ...(questions === undefined ? {} : { questions }) };
        expect(homeTone(workspace, counted), `${jobs.length} ${questions}`).toBe("yellow");
        expect(projectTicket(workspace, counted)).toMatchObject({ paused: true, deciding: true, recoverable: false, stage: stageOf("changes_requested") });
        expect(projectTicket(workspace, counted).primary.label).toBe("Answer");
      }
      // None: stopped, with the stopped page to say why, never decisions required.
      const none = { ...row, questions: 0 };
      expect(homeTone(workspace, none), `${jobs.length}`).toBe("red");
      const projected = projectTicket(workspace, none);
      expect(projected).toMatchObject({ paused: false, recoverable: true, screen: "stopped" });
      expect(projected.deciding).toBe(false);
      expect(projected.primary.label).toBe("See the stopped run");
    }
    // A run that ended on a verdict, before its records are read, is still the pause.
    row.ticket.state = "independent_review";
    workspace.jobs = [verdict];
    expect(homeTone(workspace, row)).toBe("yellow");
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

describe("how far the host read a journey reached on its records (TaskRow.reached)", () => {
  it("fills Home's wheel, which holds no detail, to that stage and never back", async () => {
    const { workspace, row } = await fixture();
    workspace.refreshingRepos = [];
    row.ticket.state = "changes_requested";
    expect(projectTicket(workspace, row).stage).toBe(3);
    expect(projectTicket(workspace, { ...row, reached: { stage: 5, approved: false } }).stage).toBe(5);
    // A ticket whose state names an earlier stage keeps the stage its records reached.
    row.ticket.state = "executing";
    expect(projectTicket(workspace, { ...row, reached: { stage: 4, approved: false } }).stage).toBe(4);
  });

  it("counts a journey whose last attempt the records approved as completed, as the loop page does", async () => {
    const { workspace, row } = await fixture();
    workspace.refreshingRepos = [];
    row.ticket.state = "ready";
    expect(projectTicket(workspace, { ...row, reached: { stage: 3, approved: false } })).toMatchObject({ resultReady: false, stage: 3 });
    expect(projectTicket(workspace, { ...row, reached: { stage: 3, approved: true } })).toMatchObject({
      resultReady: true,
      stage: COMPLETED,
    });
  });
});

describe("the evidence the results page reads after a refinement round", () => {
  it("counts the criteria the review before the round directly verified, and nothing where no review is on record", async () => {
    const { workspace, row, detail } = await fixture();
    workspace.refreshingRepos = [];
    const reviewed = detail.attempts.findLast((attempt) => attempt.review)!;
    const met = reviewed.review!.coverage.filter(
      (entry) => entry.status === "met" && entry.verification_strength === "directly_verified",
    ).length;
    expect(met).toBeGreaterThan(0);
    detail.attempts.push({
      ...reviewed,
      id: "refinement-round-1",
      round: 1,
      review: null,
      reviewDecision: null,
      verification: { all_closed: true, deterministic_failure: null, open_keys: [], per_finding: [] },
    });
    const { evidence } = projectTicket(workspace, row, detail);
    expect(evidence.kind).toBe("closure");
    expect(evidence.verified).toBe(met);
    expect(evidence.review?.review_id).toBe(reviewed.review!.review_id);
    // A review of another version of the contract is not this contract's.
    const replanned = { ...row, ticket: { ...row.ticket, plan_version: row.ticket.plan_version + 1 } };
    const other = { ...detail, ticket: replanned.ticket, contract: { ...detail.contract, version: replanned.ticket.plan_version } };
    expect(projectTicket(workspace, replanned, other).evidence).toMatchObject({ review: undefined, verified: null });
  });
});

describe("the review the results page reads each criterion from", () => {
  /** The sample's reviewed attempt, its review holding two open findings, and a verification that judged some of them. */
  async function judged() {
    const { detail } = await fixture();
    const reviewed = detail.attempts.findLast((attempt) => attempt.review)!;
    const base = reviewed.review!.findings[0]!;
    const review = {
      ...reviewed.review!,
      findings: [
        { ...base, key: "first", status: "open" as const },
        { ...base, key: "second", status: "open" as const },
      ],
    };
    const contract = { plan_id: review.plan_id, plan_version: review.plan_version };
    const verification = (id: string, per_finding: Array<[string, "closed" | "not_closed"]>) => ({
      ...reviewed,
      id,
      review: null,
      reviewDecision: null,
      verification: {
        all_closed: per_finding.every(([, status]) => status === "closed"),
        deterministic_failure: null,
        open_keys: per_finding.filter(([, status]) => status !== "closed").map(([key]) => key),
        per_finding: per_finding.map(([finding_key, status]) => ({ finding_key, status, pointer: "src/result.ts:2" })),
      },
    });
    return { reviewed: { ...reviewed, review }, contract, verification };
  }

  const statuses = (review: ReturnType<typeof judgedReview>) => review!.findings.map((finding) => [finding.key, finding.status]);

  it("reads a finding open where a later verification left it open, though an earlier one closed it", async () => {
    const { reviewed, contract, verification } = await judged();
    const attempts = [
      reviewed,
      verification("round-1", [["first", "closed"], ["second", "closed"]]),
      verification("round-2", [["first", "not_closed"]]),
    ];
    expect(statuses(judgedReview(attempts, contract))).toEqual([["first", "open"], ["second", "resolved"]]);
  });

  it("reads nothing a verification before the review judged", async () => {
    const { reviewed, contract, verification } = await judged();
    const attempts = [verification("before", [["first", "closed"]]), reviewed];
    expect(statuses(judgedReview(attempts, contract))).toEqual([["first", "open"], ["second", "open"]]);
  });
});
