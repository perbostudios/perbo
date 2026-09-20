import { describe, expect, it } from "vitest";
import { ProfileStateSchema } from "./store.js";
import { SettingsSchema } from "../../shared/protocol.js";

const stored = {
  version: 1,
  settings: SettingsSchema.parse({}),
  repositories: [],
  jobs: [],
};

describe("the profile's record", () => {
  it("reads a profile written before the later preferences arrived", () => {
    const state = ProfileStateSchema.parse(stored);
    expect(state.titles).toEqual({});
    expect(state.taskModels).toEqual({});
    expect(state.archived).toEqual([]);
    expect(state.editingSessions).toEqual([]);
    // A profile from before the archive preference has not been seeded, so the
    // first complete listing files what had already finished.
    expect(state.archivedSeeded).toBe(false);
  });

  it("refuses a repository the app could not have registered", () => {
    expect(() =>
      ProfileStateSchema.parse({
        ...stored,
        repositories: [{ id: "not-a-uuid", name: "r", path: "/tmp/r" }],
      }),
    ).toThrow();
  });

  it("keeps every field of a job it wrote", () => {
    const job = {
      id: "80000000-0000-4000-8000-000000000001",
      repoId: "80000000-0000-4000-8000-000000000002",
      key: "PRB-1",
      kind: "run",
      label: "Run engineering loop",
      state: "running",
      startedAt: "2026-09-19T09:00:00.000Z",
      endedAt: null,
      log: "",
      error: null,
      resultKey: null,
      result: null,
      editing: {
        sessionId: "80000000-0000-4000-8000-000000000003",
        operationId: "80000000-0000-4000-8000-000000000004",
      },
    };
    expect(ProfileStateSchema.parse({ ...stored, jobs: [job] }).jobs[0]).toEqual(job);
  });
});
