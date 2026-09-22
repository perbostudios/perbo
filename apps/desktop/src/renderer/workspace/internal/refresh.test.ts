// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { sizeEstimate } from "@perbo/contracts/size";
import { WorkspaceRefresh } from "./refresh.js";
import { WorkspaceReads } from "../../../host/workspace-reads.js";
import { READ_ATTEMPTS } from "../../../shared/read-generations.js";
import { sampleBridge } from "../../../sample-host/bridge.js";
import { bridge, useGraph, useTaskSummary } from "../index.js";
import { TaskModelsSchema } from "../../../shared/protocol.js";
import type { Change, DesktopBridge, Detail, GraphView, Job, ReplyMap, Request, Snapshot, TaskSummary } from "../../../shared/protocol.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const snapshot = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  snapshot.jobs = [];
  snapshot.sequence = 0;
  const row = snapshot.tasks[0]!;
  const detail = structuredClone(await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }));
  const requests: Request[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always", staleTime: Infinity } } });
  client.setQueryData(["workspace"], snapshot);
  let listener: ((change: Change) => void) | undefined;
  let reply: (request: Request) => Promise<unknown> = async (request) => {
    if (request.kind === "snapshot") return structuredClone(snapshot);
    if (request.kind === "detail") return structuredClone(detail);
    if (request.kind === "output") return { transcript: "selected attempt", diff: null, notes: [] };
    if (request.kind === "repositorySnapshot") return structuredClone({ repository: snapshot.repositories.find((entry) => entry.id === request.repoId)!, tasks: snapshot.tasks.filter((entry) => entry.repoId === request.repoId), errors: [] });
    throw new Error("Unexpected request " + request.kind);
  };
  const connection: DesktopBridge = {
    async request<T extends Request>(request: T): Promise<ReplyMap[T["kind"]]> { requests.push(request); return await reply(request) as ReplyMap[T["kind"]]; },
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
  };
  const refresh = new WorkspaceRefresh(client, connection);
  cleanups.push(refresh.connect(), () => client.clear());
  const job: Job = { id: crypto.randomUUID(), repoId: row.repoId, key: row.ticket.key, kind: "run", label: "Run", state: "running", startedAt: new Date().toISOString(), endedAt: null, log: "", error: null, result: null, resultKey: null };
  const observeDetail = (repoId = row.repoId) => {
    const observer = new QueryObserver(client, { queryKey: ["detail", repoId, row.ticket.key], queryFn: () => refresh.detail(repoId, row.ticket.key), initialData: structuredClone(detail), staleTime: Infinity });
    cleanups.push(observer.subscribe(() => undefined));
    return observer;
  };
  return { snapshot, row, detail, requests, client, refresh, job, observeDetail, emit: (change: Change) => listener!(change), override: (next: typeof reply) => { const old = reply; reply = next; return old; } };
}

