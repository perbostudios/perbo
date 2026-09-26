// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sampleBridge } from "./bridge.js";
import { editing, job, sampleInterviews, saveSpec, snapshot, specFiles, writeGraphEdit } from "./records.js";
import { applyGraphEdit } from "@perbo/planning/browser";
import type { EditingSession, Job } from "../shared/protocol.js";
import { TICKET_TRANSITIONS } from "@perbo/contracts/browser";
import { unseenAttention } from "../renderer/tasks/ticket-workspace.js";

/**
 * Deleting a piece of work from the sample host refuses where the host's
 * `discardTicket` refuses, in the host's own sentences (D-120, D-129): a
 * screen driven against the sample has to meet the refusal a person meets.
 */

const repoId = snapshot.repositories[0]!.id;
const tasks = [...snapshot.tasks];
const held: Job[] = [];

beforeEach(() => {
  localStorage.clear();
  snapshot.tasks = tasks.map((row) => ({ ...row, ticket: { ...row.ticket } }));
});

afterEach(() => {
  for (const each of held.splice(0)) each.state = "cancelled";
});

const onBoard = (key: string): boolean =>
  snapshot.tasks.some((row) => row.repoId === repoId && row.ticket.key === key);

const stored = (): EditingSession[] =>
  JSON.parse(localStorage.getItem("perbo:preview-editing") ?? "[]") as EditingSession[];

/**
 * The planning that drafted PRB-421, the sample's plan in review, with the
 * ticket moved on to `state` since, as a plan approved and run moves on.
 */
async function drafted(state: string): Promise<EditingSession> {
  const opened = await sampleBridge.request({
    kind: "editingOpen",
    target: { kind: "planning", repoId, key: "PRB-421" },
  });
  localStorage.setItem(
    "perbo:preview-editing",
    JSON.stringify(stored().map((each) => (each.id === opened.id ? { ...each, admitted: true } : each))),
  );
  const row = snapshot.tasks.find((each) => each.ticket.key === "PRB-421")!;
  row.ticket = { ...row.ticket, state: state as typeof row.ticket.state };
  return opened;
}

it("keeps work whose pull request is open, in the host's words", async () => {
  expect(snapshot.tasks.find((row) => row.ticket.key === "PRB-377")?.ticket.state).toBe("pr_open");
  await expect(sampleBridge.request({ kind: "discard", repoId, key: "PRB-377" })).rejects.toThrow(
    "PRB-377 has a pull request open, and that is a record this machine does not own. Close " +
      "or merge it on GitHub first, then delete the work.",
  );
  expect(onBoard("PRB-377")).toBe(true);
});

it("keeps the ticket a discarded planning drafted once its pull request is open, and says why", async () => {
  const planning = await drafted("pr_open");
  // The planning goes; the ticket stays where it is listed, and the refusal
  // is said in the host's words rather than swallowed.
  await expect(sampleBridge.request({ kind: "editingDiscard", id: planning.id })).rejects.toThrow(
    "PRB-421 has a pull request open, and that is a record this machine does not own. Close " +
      "or merge it on GitHub first, then delete the work.",
  );
  expect(stored().find((each) => each.id === planning.id)?.phase).toBe("discarded");
  expect(onBoard("PRB-421")).toBe(true);
});

it("waits for a command running in the repository, in the host's words", async () => {
  held.push(job("run", repoId, "PRB-404", () => undefined, 60_000));
  await expect(sampleBridge.request({ kind: "discard", repoId, key: "PRB-412" })).rejects.toThrow(
    "Wait for the commands running in this repository to finish before deleting a contract.",
  );
  expect(onBoard("PRB-412")).toBe(true);
});

