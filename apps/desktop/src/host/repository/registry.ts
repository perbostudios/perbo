import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { MaterializationManifestSchema } from "@perbo/contracts";
import { heldRepository } from "../../shared/jobs.js";
import { redact } from "../process.js";
import { forgetRepository } from "../profile/preferences.js";
import { repositoryStatus, topLevel, type Execute } from "./git.js";
import { configPath, perboPath } from "./layout.js";
import type { Changes } from "../changes.js";
import type { WorkspaceReads } from "../workspace-reads.js";
import type { Profile, RegisteredRepository } from "../profile/store.js";
import type { Job, Repository } from "../../shared/protocol.js";

export interface RegistryDeps {
  profile: Profile;
  changes: Changes;
  reads: WorkspaceReads;
  execute: Execute;
  liveJobs(): Job[];
}

/**
 * The repositories the person connected, and what Git and the repository's own
 * configuration say about each.
 *
 * A lookup is where a request's repository id becomes a folder on this
 * machine: the id is checked against what the profile holds, the recorded path
 * is checked against where it now resolves, and the `.perbo` folder is
 * resolved through `safePath`, so every read below starts inside a checkout
 * this host registered.
 */
export class RepositoryRegistry {
  private readonly deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  lookup(id: string): RegisteredRepository {
    const repo = this.deps.profile.state.repositories.find((entry) => entry.id === id);
    if (!repo)
      throw new Error(
        "This repository is no longer connected. Choose it again in Settings.",
      );
    if (realpathSync(repo.path) !== repo.path)
      throw new Error(
        "The repository path changed. Reconnect the repository before continuing.",
      );
    perboPath(repo);
    return repo;
  }

  all(): readonly RegisteredRepository[] {
    return this.deps.profile.state.repositories;
  }

  /**
   * Connect a checkout by its root folder. A folder inside one is refused
   * rather than registered as if it were the repository, and a folder already
   * connected keeps the id it has.
   */
  async register(path: string): Promise<Repository> {
    const canonical = realpathSync(path);
    const root = await topLevel(this.deps.execute, canonical);
    if (realpathSync(root) !== canonical)
      throw new Error("Choose the root folder of the Git checkout.");
    const existing = this.deps.profile.state.repositories.find(
      (repo) => repo.path === canonical,
    );
    if (existing) return this.metadata(existing);
    const repo = { id: randomUUID(), name: basename(canonical), path: canonical };
    perboPath(repo);
    this.deps.profile.state.repositories.push(repo);
    this.deps.changes.changed(true, { kind: "repositories" });
    return this.metadata(repo);
  }

  /** Disconnect it, with the preferences its tickets carried on this machine. */
  forget(id: string): null {
    const repo = this.lookup(id);
    if (heldRepository(this.deps.liveJobs(), repo.id))
      throw new Error(
        "Wait for the commands running in this repository to finish before disconnecting it.",
      );
    forgetRepository(this.deps.profile.state, repo.id);
    this.deps.changes.changed(true, { kind: "repositories" });
    this.deps.changes.preferences(this.deps.profile.state, false);
    return null;
  }

  metadata(repo: RegisteredRepository): Promise<Repository> {
    return this.deps.reads.read("metadata:" + repo.id, repo.id, () => this.read(repo));
  }

  /**
   * What the repository is on now. A repository that cannot be read comes back
   * as itself with the reason rather than as a failure: the list shows every
   * connected repository, including the one whose checkout has gone.
   */
  private async read(repo: RegisteredRepository): Promise<Repository> {
    try {
      this.lookup(repo.id);
      const status = await repositoryStatus(this.deps.execute, repo.path);
      const config = existsSync(configPath(repo))
        ? z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(readFileSync(configPath(repo), "utf8")))
        : {};
      const manifest = MaterializationManifestSchema.safeParse(
        config["materialization_manifest"],
      );
      const protectedPaths = z.array(z.string()).safeParse(config["protected_paths"]);
      return {
        ...repo,
        ...status,
        configured: existsSync(configPath(repo)),
        error: null,
        ...(manifest.success
          ? {
              testCommand: manifest.data.verify.command.join(" "),
              manifestCount: manifest.data.entries.length,
            }
          : {}),
        ...(protectedPaths.success ? { prohibitedPaths: protectedPaths.data } : {}),
      };
    } catch (error) {
      return {
        ...repo,
        branch: "Unavailable",
        head: "",
        dirty: false,
        configured: false,
        error: redact(String(error)),
      };
    }
  }
}
