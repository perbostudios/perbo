import { isLive } from "../shared/jobs.js";
import type { Changes } from "./changes.js";
import type { HostIO } from "./service.js";
import type { Job, PowerState, Settings } from "../shared/protocol.js";

export interface PowerDeps {
  io: HostIO;
  settings(): Settings;
  liveJobs(): Job[];
  changes: Pick<Changes, "power">;
}

/**
 * AFK mode (S6F): the machine is held awake only while a run or decision is
 * live, and only as the settings allow. Nothing is persisted — the hold is a
 * fact about this moment — and nothing is told where nothing changed.
 */
export class PowerHold {
  private readonly deps: PowerDeps;
  private held: PowerState = { holding: false, detail: null, since: null };

  constructor(deps: PowerDeps) {
    this.deps = deps;
  }

  get state(): PowerState {
    return this.held;
  }

  /** AFK mode (S6F): the machine is held awake only while a run or decision is live, and only as the settings allow. */
  update(): void {
    const afk = this.deps.settings().afk;
    // Every live run, since runs of different tickets go on at once (D-049).
    const running = this.deps.liveJobs().filter(
      (job) => ["run", "decide"].includes(job.kind) && isLive(job),
    );
    const onBattery = this.deps.io.onBattery?.() ?? false;
    const hold = Boolean(
      afk.holdSleep && running.length > 0 && !(afk.releaseOnBattery && onBattery),
    );
    const names = running.map((job) => job.key ?? "a run");
    const named =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    const detail = hold
      ? `Holding sleep now — ${named} ${names.length === 1 ? "is" : "are"} running.`
      : running.length > 0 && afk.holdSleep
        ? "Released on battery power."
        : null;
    if (hold === this.held.holding && detail === this.held.detail) return;
    this.held = {
      holding: hold,
      detail,
      since: hold
        ? this.held.holding
          ? this.held.since
          : new Date().toISOString()
        : null,
    };
    this.deps.io.holdSleep?.(hold, afk.displaySleep);
    this.deps.changes.power(this.held);
  }
}
