// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type PropsWithChildren } from "react";
import type { StandingProhibitedEntry } from "@perbo/contracts";
import { ContractEditing, interviewProviderFor, interviewSessionArgs } from "../shared/contract-editing.js";
import { WorkspaceReads } from "../host/workspace-reads.js";
import { ContractEditor, flushContractEditors, useContractEditing } from "./contract-editor.js";
import { bridge } from "./workspace/index.js";
import { INTERVIEW_CONVERSATION_CAP, TaskModelsSchema } from "../shared/protocol.js";
import { READ_ATTEMPTS } from "../shared/read-generations.js";
import type { Change, DesktopBridge, Detail, EditingSession, Job, ReplyMap, Request } from "../shared/protocol.js";
import { sampleBridge } from "../sample-host/bridge.js";

const repoId = "10000000-0000-4000-8000-000000000001";
const otherRepo = "10000000-0000-4000-8000-000000000002";
const models = TaskModelsSchema.parse({});
const draft = { outcome: "Save the result", criteria: [{ text: "Saved", assertion: "The saved text can be read", kind: "test" as const }], paths: ["src/**"], prohibited: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const snapshot = await sampleBridge.request({ kind: "snapshot" });
  const row = snapshot.tasks.find((entry) => entry.ticket.key === "PRB-421")!;
  const sample = structuredClone(await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }));
  sample.ticket.approved_at = null;
  let records: EditingSession[] = [];
  const repositories = new Set([repoId, otherRepo]);
  const details = new Map([[repoId + ":PRB-421", sample], [otherRepo + ":PRB-421", structuredClone(sample)]]);
  const persist = vi.fn((next: EditingSession[]) => { records = structuredClone(next); });
  const detail = vi.fn(async (repo: string, key: string): Promise<Detail> => {
    const found = details.get(repo + ":" + key);
    if (!found) throw new Error("Missing task");
    return structuredClone(found);
  });
  const jobs: Job[] = [];
  const start = vi.fn(async (request: Extract<Request, { kind: "draft" | "admit" | "edit" }>, owner: { sessionId: string; operationId: string }) => {
    const job: Job = { id: crypto.randomUUID(), repoId: request.repoId, key: "key" in request ? request.key : null, kind: request.kind, label: "Compile", state: "running", startedAt: new Date().toISOString(), endedAt: null, log: "", resultKey: null, error: null, result: null, editing: owner };
    editing.started(owner, job);
    jobs.push(job);
    return job;
  });
  const stop = vi.fn(async (id: string) => {
    const job = jobs.find((entry) => entry.id === id)!;
    job.state = "cancelled";
    await editing.settled(job);
  });
  let standing: StandingProhibitedEntry[] = [];
  const io = { records: () => records, persist, repository: (id: string) => { if (!repositories.has(id)) throw new Error("Disconnected"); }, defaults: () => models, detail, start, stop, id: () => crypto.randomUUID(), standing: () => [...standing], setStanding: (_id: string, entries: StandingProhibitedEntry[]) => { standing = [...entries]; } };
  const editing = new ContractEditing(io);
  const request = vi.fn(async <T extends Request>(input: T): Promise<ReplyMap[T["kind"]]> => {
    let result: unknown;
    switch (input.kind) {
      case "editingOpen": result = await editing.open(input.target); break;
      case "editingRead": result = editing.read(input.id); break;
      case "editingSave": result = editing.save(input.id, input.revision, input.repoId, input.form); break;
      case "editingSubmit": result = await editing.submit(input.id, input.revision, input.operationId, input.intent); break;
      case "editingStop": result = await editing.stop(input.id); break;
      case "editingDiscard": result = editing.discard(input.id, input.revision); break;
      case "detail": result = await detail(input.repoId, input.key); break;
      default: throw new Error("Unexpected request " + input.kind);
    }
    return result as ReplyMap[T["kind"]];
  });
  let listener: ((change: Change) => void) | undefined;
  const connection: DesktopBridge = { request: async <T extends Request>(input: T) => await request(input) as ReplyMap[T["kind"]], subscribe: (next) => { listener = next; return () => { listener = undefined; }; } };
  return { editing, io, records: () => records, repositories, details, detail, persist, jobs, start, stop, request, connection, emit: (change: Change) => listener?.(change) };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("contract editing session interface", () => {
  it("restores every unfinished field and model choice without admitting a Ticket", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    const form = { ...session.form, draft: { ...draft, outcome: "incomplete ", criteria: [] }, editing: 0, criterion: { text: "partly typed", assertion: "", kind: "query" as const }, newPath: "src/", models: { ...models, executorModel: "chosen-model" } };
    const saved = f.editing.save(session.id, session.revision, repoId, form);
    const restarted = new ContractEditing(f.io);
    restarted.recover();
    expect(await restarted.open({ kind: "new", repoId: otherRepo })).toEqual(saved);
    expect(f.start).not.toHaveBeenCalled();
    expect(() => restarted.save(session.id, 0, repoId, form)).toThrow(/another view/);
  });

  it("owns completion across navigation and repository namespaces, and deduplicates submissions", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    const a = f.editing.save(initial.id, initial.revision, repoId, { ...initial.form, draft });
    const operation = crypto.randomUUID();
    const running = await f.editing.submit(a.id, a.revision, operation, "draft");
    expect(await f.editing.submit(a.id, a.revision, operation, "draft")).toEqual(running);
    await expect(f.editing.submit(a.id, a.revision, operation, "compile")).rejects.toThrow(/different input/);
    const b = await f.editing.open({ kind: "ticket", repoId: otherRepo, key: "PRB-421" });
    const savedB = f.editing.save(b.id, b.revision, otherRepo, { ...b.form, criterion: { text: "B's unfinished text", assertion: "", kind: "test" } });
    const job = f.jobs[0]!;
    await f.editing.settled({ ...job, repoId: otherRepo, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(a.id).phase).toBe("working");
    await f.editing.settled({ ...job, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(a.id)).toMatchObject({ key: "PRB-421", repoId, phase: "editing", form: { step: 2 } });
    expect((await f.editing.open({ kind: "ticket", repoId, key: "PRB-421" })).id).toBe(a.id);
    expect(f.editing.read(b.id)).toEqual(savedB);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("keeps interrupted admissions unknown and never automatically submits them again", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    const saved = f.editing.save(initial.id, initial.revision, repoId, { ...initial.form, draft });
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "compile");
    const restarted = new ContractEditing(f.io);
    restarted.recover();
    const recovered = await restarted.open({ kind: "new", repoId });
    expect(recovered).toMatchObject({ phase: "outcome-unknown", form: { draft }, operation: { state: "interrupted" } });
    await expect(restarted.submit(saved.id, recovered.revision, crypto.randomUUID(), "compile")).rejects.toThrow(/Restore/);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("reserves an admission's Ticket while an earlier editor open shares its pending read", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    const saved = f.editing.save(initial.id, 0, repoId, { ...initial.form, draft });
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "draft");
    const reads = new WorkspaceReads(), held = deferred<Detail>();
    f.detail.mockImplementation((repo, key) => reads.read("detail:" + repo + ":" + key, repo, () => held.promise));
    const opening = f.editing.open({ kind: "ticket", repoId, key: "PRB-421" });
    reads.invalidate(repoId);
    const settling = f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" });
    held.resolve(f.details.get(repoId + ":PRB-421")!);
    const [opened] = await Promise.all([opening, settling]);
    expect(opened.id).toBe(initial.id);
    expect(f.records().filter((entry) => entry.key === "PRB-421")).toHaveLength(1);
  });

  it("preserves both buffers when another editor opens before admission reports its identity", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    const saved = f.editing.save(initial.id, 0, repoId, { ...initial.form, draft });
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "draft");
    const other = await f.editing.open({ kind: "ticket", repoId, key: "PRB-421" });
    const edited = f.editing.save(other.id, other.revision, repoId, { ...other.form, editing: 0, criterion: { text: "Keep this unfinished criterion", assertion: "", kind: "test" } });
    await f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" });
    const restarted = new ContractEditing(f.io);
    expect(await restarted.open({ kind: "ticket", repoId, key: "PRB-421" })).toEqual(edited);
    const conflict = await restarted.open({ kind: "new", repoId });
    expect(conflict).toMatchObject({
      id: initial.id, key: null, phase: "conflict", form: saved.form,
      operation: { state: "completed", resultKey: "PRB-421", reconciled: true },
    });
    expect(f.records().filter((entry) => entry.key === "PRB-421")).toHaveLength(1);
    expect(await restarted.open({ kind: "session", id: conflict.id })).toEqual(conflict);
    expect(await restarted.submit(conflict.id, saved.revision, conflict.operation!.id, "draft")).toEqual(conflict);
    await expect(restarted.submit(conflict.id, conflict.revision, crypto.randomUUID(), "draft")).rejects.toThrow(/Restore/);
    restarted.discard(edited.id, edited.revision);
    const current = await restarted.open({ kind: "ticket", repoId, key: "PRB-421" });
    expect(current).toMatchObject({ key: "PRB-421", phase: "editing" });
    expect(current.id).not.toBe(conflict.id);
    expect(current.id).not.toBe(edited.id);
    expect(await restarted.open({ kind: "new", repoId })).toEqual(conflict);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the Ticket reserved when the first result reconciliation read fails", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    const saved = f.editing.save(initial.id, 0, repoId, { ...initial.form, draft });
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "draft");
    f.detail.mockRejectedValueOnce(new Error("Temporarily unavailable"));
    await f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(initial.id).phase).toBe("outcome-unknown");
    const opened = await f.editing.open({ kind: "ticket", repoId, key: "PRB-421" });
    expect(opened.id).toBe(initial.id);
    const edited = f.editing.save(opened.id, opened.revision, repoId, { ...opened.form, newPath: "packages/unfinished" });
    expect(await new ContractEditing(f.io).open({ kind: "ticket", repoId, key: "PRB-421" })).toEqual(edited);
    expect(f.records()).toHaveLength(1);
  });

  it("rejects invalid submissions and failed durable writes before launching work", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    await expect(f.editing.submit(initial.id, initial.revision, crypto.randomUUID(), "draft")).rejects.toThrow();
    const saved = f.editing.save(initial.id, initial.revision, repoId, { ...initial.form, draft });
    f.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    await expect(f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "compile")).rejects.toThrow("Disk full");
    expect(f.editing.read(saved.id)).toEqual(saved);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("reports a terminal receipt write failure and reconciles it after storage recovers", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    const saved = f.editing.save(initial.id, 0, repoId, { ...initial.form, draft });
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "compile");
    f.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    await expect(f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" })).rejects.toThrow("Disk full");
    expect(f.editing.read(saved.id)).toMatchObject({ phase: "outcome-unknown", error: expect.stringContaining("could not be saved") });
    expect(await f.editing.open({ kind: "session", id: saved.id })).toMatchObject({ key: "PRB-421", phase: "editing", operation: { state: "completed" } });
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("returns disconnected drafts for recovery and allows rebinding only before admission", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    const saved = f.editing.save(initial.id, 0, repoId, { ...initial.form, draft });
    f.repositories.delete(repoId);
    const recovered = await new ContractEditing(f.io).open({ kind: "new", repoId: otherRepo });
    expect(recovered).toMatchObject({ id: saved.id, phase: "conflict", form: { draft } });
    expect(f.editing.save(saved.id, recovered.revision, otherRepo, recovered.form)).toMatchObject({ phase: "editing", repoId: otherRepo });
  });

  it.each([false, true])("a late canonical read cannot revive discarded edits (failure: %s)", async (failure) => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "ticket", repoId, key: "PRB-421" });
    const reply = deferred<Detail>();
    f.detail.mockImplementationOnce(() => reply.promise);
    const opening = f.editing.open({ kind: "session", id: initial.id });
    await vi.waitFor(() => expect(f.detail).toHaveBeenCalledTimes(3));
    const discarded = f.editing.discard(initial.id, initial.revision);
    reply.resolve({ ...f.details.get(repoId + ":PRB-421")!, digest: "b".repeat(64) });
    if (failure) f.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    await opening.catch(() => undefined);
    expect(f.editing.read(initial.id)).toEqual(discarded);
  });

  it("completed receipts do not exhaust the unfinished-session limit", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    f.io.persist(Array.from({ length: 101 }, () => ({ ...initial, id: crypto.randomUUID(), resumeNew: false, phase: "ready" as const })));
    expect((await f.editing.open({ kind: "new", repoId })).phase).toBe("editing");
  });
});

