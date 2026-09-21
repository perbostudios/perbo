import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { discardTicket, type DiscardDeps } from "./discard.js";
import { attemptsPath, bundlesPath, ticketPath } from "../repository/layout.js";
import { ProfileStateSchema, type ProfileState, type RegisteredRepository } from "../profile/store.js";
import { SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import { editingForm } from "../../shared/contract-editing.js";
import type { Job } from "../../shared/protocol.js";
import type { Ticket } from "@perbo/contracts";

const scratchDirectory = createScratch("perbo-discard-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const repoId = "80000000-0000-4000-8000-000000000001";
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(join(path, ".perbo", "tickets"), { recursive: true });
  const repo = { id: repoId, name: "checkout", path };
  for (const suffix of [".json", ".contract.json", ".draft.json"] as const)
    writeFileSync(ticketPath(repo, "PRB-1", suffix), "{}\n");
  return repo;
}
const ticket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    key: "PRB-1",
    ticket_id: "ticket_1",
    state: "ready",
    delivery: { pull_request_url: null },
    ...over,
  }) as Ticket;
function state(): ProfileState {
  return ProfileStateSchema.parse({
    version: 1,
    settings: SettingsSchema.parse({}),
    repositories: [],
    jobs: [],
    titles: { [repoId + ":PRB-1"]: "Renamed" },
    archived: [repoId + ":PRB-1"],
  });
}
function deps(over: { ticket?: Ticket; jobs?: Job[]; profile?: ProfileState } = {}): DiscardDeps {
  return {
    tickets: { list: () => Promise.resolve({ tickets: [over.ticket ?? ticket()] }) },
    profile: { state: over.profile ?? state() },
    liveJobs: () => over.jobs ?? [],
  };
}
/** A planning session drafting one ticket, as the profile records it. */
const planning = (key: string): Record<string, unknown> => ({
  version: 1,
  id: key === "PRB-1"
    ? "80000000-0000-4000-8000-000000000003"
    : "80000000-0000-4000-8000-000000000004",
  repoId,
  key,
  digest: null,
  revision: 0,
  resumeNew: true,
  form: editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({}))),
  phase: "editing",
  error: null,
  operation: null,
});
const running = (over: Partial<Job> = {}): Job =>
  ({
    id: "80000000-0000-4000-8000-00000000000a",
    repoId,
    key: "PRB-2",
    kind: "run",
    label: "Run engineering loop",
    state: "running",
    startedAt: "2026-09-19T09:00:00.000Z",
    endedAt: null,
    log: "",
    error: null,
    resultKey: null,
    result: null,
    ...over,
  }) as Job;