it("refuses to discard the planning that drafted its ticket while a command runs, before anything goes", async () => {
  const planning = await drafted("executing");
  held.push(job("run", repoId, "PRB-404", () => undefined, 60_000));
  await expect(sampleBridge.request({ kind: "editingDiscard", id: planning.id })).rejects.toThrow(
    "Wait for the commands running in this repository to finish before deleting a contract.",
  );
  // Refused before the planning went, as the host refuses it: the person
  // finds the work as it was, planning and ticket both.
  expect(stored().find((each) => each.id === planning.id)?.phase).not.toBe("discarded");
  expect(onBoard("PRB-421")).toBe(true);
});

/** That planning writing the spec `slug`, whose file the sample holds. */
function writing(planning: EditingSession, slug: string): void {
  localStorage.setItem(
    "perbo:preview-editing",
    JSON.stringify(stored().map((each) => (each.id === planning.id ? { ...each, specSlug: slug } : each))),
  );
  saveSpec(slug, "# Retry on failure\n");
}

it("takes the spec with a planning thrown away after its ticket was deleted out of band", async () => {
  const planning = await drafted("plan_review");
  writing(planning, "retry-on-failure");
  snapshot.tasks = snapshot.tasks.filter((row) => row.ticket.key !== "PRB-421");
  await sampleBridge.request({ kind: "editingDiscard", id: planning.id });
  expect(stored().find((each) => each.id === planning.id)?.phase).toBe("discarded");
  expect(specFiles()["retry-on-failure"], "the spec").toBeUndefined();
});

it("refuses to read the plan of a planning thrown away against its spec, in the host's words", async () => {
  // Over an open pull request, so the ticket and its plan stay where they are
  // listed and only the planning goes: nothing but the planning being thrown
  // away stands in the way of a reading.
  const planning = await drafted("pr_open");
  writing(planning, "retry-on-failure");
  await expect(sampleBridge.request({ kind: "editingDiscard", id: planning.id })).rejects.toThrow(
    "PRB-421 has a pull request open",
  );
  expect(onBoard("PRB-421")).toBe(true);
  await expect(sampleBridge.request({ kind: "driftCheck", id: planning.id, state: null })).rejects.toThrow(
    "This planning has been thrown away, and its plan with it.",
  );
});

it("deletes the ticket once nothing holds it, and every planning over it with its chat", async () => {
  const planning = await drafted("executing");
  expect(planning.phase).not.toBe("discarded");
  await sampleBridge.request({ kind: "interviewTurn", id: planning.id, text: "Split the settings page" });
  expect(sampleInterviews.has(planning.id), "the planning's chat is running").toBe(true);
  await expect(sampleBridge.request({ kind: "discard", repoId, key: "PRB-421" })).resolves.toBeNull();
  expect(onBoard("PRB-421")).toBe(false);
  expect(stored().find((each) => each.id === planning.id)?.phase).toBe("discarded");
  expect(sampleInterviews.has(planning.id), "the chat went with it").toBe(false);
});

/**
 * A fresh planning whose spec states a title another ticket already carries,
 * drafted from with Generate plan: the ticket it drafts, and the spec's title
 * after. `byPerson` is whether the person gave that title on the Spec pane.
 */
async function draftedUnder(byPerson: boolean): Promise<{ ticket: string; spec: string }> {
  const taken = snapshot.tasks.find((row) => row.repoId === repoId)!.ticket.title;
  const opened = await sampleBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
  const slug = "confirmation-email";
  editing.recordSpec(opened.id, slug);
  saveSpec(
    slug,
    `# ${taken}\n\n## Outcome\n\nNew users receive a confirmation email.\n\n` +
      "## Requirements\n\n- R1: A signup queues exactly one email.\n\n## No-Gos\n\n## Rabbit holes\n\n## Notes\n",
  );
  if (byPerson) editing.personTitled(opened.id, taken);
  await sampleBridge.request({ kind: "generatePlan", repoId, id: opened.id });
  const row = await vi.waitFor(
    () => {
      const found = snapshot.tasks.find((each) => each.ticket.admission.spec?.path === `specs/${slug}/spec.md`);
      if (found === undefined) throw new Error("not drafted yet");
      return found;
    },
    { timeout: 5000 },
  );
  return { ticket: row.ticket.title, spec: specFiles()[slug]!.split("\n")[0]! };
}