/**
 * SCP-313: the interview's conversation lives on the editing session, so
 * leaving planning mode and restarting the app both come back to it (D-102).
 */
describe("the interview's conversation on an editing session", () => {
  it("numbers each line, leaves the revision alone, and drops the oldest past the cap", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    const at = "2026-01-01T00:00:00.000Z";
    const first = f.editing.converse(session.id, { kind: "turn", text: "why two nodes?" }, at);
    expect(first).toEqual({ n: 1, at, line: { kind: "turn", text: "why two nodes?" } });
    f.editing.converse(session.id, { kind: "said", text: "Because the retry path is separate." }, at);
    // A chat that bumped the revision would make every save in flight stale.
    expect(f.editing.read(session.id).revision).toBe(session.revision);
    expect(f.editing.read(session.id).conversation.map((line) => line.n)).toEqual([1, 2]);

    for (let count = 0; count < INTERVIEW_CONVERSATION_CAP; count++)
      f.editing.converse(session.id, { kind: "note", text: `line ${String(count)}` }, at);
    const kept = f.editing.read(session.id).conversation;
    expect(kept).toHaveLength(INTERVIEW_CONVERSATION_CAP);
    // The numbers keep counting, so the chat can say the beginning is not kept.
    expect(kept[0]!.n).toBe(3);
    expect(kept.at(-1)!.n).toBe(INTERVIEW_CONVERSATION_CAP + 2);
  });

  it("records the interview's own session id, which is what continues it", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    expect(session.interviewSession).toBeNull();
    const recorded = f.editing.recordInterview(session.id, "sdk-session-1", "claude");
    expect(recorded.interviewSession).toBe("sdk-session-1");
    expect(recorded.interviewProvider).toBe("claude");
  });
});

