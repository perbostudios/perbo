import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryRegistry } from "./registry.js";
import { Changes } from "../changes.js";
import { WorkspaceReads } from "../workspace-reads.js";
import { Profile } from "../profile/store.js";
import { runProcess } from "../process.js";
import { configPath } from "./layout.js";
import type { Change, Job } from "../../shared/protocol.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
/** A real checkout, because registering one asks Git where its root is. */
function checkout(name = "checkout"): string {
  const root = mkdtempSync(join(tmpdir(), "perbo-registry-"));
  temporary.push(root);
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "Desktop Test"],
    ["config", "user.email", "desktop@example.invalid"],
    ["config", "commit.gpgsign", "false"],
  ])
    execFileSync("git", args, { cwd: path, stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "# Test repository\n");
  execFileSync("git", ["add", "README.md"], { cwd: path });
  execFileSync("git", ["commit", "-m", "Initial test state"], { cwd: path, stdio: "ignore" });
  return realpathSync(path);
}
function registry(jobs: Job[] = []): {
  registry: RepositoryRegistry;
  profile: Profile;
  told: Change[];
} {
  const directory = mkdtempSync(join(tmpdir(), "perbo-registry-profile-"));
  temporary.push(directory);
  const profile = Profile.open(directory);
  const told: Change[] = [];
  const changes = new Changes({
    reads: new WorkspaceReads(),
    save: () => profile.save(),
    emit: (change) => told.push(change),
  });
  return {
    profile,
    told,
    registry: new RepositoryRegistry({
      profile,
      changes,
      reads: new WorkspaceReads(),
      execute: runProcess,
      liveJobs: () => jobs,
    }),
  };
}
const running = (repoId: string): Job =>
  ({
    id: "80000000-0000-4000-8000-00000000000a",
    repoId,
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
  }) as Job;

describe("registering a repository", () => {
  it("takes the root of a checkout, names it after its folder and tells the change", async () => {
    const path = checkout();
    const w = registry();
    const registered = await w.registry.register(path);
    expect(registered.name).toBe("checkout");
    expect(registered.path).toBe(path);
    expect(registered.branch).toBe("main");
    expect(registered.dirty).toBe(false);
    expect(w.told.map((change) => change.kind)).toEqual(["repositories"]);
  });

  it("refuses a folder inside a checkout rather than registering it as one", async () => {
    const path = checkout();
    mkdirSync(join(path, "src"));
    await expect(registry().registry.register(join(path, "src"))).rejects.toThrow(
      "Choose the root folder of the Git checkout.",
    );
  });

  it("keeps the id a repository already has, and tells nothing", async () => {
    const path = checkout();
    const w = registry();
    const first = await w.registry.register(path);
    const again = await w.registry.register(path);
    expect(again.id).toBe(first.id);
    expect(w.told).toHaveLength(1);
  });
});

describe("looking a repository up", () => {
  it("refuses an id the profile does not hold", () => {
    expect(() => registry().registry.lookup("80000000-0000-4000-8000-00000000000f")).toThrow(
      "This repository is no longer connected. Choose it again in Settings.",
    );
  });

  it("refuses one whose recorded path no longer resolves to itself", async () => {
    const path = checkout();
    const w = registry();
    const registered = await w.registry.register(path);
    const moved = join(path, "..", "moved");
    rmSync(path, { recursive: true, force: true });
    mkdirSync(moved, { recursive: true });
    // The record still names the old folder; a link now stands where it was.
    symlinkSync(moved, path);
    expect(() => w.registry.lookup(registered.id)).toThrow(
      "The repository path changed. Reconnect the repository before continuing.",
    );
  });

  it("lists what the profile holds", async () => {
    const w = registry();
    expect(w.registry.all()).toEqual([]);
    await w.registry.register(checkout());
    expect(w.registry.all()).toHaveLength(1);
  });
});

describe("reading what a repository is on", () => {
  it("says a checkout with uncommitted work is dirty", async () => {
    const path = checkout();
    const w = registry();
    const registered = await w.registry.register(path);
    writeFileSync(join(path, "README.md"), "# Changed\n");
    const repo = w.registry.lookup(registered.id);
    expect(await w.registry.metadata(repo)).toMatchObject({ dirty: true, branch: "main" });
  });

  it("carries the manifest's verify command and the repository's off-limits paths", async () => {
    const path = checkout();
    const w = registry();
    const registered = await w.registry.register(path);
    const repo = w.registry.lookup(registered.id);
    mkdirSync(join(path, ".perbo"), { recursive: true });
    writeFileSync(
      configPath(repo),
      JSON.stringify({
        protected_paths: ["infra/**"],
        materialization_manifest: {
          manifest_version: 1,
          repository_id: "repo_0000000000000001",
          source_checkout: ".",
          entries: [],
          install: {
            kind: "none",
            package_manager: "none",
            offline_preferred: true,
            lifecycle_scripts: { policy: "disabled", exception: null },
            command: ["true"],
            pinned: true,
          },
          verify: { command: ["node", "--test"], timeout_ms: 1000 },
          isolation: {
            mode: "serialized",
            port_range_size: 0,
            port_range_start: 20_000,
            port_range_end: 21_000,
            database_schema_prefix: null,
          },
        },
      }),
    );
    expect(await w.registry.metadata(repo)).toMatchObject({
      configured: true,
      testCommand: "node --test",
      manifestCount: 0,
      prohibitedPaths: ["infra/**"],
    });
  });

  it("answers with the repository and the reason where its checkout has gone", async () => {
    const path = checkout();
    const w = registry();
    const registered = await w.registry.register(path);
    const repo = w.registry.lookup(registered.id);
    rmSync(path, { recursive: true, force: true });
    const read = await w.registry.metadata(repo);
    expect(read).toMatchObject({ branch: "Unavailable", head: "", dirty: false, configured: false });
    expect(read.error).toContain("no such file");
  });
});

describe("forgetting a repository", () => {
  it("drops it and tells the repositories and the preferences", async () => {
    const w = registry();
    const registered = await w.registry.register(checkout());
    w.profile.state.titles = { [registered.id + ":PRB-1"]: "Renamed" };
    expect(w.registry.forget(registered.id)).toBeNull();
    expect(w.registry.all()).toEqual([]);
    expect(w.profile.state.titles).toEqual({});
    expect(w.told.map((change) => change.kind)).toEqual([
      "repositories",
      "repositories",
      "preferences",
    ]);
  });

  it("waits for the repository's own commands to finish", async () => {
    const live: Job[] = [];
    const w = registry(live);
    const registered = await w.registry.register(checkout());
    live.push(running(registered.id));
    expect(() => w.registry.forget(registered.id)).toThrow(
      "Wait for the commands running in this repository to finish before disconnecting it.",
    );
    expect(w.registry.all()).toHaveLength(1);
  });

  it("does not wait for a command in another repository", async () => {
    const live: Job[] = [];
    const w = registry(live);
    const registered = await w.registry.register(checkout());
    live.push(running("80000000-0000-4000-8000-00000000000f"));
    expect(w.registry.forget(registered.id)).toBeNull();
  });
});