it("drafts the plan under the name the person gave the spec, and the spec keeps it (D-127)", async () => {
  const taken = snapshot.tasks.find((row) => row.repoId === repoId)!.ticket.title;
  expect(await draftedUnder(true)).toEqual({ ticket: taken, spec: `# ${taken}` });
});

it("names a plan whose spec nobody titled as admit does, and the spec takes that name (D-127)", async () => {
  expect(await draftedUnder(false)).toEqual({
    ticket: "New users receive a confirmation email.",
    spec: "# New users receive a confirmation email.",
  });
});

it("moves a ticket on a principle with no finding answered, as the principle alone does, and publishes nothing (D-065)", async () => {
  const key = "PRB-412";
  const state = () => snapshot.tasks.find((row) => row.ticket.key === key)!.ticket.state;
  const digest = async () => (await sampleBridge.request({ kind: "detail", repoId, key })).digest;
  // The run that stops for it was going to publish.
  await sampleBridge.request({ kind: "run", repoId, key, digest: await digest(), publish: true, approve: false, resumeFrom: null });
  await vi.waitFor(() => expect(state()).not.toBe("provisioning"), { timeout: 5000 });
  const decided = await sampleBridge.request({
    kind: "decide",
    repoId,
    key,
    digest: await digest(),
    answer: "Keep dead letters apart.",
    decisions: [],
  });
  expect(decided.publish).toBe(false);
  await vi.waitFor(() => expect(state()).not.toBe("provisioning"), { timeout: 5000 });
  expect(state()).toBe("pr_open");
});

it("moves a ticket as the CLI does, along the lifecycle's own rows with a row of history each step, so one opened before it came to need the person owes it again", async () => {
  const key = "PRB-412";
  const ticket = () => snapshot.tasks.find((row) => row.ticket.key === key)!.ticket;
  const from = ticket().state;
  const before = ticket().history.length;
  await sampleBridge.request({ kind: "ticketOpened", repoId, key });
  const digest = (await sampleBridge.request({ kind: "detail", repoId, key })).digest;
  await sampleBridge.request({ kind: "run", repoId, key, digest, publish: false, approve: false, resumeFrom: null });
  // Back through `ready`, then `provisioning` before the attempt.
  expect(ticket().history.slice(before).map((row) => [row.from, row.to])).toEqual([[from, "ready"], ["ready", "provisioning"]]);
  await vi.waitFor(() => expect(ticket().state).not.toBe("provisioning"), { timeout: 5000 });
  const walked = ticket().history.slice(before);
  expect(walked.map((row) => row.to)).toEqual(["ready", "provisioning", "executing", "verifying", "independent_review", ticket().state]);
  for (const step of walked)
    expect(TICKET_TRANSITIONS.some((row) => row.from === step.from && row.to === step.to), `${step.from} to ${step.to}`).toBe(true);
  expect(walked.at(-1)).toMatchObject({ from: "independent_review", to: ticket().state, at: ticket().updated_at });
  const board = await sampleBridge.request({ kind: "snapshot" });
  expect(unseenAttention(board, board.tasks.find((row) => row.ticket.key === key)!)).toBe(true);
  await sampleBridge.request({ kind: "ticketOpened", repoId, key });
  const opened = await sampleBridge.request({ kind: "snapshot" });
  expect(unseenAttention(opened, opened.tasks.find((row) => row.ticket.key === key)!)).toBe(false);
});

