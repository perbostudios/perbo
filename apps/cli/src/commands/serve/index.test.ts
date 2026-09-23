import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES, TicketSchema, transition, withReconciliation, type Ticket, type TicketState } from "@perbo/contracts";
import { acquireServeLock } from "@perbo/runner";
import { UsageError } from "../../usage-error.js";
import { admitCommandLine } from "../admit.js";
import { ServeTickSchema, processDeps, serveCommandLine, type ServeDeps } from "./index.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { readEndpoint } from "../../endpoint/index.js";
import { SPAWN_TEST_TIMEOUT_MS, gitEnvironment, initRepository } from "@perbo/test-support";
import { readTicket, storeDir, writeTicket } from "../../store/tickets.js";
import { recordStreams } from "../../test-support/streams.js";
import { emptyRepository } from "../../test-support/repository.js";

/**
 * `perbo serve` (SCP-008 criterion 5, SCP-227): the queue over one store.
 *
 * Every process it would start is a fake here — the run it spawns, the fetch,
 * the sync, the diff of a sealed branch — and each fake records what it was
 * asked, so a test reads the queue's decisions rather than a coding agent's.
 * The tickets are real: admitted through `perbo admit` into a real store in a
 * real git repository, because the queue reads exactly what a person's store
 * holds and a hand-built record would be a second opinion about its shape.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-serve-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let repos = 0;
function repository(config: Record<string, unknown> = {}): string {
  const dir = join(scratch, `repo-${repos++}`);
  mkdirSync(dir, { recursive: true });
  emptyRepository(dir);
  mkdirSync(join(dir, ".perbo"), { recursive: true });
  writeFileSync(join(dir, ".perbo", "config.json"), JSON.stringify({ base_ref: "main", ...config }, null, 2));
  return dir;
}

/** Admit and approve one ticket, typed, so no model is involved. Returns its key. */
function admitted(
  repo: string,
  input: { outcome: string; paths: string[]; dependsOn?: string[]; priority?: string; generated?: string[] },
): string {
  const streams = recordStreams();
  const argv = [
    "--repo", repo,
    "--outcome", input.outcome,
    "--criterion", `${input.outcome} :: a test asserts it`,
    ...input.paths.flatMap((path) => ["--path", path]),
    ...(input.generated ?? []).flatMap((glob) => ["--generated", glob]),
    ...(input.dependsOn ?? []).flatMap((key) => ["--depends-on", key]),
    ...(input.priority ? ["--priority", input.priority] : []),
    "--approve",
    "--json",
  ];
  const code = runCommandLine(admitCommandLine, { argv: argv, streams, cwd: repo });
  if (code !== EXIT_CODES.approve) throw new Error(`admit failed: ${streams.err()}`);
  const document = streams.json<{ ticket: { key: string } }>();
  return document.ticket.key;
}

/** Walk a stored ticket along a path of states, so its record reads like a run's. */
function walk(repo: string, key: string, path: TicketState[]): Ticket {
  const dir = storeDir(repo);
  let ticket = readTicket(dir, key);
  for (const state of path) ticket = transition(ticket, state, `test walk to ${state}`);
  writeTicket(dir, ticket);
  return ticket;
}

const TO_PR_OPEN: TicketState[] = ["provisioning", "executing", "verifying", "independent_review", "pr_open"];

interface Fakes {
  spawned: string[];
  fetched: string[];
  synced: Array<{ key: string; merge: boolean }>;
  listed: Array<{ repository: string; label: string }>;
  drafted: string[];
  deps: ServeDeps;
}

function fakes(overrides: Partial<ServeDeps> = {}): Fakes {
  const spawned: string[] = [];
  const fetched: string[] = [];
  const synced: Array<{ key: string; merge: boolean }> = [];
  const listed: Array<{ repository: string; label: string }> = [];
  const drafted: string[] = [];
  const deps: ServeDeps = {
    spawnRun: async ({ key }) => {
      spawned.push(key);
      return { code: 0 };
    },
    fetchBase: async ({ base_ref }) => {
      fetched.push(base_ref);
      return { ok: true, detail: `fetched ${base_ref}` };
    },
    sync: async ({ key, merge }) => {
      synced.push({ key, merge });
      return EXIT_CODES.approve;
    },
    sealedPaths: async () => null,
    liveRuns: () => [],
    baseState: async () => null,
    listIssues: async (input) => {
      listed.push(input);
      return { ok: true, issues: [] };
    },
    draft: async ({ reference }) => {
      drafted.push(reference);
      return { code: 0, key: null };
    },
    sleep: async () => {},
    ...overrides,
  };
  return { spawned, fetched, synced, listed, drafted, deps };
}

/** The input one line means, which is what the assertions below are about. */
const serveLine = (argv: readonly string[]) => serveCommandLine.read(argv).input;

/** The one moment every queue here is asked to run at, so a record's dates are the test's. */
const AT = new Date("2026-09-10T12:00:00.000Z");

