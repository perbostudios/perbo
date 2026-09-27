import { describe, expect, it } from "vitest";
import { editingForm } from "../../shared/contract-editing.js";
import { SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import { ProfileStateSchema, type ProfileState } from "./store.js";
import {
  discardEditingFor,
  forgetCalledOff,
  forgetRepository,
  forgetTicket,
  recordOpened,
  recordCalledOff,
  setArchived,
} from "./preferences.js";

/** A pull request's URL, as the ticket's delivery records it. */
const PR = (number: number): string => `https://github.com/example/webstore/pull/${number}`;

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
  confirmed: null, read: null, impact: null,
  named: null,
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
    calledOff: [alpha + ":PRB-1:" + PR(1), alpha + ":PRB-10:" + PR(10), beta + ":PRB-9:" + PR(9)],
    lastOpened: { [alpha + ":PRB-1"]: "2026-09-20T09:00:00.000Z", [beta + ":PRB-9"]: "2026-09-21T09:00:00.000Z" },
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
    expect(state.calledOff).toEqual([beta + ":PRB-9:" + PR(9)]);
    expect(state.lastOpened).toEqual({ [beta + ":PRB-9"]: "2026-09-21T09:00:00.000Z" });
  });

  it("leaves a repository whose id is not the one forgotten", () => {
    const state = profile();
    forgetRepository(state, "80000000-0000-4000-8000-00000000000f");
    expect(state.repositories).toHaveLength(2);
    expect(state.archived).toHaveLength(3);
  });
});

describe("forgetTicket", () => {
  it("drops that one ticket's title, models, archive mark, call-off and last opening", () => {
    const state = profile();
    forgetTicket(state, alpha, "PRB-1");
    expect(state.titles).toEqual({ [beta + ":PRB-9"]: "Another repository's" });
    expect(state.taskModels).toEqual({});
    expect(state.archived).toEqual([alpha + ":PRB-2", beta + ":PRB-9"]);
    // Every call-off of that ticket, and not one of a key it prefixes.
    expect(state.calledOff).toEqual([alpha + ":PRB-10:" + PR(10), beta + ":PRB-9:" + PR(9)]);
    expect(state.lastOpened).toEqual({ [beta + ":PRB-9"]: "2026-09-21T09:00:00.000Z" });
  });

  it("leaves the same key in another repository alone", () => {
    const state = profile({ archived: [alpha + ":PRB-1", beta + ":PRB-1"] });
    forgetTicket(state, alpha, "PRB-1");
    expect(state.archived).toEqual([beta + ":PRB-1"]);
  });
});

describe("recordOpened", () => {
  it("writes the time a ticket's page opened, replacing the last one and no other", () => {
    const state = profile();
    recordOpened(state, alpha, "PRB-1", new Date("2026-09-24T10:30:00.000Z"));
    recordOpened(state, alpha, "PRB-2", new Date("2026-09-24T10:31:00.000Z"));
    expect(state.lastOpened).toEqual({
      [alpha + ":PRB-1"]: "2026-09-24T10:30:00.000Z",
      [alpha + ":PRB-2"]: "2026-09-24T10:31:00.000Z",
      [beta + ":PRB-9"]: "2026-09-21T09:00:00.000Z",
    });
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

describe("recordCalledOff", () => {
  it("records a merge called off once, keyed to its repository and the pull request it was called off on", () => {
    const state = profile({ calledOff: [alpha + ":PRB-1:" + PR(1)] });
    recordCalledOff(state, alpha, "PRB-1", PR(1));
    recordCalledOff(state, beta, "PRB-1", PR(1));
    recordCalledOff(state, alpha, "PRB-1", PR(2));
    expect(state.calledOff).toEqual([alpha + ":PRB-1:" + PR(1), beta + ":PRB-1:" + PR(1), alpha + ":PRB-1:" + PR(2)]);
  });
});

describe("forgetCalledOff", () => {
  it("drops every call-off of the ticket, whichever pull request it names, and says whether there was one", () => {
    const state = profile({ calledOff: [alpha + ":PRB-1:" + PR(1), alpha + ":PRB-1:" + PR(2), alpha + ":PRB-10:" + PR(10)] });
    expect(forgetCalledOff(state, alpha, "PRB-1")).toBe(true);
    expect(state.calledOff).toEqual([alpha + ":PRB-10:" + PR(10)]);
    expect(forgetCalledOff(state, alpha, "PRB-1")).toBe(false);
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
