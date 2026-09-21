import type { QueryClient } from "@tanstack/react-query";
import { ChangeSchema } from "../shared/protocol.js";
import { ALL_SCOPE, ReadGenerations, SNAPSHOT_SCOPE } from "../shared/read-generations.js";
import type { Change, DesktopBridge, Job, Snapshot } from "../shared/protocol.js";

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Owns event ordering, scoped refresh and polling reads behind the query hooks. */
export class WorkspaceRefresh {
  private readonly client: QueryClient;
  private readonly connection: DesktopBridge;
  private readonly generations = new ReadGenerations();
  private readonly pending = new Set<string>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly jobs = new Map<string, { job: Job; sequence: number }>();
  private preferences: Extract<Change, { kind: "preferences" }> | undefined;
  private power: Extract<Change, { kind: "power" }> | undefined;
  private users = 0;
  private unsubscribe: (() => void) | undefined;
  constructor(client: QueryClient, connection: DesktopBridge) { this.client = client; this.connection = connection; }

  connect = (): (() => void) => {
    if (this.users++ === 0) {
      this.unsubscribe = this.connection.subscribe(this.changed);
      document.addEventListener("visibilitychange", this.wake);
    }
    return () => {
      if (--this.users === 0) { this.unsubscribe?.(); document.removeEventListener("visibilitychange", this.wake); }
    };
  };
  private wake = (): void => {
    if (document.visibilityState === "visible") this.refreshAll();
  };
  private patch(update: (snapshot: Snapshot) => Snapshot): void {
    this.client.setQueryData<Snapshot>(["workspace"], (snapshot) => snapshot ? update(snapshot) : undefined);
  }
  private merge(snapshot: Snapshot): Snapshot {
    const jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));
    for (const [id, entry] of this.jobs) {
      if (entry.sequence > (snapshot.sequence ?? -1)) jobs.set(id, entry.job);
      else this.jobs.delete(id);
    }
    const preferences = this.preferences && this.preferences.sequence > (snapshot.sequence ?? -1) ? this.preferences : undefined;
    const power = this.power && this.power.sequence > (snapshot.sequence ?? -1) ? this.power.power : undefined;
    return {
      ...snapshot, jobs: [...jobs.values()].slice(-40), refreshingRepos: [...this.pending],
      ...(preferences ? { settings: preferences.settings, titles: preferences.titles, taskModels: preferences.taskModels, archived: preferences.archived } : {}),
      ...(power ? { power } : {}),
    };
  }
  private markPending(repoId: string): void {
    this.pending.add(repoId);
    this.patch((snapshot) => ({ ...snapshot, refreshingRepos: [...this.pending] }));
  }
  private async visible(repoId?: string): Promise<void> {
    await this.client.invalidateQueries({
      predicate: (query) => ["detail", "output", "summary", "graph"].includes(String(query.queryKey[0])) && (!repoId || query.queryKey[1] === repoId),
      refetchType: "active",
    }, { cancelRefetch: false, throwOnError: true });
  }
  snapshot = async (): Promise<Snapshot> => {
    const snapshot = await this.generations.read(SNAPSHOT_SCOPE, async () => {
      const result = await this.connection.request({ kind: "snapshot" });
      // Focused evidence failures remain on their own query; Home must still load.
      await this.visible().catch(() => undefined);
      return result;
    });
    const failed = this.client.getQueryCache().findAll({ type: "active", predicate: (query) =>
      ["detail", "output"].includes(String(query.queryKey[0])) && query.state.status === "error" });
    for (const repo of snapshot.repositories) if (!snapshot.repositoryErrors?.[repo.id]?.length && !repo.error &&
      !failed.some((query) => query.queryKey[1] === repo.id)) this.pending.delete(repo.id);
    for (const id of this.pending) if (!snapshot.repositories.some((repo) => repo.id === id)) this.pending.delete(id);
    return this.merge(snapshot);
  };
  detail = (repoId: string, key: string) => this.generations.read(repoId, () => this.connection.request({ kind: "detail", repoId, key }));
  output = (repoId: string, key: string, attemptId?: string) => this.generations.read(repoId, () => this.connection.request({ kind: "output", repoId, key, ...(attemptId ? { attemptId } : {}) }));
  summary = (repoId: string, key: string) => this.generations.read(repoId, () => this.connection.request({ kind: "taskSummary", repoId, key }));
  graph = (repoId: string, key: string) => this.generations.read(repoId, () => this.connection.request({ kind: "graphRead", repoId, key }));

  // An editing session changed: the picker's list of open drafts follows it, and nothing else in the snapshot does.
  private refreshDrafts(): void {
    void this.connection.request({ kind: "drafts" })
      .then((drafts) => this.patch((snapshot) => ({ ...snapshot, drafts })))
      .catch(() => undefined);
  }
  private refreshAll(): void {
    this.generations.invalidate(ALL_SCOPE);
    void this.client.invalidateQueries({ queryKey: ["workspace"] }, { cancelRefetch: false });
  }
  private refreshRepository(repoId: string): void {
    if (this.refreshing.has(repoId)) return;
    const work = (async () => {
      try {
        for (;;) {
          const token = this.generations.token(repoId);
          const results = await Promise.allSettled([
            this.connection.request({ kind: "repositorySnapshot", repoId }), this.visible(repoId),
          ]);
          if (token !== this.generations.token(repoId)) continue;
          const [records, visible] = results;
          if (records.status === "rejected") throw records.reason;
          const result = records.value;
          if (!result.errors.length && visible.status === "fulfilled") this.pending.delete(repoId);
          this.patch((snapshot) => {
            const repositoryErrors = { ...snapshot.repositoryErrors, [repoId]: result.errors };
            return this.merge({ ...snapshot,
              repositories: snapshot.repositories.map((repo) => repo.id === repoId ? result.repository : repo),
              tasks: result.errors.length ? snapshot.tasks : [...snapshot.tasks.filter((row) => row.repoId !== repoId), ...result.tasks],
              repositoryErrors, errors: Object.values(repositoryErrors).flat(),
            });
          });
          return;
        }
      } catch (error) {
        this.patch((snapshot) => ({ ...snapshot, errors: [...snapshot.errors, "Could not refresh the recorded outcome: " + message(error)] }));
      }
    })();
    this.refreshing.set(repoId, work);
    void work.finally(() => { this.refreshing.delete(repoId); });
  }
  private changed = (input: Change): void => {
    const parsed = ChangeSchema.safeParse(input);
    if (!parsed.success) return;
    const change = parsed.data;
    if (change.kind === "editing") { this.refreshDrafts(); return; }
    // An interview's lines arrive many times a turn and nothing in a repository
    // moves when one does, so the list of live interviews is patched where it
    // is and no record is read. The line itself goes to the chat, which reads
    // the change stream directly.
    if (change.kind === "interview") {
      this.patch((snapshot) => {
        const live = new Set(snapshot.interviews ?? []);
        if (change.running) live.add(change.sessionId);
        else live.delete(change.sessionId);
        return { ...snapshot, interviews: [...live] };
      });
      return;
    }
    if (change.kind === "power") {
      if (this.power && this.power.sequence > change.sequence) return;
      this.power = change;
      this.patch((snapshot) => this.merge(snapshot));
      return;
    }
    if ((change.kind === "progress" || change.kind === "records") && change.job) {
      const previous = this.jobs.get(change.job.id);
      if (!previous || previous.sequence <= change.sequence) this.jobs.set(change.job.id, { job: change.job, sequence: change.sequence });
      this.patch((snapshot) => this.merge(snapshot));
    }
    if (change.kind === "progress") return;
    if (change.kind === "preferences") {
      if (this.preferences && this.preferences.sequence > change.sequence) return;
      this.preferences = change;
      this.generations.invalidate(ALL_SCOPE);
      this.patch((snapshot) => this.merge(snapshot));
      void this.visible().catch((error: unknown) => this.patch((snapshot) => ({ ...snapshot, errors: [...snapshot.errors, message(error)] })));
      return;
    }
    if (change.kind === "records" && change.repoId) {
      this.generations.invalidate(change.repoId);
      this.markPending(change.repoId);
      this.refreshRepository(change.repoId);
    } else {
      for (const repo of this.client.getQueryData<Snapshot>(["workspace"])?.repositories ?? []) this.markPending(repo.id);
      this.refreshAll();
    }
  };
}

const refreshes = new WeakMap<QueryClient, WorkspaceRefresh>();
export function workspaceRefresh(client: QueryClient, connection: DesktopBridge): WorkspaceRefresh {
  let refresh = refreshes.get(client);
  if (!refresh) { refresh = new WorkspaceRefresh(client, connection); refreshes.set(client, refresh); }
  return refresh;
}