describe("editor binding lifecycle", () => {
  it("starts a usable new editor after discarding a failed save", async () => {
    const f = await fixture();
    vi.spyOn(bridge, "request").mockImplementation(f.connection.request);
    vi.spyOn(bridge, "subscribe").mockImplementation(f.connection.subscribe);
    const client = new QueryClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const open = () => renderHook(() => useContractEditing({ kind: "new", repoId }, models), { wrapper });
    const first = open();
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    const discardedId = first.result.current.session!.id;
    f.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    await act(async () => {
      first.result.current.update({ draft });
      await expect(flushContractEditors()).rejects.toThrow(/could not be saved/);
    });
    await act(async () => { expect(await first.result.current.discard()).toBe(true); });
    first.unmount();
    const second = open();
    await waitFor(() => {
      expect(second.result.current.session?.phase).toBe("editing");
      expect(second.result.current.session?.id).not.toBe(discardedId);
    });
    await act(async () => {
      second.result.current.update({ draft: { ...draft, outcome: "The next task saves normally" } });
      await flushContractEditors();
    });
    expect(f.records().find((entry) => entry.id === second.result.current.session!.id)?.form.draft.outcome).toBe("The next task saves normally");
    second.unmount();
    client.clear();
  });

  it("does not lose completion behind an earlier in-flight session read", async () => {
    const f = await fixture();
    const editor = new ContractEditor(f.connection, { kind: "new", repoId }, models);
    const disconnect = editor.connect();
    await vi.waitFor(() => expect(editor.getSnapshot().loading).toBe(false));
    editor.update({ draft });
    editor.submit("draft");
    await flushContractEditors();
    const old = deferred<EditingSession>(), original = f.request.getMockImplementation()!;
    let reads = 0;
    f.request.mockImplementation(async (request) => request.kind === "editingRead" && ++reads === 1 ? old.promise : original(request));
    const stale = structuredClone(editor.getSnapshot().session!);
    f.emit({ kind: "editing", sequence: 1, sessionId: stale.id });
    await f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" });
    f.emit({ kind: "records", sequence: 2, repoId, key: "PRB-421" });
    old.resolve(stale);
    await vi.waitFor(() => expect(editor.getSnapshot().session).toMatchObject({ phase: "editing", key: "PRB-421" }));
    expect(reads).toBe(2);
    disconnect();
  });

  /**
   * A session that changes under every read never settles, and the editor
   * follows the same ceiling every other guarded read does: it stops reading,
   * says so where the screen can show it, and leaves the next change or the
   * next refresh to read again.
   */
  it("refuses a session read that every change overlaps", async () => {
    const f = await fixture();
    const editor = new ContractEditor(f.connection, { kind: "new", repoId }, models);
    const disconnect = editor.connect();
    await vi.waitFor(() => expect(editor.getSnapshot().loading).toBe(false));
    const original = f.request.getMockImplementation()!;
    let reads = 0;
    // Changes for longer than the ceiling allows, then settles: an unbounded
    // loop reads the settled session and reports no failure at all.
    f.request.mockImplementation(async (request) => {
      if (request.kind !== "editingRead") return original(request);
      reads += 1;
      if (reads <= READ_ATTEMPTS + 5) {
        await Promise.resolve();
        f.emit({ kind: "records", sequence: reads, repoId: null, key: null });
      }
      return original(request);
    });
    f.emit({ kind: "records", sequence: 0, repoId: null, key: null });
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(READ_ATTEMPTS));
    expect(reads).toBe(READ_ATTEMPTS);
    expect(editor.getSnapshot().error).toMatch(/changed while every attempt to read them/);
    disconnect();
  });

  it("cancels queued submission before dispatch and flushes pending edits before closing", async () => {
    const f = await fixture();
    const editor = new ContractEditor(f.connection, { kind: "new", repoId }, models);
    const disconnect = editor.connect();
    await vi.waitFor(() => expect(editor.getSnapshot().loading).toBe(false));
    const saved = deferred<void>(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => { if (request.kind === "editingSave") await saved.promise; return original(request); });
    editor.update({ draft });
    editor.submit("draft");
    editor.stop();
    disconnect();
    let closed = false;
    const closing = flushContractEditors().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    saved.resolve();
    await closing;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.records()[0]!.form.draft).toEqual(draft);
  });

  it("cancels an owned submission even when its acknowledgment arrives after navigation", async () => {
    const f = await fixture();
    const editor = new ContractEditor(f.connection, { kind: "new", repoId }, models);
    const disconnect = editor.connect();
    await vi.waitFor(() => expect(editor.getSnapshot().loading).toBe(false));
    editor.update({ draft });
    await flushContractEditors();
    const acknowledgment = deferred<void>(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => { const reply = await original(request); if (request.kind === "editingSubmit") await acknowledgment.promise; return reply; });
    editor.submit("draft");
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    editor.stop();
    disconnect();
    acknowledgment.resolve();
    await flushContractEditors();
    expect(f.stop).toHaveBeenCalledWith(f.jobs[0]!.id);
    expect(f.records()[0]!.operation?.state).toBe("cancelled");
  });

  it("retains a failed save across navigation and blocks closing until it is recovered", async () => {
    const f = await fixture();
    const editor = new ContractEditor(f.connection, { kind: "new", repoId }, models);
    const disconnect = editor.connect();
    await vi.waitFor(() => expect(editor.getSnapshot().loading).toBe(false));
    f.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    editor.update({ draft });
    await expect(flushContractEditors()).rejects.toThrow(/could not be saved/);
    disconnect();
    const disconnectAgain = editor.connect();
    expect(editor.getSnapshot().form.draft).toEqual(draft);
    await editor.retry();
    await flushContractEditors();
    expect(f.records()[0]!.form.draft).toEqual(draft);
    disconnectAgain();
  });
});