describe("workspace refresh interface", () => {
  it("patches sustained progress without requesting repository records", async () => {
    const f = await fixture();
    f.observeDetail();
    for (let sequence = 1; sequence <= 100; sequence++) f.emit({ kind: "progress", sequence, job: { ...f.job, log: "progress " + sequence } });
    expect(f.requests).toEqual([]);
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.jobs[0]!.log).toBe("progress 100");
  });

  /**
   * SCP-313: an interview's lines arrive many times a turn, and nothing in the
   * repository has moved when one does. The list of live interviews is patched
   * where it is, and no record is read.
   */
  it("follows a live interview without requesting repository records", async () => {
    const f = await fixture();
    f.observeDetail();
    const sessionId = "70000000-0000-4000-8000-000000000001";
    const line = (n: number, running: boolean): Change => ({
      kind: "interview",
      sequence: n,
      sessionId,
      running,
      entry: { n, at: "2026-01-01T00:00:00.000Z", line: { kind: "said", text: "line " + String(n) } },
      asking: null,
      working: false,
    });
    for (let n = 1; n <= 40; n++) f.emit(line(n, true));
    expect(f.requests).toEqual([]);
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.interviews).toEqual([sessionId]);
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos ?? []).toEqual([]);
    // And the one that says it has gone takes it off the list.
    f.emit({ kind: "interview", sequence: 41, sessionId, running: false, entry: null, asking: null, working: false });
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.interviews).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it("does not let an older snapshot erase newer progress", async () => {
    const f = await fixture(), reply = deferred<Snapshot>();
    f.override(async () => reply.promise);
    const reading = f.refresh.snapshot();
    f.emit({ kind: "progress", sequence: 10, job: { ...f.job, log: "Latest progress" } });
    reply.resolve(f.snapshot);
    expect((await reading).jobs[0]!.log).toBe("Latest progress");
    expect(f.requests).toHaveLength(1);
  });

  it("refreshes only the changed repository and its visible evidence", async () => {
    const f = await fixture();
    f.observeDetail();
    const other = f.snapshot.repositories.find((entry) => entry.id !== f.row.repoId)!;
    f.observeDetail(other.id);
    const output = new QueryObserver(f.client, { queryKey: ["output", f.row.repoId, f.row.ticket.key, "attempt-one"], queryFn: () => f.refresh.output(f.row.repoId, f.row.ticket.key, "attempt-one"), initialData: { transcript: null, diff: null, notes: [] }, staleTime: Infinity });
    cleanups.push(output.subscribe(() => undefined));
    f.emit({ kind: "records", sequence: 1, repoId: f.row.repoId, key: f.row.ticket.key, job: { ...f.job, state: "completed" } });
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos).toContain(f.row.repoId);
    await vi.waitFor(() => expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos).toEqual([]));
    expect(f.requests.filter((request) => request.kind === "snapshot")).toHaveLength(0);
    expect(f.requests.filter((request) => "repoId" in request && request.repoId === other.id)).toHaveLength(0);
    expect(f.requests).toContainEqual({ kind: "output", repoId: f.row.repoId, key: f.row.ticket.key, attemptId: "attempt-one" });
  });

  it("performs a follow-up read when completion arrives during an older detail request", async () => {
    const f = await fixture(), oldDetail = deferred<Detail>();
    const observer = f.observeDetail();
    let calls = 0;
    const original = f.override(async (request) => request.kind === "detail" && ++calls === 1 ? oldDetail.promise : original(request));
    const reading = observer.refetch();
    f.detail.ticket.state = "pr_open";
    f.emit({ kind: "records", sequence: 2, repoId: f.row.repoId, key: f.row.ticket.key, job: { ...f.job, state: "completed" } });
    oldDetail.resolve({ ...f.detail, ticket: { ...f.detail.ticket, state: "provisioning" } });
    await reading;
    await vi.waitFor(() => expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos).toEqual([]));
    expect(observer.getCurrentResult().data!.ticket.state).toBe("pr_open");
    expect(calls).toBe(2);
  });

  it("polling refreshes visible detail and retained output even without a host event", async () => {
    const f = await fixture();
    const observer = f.observeDetail();
    f.detail.ticket.state = "pr_open";
    await f.refresh.snapshot();
    expect(observer.getCurrentResult().data!.ticket.state).toBe("pr_open");
    expect(f.requests.map((request) => request.kind)).toEqual(["snapshot", "detail"]);
  });

  it("keeps recovery pending when fresh canonical reads fail", async () => {
    const f = await fixture();
    f.override(async () => { throw new Error("Repository unavailable"); });
    f.emit({ kind: "records", sequence: 1, repoId: f.row.repoId, key: f.row.ticket.key });
    await vi.waitFor(() => expect(f.client.getQueryData<Snapshot>(["workspace"])!.errors.join(" ")).toContain("Repository unavailable"));
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos).toContain(f.row.repoId);
  });

  it("reads a repository again when its records moved while it was being read", async () => {
    const f = await fixture();
    let reads = 0;
    const original = f.override(async (request) => {
      if (request.kind !== "repositorySnapshot") return original(request);
      reads += 1;
      if (reads === 1) {
        await Promise.resolve();
        f.emit({ kind: "records", sequence: 2, repoId: f.row.repoId, key: f.row.ticket.key });
      }
      return original(request);
    });
    f.emit({ kind: "records", sequence: 1, repoId: f.row.repoId, key: f.row.ticket.key });
    await vi.waitFor(() => expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos).toEqual([]));
    expect(reads).toBe(2);
  });

  /**
   * A repository whose records move faster than they can be read never
   * settles, and the refresh follows the same ceiling every other read does:
   * it says so, leaves the repository pending, and reads it again on the next
   * event or the next poll.
   */
  it("gives up on a repository whose records never settle", async () => {
    const f = await fixture();
    let reads = 0;
    // Mutates for longer than the ceiling allows, then settles: an unbounded
    // refresh reads the settled records and reports no failure at all.
    const original = f.override(async (request) => {
      if (request.kind !== "repositorySnapshot") return original(request);
      reads += 1;
      if (reads <= READ_ATTEMPTS + 5) {
        await Promise.resolve();
        f.emit({ kind: "records", sequence: reads + 1, repoId: f.row.repoId, key: f.row.ticket.key });
      }
      return original(request);
    });
    f.emit({ kind: "records", sequence: 1, repoId: f.row.repoId, key: f.row.ticket.key });
    await vi.waitFor(() => expect(f.client.getQueryData<Snapshot>(["workspace"])!.errors.join(" "))
      .toContain("changed while every attempt to read them"));
    expect(reads).toBe(READ_ATTEMPTS);
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos).toContain(f.row.repoId);
  });

  it("keeps Home available when one focused evidence read fails", async () => {
    const f = await fixture();
    const observer = f.observeDetail();
    const original = f.override(async (request) => {
      if (request.kind === "detail") throw new Error("Missing focused ticket");
      return original(request);
    });
    expect((await f.refresh.snapshot()).repositories).toEqual(f.snapshot.repositories);
    expect(observer.getCurrentResult().error?.message).toBe("Missing focused ticket");
  });

  it("refreshes per-task model choices together with a compiled contract", async () => {
    const f = await fixture();
    const taskModels = { [f.row.repoId + ":" + f.row.ticket.key]: TaskModelsSchema.strip().parse({ ...f.snapshot.settings, executorModel: "explicit-choice" }) };
    f.emit({ kind: "preferences", sequence: 1, settings: f.snapshot.settings, titles: {}, taskModels: {}, archived: [] });
    f.emit({ kind: "preferences", sequence: 2, settings: f.snapshot.settings, titles: {}, taskModels, archived: [] });
    f.emit({ kind: "records", sequence: 3, repoId: f.row.repoId, key: f.row.ticket.key });
    await vi.waitFor(() => expect(f.client.getQueryData<Snapshot>(["workspace"])!.refreshingRepos).toEqual([]));
    await vi.waitFor(() => expect(f.client.getQueryData<Snapshot>(["workspace"])!.taskModels).toEqual(taskModels));
    f.emit({ kind: "preferences", sequence: 1, settings: f.snapshot.settings, titles: {}, taskModels: {}, archived: [] });
    expect(f.client.getQueryData<Snapshot>(["workspace"])!.taskModels).toEqual(taskModels);
  });
});

