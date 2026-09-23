import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { Profile, ProfileStateSchema } from "./store.js";
import { SettingsSchema } from "../../shared/protocol.js";

const scratchDirectory = createScratch("perbo-profile-");
afterEach(() => {
  scratchDirectory.removeAll();
});
/** A profile directory the app has not opened yet, optionally holding a record. */
function directory(written?: unknown): string {
  const root = scratchDirectory();
  const path = join(root, "profile");
  if (written !== undefined) {
    rmSync(path, { recursive: true, force: true });
    writeFileSync(join(root, "workspace.json"), JSON.stringify(written, null, 2));
    return root;
  }
  return path;
}
const job = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  ...over,
});

const stored = {
  version: 1,
  settings: SettingsSchema.parse({}),
  repositories: [],
  jobs: [],
  asks: {},
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

  it("refuses a record without each repository's unsent ask", () => {
    const without: Record<string, unknown> = { ...stored };
    delete without["asks"];
    expect(() => ProfileStateSchema.parse(without)).toThrow(/asks/);
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

describe("opening the profile", () => {
  it("starts one where there is none, with the tickets already finished counted as filed", () => {
    const path = directory();
    const profile = Profile.open(path);
    expect(profile.state.repositories).toEqual([]);
    expect(profile.state.archivedSeeded).toBe(true);
    expect(existsSync(profile.path)).toBe(false);
  });

  it("makes the profile directory readable only by its owner", () => {
    const profile = Profile.open(directory());
    profile.save();
    expect(statSync(profile.path).mode & 0o777).toBe(0o600);
  });

  it("reads back what it saved, and replaces the file whole", () => {
    const path = directory();
    const first = Profile.open(path);
    first.state.titles = { "repo:PRB-1": "Renamed" };
    first.state.settings = SettingsSchema.parse({ name: "Morgan", executorProvider: "codex-cli" });
    first.save();
    expect(first.lastSave).toBeGreaterThan(0);
    const reopened = Profile.open(path).state;
    expect(reopened.titles).toEqual({ "repo:PRB-1": "Renamed" });
    // The preferences are read back as they were written, so the app opens on
    // what the person last chose.
    expect(reopened.settings.name).toBe("Morgan");
    expect(reopened.settings.executorProvider).toBe("codex-cli");
  });

  it("keeps what a profile from before the four moments said with its one switch", () => {
    // Written before `notifyOn` existed: one switch, and no record of the four.
    const settings: Record<string, unknown> = {
      ...SettingsSchema.parse({}),
      notifications: false,
    };
    delete settings["notifyOn"];
    const root = directory({
      version: 1,
      asks: {},
      settings,
      repositories: [],
      jobs: [],
    });
    expect(Profile.open(root).state.settings.notifyOn).toEqual({
      decision: false,
      review: false,
      ceiling: false,
      stage: false,
    });
  });

  it("leaves the four moments alone where the profile already carries them", () => {
    const notifyOn = { decision: true, review: false, ceiling: true, stage: false };
    const root = directory({
      version: 1,
      asks: {},
      settings: { ...SettingsSchema.parse({}), notifications: false, notifyOn },
      repositories: [],
      jobs: [],
    });
    expect(Profile.open(root).state.settings.notifyOn).toEqual(notifyOn);
  });

  it("marks a job the app closed on interrupted, and says where its outcome is", () => {
    const root = directory({
      version: 1,
      asks: {},
      settings: SettingsSchema.parse({}),
      repositories: [],
      jobs: [job(), job({ id: "80000000-0000-4000-8000-000000000003", state: "stopping" })],
    });
    const state = Profile.open(root).state;
    expect(state.jobs.map((entry) => entry.state)).toEqual(["interrupted", "interrupted"]);
    expect(state.jobs[0]?.error).toBe(
      "Perbo closed before the command reported an outcome. Refresh the ticket from its CLI records before starting again.",
    );
    expect(state.jobs[0]?.endedAt).not.toBeNull();
  });

  it("leaves a job that had already finished as it was recorded", () => {
    const root = directory({
      version: 1,
      asks: {},
      settings: SettingsSchema.parse({}),
      repositories: [],
      jobs: [job({ state: "completed", endedAt: "2026-09-19T09:01:00.000Z", error: null })],
    });
    expect(Profile.open(root).state.jobs[0]).toMatchObject({
      state: "completed",
      endedAt: "2026-09-19T09:01:00.000Z",
    });
  });

  it("leaves nothing beside the record when the save cannot land", () => {
    const profile = Profile.open(directory());
    profile.save();
    // A non-empty directory where the record belongs: the bytes are written
    // and the step that swaps them in is the one that fails, which is where a
    // temporary is left behind unless the failure takes it away.
    rmSync(profile.path);
    mkdirSync(profile.path);
    writeFileSync(join(profile.path, "x"), "");

    expect(() => profile.save()).toThrow();
    expect(readdirSync(dirname(profile.path))).toEqual(["workspace.json"]);
  });

  it("carries the record's own bytes, so a save writes what was read", () => {
    const root = directory({
      version: 1,
      asks: {},
      settings: SettingsSchema.parse({}),
      repositories: [{ id: "80000000-0000-4000-8000-000000000002", name: "a", path: "/a" }],
      jobs: [],
      archived: ["80000000-0000-4000-8000-000000000002:PRB-1"],
    });
    const profile = Profile.open(root);
    profile.save();
    expect(JSON.parse(readFileSync(profile.path, "utf8"))).toMatchObject({
      repositories: [{ name: "a" }],
      archived: ["80000000-0000-4000-8000-000000000002:PRB-1"],
    });
  });
});