it("stops a run as the host does: the ticket stays where the run left it, with no row for the stop", async () => {
  const key = "PRB-412";
  const ticket = () => snapshot.tasks.find((row) => row.ticket.key === key)!.ticket;
  const digest = (await sampleBridge.request({ kind: "detail", repoId, key })).digest;
  const run = await sampleBridge.request({ kind: "run", repoId, key, digest, publish: false, approve: false, resumeFrom: null });
  const started = structuredClone(ticket());
  expect(started.state).toBe("provisioning");
  await sampleBridge.request({ kind: "cancel", jobId: run.id });
  await vi.waitFor(() => expect(snapshot.jobs.find((each) => each.id === run.id)!.state).toBe("cancelled"), { timeout: 5000 });
  expect(ticket()).toEqual(started);
});

it("refuses a run on a ticket the lifecycle gives no route back to ready, before any job opens", async () => {
  const key = "PRB-412";
  const row = snapshot.tasks.find((each) => each.ticket.key === key)!;
  const refused = async (state: "cancelled" | "pr_open", delivery: "open" | "closed") => {
    row.ticket = { ...row.ticket, state, delivery: { ...row.ticket.delivery, state: delivery } };
    const before = structuredClone(row.ticket);
    const jobs = snapshot.jobs.length;
    const digest = (await sampleBridge.request({ kind: "detail", repoId, key })).digest;
    await expect(
      sampleBridge.request({ kind: "run", repoId, key, digest, publish: false, approve: false, resumeFrom: null }),
    ).rejects.toThrow(`PRB-412 is ${state}, which the lifecycle has no route out of back to ready.`);
    expect(snapshot.jobs).toHaveLength(jobs);
    expect(row.ticket).toEqual(before);
  };
  await refused("cancelled", "open");
  // The rows out of pr_open but the merge are for a pull request GitHub closed.
  await refused("pr_open", "open");
});

it("refuses a move the lifecycle has no row for, and leaves the ticket where it was", async () => {
  const key = "PRB-412";
  const row = snapshot.tasks.find((each) => each.ticket.key === key)!;
  // An open pull request on a ticket still waiting on the person: no row takes it to merged.
  row.ticket = { ...row.ticket, delivery: { ...row.ticket.delivery, state: "open" } };
  const before = structuredClone(row.ticket);
  const sync = await sampleBridge.request({ kind: "sync", repoId, key });
  await vi.waitFor(() => expect(snapshot.jobs.find((each) => each.id === sync.id)!.state).toBe("failed"), { timeout: 5000 });
  expect(snapshot.jobs.find((each) => each.id === sync.id)!.error).toBe(
    "PRB-412 cannot move from changes_requested to merged: the lifecycle has no row for it.",
  );
  expect(row.ticket).toEqual(before);
});

/**
 * A fresh planning drafted from a spec with Generate plan, once it has landed:
 * one requirement drafts a basic ticket, two an epic the drafter divides.
 */
async function draftedFromSpec(slug: string, requirements: string[]): Promise<{ id: string; key: string }> {
  const opened = await sampleBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
  editing.recordSpec(opened.id, slug);
  saveSpec(
    slug,
    "# Confirmation email\n\n## Outcome\n\nNew users receive a confirmation email.\n\n## Requirements\n\n" +
      requirements.map((each, index) => `- R${index + 1}: ${each}`).join("\n") +
      "\n\n## No-Gos\n\n## Rabbit holes\n\n## Notes\n",
  );
  const key = await submitted(opened.id, "generate");
  return { id: opened.id, key };
}

/** Generate plan, or Start over, pressed as the Spec pane presses it, and its plan landed on the planning. */
async function submitted(id: string, intent: "generate" | "startOver"): Promise<string> {
  // Opened again, as the page does as it mounts: a landed plan is edited from there.
  const session = await sampleBridge.request({ kind: "editingOpen", target: { kind: "session", id } });
  const operationId = crypto.randomUUID();
  await sampleBridge.request({ kind: "editingSubmit", id, revision: session.revision, operationId, intent });
  return vi.waitFor(
    () => {
      const now = editing.read(id);
      if (now.key === null || now.operation?.id !== operationId || !now.operation.reconciled)
        throw new Error("not landed yet");
      return now.key;
    },
    { timeout: 5000 },
  );
}