describe("which session an interview continues", () => {
  const recorded = (
    interviewSession: string | null,
    interviewProvider: "claude" | "codex" | null,
  ) => ({ interviewSession, interviewProvider });

  it("carries a recorded id only for the provider that reported it", () => {
    expect(interviewSessionArgs(recorded("sdk-1", "claude"), "claude")).toEqual([
      "--session",
      "sdk-1",
    ]);
    expect(interviewSessionArgs(recorded("thread-1", "codex"), "codex")).toEqual([
      "--session",
      "thread-1",
    ]);
    // The planning's drafting choice has changed since: the new provider has
    // never heard of this id, so the session starts fresh.
    expect(interviewSessionArgs(recorded("sdk-1", "claude"), "codex")).toEqual([]);
    expect(interviewSessionArgs(recorded("thread-1", "codex"), "claude")).toEqual([]);
    // Nothing recorded, and a record from before the provider was written down.
    expect(interviewSessionArgs(recorded(null, null), "claude")).toEqual([]);
    // Recorded before the provider was written down: Claude's, as `perbo
    // interview` reads it, so a planning in flight keeps its session.
    expect(interviewSessionArgs(recorded("sdk-1", null), "claude")).toEqual(["--session", "sdk-1"]);
    expect(interviewSessionArgs(recorded("sdk-1", null), "codex")).toEqual([]);
  });

  it("reads the provider off the planning's drafting choice", () => {
    expect(interviewProviderFor({ draftingProvider: "codex-cli" })).toBe("codex");
    expect(interviewProviderFor({ draftingProvider: "claude-cli" })).toBe("claude");
  });
});
