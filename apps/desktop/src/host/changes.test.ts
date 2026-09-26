import { describe, expect, it } from "vitest";
import { Changes } from "./changes.js";
import { WorkspaceReads } from "./workspace-reads.js";
import { SettingsSchema } from "../shared/protocol.js";
import { ProfileStateSchema } from "./profile/store.js";
import type { Change } from "../shared/protocol.js";

/** A recorder for what a change did: what was told, what was invalidated, what was saved. */
function wiring(): {
  changes: Changes;
  told: Change[];
  invalidated: string[];
  saved: number[];
} {
  const told: Change[] = [];
  const invalidated: string[] = [];
  const saved: number[] = [];
  const reads = new WorkspaceReads();
  const invalidate = reads.invalidate.bind(reads);
  reads.invalidate = (scope: string): void => {
    invalidated.push(scope);
    invalidate(scope);
  };
  const changes = new Changes({
    reads,
    save: () => saved.push(saved.length + 1),
    emit: (change) => told.push(change),
  });
  return { changes, told, invalidated, saved };
}
const state = ProfileStateSchema.parse({
  version: 1,
  settings: SettingsSchema.parse({}),
  repositories: [],
  jobs: [],
  asks: {},
  lastOpened: { "repo:PRB-1": "2026-09-24T10:00:00.000Z" },
  titles: { "repo:PRB-1": "Renamed" },
  archived: ["repo:PRB-1"],
});

describe("Changes", () => {
  it("numbers every change it tells, one at a time", () => {
    const w = wiring();
    w.changes.changed();
    w.changes.changed(false);
    w.changes.power({ holding: true, detail: null, since: null });
    expect(w.told.map((change) => change.sequence)).toEqual([1, 2, 3]);
    expect(w.changes.sequence).toBe(3);
  });

  it("persists unless the caller says not to", () => {
    const w = wiring();
    w.changes.changed();
    expect(w.saved).toHaveLength(1);
    w.changes.changed(false);
    expect(w.saved).toHaveLength(1);
  });

  it("invalidates one repository's reads for a change to its records", () => {
    const w = wiring();
    w.changes.changed(true, { kind: "records", repoId: "repo-a", key: null });
    expect(w.invalidated).toEqual(["repo-a"]);
  });

  it("invalidates every read where a change names no repository", () => {
    const w = wiring();
    w.changes.changed(true, { kind: "records", repoId: null, key: null });
    expect(w.invalidated).toEqual(["all"]);
  });

  it("invalidates every read when the repositories or the preferences move", () => {
    const w = wiring();
    w.changes.changed(true, { kind: "repositories" });
    w.changes.preferences(state);
    expect(w.invalidated).toEqual(["all", "all"]);
  });

  it("carries the preferences as they now stand", () => {
    const w = wiring();
    w.changes.preferences(state);
    expect(w.told[0]).toMatchObject({
      kind: "preferences",
      titles: { "repo:PRB-1": "Renamed" },
      archived: ["repo:PRB-1"],
    });
    // When a page opened is told on its own, so an older preferences change cannot undo a newer opening.
    expect(w.told[0]).not.toHaveProperty("lastOpened");
  });

  it("tells the preferences without persisting where a save has already happened", () => {
    const w = wiring();
    w.changes.preferences(state, false);
    expect(w.saved).toHaveLength(0);
    expect(w.told[0]?.kind).toBe("preferences");
  });

  it("neither persists nor invalidates when only the power hold moved", () => {
    const w = wiring();
    const power = { holding: true, detail: "Holding sleep now", since: "2026-09-19T09:00:00.000Z" };
    w.changes.power(power);
    expect(w.saved).toHaveLength(0);
    expect(w.invalidated).toEqual([]);
    expect(w.told[0]).toEqual({ kind: "power", power, sequence: 1 });
  });

  it("neither persists nor invalidates when a ticket's page opened", () => {
    const w = wiring();
    w.changes.opened(state.lastOpened);
    expect(w.saved).toHaveLength(0);
    expect(w.invalidated).toEqual([]);
    expect(w.told[0]).toEqual({ kind: "opened", lastOpened: { "repo:PRB-1": "2026-09-24T10:00:00.000Z" }, sequence: 1 });
  });

  it("leaves what a progress change reported readable without invalidating a read", () => {
    const w = wiring();
    w.changes.changed(false, { kind: "editing", sessionId: "session-1" });
    expect(w.invalidated).toEqual([]);
    expect(w.told[0]).toMatchObject({ kind: "editing", sessionId: "session-1" });
  });
});