describe("discardTicket", () => {
  it("removes the ticket's three records and its preferences", async () => {
    const repo = repository();
    const profile = state();
    await discardTicket(deps({ profile }), repo, "PRB-1");
    for (const suffix of [".json", ".contract.json", ".draft.json"] as const)
      expect(existsSync(ticketPath(repo, "PRB-1", suffix))).toBe(false);
    expect(profile.titles).toEqual({});
    expect(profile.archived).toEqual([]);
  });

  it("waits for the repository's own commands to finish", async () => {
    const repo = repository();
    await expect(discardTicket(deps({ jobs: [running()] }), repo, "PRB-1")).rejects.toThrow(
      "Wait for the commands running in this repository to finish before deleting a contract.",
    );
    expect(existsSync(ticketPath(repo, "PRB-1", ".json"))).toBe(true);
  });

  it("does not wait for a command in another repository", async () => {
    const repo = repository();
    const elsewhere = running({ repoId: "80000000-0000-4000-8000-00000000000b" });
    await expect(discardTicket(deps({ jobs: [elsewhere] }), repo, "PRB-1")).resolves.toBeUndefined();
  });

  it("refuses a ticket the store no longer holds", async () => {
    const repo = repository();
    await expect(
      discardTicket(deps({ ticket: ticket({ key: "PRB-9" }) }), repo, "PRB-1"),
    ).rejects.toThrow("This task is no longer in the repository's ticket store.");
  });

  it("keeps a contract that has moved past the contract stage", async () => {
    const repo = repository();
    for (const state of ["executing", "merged", "pr_open"])
      await expect(
        discardTicket(deps({ ticket: ticket({ state: state as Ticket["state"] }) }), repo, "PRB-1"),
      ).rejects.toThrow("Only a contract that has never run can be deleted.");
    expect(existsSync(ticketPath(repo, "PRB-1", ".json"))).toBe(true);
  });

  it("deletes from every state a contract can still be in", async () => {
    for (const state of ["draft", "specifying", "plan_review", "ready", "plan_invalid"]) {
      const repo = repository();
      await expect(
        discardTicket(deps({ ticket: ticket({ state: state as Ticket["state"] }) }), repo, "PRB-1"),
      ).resolves.toBeUndefined();
    }
  });

  it("keeps a contract with a recorded attempt", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo", "state"), { recursive: true });
    writeFileSync(
      attemptsPath(repo, "ticket_1"),
      JSON.stringify({ ticket_id: "ticket_1", attempts: [{ attempt_id: "att_1" }] }),
    );
    await expect(discardTicket(deps(), repo, "PRB-1")).rejects.toThrow(
      "This contract has recorded attempts or evidence, so it stays.",
    );
  });

  it("keeps a contract whose attempts record could not be read", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo", "state"), { recursive: true });
    writeFileSync(attemptsPath(repo, "ticket_1"), "{not json");
    await expect(discardTicket(deps(), repo, "PRB-1")).rejects.toThrow(
      "This contract has recorded attempts or evidence, so it stays.",
    );
  });

  it("keeps a contract with a bundle on record, and ignores another ticket's", async () => {
    const repo = repository();
    mkdirSync(bundlesPath(repo), { recursive: true });
    const bundle = (ticketId: string): string =>
      JSON.stringify({
        bundle_id: "bundle_0000000000000001",
        kind: "execution",
        ticket_id: ticketId,
        subject_id: "att_1",
        artifacts: [],
      });
    writeFileSync(join(bundlesPath(repo), "other.json"), bundle("ticket_other"));
    await expect(discardTicket(deps(), repo, "PRB-1")).resolves.toBeUndefined();
    const second = repository();
    mkdirSync(bundlesPath(second), { recursive: true });
    writeFileSync(join(bundlesPath(second), "own.json"), bundle("ticket_1"));
    await expect(discardTicket(deps(), second, "PRB-1")).rejects.toThrow(
      "This contract has recorded attempts or evidence, so it stays.",
    );
  });

  it("keeps a contract with a pull request on record", async () => {
    const repo = repository();
    await expect(
      discardTicket(
        deps({
          ticket: ticket({
            delivery: { pull_request_url: "https://github.com/perbo/perbo/pull/1" } as Ticket["delivery"],
          }),
        }),
        repo,
        "PRB-1",
      ),
    ).rejects.toThrow("This contract has a pull request on record, so it stays.");
  });

  it("refuses a ticket store holding a link rather than following it", async () => {
    const repo = repository();
    const outside = join(repo.path, "..", "outside.json");
    writeFileSync(outside, "{}\n");
    rmSync(ticketPath(repo, "PRB-1", ".draft.json"));
    symlinkSync(outside, join(repo.path, ".perbo", "tickets", "PRB-1.draft.json"));
    await expect(discardTicket(deps(), repo, "PRB-1")).rejects.toThrow("refuses a symlink");
    expect(existsSync(outside)).toBe(true);
  });

  it("marks this ticket's planning discarded, and leaves another ticket's alone", async () => {
    const repo = repository();
    const profile = state();
    profile.editingSessions = ProfileStateSchema.parse({
      version: 1,
      settings: SettingsSchema.parse({}),
      repositories: [],
      jobs: [],
      editingSessions: [planning("PRB-1"), planning("PRB-2")],
    }).editingSessions;
    await discardTicket(deps({ profile }), repo, "PRB-1");
    expect(profile.editingSessions.map((entry) => entry.phase)).toEqual([
      "discarded",
      "editing",
    ]);
  });
});