async function serveOnce(repo: string, deps: ServeDeps, extra: string[] = [], paused = false) {
  const streams = recordStreams();
  const code = await runCommandLine(serveCommandLine, {
    argv: ["--repo", repo, "--once", ...extra],
    streams,
    cwd: repo,
    now: AT,
    deps: { processes: deps, clock: () => AT, paused },
  });
  return { code, streams };
}

describe("the line a queue is asked for by", () => {
  it("refuses an unknown flag and a non-numeric interval", () => {
    expect(() => serveLine(["--repo", ".", "--forever"])).toThrow(UsageError);
    expect(() => serveLine(["--interval", "soon"])).toThrow(UsageError);
    expect(() => serveLine(["--interval", "0"])).toThrow(UsageError);
  });

  it("defaults to a minute between ticks, no publish, and running until stopped", () => {
    expect(serveLine([])).toEqual({
      repo: ".",
      store: null,
      publish: false,
      once: false,
      intervalMs: 60_000,
      json: false,
      noEndpoint: false,
    });
    expect(serveLine(["--interval", "5s", "--publish", "--once", "--json"])).toMatchObject({
      publish: true,
      once: true,
      intervalMs: 5_000,
      json: true,
    });
    expect(serveLine(["--interval", "2m"]).intervalMs).toBe(120_000);
    expect(serveLine(["--interval", "1500"]).intervalMs).toBe(1500);
  });
});