describe("native read sharing", () => {
  it("shares overlapping reads and follows a mutation with fresh data", async () => {
    const reads = new WorkspaceReads(), old = deferred<string>();
    const loader = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue("new record");
    const first = reads.read("detail:A", "A", loader), second = reads.read("detail:A", "A", loader);
    reads.invalidate("A");
    old.resolve("old record");
    expect(await Promise.all([first, second])).toEqual(["new record", "new record"]);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

/**
 * ADR-0034's rule holds for every query hook, not only the ones the refresh
 * reads itself: a reply that was in flight when the records under it moved is
 * an account of what was there before, and marking it fresh hides that.
 */
describe("hooks read through the guard", () => {
  const hookRepo = "90000000-0000-4000-8000-000000000001";
  const hookKey = "PRB-901";
  function hooks() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always" } } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    let listener: ((change: Change) => void) | undefined;
    vi.spyOn(bridge, "subscribe").mockImplementation((next) => { listener = next; return () => { listener = undefined; }; });
    const request = vi.spyOn(bridge, "request");
    cleanups.push(() => { cleanup(); vi.restoreAllMocks(); client.clear(); });
    return { client, wrapper, request, emit: (change: Change) => listener!(change) };
  }
  /** Every reply the refresh asks for while a records change is being followed. */
  const answered = (kind: Request["kind"]): boolean => kind === "repositorySnapshot" || kind === "snapshot";

  it("takes a task summary again when the records moved while it was in flight", async () => {
    const f = hooks();
    const summary = (note: string): TaskSummary =>
      ({ branch: null, attempts: 1, latestAttemptAt: null, costMicros: null, costBasis: "none", diff: null, note });
    const held = deferred<TaskSummary>();
    let reads = 0;
    f.request.mockImplementation(async (input) => {
      if (input.kind === "taskSummary") return (++reads === 1 ? await held.promise : summary("new")) as never;
      if (answered(input.kind)) return { repository: null, tasks: [], errors: [] } as never;
      throw new Error("Unexpected request " + input.kind);
    });
    const view = renderHook(() => useTaskSummary(hookRepo, hookKey), { wrapper: f.wrapper });
    await waitFor(() => { expect(reads).toBe(1); });
    f.emit({ kind: "records", sequence: 1, repoId: hookRepo, key: hookKey });
    held.resolve(summary("old"));
    await waitFor(() => { expect(view.result.current.data?.note).toBe("new"); });
    expect(reads).toBe(2);
  });

  it("takes a graph read again when the records moved while it was in flight", async () => {
    const f = hooks();
    const graph = (note: string): GraphView => ({
      key: hookKey, state: "planning", approved: false, outcome: "A sample plan", nodes: [], criteria: [],
      edges: [], pathsAllowed: [], size: sizeEstimate({ nodes: 0, criteria: 0, files: 0, packages: 0 }),
      editCount: 0, history: [], digest: "0".repeat(64),
      live: { attempt: null, nodes: [], outside: [], note },
    });
    const held = deferred<GraphView>();
    let reads = 0;
    f.request.mockImplementation(async (input) => {
      if (input.kind === "graphRead") return (++reads === 1 ? await held.promise : graph("new")) as never;
      if (answered(input.kind)) return { repository: null, tasks: [], errors: [] } as never;
      throw new Error("Unexpected request " + input.kind);
    });
    const view = renderHook(() => useGraph(hookRepo, hookKey), { wrapper: f.wrapper });
    await waitFor(() => { expect(reads).toBe(1); });
    f.emit({ kind: "records", sequence: 1, repoId: hookRepo, key: hookKey });
    held.resolve(graph("old"));
    await waitFor(() => { expect(view.result.current.data?.live.note).toBe("new"); });
    expect(reads).toBe(2);
  });
});
