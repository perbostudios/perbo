import { describe, expect, it } from "vitest";
import { PowerHold } from "./power.js";
import { SettingsSchema } from "../shared/protocol.js";
import type { HostIO } from "./service.js";
import type { Change, Job, Settings } from "../shared/protocol.js";

const settings = SettingsSchema.parse({});
const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "80000000-0000-4000-8000-00000000000a",
    repoId: "80000000-0000-4000-8000-000000000001",
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
  }) as Job;
/** A hold over a settable set of jobs, recording what the host was asked to do. */
function hold(over: { settings?: Settings; onBattery?: boolean } = {}) {
  const jobs: Job[] = [];
  const held: { hold: boolean; displaySleep: boolean }[] = [];
  const told: Change[] = [];
  const io = {
    holdSleep: (value: boolean, displaySleep: boolean) => {
      held.push({ hold: value, displaySleep });
    },
    onBattery: () => over.onBattery ?? false,
  } as unknown as HostIO;
  const power = new PowerHold({
    io,
    settings: () => over.settings ?? settings,
    liveJobs: () => jobs,
    changes: { power: (state) => told.push({ kind: "power", power: state, sequence: told.length + 1 }) },
  });
  return { power, jobs, held, told };
}
const afk = (over: Partial<Settings["afk"]>): Settings => ({
  ...settings,
  afk: { ...settings.afk, ...over },
});

describe("PowerHold", () => {
  it("holds the machine awake while a run is live", () => {
    const w = hold({ settings: afk({ holdSleep: true }) });
    w.jobs.push(job());
    w.power.update();
    expect(w.power.state.holding).toBe(true);
    expect(w.power.state.detail).toContain("PRB-1");
    expect(w.power.state.since).not.toBeNull();
    expect(w.held).toEqual([{ hold: true, displaySleep: settings.afk.displaySleep }]);
  });

  it("holds nothing where the person asked for nothing", () => {
    const w = hold({ settings: afk({ holdSleep: false }) });
    w.jobs.push(job());
    w.power.update();
    expect(w.power.state.holding).toBe(false);
    expect(w.told).toEqual([]);
  });

  it("holds nothing for planning, which is not a run", () => {
    const w = hold({ settings: afk({ holdSleep: true }) });
    w.jobs.push(job({ kind: "draft", label: "Draft a task contract" }));
    w.power.update();
    expect(w.power.state.holding).toBe(false);
  });

  it("releases on battery where the person asked it to, and says so", () => {
    const w = hold({ settings: afk({ holdSleep: true, releaseOnBattery: true }), onBattery: true });
    w.jobs.push(job());
    w.power.update();
    expect(w.power.state.holding).toBe(false);
    expect(w.power.state.detail).toBe("Released on battery power.");
  });

  it("keeps holding on battery where the person did not ask it to release", () => {
    const w = hold({ settings: afk({ holdSleep: true, releaseOnBattery: false }), onBattery: true });
    w.jobs.push(job());
    w.power.update();
    expect(w.power.state.holding).toBe(true);
  });

  it("keeps the moment the hold started across updates, and says nothing twice", () => {
    const w = hold({ settings: afk({ holdSleep: true }) });
    w.jobs.push(job());
    w.power.update();
    const since = w.power.state.since;
    w.power.update();
    expect(w.power.state.since).toBe(since);
    expect(w.told).toHaveLength(1);
  });

  it("releases when the run has finished, and starts a fresh moment next time", () => {
    const w = hold({ settings: afk({ holdSleep: true }) });
    w.jobs.push(job());
    w.power.update();
    const since = w.power.state.since;
    w.jobs.splice(0);
    w.power.update();
    expect(w.power.state).toMatchObject({ holding: false, detail: null, since: null });
    w.jobs.push(job({ key: "PRB-2" }));
    w.power.update();
    // A fresh hold is a fresh moment, whether or not the clock has moved.
    expect(w.power.state.holding).toBe(true);
    expect(w.power.state.detail).toContain("PRB-2");
    expect(since).not.toBeNull();
    expect(w.told).toHaveLength(3);
  });
});
