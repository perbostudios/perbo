import { describe, expect, it } from "vitest";
import { editingForm } from "../../shared/contract-editing.js";
import { SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import { ProfileStateSchema, type ProfileState } from "./store.js";
import {
  discardEditingFor,
  forgetRepository,
  forgetTicket,
  seedArchived,
  setArchived,
} from "./preferences.js";

const alpha = "80000000-0000-4000-8000-000000000001";
const beta = "80000000-0000-4000-8000-000000000002";
const sessionId = "80000000-0000-4000-8000-000000000003";
const session = (over: Record<string, unknown>): Record<string, unknown> => ({
  version: 1,
  id: sessionId,
  repoId: alpha,
  key: "PRB-1",
  digest: null,
  revision: 0,
  resumeNew: true,
  form: editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({}))),
  phase: "editing",
  error: null,
  operation: null,
  drift: null,
  change: null,
  lastPane: null,
  lastView: null,
  interviewModel: null,
  ...over,
});
function profile(over: Record<string, unknown> = {}): ProfileState {
  return ProfileStateSchema.parse({
    version: 1,
    settings: SettingsSchema.parse({}),
    repositories: [
      { id: alpha, name: "alpha", path: "/checkout/alpha" },
      { id: beta, name: "beta", path: "/checkout/beta" },
    ],
    jobs: [],
    asks: {},
    titles: { [alpha + ":PRB-1"]: "Renamed", [beta + ":PRB-9"]: "Another repository's" },
    taskModels: { [alpha + ":PRB-1"]: TaskModelsSchema.strip().parse(SettingsSchema.parse({})) },
    archived: [alpha + ":PRB-1", alpha + ":PRB-2", beta + ":PRB-9"],
    ...over,
  });
}

describe("forgetRepository", () => {
  it("drops the repository and every preference keyed to it", () => {
    const state = profile();
    forgetRepository(state, alpha);
    expect(state.repositories.map((entry) => entry.id)).toEqual([beta]);
    expect(state.titles).toEqual({ [beta + ":PRB-9"]: "Another repository's" });
    expect(state.taskModels).toEqual({});
    expect(state.archived).toEqual([beta + ":PRB-9"]);
  });

  it("leaves a repository whose id is not the one forgotten", () => {
    const state = profile();
    forgetRepository(state, "80000000-0000-4000-8000-00000000000f");
    expect(state.repositories).toHaveLength(2);
    expect(state.archived).toHaveLength(3);
  });
});

describe("forgetTicket", () => {
  it("drops that one ticket's title, models and archive mark", () => {
    const state = profile();
    forgetTicket(state, alpha, "PRB-1");
    expect(state.titles).toEqual({ [beta + ":PRB-9"]: "Another repository's" });
    expect(state.taskModels).toEqual({});
    expect(state.archived).toEqual([alpha + ":PRB-2", beta + ":PRB-9"]);
  });

  it("leaves the same key in another repository alone", () => {
    const state = profile({ archived: [alpha + ":PRB-1", beta + ":PRB-1"] });
    forgetTicket(state, alpha, "PRB-1");
    expect(state.archived).toEqual([beta + ":PRB-1"]);
  });
});

describe("setArchived", () => {
  it("files tickets away without repeating one already filed", () => {
    const state = profile({ archived: [alpha + ":PRB-1"] });
    setArchived(state, alpha, ["PRB-1", "PRB-3"], true);
    expect(state.archived).toEqual([alpha + ":PRB-1", alpha + ":PRB-3"]);
  });

  it("puts them back on Home, leaving every other mark", () => {
    const state = profile();
    setArchived(state, alpha, ["PRB-1"], false);
    expect(state.archived).toEqual([alpha + ":PRB-2", beta + ":PRB-9"]);
  });
});

describe("discardEditingFor", () => {
  it("marks this ticket's planning discarded, moves its revision on, and names it", () => {
    const state = profile({ editingSessions: [session({})] });
    expect(discardEditingFor(state, alpha, "PRB-1")).toEqual([state.editingSessions[0]!.id]);
    expect(state.editingSessions[0]).toMatchObject({
      phase: "discarded",
      resumeNew: false,
      revision: 1,
    });
  });

  it("leaves a session already discarded where it is", () => {
    const state = profile({
      editingSessions: [session({ phase: "discarded", revision: 4, resumeNew: false })],
    });
    expect(discardEditingFor(state, alpha, "PRB-1")).toEqual([]);
    expect(state.editingSessions[0]).toMatchObject({ phase: "discarded", revision: 4 });
  });

  it("leaves a session of another ticket, or another repository, alone", () => {
    const state = profile({
      editingSessions: [
        session({ key: "PRB-2" }),
        session({ id: "80000000-0000-4000-8000-000000000004", repoId: beta }),
      ],
    });
    expect(discardEditingFor(state, alpha, "PRB-1")).toEqual([]);
    expect(state.editingSessions.map((entry) => entry.phase)).toEqual(["editing", "editing"]);
  });
});

describe("seedArchived", () => {
  const row = (key: string, state: string): { repoId: string; ticket: { key: string; state: string } } => ({
    repoId: alpha,
    ticket: { key, state },
  });

  it("files what had already finished, once", () => {
    const state = profile({ archived: [], archivedSeeded: false });
    expect(
      seedArchived(state, [row("PRB-1", "merged"), row("PRB-2", "executing"), row("PRB-3", "closed")]),
    ).toBe(true);
    expect(state.archived).toEqual([alpha + ":PRB-1", alpha + ":PRB-3"]);
    expect(state.archivedSeeded).toBe(true);
  });

  it("does nothing on a profile that has already been seeded", () => {
    const state = profile({ archived: [], archivedSeeded: true });
    expect(seedArchived(state, [row("PRB-1", "merged")])).toBe(false);
    expect(state.archived).toEqual([]);
  });

  it("keeps what the person had already filed by hand", () => {
    const state = profile({ archived: [alpha + ":PRB-9"], archivedSeeded: false });
    seedArchived(state, [row("PRB-1", "merged")]);
    expect(state.archived).toEqual([alpha + ":PRB-9", alpha + ":PRB-1"]);
  });
});
