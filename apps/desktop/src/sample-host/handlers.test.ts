// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { sampleBridge } from "./bridge.js";
import { job, sampleInterviews, snapshot } from "./records.js";
import type { EditingSession, Job } from "../shared/protocol.js";

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
