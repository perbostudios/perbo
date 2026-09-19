import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopService, type ServiceOptions } from "../src/host/service.js";
import { runProcess } from "../src/host/process.js";
import { SettingsSchema } from "../src/shared/protocol.js";
import type { Change, Draft, Job } from "../src/shared/protocol.js";

const temporary: string[] = [];
const services: DesktopService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture(process?: typeof runProcess) {
  const root = mkdtempSync(join(tmpdir(), "perbo-desktop-v2-"));
  temporary.push(root);
  const repo = join(root, "repository");
  mkdirSync(repo);
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Desktop Test"],
    ["config", "user.email", "desktop@example.invalid"],
    ["config", "commit.gpgsign", "false"],
  ])
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# Test repository\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "Initial test state"], {
    cwd: repo,
    stdio: "ignore",
  });
  const notifications: {
    title: string;
    body: string;
    silent: boolean | undefined;
  }[] = [];
  const holds: { hold: boolean; displaySleep: boolean }[] = [];
  const themes: string[] = [];
  const changes: Change[] = [];
  let onBattery = false;
  const options: ServiceOptions = {
    dataDirectory: join(root, "profile"),
    cliPath: resolve("../cli/dist/perbo.js"),
    nodeBinary: globalThis.process.execPath,
    version: "test",
    changed: (change) => {
      changes.push(change);
    },
    io: {
      chooseDirectory: async () => repo,
      openPath: async () => undefined,
      openExternal: async () => undefined,
      saveFile: async (): Promise<string | null> => null,
      notify: (title, body, extra) => {
        notifications.push({ title, body, silent: extra?.silent });
      },
      holdSleep: (hold, displaySleep) => {
        holds.push({ hold, displaySleep });
      },
      onBattery: () => onBattery,
      applyTheme: (theme) => {
        themes.push(theme);
      },
    },
    usageProbe: async () => ({
      plan: "Pro",
      windows: [
        { label: "Session · 5-hour window", usedPercent: 23, resetsAt: null },
      ],
      detail: "Injected.",
    }),
    ...(process ? { process } : {}),
  };
  const service = new DesktopService(options);
  services.push(service);
  return {
    repo,
    root,
    service,
    options,
    notifications,
    holds,
    themes,
    changes,
    setBattery: (value: boolean) => {
      onBattery = value;
    },
  };
}
const draft: Draft = {
  outcome: "Make errors actionable",
  criteria: [
    {
      text: "The user can retry",
      assertion: "The retry button is visible after failure",
      kind: "test",
    },
  ],
  paths: ["src/**", "test/**"],
  prohibited: [],
};
async function finished(service: DesktopService, id: string): Promise<Job> {
  for (let count = 0; count < 200; count++) {
    const job = (await service.snapshot()).jobs.find(
      (entry) => entry.id === id,
    )!;
    if (!["running", "stopping"].includes(job.state)) return job;
    await delay(20);
  }
  throw new Error("Desktop command did not settle");
}
function setTicketState(
  repo: string,
  key: string,
  state: string,
): { ticket_id: string } {
  const path = join(repo, ".perbo", "tickets", `${key}.json`);
  const ticket = JSON.parse(readFileSync(path, "utf8")) as {
    state: string;
    ticket_id: string;
  };
  ticket.state = state;
  writeFileSync(path, JSON.stringify(ticket, null, 2));
  return ticket;
}