const settledJob = (id: string) =>
  vi.waitFor(
    () => {
      const found = snapshot.jobs.find((each) => each.id === id)!;
      if (found.state === "running" || found.state === "stopping") throw new Error("still running");
      expect(found.state).toBe("completed");
    },
    { timeout: 5000 },
  );

/** The sample's refusal of a dismissal after a person's edit of the plan, in the CLI's words. */
const handEditedRefusal = (key: string) =>
  `${key}'s plan has been edited by hand since it was drafted, so its problems cannot be ` +
  "dismissed: answer them, or edit the plan until a reading finds none";

it("dismisses the problems of a plan nobody has edited since it was drafted", async () => {
  const { id } = await draftedFromSpec("dismiss-untouched", ["A signup queues exactly one email."]);
  await expect(sampleBridge.request({ kind: "driftDismiss", id })).resolves.toBeNull();
});

it("dismisses after edits the chat made alone, which move the spec with the plan", async () => {
  const { id, key } = await draftedFromSpec("dismiss-after-chat", [
    "A signup queues exactly one email.",
    "A failed send is retried once.",
  ]);
  // The chat's edit, as the sample interview applies one: through the same
  // edit path, recorded as the interview's.
  writeGraphEdit(
    key,
    (state) =>
      applyGraphEdit(
        state,
        {
          op: "set_criterion",
          id: "ac_1",
          text: "A signup queues exactly two emails.",
          expected_verification: { kind: "test", assertion: "two emails" },
        },
        [],
      ),
    null,
    undefined,
    "interview",
  );
  await settledJob((await sampleBridge.request({ kind: "driftCheck", id, state: null })).id);
  await expect(sampleBridge.request({ kind: "driftDismiss", id })).resolves.toBeNull();
  // The person taking the chat's edit back in the Graph pane is an edit by hand.
  const undo = await sampleBridge.request({ kind: "graphUndo", repoId, key, edit: 1 });
  await settledJob(undo.id);
  await expect(sampleBridge.request({ kind: "driftDismiss", id })).rejects.toThrow(handEditedRefusal(key));
});

it("refuses the dismissal after a hand edit on a basic ticket's contract page, saying why", async () => {
  const { id, key } = await draftedFromSpec("dismiss-after-contract", ["A signup queues exactly one email."]);
  const session = editing.read(id);
  expect(session.nodes).toBe(0);
  const { digest } = await sampleBridge.request({ kind: "detail", repoId, key });
  const draft = session.form.draft;
  const edit = await sampleBridge.request({
    kind: "edit",
    repoId,
    key,
    digest,
    draft: { ...draft, criteria: [{ ...draft.criteria[0]!, text: "A signup queues exactly two emails." }] },
  });
  await settledJob(edit.id);
  await expect(sampleBridge.request({ kind: "driftDismiss", id })).rejects.toThrow(handEditedRefusal(key));
});

it("refuses the dismissal after a hand edit in an epic's Graph pane, until the plan is drafted again", async () => {
  const { id, key } = await draftedFromSpec("dismiss-after-graph", [
    "A signup queues exactly one email.",
    "A failed send is retried once.",
  ]);
  expect(editing.read(id).nodes).toBeGreaterThan(0);
  const edit = await sampleBridge.request({
    kind: "graphEdit",
    repoId,
    key,
    edit: {
      op: "set_criterion",
      id: "ac_1",
      text: "A signup queues exactly two emails.",
      expected_verification: { kind: "test", assertion: "two emails" },
    },
  });
  await settledJob(edit.id);
  await expect(sampleBridge.request({ kind: "driftDismiss", id })).rejects.toThrow(handEditedRefusal(key));
  // Start over drafts the plan again, over the edit.
  await submitted(id, "startOver");
  await expect(sampleBridge.request({ kind: "driftDismiss", id })).resolves.toBeNull();
});