describe("perbo serve --once", () => {
  it("fetches the base once, then starts the ready tickets in queue order up to the ceiling", async () => {
    const repo = repository({ limits: { organisation: "t", limits: { concurrent_local_attempts: 2 } } });
    const first = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const second = admitted(repo, { outcome: "The CLI prints a version.", paths: ["apps/cli/**"] });
    const third = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"] });
    const f = fakes();

    const { code, streams } = await serveOnce(repo, f.deps);

    expect(code).toBe(EXIT_CODES.approve);
    expect(f.fetched).toEqual(["main"]);
    expect(f.spawned).toEqual([first, second]);
    expect(f.synced).toEqual([]);
    // Capacity, not a wait: the third is still ready, waits on nothing, and
    // was not rewritten to say so — its record already said it.
    const left = readTicket(storeDir(repo), third);
    expect(left.state).toBe("ready");
    expect(left.scheduling).toEqual({ waits_on: [], decided_at: null, reconciliation: null });
    expect(streams.err()).toContain(`started ${first}`);
    expect(streams.err()).toContain(`started ${second}`);
  });

  it("starts one at a time by default, and counts a run it did not start", async () => {
    const repo = repository();
    const first = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    admitted(repo, { outcome: "The CLI prints a version.", paths: ["apps/cli/**"] });
    const alone = fakes();
    await serveOnce(repo, alone.deps);
    expect(alone.spawned).toEqual([first]);

    const busy = fakes({ liveRuns: () => [{ ticket_key: "AYO-99" }] });
    await serveOnce(repo, busy.deps);
    expect(busy.spawned).toEqual([]);
  });

  it("starts nothing and asks nobody to merge while paused, but still syncs what is open", async () => {
    const repo = repository({ merge: "loop", limits: { organisation: "t", limits: { concurrent_local_attempts: 2 } } });
    const open = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    admitted(repo, { outcome: "The CLI prints a version.", paths: ["apps/cli/**"] });
    walk(repo, open, TO_PR_OPEN);
    // The open branch is behind the base, so an unpaused queue would re-level it.
    const f = fakes({ baseState: async () => ({ tip: "a".repeat(40), behind: true }) });
    const { code, streams } = await serveOnce(repo, f.deps, ["--publish"], true);
    expect(code).toBe(EXIT_CODES.approve);
    expect(f.spawned).toEqual([]);
    // The open pull request is still read, so a merge by hand is seen; the
    // queue itself asks for none.
    expect(f.synced).toEqual([{ key: open, merge: false }]);
    expect(streams.err()).not.toContain("started ");
  });

  it("hosts the endpoint for the tick and removes its record when it stops, and writes none under --no-endpoint", async () => {
    const repo = repository();
    admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const dir = storeDir(repo);
    let during: ReturnType<typeof readEndpoint> = null;
    const f = fakes({
      liveRuns: () => {
        during = readEndpoint(dir);
        return [];
      },
    });
    await serveOnce(repo, f.deps);
    expect(during).not.toBeNull();
    expect(readEndpoint(dir)).toBeNull();

    during = null;
    const none = fakes({
      liveRuns: () => {
        during = readEndpoint(dir);
        return [];
      },
    });
    await serveOnce(repo, none.deps, ["--no-endpoint"]);
    expect(during).toBeNull();
  });

  it("hands the run the store and the publish flag it was given", async () => {
    const repo = repository();
    const key = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const argvs: string[][] = [];
    const f = fakes({
      spawnRun: async ({ argv }) => {
        argvs.push(argv);
        return { code: 0 };
      },
    });
    await serveOnce(repo, f.deps, ["--publish"]);
    expect(argvs).toEqual([["run", "--ticket", key, "--repo", repo, "--publish"]]);
  });

  it("blocks a ticket whose scope overlaps one ahead of it, and frees it when that one merges", async () => {
    const repo = repository();
    const first = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"] });
    const second = admitted(repo, { outcome: "Every package lints.", paths: ["packages/**"] });
    const dir = storeDir(repo);

    const f = fakes();
    await serveOnce(repo, f.deps);
    expect(f.spawned).toEqual([first]);
    const blocked = readTicket(dir, second);
    expect(blocked.state).toBe("blocked");
    expect(blocked.scheduling.waits_on).toEqual([
      { key: first, reason: "scope_overlap", paths: ["packages/runner/**"], state: "ready" },
    ]);
    expect(blocked.history[blocked.history.length - 1]).toMatchObject({
      from: "ready",
      to: "blocked",
      note: `waits on ${first} (scope overlap: packages/runner/**)`,
    });

    walk(repo, first, [...TO_PR_OPEN, "merged"]);
    const again = fakes();
    await serveOnce(repo, again.deps);
    const freed = readTicket(dir, second);
    // Ready, not provisioning: the fake run moves nothing, and the real one
    // moves the ticket itself.
    expect(freed.state).toBe("ready");
    expect(freed.history.map((row) => `${row.from}->${row.to}`)).toContain("blocked->ready");
    expect(freed.history.find((row) => row.to === "ready" && row.from === "blocked")?.note).toBe(
      `${first} merged`,
    );
    expect(again.spawned).toEqual([second]);
  });

  it("blocks a ticket on an unmerged dependency, naming its state, and on one the store does not hold", async () => {
    const repo = repository({ limits: { organisation: "t", limits: { concurrent_local_attempts: 3 } } });
    const dep = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const waiting = admitted(repo, { outcome: "The CLI prints a version.", paths: ["apps/**"], dependsOn: [dep] });
    const orphan = admitted(repo, { outcome: "The runner counts.", paths: ["packages/**"], dependsOn: ["AYO-404"] });
    walk(repo, dep, ["provisioning", "executing"]);

    const f = fakes({ liveRuns: () => [{ ticket_key: "AYO-99" }] });
    await serveOnce(repo, f.deps);

    const dir = storeDir(repo);
    expect(readTicket(dir, waiting).scheduling.waits_on).toEqual([
      { key: dep, reason: "depends_on", paths: [], state: "executing" },
    ]);
    expect(readTicket(dir, waiting).state).toBe("blocked");
    expect(readTicket(dir, orphan).scheduling.waits_on).toEqual([
      { key: "AYO-404", reason: "depends_on", paths: [], state: null },
    ]);
    expect(f.spawned).toEqual([]);
  });

  it("judges a sealed ticket ahead by the paths it changed, not its globs", async () => {
    const repo = repository();
    const sealed = admitted(repo, { outcome: "Every package lints.", paths: ["packages/**"], generated: ["**/pnpm-lock.yaml"] });
    const behind = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"] });
    walk(repo, sealed, TO_PR_OPEN);

    const asked: string[] = [];
    const disjoint = fakes({
      sealedPaths: async ({ branch }) => {
        asked.push(branch);
        return ["packages/review/src/prompt.ts", "pnpm-lock.yaml"];
      },
    });
    await serveOnce(repo, disjoint.deps);
    expect(asked.length).toBe(1);
    expect(disjoint.spawned).toEqual([behind]);

    const touching = fakes({ sealedPaths: async () => ["packages/runner/src/loop.ts"] });
    await serveOnce(repo, touching.deps);
    expect(touching.spawned).toEqual([]);
    expect(readTicket(storeDir(repo), behind).scheduling.waits_on).toEqual([
      { key: sealed, reason: "scope_overlap", paths: ["packages/runner/src/loop.ts"], state: "pr_open" },
    ]);
  });

  it("syncs every open pull request, merging only the first in order and only under merge: loop", async () => {
    const person = repository();
    const a = admitted(person, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const b = admitted(person, { outcome: "The CLI prints a version.", paths: ["apps/**"] });
    walk(person, a, TO_PR_OPEN);
    walk(person, b, TO_PR_OPEN);
    const hand = fakes();
    await serveOnce(person, hand.deps);
    expect(hand.synced).toEqual([
      { key: a, merge: false },
      { key: b, merge: false },
    ]);

    const loop = repository({ merge: "loop" });
    const c = admitted(loop, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const d = admitted(loop, { outcome: "The CLI prints a version.", paths: ["apps/**"] });
    walk(loop, c, TO_PR_OPEN);
    walk(loop, d, TO_PR_OPEN);
    const queue = fakes();
    await serveOnce(loop, queue.deps);
    expect(queue.synced).toEqual([
      { key: c, merge: true },
      { key: d, merge: false },
    ]);
  });

  it("reconciles a stranded ticket no run is inside, and leaves one a live run holds", async () => {
    const repo = repository();
    const stranded = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const running = admitted(repo, { outcome: "The CLI prints a version.", paths: ["apps/**"] });
    walk(repo, stranded, ["provisioning", "executing"]);
    const held = walk(repo, running, ["provisioning", "executing"]);
    const f = fakes({ liveRuns: () => [{ ticket_key: held.key }] });
    await serveOnce(repo, f.deps);
    expect(f.synced).toEqual([{ key: stranded, merge: false }]);
  });

  it("goes on when the fetch fails, and says so once", async () => {
    const repo = repository();
    const key = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const f = fakes({ fetchBase: async () => ({ ok: false, detail: "fatal: 'origin' does not appear to be a git repository" }) });
    const { code, streams } = await serveOnce(repo, f.deps);
    expect(code).toBe(EXIT_CODES.approve);
    expect(f.spawned).toEqual([key]);
    expect(streams.err()).toContain("fetch of main failed");
  });

  it("refuses to run beside another queue over the same store", async () => {
    const repo = repository();
    admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const held = acquireServeLock({
      state_root: join(storeDir(repo), "state"),
      repository_root: repo,
      now: new Date(),
    });
    try {
      const f = fakes();
      const { code, streams } = await serveOnce(repo, f.deps);
      expect(code).toBe(EXIT_CODES.usage_or_input_error);
      expect(streams.err()).toContain(String(process.pid));
      expect(f.spawned).toEqual([]);
    } finally {
      held.release();
    }
  });

  it("refuses before anything runs when the base cannot be named", async () => {
    const repo = repository();
    writeFileSync(join(repo, ".perbo", "config.json"), JSON.stringify({ base_ref: "  " }));
    admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const f = fakes();
    const { code, streams } = await serveOnce(repo, f.deps);
    expect(code).toBe(EXIT_CODES.usage_or_input_error);
    expect(streams.err()).toContain("base_ref");
    expect(f.fetched).toEqual([]);
    expect(f.spawned).toEqual([]);
  });

  it("starts nothing while a kill switch is engaged, and says which", async () => {
    const repo = repository({
      limits: { organisation: "t", limits: {}, kill_switches: { organisation_automation_disabled: true } },
    });
    admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const f = fakes();
    const { code, streams } = await serveOnce(repo, f.deps);
    expect(code).toBe(EXIT_CODES.approve);
    expect(f.spawned).toEqual([]);
    expect(streams.err()).toContain("automation is disabled");
  });

  it("rewrites a ticket only when its reading changed", async () => {
    const repo = repository();
    admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"] });
    const second = admitted(repo, { outcome: "Every package lints.", paths: ["packages/**"] });
    const dir = storeDir(repo);
    await serveOnce(repo, fakes().deps);
    const first = readTicket(dir, second);
    expect(first.state).toBe("blocked");
    const before = statSync(join(dir, "tickets", `${second}.json`)).mtimeMs;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await serveOnce(repo, fakes().deps);
    expect(statSync(join(dir, "tickets", `${second}.json`)).mtimeMs).toBe(before);
    expect(readTicket(dir, second)).toEqual(first);
  });

  it("leaves a ready ticket a run is inside to that run, even one the queue would block", async () => {
    const repo = repository({ limits: { organisation: "t", limits: { concurrent_local_attempts: 3 } } });
    const dep = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    walk(repo, dep, ["provisioning", "executing"]);
    // Depends on an unmerged ticket, so the queue would block it — but a run
    // holds it while its record still says ready: the window between the
    // run's read and its first write.
    const held = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"], dependsOn: [dep] });
    const behind = admitted(repo, { outcome: "Every package lints.", paths: ["packages/**"] });
    const dir = storeDir(repo);
    const f = fakes({ liveRuns: () => [{ ticket_key: dep }, { ticket_key: held }] });
    await serveOnce(repo, f.deps);
    const untouched = readTicket(dir, held);
    expect(untouched.state).toBe("ready");
    expect(untouched.scheduling).toEqual({ waits_on: [], decided_at: null, reconciliation: null });
    expect(f.spawned).toEqual([]);
    // It still holds its place: the ticket behind it waits on it.
    expect(readTicket(dir, behind).state).toBe("blocked");
  });

  it("reads the live runs again before deciding, so a run started mid-tick keeps its ticket", async () => {
    const repo = repository();
    const dep = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    walk(repo, dep, ["provisioning", "executing"]);
    const held = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"], dependsOn: [dep] });
    const dir = storeDir(repo);
    // Nobody at the start of the tick; the run appears by the time the queue decides.
    let reads = 0;
    const f = fakes({
      liveRuns: () => (reads++ === 0 ? [{ ticket_key: dep }] : [{ ticket_key: dep }, { ticket_key: held }]),
    });
    await serveOnce(repo, f.deps);
    expect(readTicket(dir, held).state).toBe("ready");
    expect(readTicket(dir, held).scheduling.waits_on).toEqual([]);
  });

  it("reads the live runs once more before starting, so a run begun during the git reads is not started twice", async () => {
    const repo = repository({ limits: { organisation: "t", limits: { concurrent_local_attempts: 2 } } });
    const open = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const next = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"] });
    walk(repo, open, TO_PR_OPEN);
    // Nobody until the sealed-path read; then a hand run holds the next ticket.
    let handRun = false;
    const f = fakes({
      sealedPaths: async () => {
        handRun = true;
        return null;
      },
      liveRuns: () => (handRun ? [{ ticket_key: next }] : []),
    });
    await serveOnce(repo, f.deps);
    expect(f.spawned).toEqual([]);
  });

  it("does not write over a ticket a run moved between the read and the write", async () => {
    const repo = repository();
    const dep = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    walk(repo, dep, ["provisioning", "executing"]);
    const held = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"], dependsOn: [dep] });
    const dir = storeDir(repo);
    // The run writes `provisioning` while the queue is computing sealed paths.
    const f = fakes({
      liveRuns: () => [{ ticket_key: dep }],
      sealedPaths: async () => {
        walk(repo, held, ["provisioning"]);
        return null;
      },
    });
    walk(repo, dep, ["verifying", "independent_review", "pr_open"]);
    const { streams } = await serveOnce(repo, f.deps);
    expect(readTicket(dir, held).state).toBe("provisioning");
    expect(streams.err()).toContain(`${held} moved to provisioning while the queue was deciding`);
  });

  it("orders a dependency before the ticket that names it, whatever their priority", async () => {
    const repo = repository({ limits: { organisation: "t", limits: { concurrent_local_attempts: 2 } } });
    const low = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"] });
    const high = admitted(repo, { outcome: "Every package lints.", paths: ["packages/**"], dependsOn: [low], priority: "high" });
    const dir = storeDir(repo);
    const f = fakes();
    await serveOnce(repo, f.deps);
    // The low one goes first; the high one waits on it and only on it.
    expect(f.spawned).toEqual([low]);
    expect(readTicket(dir, high).scheduling.waits_on).toEqual([
      { key: low, reason: "depends_on", paths: [], state: "ready" },
    ]);
    expect(readTicket(dir, low).state).toBe("ready");
  });

  it("re-levels an open branch behind the base before starting new work, and only when it may push", async () => {
    const repo = repository();
    const open = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const next = admitted(repo, { outcome: "The CLI prints a version.", paths: ["apps/**"] });
    walk(repo, open, TO_PR_OPEN);
    const TIP = "a".repeat(40);
    const argvs: string[][] = [];
    const publishing = fakes({
      baseState: async () => ({ tip: TIP, behind: true }),
      spawnRun: async ({ argv }) => {
        argvs.push(argv);
        return { code: 0 };
      },
    });
    const { streams } = await serveOnce(repo, publishing.deps, ["--publish", "--json"]);
    // The re-level takes the one place; the new ticket waits for the next tick.
    expect(argvs).toEqual([["run", "--ticket", open, "--relevel", "--repo", repo, "--publish"]]);
    const tick = ServeTickSchema.parse(JSON.parse(streams.out().trim()));
    expect(tick.relevelled).toEqual([open]);
    expect(tick.started).toEqual([]);
    expect(readTicket(storeDir(repo), open).scheduling.reconciliation).toBeNull();

    const hand = fakes({ baseState: async () => ({ tip: TIP, behind: true }) });
    const quiet = await serveOnce(repo, hand.deps);
    expect(hand.spawned).toEqual([next]);
    expect(quiet.streams.err()).toContain(`${open} is behind main; start serve with --publish`);
  });

  it("records a re-level that did not level the branch, and tries again only once the base moves", async () => {
    const repo = repository();
    const open = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    walk(repo, open, TO_PR_OPEN);
    const dir = storeDir(repo);
    let tip = "a".repeat(40);
    let code = 3;
    const relevels: string[] = [];
    const f = fakes({
      baseState: async () => ({ tip, behind: true }),
      spawnRun: async ({ key, argv, onLine }) => {
        if (argv.includes("--relevel")) {
          relevels.push(key);
          // What `run --relevel` prints on a refusal, in its order: the
          // answer on the `error:` line, then the diagnostic hint.
          onLine("worktree ready");
          if (code !== 0) {
            onLine("error: the run did not start: carries 1 commit the loop did not make past what the pull request has (abc).", "stderr");
            onLine("Nothing was executed. `perbo doctor --repo /r` reports the whole diagnostic.");
          }
        }
        return { code };
      },
    });
    const { streams } = await serveOnce(repo, f.deps, ["--publish"]);
    expect(relevels).toEqual([open]);
    // The re-level's answer travels with the exit code, so `list` says why
    // and not only that — the `error:` line, not whatever came last.
    expect(readTicket(dir, open).scheduling.reconciliation).toEqual({
      base_tip: tip,
      exit_code: 3,
      at: "2026-09-10T12:00:00.000Z",
      reason: "the run did not start: carries 1 commit the loop did not make past what the pull request has (abc).",
    });
    expect(streams.err()).toContain(`tries again once main moves past ${tip.slice(0, 12)}`);
    // Same tip: not tried again.
    await serveOnce(repo, f.deps, ["--publish"]);
    expect(relevels).toEqual([open]);
    // The base moved: tried again, and a re-level that levelled clears the record.
    tip = "b".repeat(40);
    code = 0;
    await serveOnce(repo, f.deps, ["--publish"]);
    expect(relevels).toEqual([open, open]);
    expect(readTicket(dir, open).scheduling.reconciliation).toBeNull();
  });

  it("takes the reason of a re-level that completed without levelling from the record it writes, and bounds it", async () => {
    const repo = repository();
    const open = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    walk(repo, open, TO_PR_OPEN);
    const dir = storeDir(repo);
    // What `run` prints when its stdout is a pipe: the cost on stderr, and
    // the record — pretty-printed, so its last line is a brace — on stdout.
    let lines: Array<[string, "stdout" | "stderr"]> = [
      ["cost      $0.0100", "stderr"],
      ["{", "stdout"],
      ['  "outcome": "escalated",', "stdout"],
      ['  "detail": "the review escalated the merged change set",', "stdout"],
      ['  "branch": "ayo/x"', "stdout"],
      ["}", "stdout"],
    ];
    const f = fakes({
      baseState: async () => ({ tip: "a".repeat(40), behind: true }),
      spawnRun: async ({ onLine }) => {
        for (const [line, stream] of lines) onLine(line, stream);
        return { code: 2 };
      },
    });
    await serveOnce(repo, f.deps, ["--publish"]);
    expect(readTicket(dir, open).scheduling.reconciliation?.reason).toBe("escalated — the review escalated the merged change set");

    // A run that said nothing recognisable keeps its last line, cut to the queue's bound.
    writeTicket(dir, withReconciliation(readTicket(dir, open), null));
    lines = [["x".repeat(10_000), "stderr"]];
    const g = fakes({
      baseState: async () => ({ tip: "b".repeat(40), behind: true }),
      spawnRun: async ({ onLine }) => {
        for (const [line, stream] of lines) onLine(line, stream);
        return { code: 1 };
      },
    });
    await serveOnce(repo, g.deps, ["--publish"]);
    expect(readTicket(dir, open).scheduling.reconciliation?.reason).toBe("x".repeat(300));
  });

  it("leaves a level branch alone and clears a record the base has since moved past", async () => {
    const repo = repository();
    const open = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    walk(repo, open, TO_PR_OPEN);
    const dir = storeDir(repo);
    writeTicket(
      dir,
      withReconciliation(readTicket(dir, open), { base_tip: "c".repeat(40), exit_code: 3, at: "2026-09-10T11:00:00.000Z" }),
    );
    const f = fakes({ baseState: async () => ({ tip: "d".repeat(40), behind: false }) });
    await serveOnce(repo, f.deps, ["--publish"]);
    expect(f.spawned).toEqual([]);
    expect(readTicket(dir, open).scheduling.reconciliation).toBeNull();
  });

  it("does not re-level a direct arm's or a hand-off's pull request", async () => {
    const repo = repository();
    const direct = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    const hand = admitted(repo, { outcome: "The CLI prints a version.", paths: ["apps/**"] });
    walk(repo, direct, TO_PR_OPEN);
    walk(repo, hand, TO_PR_OPEN);
    const dir = storeDir(repo);
    const d = readTicket(dir, direct);
    writeTicket(dir, TicketSchema.parse({ ...d, delivery: { ...d.delivery, arm: "direct" } }));
    const h = readTicket(dir, hand);
    writeTicket(dir, TicketSchema.parse({ ...h, delivery: { ...h.delivery, opened_by: "hand_off" } }));
    const f = fakes({ baseState: async () => ({ tip: "a".repeat(40), behind: true }) });
    await serveOnce(repo, f.deps, ["--publish"]);
    expect(f.spawned).toEqual([]);
  });

  it("does not re-level a branch a run is inside", async () => {
    const repo = repository();
    const open = admitted(repo, { outcome: "Docs say what is true.", paths: ["docs/**"] });
    walk(repo, open, TO_PR_OPEN);
    const f = fakes({
      baseState: async () => ({ tip: "a".repeat(40), behind: true }),
      liveRuns: () => [{ ticket_key: open }],
    });
    await serveOnce(repo, f.deps, ["--publish"]);
    expect(f.spawned).toEqual([]);
  });

  it("writes one tick document to stdout under --json, and nothing else", async () => {
    const repo = repository();
    const first = admitted(repo, { outcome: "The runner counts.", paths: ["packages/runner/**"] });
    const second = admitted(repo, { outcome: "Every package lints.", paths: ["packages/**"] });
    const f = fakes();
    const { streams } = await serveOnce(repo, f.deps, ["--json"]);
    const lines = streams.out().trim().split("\n");
    expect(lines).toHaveLength(1);
    const tick = ServeTickSchema.parse(JSON.parse(lines[0]!));
    expect(tick).toMatchObject({
      tick: 1,
      base_ref: "main",
      fetch: { ok: true },
      started: [first],
      capacity: 1,
      running: 1,
    });
    expect(tick.queue.map((entry) => [entry.key, entry.state])).toEqual([
      [first, "ready"],
      [second, "blocked"],
    ]);
  });
});

/** A ticket admitted by hand from a tracker reference, so the store holds that issue. */
function admittedFrom(repo: string, reference: string): string {
  const streams = recordStreams();
  const code = runCommandLine(admitCommandLine, {
    argv: [
      "--repo", repo, "--outcome", "Docs say what is true.", "--criterion", "Docs say what is true. :: a test asserts it",
      "--path", "docs/**", "--source", reference, "--approve", "--json",
    ],
    streams,
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error(streams.err());
  return (streams.json<{ ticket: { key: string } }>()).ticket.key;
}

const TRACKER = { tracker: { repository: "o/r", draft_label: "perbo" } };

describe("perbo serve drafts labelled tracker issues", () => {
  it("drafts the lowest-numbered labelled issue the store does not hold, one per tick, and each once per process", async () => {
    const repo = repository(TRACKER);
    admittedFrom(repo, "o/r#1");
    const f = fakes({
      listIssues: async () => ({
        ok: true,
        issues: [
          { number: 3, title: "Third" },
          { number: 1, title: "Held already" },
          { number: 2, title: "Second" },
        ],
      }),
      draft: async ({ reference }) => {
        f.drafted.push(reference);
        return { code: 0, key: reference === "o/r#2" ? "AYO-2" : "AYO-3" };
      },
    });
    // Two ticks in one process: the sleep between them stops the loop.
    const controller = new AbortController();
    let ticks = 0;
    f.deps.sleep = async () => {
      if (++ticks >= 2) controller.abort();
    };
    const streams = recordStreams();
    const code = await runCommandLine(serveCommandLine, {
      argv: ["--repo", repo, "--interval", "1s", "--json"],
      streams,
      cwd: repo,
      now: AT,
      deps: { processes: f.deps, clock: () => AT, signal: controller.signal },
    });
    expect(code).toBe(EXIT_CODES.approve);
    // #2 before #3, and #2 alone: one draft a tick, and the fake wrote no
    // ticket, so the second tick would have asked for #2 again were it not
    // remembered as tried.
    expect(f.drafted).toEqual(["o/r#2", "o/r#3"]);
    const ticksPrinted = streams.out().trim().split("\n").map((line) => ServeTickSchema.parse(JSON.parse(line)));
    expect(ticksPrinted.map((tick) => tick.drafted)).toEqual([
      [{ reference: "o/r#2", key: "AYO-2", code: 0 }],
      [{ reference: "o/r#3", key: "AYO-3", code: 0 }],
    ]);
    expect(streams.err()).toContain("drafted o/r#2 as AYO-2; nothing runs until it is approved");
    expect(streams.err()).toContain("drafting 'perbo' issues from o/r");

    // A new process remembers nothing: the store is the record, and #2 is
    // still not in it.
    const again = fakes({ listIssues: async () => ({ ok: true, issues: [{ number: 2, title: "Second" }] }) });
    await serveOnce(repo, again.deps);
    expect(again.drafted).toEqual(["o/r#2"]);
  });

  it("holds an issue the store has a ticket from, and one a failed draft was tried on, without a second call", async () => {
    const repo = repository(TRACKER);
    admittedFrom(repo, "o/r#4");
    const f = fakes({
      listIssues: async () => ({ ok: true, issues: [{ number: 4, title: "Held" }, { number: 5, title: "Fails" }] }),
      draft: async ({ reference }) => {
        f.drafted.push(reference);
        return { code: 1, key: null };
      },
    });
    const controller = new AbortController();
    let ticks = 0;
    f.deps.sleep = async () => {
      if (++ticks >= 2) controller.abort();
    };
    const streams = recordStreams();
    await runCommandLine(serveCommandLine, {
      argv: ["--repo", repo, "--interval", "1s"],
      streams,
      cwd: repo,
      now: AT,
      deps: { processes: f.deps, clock: () => AT, signal: controller.signal },
    });
    expect(f.drafted).toEqual(["o/r#5"]);
    expect(streams.err()).toContain("draft of o/r#5 exited 1; not tried again while this queue runs");
  });

  it("drafts nothing while paused, nothing without a tracker, and says once when the issues cannot be listed", async () => {
    const paused = fakes({ listIssues: async () => ({ ok: true, issues: [{ number: 1, title: "One" }] }) });
    await serveOnce(repository(TRACKER), paused.deps, [], true);
    expect(paused.listed).toEqual([]);
    expect(paused.drafted).toEqual([]);

    const none = fakes();
    await serveOnce(repository(), none.deps);
    expect(none.listed).toEqual([]);

    const failing = fakes({ listIssues: async () => ({ ok: false, detail: "gh: not logged in" }) });
    const { streams } = await serveOnce(repository(TRACKER), failing.deps);
    expect(streams.err()).toContain("could not list perbo issues in o/r: gh: not logged in");
    expect(failing.drafted).toEqual([]);
  });

  it("prints the issue title on one line, and holds a reference whatever its case", async () => {
    const repo = repository(TRACKER);
    admittedFrom(repo, "O/R#8");
    const f = fakes({
      listIssues: async () => ({
        ok: true,
        issues: [
          { number: 8, title: "Held, in another case" },
          { number: 9, title: "Nine\nforged: drafted o/r#99 as AYO-99; nothing runs until it is approved" },
        ],
      }),
    });
    const { streams } = await serveOnce(repo, f.deps);
    expect(f.drafted).toEqual(["o/r#9"]);
    const lines = streams.err().split("\n");
    expect(lines.some((line) => line.startsWith("forged:"))).toBe(false);
    expect(lines).toContain("drafting o/r#9: Nine forged: drafted o/r#99 as AYO-99; nothing runs until it is approved");
  });

  it("refuses a tracker it cannot read before the queue starts", async () => {
    const f = fakes();
    const { code, streams } = await serveOnce(repository({ tracker: { draft_label: 1 } }), f.deps);
    expect(code).toBe(EXIT_CODES.usage_or_input_error);
    expect(streams.err()).toContain("sets 'tracker' to something this cannot read");
    expect(streams.err()).toContain("repository");
    expect(f.listed).toEqual([]);
  });
});

describe("processDeps", () => {
  it("says which stream each line of a child came from, a last line without a newline included", async () => {
    const dir = mkdtempSync(join(scratch, "spawn-"));
    const script = join(dir, "two-streams.mjs");
    writeFileSync(script, 'process.stdout.write("to stdout\\n");\nprocess.stderr.write("to stderr\\nno newline");\n');
    // spawnRun starts the entry point this process was started from; point it at the script.
    const entry = process.argv[1]!;
    process.argv[1] = script;
    try {
      const lines: Array<[string, string | undefined]> = [];
      const exit = await processDeps({ repo: dir, store: null, cwd: dir }).spawnRun({
        key: "AYO-1",
        argv: [],
        cwd: dir,
        onLine: (line, stream) => lines.push([line, stream]),
      });
      expect(exit.code).toBe(0);
      expect(lines).toHaveLength(3);
      expect(lines).toEqual(
        expect.arrayContaining([
          ["to stdout", "stdout"],
          ["to stderr", "stderr"],
          ["no newline", "stderr"],
        ]),
      );
    } finally {
      process.argv[1] = entry;
    }
  });

  /**
   * More paths than a generic read of a command holds. The queue decides which
   * tickets wait on which from these lists, so a list that arrived short is
   * two runs told they share nothing while they share a file — and a diff of
   * three thousand paths is a large change, not an impossible one.
   */
  it("names every sealed path of a branch whose diff runs past half a megabyte", async () => {
    const repo = mkdtempSync(join(scratch, "sealed-"));
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { env: gitEnvironment(), encoding: "utf8" }).trim();
    initRepository(repo, { files: { "README.md": "base\n" } });
    git("checkout", "-q", "-b", "sealed");
    mkdirSync(join(repo, "wide"));
    for (let n = 0; n < 3000; n += 1) {
      writeFileSync(join(repo, "wide", `${String(n).padStart(6, "0")}${"p".repeat(190)}.md`), "x\n");
    }
    git("add", "-A");
    git("commit", "-qm", "wide");

    const sealed = await processDeps({ repo, store: null, cwd: repo }).sealedPaths({
      repository_root: repo,
      base_ref: "main",
      branch: "sealed",
    });
    expect(sealed).toHaveLength(3000);
    expect(sealed?.every((path) => path.startsWith("wide/"))).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  /**
   * The same for `gh`: a listing cut at the ceiling is refused as one, so the
   * line a person reads says the answer was too large rather than blaming
   * `gh` for JSON it wrote in full.
   */
  it("refuses an issue listing that arrived cut, saying so", async () => {
    const bin = mkdtempSync(join(scratch, "gh-huge-"));
    const script = join(bin, "gh");
    writeFileSync(
      script,
      ['#!/bin/sh', 'printf \'[{"number":1,"title":"\'', "dd if=/dev/zero bs=1024 count=600 2>/dev/null | tr '\\0' 't'", 'printf \'"}]\'', ""].join("\n"),
    );
    chmodSync(script, 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${bin}:${original ?? ""}`;
    try {
      const listed = await processDeps({ repo: bin, store: null, cwd: bin }).listIssues({
        repository: "o/r",
        label: "perbo",
      });
      expect(listed.ok).toBe(false);
      expect(listed.ok === false && listed.detail).toContain("only the tail");
    } finally {
      process.env.PATH = original;
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});