describe("UI v2 host behaviour", () => {
  it("files already-finished tickets on the first listing, then archives and restores by hand as a preference", async () => {
    const { service, repo, options } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    await finished(
      service,
      (
        await service.request({
          kind: "admit",
          repoId: registered.id,
          draft: { ...draft, outcome: "A second outcome" },
        })
      ).id,
    );
    setTicketState(repo, "PRB-1", "merged");
    // A profile that predates the preference: the first complete listing files what had already finished.
    const profile = join(options.dataDirectory, "workspace.json");
    const stored = JSON.parse(readFileSync(profile, "utf8")) as Record<
      string,
      unknown
    >;
    delete stored["archived"];
    delete stored["archivedSeeded"];
    writeFileSync(profile, JSON.stringify(stored));
    await service.shutdown();
    const restarted = new DesktopService(options);
    services.push(restarted);
    const snapshot = await restarted.snapshot();
    expect(snapshot.archived).toEqual([registered.id + ":PRB-1"]);
    expect(snapshot.tasks.map((row) => row.ticket.key).sort()).toEqual([
      "PRB-1",
      "PRB-2",
    ]);
    setTicketState(repo, "PRB-2", "merged");
    expect((await restarted.snapshot()).archived).toEqual([
      registered.id + ":PRB-1",
    ]);
    await restarted.request({
      kind: "archive",
      repoId: registered.id,
      keys: ["PRB-2"],
      archived: true,
    });
    expect((await restarted.snapshot()).archived?.sort()).toEqual([
      registered.id + ":PRB-1",
      registered.id + ":PRB-2",
    ]);
    await restarted.request({
      kind: "archive",
      repoId: registered.id,
      keys: ["PRB-1"],
      archived: false,
    });
    expect((await restarted.snapshot()).archived).toEqual([
      registered.id + ":PRB-2",
    ]);
    await expect(
      restarted.request({
        kind: "archive",
        repoId: registered.id,
        keys: ["PRB-9"],
        archived: true,
      }),
    ).rejects.toThrow(/not in the repository/);
    const ticket = JSON.parse(
      readFileSync(join(repo, ".perbo", "tickets", "PRB-1.json"), "utf8"),
    ) as { state: string };
    expect(ticket.state).toBe("merged");
  });

  it("forgets a repository together with its tickets' titles, models and archive marks", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    await service.request({
      kind: "rename",
      repoId: registered.id,
      key: "PRB-1",
      title: "Renamed by hand",
    });
    setTicketState(repo, "PRB-1", "merged");
    await service.request({
      kind: "archive",
      repoId: registered.id,
      keys: ["PRB-1"],
      archived: true,
    });
    const before = await service.snapshot();
    expect(before.titles?.[registered.id + ":PRB-1"]).toBe("Renamed by hand");
    expect(before.archived).toEqual([registered.id + ":PRB-1"]);
    await service.request({ kind: "forgetRepository", repoId: registered.id });
    const after = await service.snapshot();
    expect(after.repositories).toEqual([]);
    expect(after.archived).toEqual([]);
    expect(Object.keys(after.titles ?? {})).toEqual([]);
    expect(
      Object.keys(after.taskModels ?? {}).filter((entry) =>
        entry.startsWith(registered.id + ":"),
      ),
    ).toEqual([]);
  });

  it("summarises a ticket from its retained attempts and reports the month's ledger with injected provider windows", async () => {
    const { service, repo } = fixture(async (binary, args, options) =>
      binary === "codex" || binary === "claude"
        ? {
            code: 0,
            stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }),
            stderr: "",
            cancelled: false,
          }
        : runProcess(binary, args, options),
    );
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    const empty = await service.request({
      kind: "taskSummary",
      repoId: registered.id,
      key: "PRB-1",
    });
    expect(empty).toEqual({
      branch: null,
      attempts: 0,
      latestAttemptAt: null,
      costMicros: null,
      costBasis: "none",
      diff: null,
      note: null,
    });
    const { ticket_id } = setTicketState(repo, "PRB-1", "merged");
    mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
    const now = new Date();
    const month =
      now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    writeFileSync(
      join(repo, ".perbo", "state", `${ticket_id}.attempts.json`),
      JSON.stringify({
        ticket_id,
        attempts: [
          {
            attempt_id: "att_1",
            branch: "ayo/prb-1",
            created_at: `${month}-02T10:00:00.000Z`,
            usage: { cost_micros: 1_250_000, wall_clock_ms: 10 },
            // D-096: the stop a run has by default, and the one the ledger and
            // the notification both count.
            termination: { reason: "stalled" },
          },
          {
            attempt_id: "att_2",
            branch: "ayo/prb-1",
            created_at: `${month}-03T10:00:00.000Z`,
            usage: { cost_micros: 750_000, wall_clock_ms: 10 },
            termination: { reason: "completed" },
          },
        ],
      }),
    );
    const summary = await service.request({
      kind: "taskSummary",
      repoId: registered.id,
      key: "PRB-1",
    });
    expect(summary).toMatchObject({
      branch: "ayo/prb-1",
      attempts: 2,
      costMicros: 2_000_000,
      costBasis: "priced",
      diff: null,
    });
    const usage = await service.request({ kind: "usage" });
    expect(usage.ledger).toEqual({
      month,
      spentMicros: 2_000_000,
      pricedAttempts: 2,
      unpricedAttempts: 0,
      ticketsRun: 1,
      ticketsMerged: 1,
      stoppedShort: 1,
      averageMergedMicros: 2_000_000,
    });
    expect(
      usage.providers.find((provider) => provider.id === "codex"),
    ).toMatchObject({
      plan: "Pro",
      windows: [{ usedPercent: 23 }],
      detail: "Injected.",
    });
    expect(
      usage.providers.find((provider) => provider.id === "claude")?.windows,
    ).toBeNull();
    expect(
      usage.providers.find((provider) => provider.id === "claude")?.detail,
    ).toMatch(/without spending a turn/);
    await expect(
      service.request({
        kind: "taskSummary",
        repoId: registered.id,
        key: "PRB-7",
      }),
    ).rejects.toThrow(/no longer in the repository/);
  });

  it("notifies on the recorded moment a person asked for, silently unless sound is on, and holds sleep only while a run is live", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "approve")
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      if (args[1] === "run") {
        options.onOutput?.("  worktree /tmp/w on ayo/prb-1 at 123\n");
        options.onOutput?.(
          "  worktree /tmp/w on ayo/prb-1 at 123\n  executing\n",
        );
        await Promise.race([
          held,
          new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          ),
        ]);
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      }
      return runProcess(binary, args, options);
    };
    const { service, repo, notifications, holds, changes, themes, setBattery } =
      fixture(runner);
    expect(themes).toEqual(["system"]);
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    const settings = SettingsSchema.parse({
      ...(await service.snapshot()).settings,
      notifyOn: { decision: true, review: true, ceiling: true, stage: true },
      notifySound: false,
      afk: { holdSleep: true, displaySleep: false, releaseOnBattery: true },
      theme: "dark",
    });
    await service.request({ kind: "saveSettings", settings });
    expect(themes.at(-1)).toBe("dark");
    const detail = await service.detail(registered.id, "PRB-1");
    const job = await service.request({
      kind: "run",
      repoId: registered.id,
      key: "PRB-1",
      digest: detail.digest,
      approve: true,
      publish: false,
      resumeFrom: null,
    });
    await vi.waitFor(() =>
      expect(holds.at(-1)).toEqual({ hold: true, displaySleep: false }),
    );
    expect((await service.snapshot()).power).toMatchObject({
      holding: true,
      detail: expect.stringContaining("PRB-1"),
    });
    expect(
      changes.some((change) => change.kind === "power" && change.power.holding),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(notifications.map((entry) => entry.title)).toEqual([
        "PRB-1 · Materialising the worktree",
        "PRB-1 · Working on the approved outcome",
      ]),
    );
    expect(notifications[0]?.silent).toBe(true);
    setBattery(true);
    service.powerChanged();
    expect(holds.at(-1)).toEqual({ hold: false, displaySleep: false });
    expect((await service.snapshot()).power).toMatchObject({
      holding: false,
      detail: "Released on battery power.",
    });
    setBattery(false);
    service.powerChanged();
    expect(holds.at(-1)).toEqual({ hold: true, displaySleep: false });
    setTicketState(repo, "PRB-1", "changes_requested");
    release();
    await finished(service, job.id);
    await vi.waitFor(() =>
      expect(notifications.at(-1)).toEqual({
        title: "PRB-1 needs a decision",
        body: "The loop is paused until you answer.",
        silent: true,
      }),
    );
    expect(holds.at(-1)).toEqual({ hold: false, displaySleep: false });
    expect((await service.snapshot()).power).toEqual({
      holding: false,
      detail: null,
      since: null,
    });
  });

  it("keeps an older profile's single notification switch meaning what it said", async () => {
    const { service, options } = fixture();
    await service.shutdown();
    const profile = join(options.dataDirectory, "workspace.json");
    const stored = JSON.parse(readFileSync(profile, "utf8")) as {
      settings: Record<string, unknown>;
    };
    delete stored.settings["notifyOn"];
    stored.settings["notifications"] = false;
    writeFileSync(profile, JSON.stringify(stored));
    const restarted = new DesktopService(options);
    services.push(restarted);
    expect((await restarted.snapshot()).settings.notifyOn).toEqual({
      decision: false,
      review: false,
      ceiling: false,
      stage: false,
    });
  });

  it("deletes only a contract that has never run, and refuses one with evidence", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    await finished(
      service,
      (
        await service.request({
          kind: "admit",
          repoId: registered.id,
          draft: { ...draft, outcome: "Second" },
        })
      ).id,
    );
    await service.request({
      kind: "rename",
      repoId: registered.id,
      key: "PRB-1",
      title: "Renamed",
    });
    const { ticket_id } = setTicketState(repo, "PRB-2", "plan_review");
    mkdirSync(join(repo, ".perbo", "state"), { recursive: true });
    writeFileSync(
      join(repo, ".perbo", "state", `${ticket_id}.attempts.json`),
      JSON.stringify({ ticket_id, attempts: [{ attempt_id: "att_1" }] }),
    );
    await expect(
      service.request({ kind: "discard", repoId: registered.id, key: "PRB-2" }),
    ).rejects.toThrow(/recorded attempts/);
    await service.request({
      kind: "discard",
      repoId: registered.id,
      key: "PRB-1",
    });
    const snapshot = await service.snapshot();
    expect(snapshot.tasks.map((row) => row.ticket.key)).toEqual(["PRB-2"]);
    expect(snapshot.titles).toEqual({});
    for (const suffix of [".json", ".contract.json", ".draft.json"])
      expect(
        existsSync(join(repo, ".perbo", "tickets", "PRB-1" + suffix)),
      ).toBe(false);
    await expect(
      service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" }),
    ).rejects.toThrow(/no longer/);
  });

  it("opens the terminal on the provider's fixed sign-in command, and names the command where it cannot", async () => {
    const opened: string[][] = [];
    const { service, options } = fixture();
    options.io.openTerminal = async (command) => {
      opened.push([...command]);
    };
    await service.request({ kind: "login", provider: "claude" });
    await service.request({ kind: "login", provider: "codex" });
    expect(opened).toEqual([
      ["claude", "auth", "login"],
      ["codex", "login"],
    ]);
    delete options.io.openTerminal;
    await expect(
      service.request({ kind: "login", provider: "codex" }),
    ).rejects.toThrow(/Run codex login in your terminal/);
  });

  it("opens the worktree on the branch a ticket already has, whatever its key would derive", async () => {
    const { service, repo, root, options } = fixture();
    const registered = await service.registerRepository(repo);
    await finished(
      service,
      (await service.request({ kind: "admit", repoId: registered.id, draft }))
        .id,
    );
    // The branch the ticket's pull request is on: `ayo/`, which PRB-1's key
    // does not derive.
    const path = join(repo, ".perbo", "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(path, "utf8")) as {
      ticket_id: string;
      delivery: { branch: string | null };
    };
    const recorded = `ayo/${ticket.ticket_id.replace(/^ticket_/, "")}/make-errors-actionable`;
    ticket.delivery.branch = recorded;
    writeFileSync(path, JSON.stringify(ticket, null, 2));
    const worktree = join(root, "worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", recorded, worktree], {
      cwd: repo,
      stdio: "ignore",
    });
    const opened: string[] = [];
    options.io.openPath = async (target) => {
      opened.push(target);
    };
    await service.request({
      kind: "openWorktree",
      repoId: registered.id,
      key: "PRB-1",
    });
    expect(opened).toEqual([realpathSync(worktree)]);
  });
});