/** A reworded criterion the sample reading finds differs from its requirement. */
function chatRewords(key: string): void {
  writeGraphEdit(
    key,
    (state) =>
      applyGraphEdit(
        state,
        {
          op: "set_criterion",
          id: "ac_1",
          text: "A signup queues exactly two emails.",
          expected_verification: { kind: "test", assertion: "two emails" },
        },
        [],
      ),
    null,
    undefined,
    "interview",
  );
}

const readingsOf = (key: string) => snapshot.jobs.filter((each) => each.kind === "drift" && each.key === key);

it("lands a plan Start over drafts with none of the problems of the plan it replaced, and reads nothing", async () => {
  const { id, key } = await draftedFromSpec("start-over-over-problems", [
    "A signup queues exactly one email.",
    "A failed send is retried once.",
  ]);
  chatRewords(key);
  await settledJob((await sampleBridge.request({ kind: "driftCheck", id, state: null })).id);
  expect(editing.read(id).drift?.open.length).toBeGreaterThan(0);
  const before = readingsOf(key).length;
  await submitted(id, "startOver");
  const landed = editing.read(id);
  expect(landed.drift).toBeNull();
  expect(landed.read).not.toBeNull();
  expect(readingsOf(key)).toHaveLength(before);
});

it("records nothing of a reading Start over overtook: the plan it read has gone", async () => {
  const { id, key } = await draftedFromSpec("start-over-under-a-reading", [
    "A signup queues exactly one email.",
    "A failed send is retried once.",
  ]);
  chatRewords(key);
  const reading = await sampleBridge.request({ kind: "driftCheck", id, state: "0123456789abcdef" });
  const session = await sampleBridge.request({ kind: "editingOpen", target: { kind: "session", id } });
  await sampleBridge.request({ kind: "editingSubmit", id, revision: session.revision, operationId: crypto.randomUUID(), intent: "startOver" });
  // The reading lands before the plan drafted again does, and finds the
  // difference in the plan it read; none of it reaches the planning.
  await settledJob(reading.id);
  const now = editing.read(id);
  expect(now.operation?.reconciled).toBe(false);
  expect((snapshot.jobs.find((each) => each.id === reading.id)!.result as { findings: unknown[] }).findings.length).toBeGreaterThan(0);
  expect(now.drift).toBeNull();
  expect(now.read).not.toBe("0123456789abcdef");
});

it("refuses to approve a ticket while a planning over it records problems open, in one sentence, and approves it once none is", async () => {
  const { id, key } = await draftedFromSpec("approve-over-problems", [
    "A signup queues exactly one email.",
    "A failed send is retried once.",
  ]);
  chatRewords(key);
  await settledJob((await sampleBridge.request({ kind: "driftCheck", id, state: null })).id);
  expect(editing.read(id).drift?.open.length).toBeGreaterThan(0);
  const ticket = () => snapshot.tasks.find((row) => row.ticket.key === key)!.ticket;
  const runs = () => snapshot.jobs.filter((each) => each.kind === "run" && each.key === key);
  const { digest } = await sampleBridge.request({ kind: "detail", repoId, key });
  const approve = () =>
    sampleBridge.request({ kind: "run", repoId, key, digest, publish: false, approve: true, resumeFrom: null });
  await expect(approve()).rejects.toThrow(
    `${key} is not approved while its plan and its spec no longer promise the same thing: resolve each ` +
      "problem on the Problems tab, or change the plan, and confirm again.",
  );
  expect(runs()).toHaveLength(0);
  expect(ticket().approved_at).toBeNull();
  // Dismissed at the command line, which the chat's edits allow: none is open, and it approves.
  await sampleBridge.request({ kind: "driftDismiss", id });
  expect(editing.read(id).drift).toBeNull();
  const run = await approve();
  held.push(run);
  expect(runs()).toHaveLength(1);
  expect(ticket().approved_at).not.toBeNull();
});