describe("planning beside a run (SCP-335)", () => {
  /**
   * A process double over the real CLI: `run` and, once `holdAdmit` is set,
   * `admit` stay in flight until released or aborted. `reached` resolves when a
   * held `admit` is actually inside the CLI call, so a test can act on a
   * command that has started rather than one that is only registered.
   */
  function held() {
    const aborted: string[] = [];
    let releaseRun!: () => void, releaseAdmit!: () => void, reached!: () => void;
    const run = new Promise<void>((resolve) => { releaseRun = resolve; });
    const admit = new Promise<void>((resolve) => { releaseAdmit = resolve; });
    const inAdmit = new Promise<void>((resolve) => { reached = resolve; });
    let holdAdmit = false;
    let holdListAfterRun = false, runReturned = false, releaseList!: () => void, listReached!: () => void;
    const list = new Promise<void>((resolve) => { releaseList = resolve; });
    const inList = new Promise<void>((resolve) => { listReached = resolve; });
    const wait = async (
      until: Promise<void>,
      name: string,
      signal: AbortSignal | undefined,
    ): Promise<boolean> => {
      await Promise.race([
        until,
        new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (!signal?.aborted) return false;
      aborted.push(name);
      return true;
    };
    const runner: typeof runProcess = async (binary, args, options) => {
      if (args[1] === "approve")
        return { code: 0, stdout: "{}", stderr: "", cancelled: false };
      if (args[1] === "run") {
        const stopped = await wait(run, "run", options.signal);
        runReturned = true;
        return { code: 0, stdout: "{}", stderr: "", cancelled: stopped };
      }
      // The receipt of a finished run reads the store; holding that read keeps
      // the finished job tracked, which is the window a stop must not reach it in.
      if (holdListAfterRun && runReturned && args[1] === "list") {
        holdListAfterRun = false;
        listReached();
        await list;
      }
      if (holdAdmit && args[1] === "admit") {
        reached();
        if (await wait(admit, "admit", options.signal))
          return { code: 130, stdout: "", stderr: "", cancelled: true };
      }
      return runProcess(binary, args, options);
    };
    return {
      runner,
      aborted,
      inAdmit,
      holdAdmit: () => { holdAdmit = true; },
      holdListAfterRun: () => { holdListAfterRun = true; },
      inList,
      release: () => { releaseRun(); releaseAdmit(); releaseList(); },
    };
  }
  async function runInFlight(service: DesktopService, repoId: string) {
    await finished(
      service,
      (await service.request({ kind: "admit", repoId, draft })).id,
    );
    const detail = await service.detail(repoId, "PRB-1");
    return service.request({
      kind: "run",
      repoId,
      key: "PRB-1",
      digest: detail.digest,
      approve: true,
      publish: false,
      resumeFrom: null,
    });
  }

  it("admits and edits beside a live run, and refuses another exclusive command by name", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const run = await runInFlight(service, registered.id);

    const admitted = await finished(
      service,
      (
        await service.request({
          kind: "admit",
          repoId: registered.id,
          draft: { ...draft, outcome: "A second outcome, planned beside it" },
        })
      ).id,
    );
    expect(admitted.state).toBe("completed");
    expect(admitted.resultKey).toBe("PRB-2");
    const second = await service.detail(registered.id, "PRB-2");
    const edited = await finished(
      service,
      (
        await service.request({
          kind: "edit",
          repoId: registered.id,
          key: "PRB-2",
          digest: second.digest,
          draft: { ...draft, outcome: "A second outcome, edited beside it" },
        })
      ).id,
    );
    expect(edited.state).toBe("completed");

    for (const request of [
      {
        kind: "run" as const,
        repoId: registered.id,
        key: "PRB-2",
        digest: second.digest,
        approve: true,
        publish: false,
        resumeFrom: null,
      },
      {
        kind: "decide" as const,
        repoId: registered.id,
        key: "PRB-1",
        digest: second.digest,
        answer: "Take the smaller change.",
      },
      { kind: "sync" as const, repoId: registered.id, key: "PRB-1" },
      { kind: "doctor" as const, repoId: registered.id, writeConfig: false },
      {
        kind: "principle" as const,
        repoId: registered.id,
        key: "PRB-1",
        answer: "Prefer the smaller change.",
      },
    ])
      await expect(service.request(request)).rejects.toThrow(
        "Run engineering loop is already running. Wait for it to finish or stop it before starting this one.",
      );

    expect(
      (await service.snapshot()).jobs.find((job) => job.id === run.id)?.state,
    ).toBe("running");
    holder.release();
    const ran = await finished(service, run.id);
    expect(ran.state).toBe("completed");
    expect(ran.error).toBeNull();
    expect(ran.key).toBe("PRB-1");
  });

  it("stops the job it is named and leaves the other lane running", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const run = await runInFlight(service, registered.id);
    holder.holdAdmit();
    const planning = await service.request({
      kind: "admit",
      repoId: registered.id,
      draft: { ...draft, outcome: "Planned while the loop runs" },
    });
    await holder.inAdmit;

    await service.request({ kind: "cancel", jobId: planning.id });
    expect((await finished(service, planning.id)).state).toBe("cancelled");
    expect(
      (await service.snapshot()).jobs.find((job) => job.id === run.id)?.state,
    ).toBe("running");

    await service.request({ kind: "cancel", jobId: run.id });
    expect((await finished(service, run.id)).state).toBe("cancelled");
    holder.release();
  });

  it("lands two drafts in flight on their own editing sessions", async () => {
    const { service, repo } = fixture();
    const registered = await service.registerRepository(repo);
    const start = async (outcome: string) => {
      const opened = await service.request({
        kind: "editingOpen",
        target: { kind: "fresh", repoId: registered.id },
      });
      const saved = await service.request({
        kind: "editingSave",
        id: opened.id,
        revision: opened.revision,
        repoId: registered.id,
        form: { ...opened.form, draft: { ...draft, outcome }, step: 2 },
      });
      return {
        id: saved.id,
        revision: saved.revision,
        operationId: randomUUID(),
        outcome,
      };
    };
    const sessions = [
      await start("The first person's own outcome"),
      await start("The second person's own outcome"),
    ];
    const submitted = await Promise.all(
      sessions.map((session) =>
        service.request({
          kind: "editingSubmit",
          id: session.id,
          revision: session.revision,
          operationId: session.operationId,
          intent: "compile",
        }),
      ),
    );
    // Neither submission was refused: both are in flight at once.
    expect(submitted.map((session) => session.operation?.state)).toEqual([
      "running",
      "running",
    ]);
    await Promise.all(
      submitted.map((session) => finished(service, session.operation!.jobId!)),
    );
    const landed = await Promise.all(
      sessions.map((session) =>
        service.request({ kind: "editingRead", id: session.id }),
      ),
    );
    expect(landed.map((session) => session.operation?.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(
      landed.map((session) => session.operation?.resultKey).sort(),
    ).toEqual(["PRB-1", "PRB-2"]);
    for (const [index, session] of landed.entries()) {
      const own = sessions[index]!;
      expect(session.operation?.id).toBe(own.operationId);
      expect(session.key).toBe(session.operation?.resultKey);
      expect(session.form.draft.outcome).toBe(own.outcome);
      expect(
        (await service.detail(registered.id, session.key!)).contract.outcome,
      ).toBe(own.outcome);
    }
  });

  it("holds a contract's deletion for the commands running in its repository, and not for another's", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const other = join(dirname(repo), "other repository");
    mkdirSync(other);
    for (const args of [["init", "--initial-branch=main"], ["config", "user.name", "Desktop Test"], ["config", "user.email", "desktop@example.invalid"], ["config", "commit.gpgsign", "false"]])
      execFileSync("git", args, { cwd: other, stdio: "ignore" });
    writeFileSync(join(other, "README.md"), "# Other\n");
    execFileSync("git", ["add", "README.md"], { cwd: other });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd: other, stdio: "ignore" });
    const second = await service.registerRepository(other);
    await finished(service, (await service.request({ kind: "admit", repoId: registered.id, draft })).id);
    await finished(service, (await service.request({ kind: "admit", repoId: second.id, draft })).id);

    holder.holdAdmit();
    const planning = await service.request({
      kind: "admit",
      repoId: second.id,
      draft: { ...draft, outcome: "Planned in the other repository" },
    });
    await holder.inAdmit;
    // A draft in the other repository holds nothing here.
    await service.request({ kind: "discard", repoId: registered.id, key: "PRB-1" });
    // One in the same repository holds its contracts and its disconnection.
    await expect(service.request({ kind: "discard", repoId: second.id, key: "PRB-1" })).rejects.toThrow(
      "Wait for the commands running in this repository to finish before deleting a contract.",
    );
    await expect(service.request({ kind: "forgetRepository", repoId: second.id })).rejects.toThrow(
      "Wait for the commands running in this repository to finish before disconnecting it.",
    );
    await service.request({ kind: "cancel", jobId: planning.id });
    await finished(service, planning.id);
    holder.release();
  });

  it("refuses to stop a job that has finished while its receipt is still being saved", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const run = await runInFlight(service, registered.id);
    holder.holdListAfterRun();
    holder.release();
    await holder.inList;
    // The run's process has returned and its job is finished, but its receipt
    // is still being written, so it is still tracked.
    await expect(service.request({ kind: "cancel", jobId: run.id })).rejects.toThrow(
      "That command is no longer active.",
    );
    holder.release();
    const settled = await finished(service, run.id);
    expect(settled.state).toBe("completed");
    // Nothing is left in the way: the lane is free once the receipt is saved.
    const snapshot = await service.snapshot();
    expect(snapshot.jobs.filter((job) => ["running", "stopping"].includes(job.state))).toEqual([]);
  });

  it("aborts and awaits every active job on shutdown", async () => {
    const holder = held();
    const { service, repo } = fixture(holder.runner);
    const registered = await service.registerRepository(repo);
    const run = await runInFlight(service, registered.id);
    holder.holdAdmit();
    const planning = await service.request({
      kind: "admit",
      repoId: registered.id,
      draft: { ...draft, outcome: "Planned while the loop runs" },
    });
    await holder.inAdmit;
    await service.shutdown();
    expect([...holder.aborted].sort()).toEqual(["admit", "run"]);
    const jobs = (await service.snapshot()).jobs;
    for (const id of [run.id, planning.id])
      expect(jobs.find((job) => job.id === id)?.state).toBe("cancelled");
    holder.release();
  });
});
