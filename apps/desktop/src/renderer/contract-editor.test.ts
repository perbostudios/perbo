// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type PropsWithChildren } from "react";
import type { StandingProhibitedEntry } from "@perbo/contracts";
import { ContractEditing, editingForm, interviewProviderFor, interviewSessionArgs, keepsPersonsTitle, sameProblems, titleChanged, untouchedPlanning } from "../shared/contract-editing.js";
import { WorkspaceReads } from "../host/workspace-reads.js";
import { ContractEditor, flushContractEditors, useContractEditing } from "./contract-editor.js";
import { bridge } from "./workspace/index.js";
import { DraftSchema, EditingSessionSchema, INTERVIEW_CONVERSATION_CAP, TaskModelsSchema } from "../shared/protocol.js";
import { READ_ATTEMPTS } from "../shared/read-generations.js";
import type { Change, DesktopBridge, Detail, EditingSession, Job, ReplyMap, Request } from "../shared/protocol.js";
import { sampleBridge } from "../sample-host/bridge.js";

const repoId = "10000000-0000-4000-8000-000000000001";
const otherRepo = "10000000-0000-4000-8000-000000000002";
const models = TaskModelsSchema.parse({ executorEffort: null, reviewerEffort: null });
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
  const start = vi.fn(async (request: Extract<Request, { kind: "admit" | "edit" }>, owner: { sessionId: string; operationId: string }) => {
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
  const io = { records: () => records, persist, repository: (id: string) => { if (!repositories.has(id)) throw new Error("Disconnected"); }, defaults: () => models, detail, start, stop, id: () => crypto.randomUUID(), specFolder: () => "specs", standing: () => [...standing], setStanding: (_id: string, entries: StandingProhibitedEntry[]) => { standing = [...entries]; } };
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
    const running = await f.editing.submit(a.id, a.revision, operation, "compile");
    expect(await f.editing.submit(a.id, a.revision, operation, "compile")).toEqual(running);
    await expect(f.editing.submit(a.id, a.revision, operation, "generate")).rejects.toThrow(/different input/);
    const b = await f.editing.open({ kind: "ticket", repoId: otherRepo, key: "PRB-421" });
    const savedB = f.editing.save(b.id, b.revision, otherRepo, { ...b.form, criterion: { text: "B's unfinished text", assertion: "", kind: "test" } });
    const job = f.jobs[0]!;
    await f.editing.settled({ ...job, repoId: otherRepo, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(a.id).phase).toBe("working");
    await f.editing.settled({ ...job, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(a.id)).toMatchObject({ key: "PRB-421", repoId, phase: "ready" });
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
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "compile");
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
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "compile");
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
    expect(await restarted.submit(conflict.id, saved.revision, conflict.operation!.id, "compile")).toEqual(conflict);
    await expect(restarted.submit(conflict.id, conflict.revision, crypto.randomUUID(), "compile")).rejects.toThrow(/Restore/);
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
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "compile");
    f.detail.mockRejectedValueOnce(new Error("Temporarily unavailable"));
    await f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(initial.id).phase).toBe("outcome-unknown");
    const opened = await f.editing.open({ kind: "ticket", repoId, key: "PRB-421" });
    expect(opened.id).toBe(initial.id);
    const edited = f.editing.save(opened.id, opened.revision, repoId, { ...opened.form, newPath: "packages/unfinished" });
    expect(await new ContractEditing(f.io).open({ kind: "ticket", repoId, key: "PRB-421" })).toEqual(edited);
    expect(f.records()).toHaveLength(1);
  });

  it("takes a plan of twenty-five criteria as its result, and a session left unread by it on its next open", async () => {
    const f = await fixture();
    const sample = f.details.get(repoId + ":PRB-421")!;
    if (!("acceptance_criteria" in sample.contract)) throw new Error("The sample is a flat plan");
    const [first] = sample.contract.acceptance_criteria;
    sample.contract.acceptance_criteria = Array.from({ length: 25 }, (_, at) => ({ ...first!, id: `ac_${at + 1}`, text: `Criterion ${at + 1}` }));
    const initial = await f.editing.open({ kind: "new", repoId });
    const saved = f.editing.save(initial.id, 0, repoId, { ...initial.form, draft });
    await f.editing.submit(saved.id, saved.revision, crypto.randomUUID(), "compile");
    await f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(saved.id)).toMatchObject({ key: "PRB-421", phase: "ready", error: null });
    expect(f.editing.read(saved.id).form.draft.criteria).toHaveLength(25);

    // A session recorded as the reconcile that could not read its result left it.
    const [record] = f.records();
    f.io.persist([{
      ...record!, key: null, digest: null, phase: "outcome-unknown", form: saved.form,
      error: "Your edits and operation were saved, but the recorded result could not be read: too_big",
      operation: { ...record!.operation!, reconciled: false },
    }]);
    const restarted = new ContractEditing(f.io);
    restarted.recover();
    const opened = await restarted.open({ kind: "session", id: saved.id });
    expect(opened).toMatchObject({ key: "PRB-421", phase: "editing", error: null, operation: { reconciled: true } });
    expect(DraftSchema.parse(opened.form.draft).criteria).toHaveLength(25);
  });

  it("rejects invalid submissions and failed durable writes before launching work", async () => {
    const f = await fixture();
    const initial = await f.editing.open({ kind: "new", repoId });
    await expect(f.editing.submit(initial.id, initial.revision, crypto.randomUUID(), "compile")).rejects.toThrow();
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

describe("taking the ticket drafted from this planning's spec", () => {
  it("fills a session that holds none, and does not claim that session made it", async () => {
    // A ticket drafted from this planning's spec outside the app — at the
    // command line — is reconciled by nothing: without this the session that
    // wrote the spec still holds no ticket, the rail offers no Graph over a
    // plan that exists, and the plan shows up in the picker as a second row
    // for work that is one thing (D-101, D-103).
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    expect(session.key, "nothing drafted yet").toBeNull();
    const revision = session.revision;

    const drafted = await f.io.detail(repoId, "PRB-421");
    const taken = f.editing.adopt(session.id, drafted, 3);
    expect(taken.key).toBe("PRB-421");
    expect(taken.digest).toBe(drafted.digest);
    // The contract's own scope, not `editingForm`'s placeholder: a session
    // carrying a scope the contract does not is read as having unsaved paths,
    // which blocks approving the plan it just drafted.
    expect(taken.form.draft.paths).toEqual(drafted.contract.scope.paths_allowed);
    expect(taken.form.draft.paths).not.toEqual(session.form.draft.paths);
    expect(taken.form.draft.outcome).toBe(drafted.contract.outcome);
    // The count the rail reads, which is drawn where no contract can be read.
    expect(taken.nodes).toBe(3);
    // And it did not make the ticket: this is a plan admitted at the command
    // line, found by the planning that wrote its spec. Whether a planning made
    // its ticket is what lets discarding it take the ticket rather than leave
    // one behind, and discarding this one must leave work it did not do.
    expect(taken.admitted).toBe(false);
    expect(taken.resumeNew).toBe(false);
    // And a save in flight is not made stale by a change the person did not
    // make, as a chat line is not.
    expect(taken.revision).toBe(revision);
  });

  it("leaves a session that already holds one alone", async () => {
    // A session on a ticket re-drafted its own plan, and the key it has is the
    // key to keep: taking another would move the planning onto somebody else's
    // ticket behind their back.
    const f = await fixture();
    const session = await f.editing.open({ kind: "ticket", repoId, key: "PRB-421" });
    expect(session.key).toBe("PRB-421");
    const other = await f.io.detail(otherRepo, "PRB-421");
    other.ticket.key = "PRB-9";
    const kept = f.editing.adopt(session.id, other, 3);
    expect(kept.key).toBe("PRB-421");
  });

  it("leaves a discarded session alone", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    f.editing.discard(session.id);
    const gone = f.editing.adopt(session.id, await f.io.detail(repoId, "PRB-421"), 3);
    expect(gone.phase).toBe("discarded");
    expect(gone.key).toBeNull();
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

  it("ends an asking without a turn, and leaves its line to be read", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    const at = "2026-01-01T00:00:00.000Z";
    const asked = f.editing.converse(
      session.id,
      {
        kind: "asked",
        groups: [
          {
            title: "Criterion 1 and R1",
            parts: [
              {
                question: "Which?",
                options: [
                  { label: "This", detail: null, recommended: true },
                  { label: "That", detail: null, recommended: false },
                ],
              },
            ],
          },
        ],
        drift: { open: 1 },
      },
      at,
    );
    f.editing.beginAsking(session.id, asked.n);
    expect(f.editing.read(session.id).asking).toEqual({ entry: asked.n, answered: 0 });
    f.editing.endAsking(session.id);
    const ended = f.editing.read(session.id);
    expect(ended.asking).toBeNull();
    expect(ended.conversation.at(-1)).toEqual(asked);
    expect(ended.revision).toBe(session.revision);
  });

  it("puts the session's own question behind a problem in front of the person, and a later reading's problem over the one before", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    const id = session.id;
    const at = "2026-01-01T00:00:00.000Z";
    const say = (line: Parameters<typeof f.editing.converse>[1]) => f.editing.converse(id, line, at);
    const finding = (heading: string) => ({
      heading,
      difference: `${heading} says something else.`,
      options: [
        { label: "Change the plan", detail: null, recommended: true },
        { label: "Change the spec", detail: null, recommended: false },
      ],
    });
    const verdict = (findings: ReturnType<typeof finding>[]) =>
      ({ findings, dismissed: false }) as unknown as Parameters<typeof f.editing.landDrift>[1];
    f.editing.landDrift(id, verdict([finding("Criterion 1 and R1")]), false, say, () => undefined);
    const problem = f.editing.read(id).asking!.entry;
    // The session asks while the problem is in front of the person: it waits.
    const asked = say({
      kind: "asked",
      groups: [{ title: "Where it lands", parts: [{ question: "Where?", options: [{ label: "Home", detail: null, recommended: false }, { label: "Board", detail: null, recommended: false }] }] }],
    });
    f.editing.beginAsking(id, asked.n);
    expect(f.editing.read(id).asking).toEqual({ entry: problem, answered: 0 });
    expect(f.editing.read(id).askingNext).toEqual([asked.n]);
    // A later reading finds another problem: it replaces the one it read
    // before, and the question still waits behind it.
    f.editing.landDrift(id, verdict([finding("Criterion 2 and R2")]), false, say, () => undefined);
    const next = f.editing.read(id).asking!.entry;
    expect(next).toBeGreaterThan(asked.n);
    expect(f.editing.read(id).askingNext).toEqual([asked.n]);
    // Closed by hand: the problem's card comes down and the question is put.
    f.editing.landDrift(id, verdict([]), false, say, () => undefined);
    expect(f.editing.read(id).asking).toEqual({ entry: asked.n, answered: 0 });
    expect(f.editing.read(id).askingNext).toEqual([]);
  });

  it("records the interview's own session id, which is what continues it", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "new", repoId });
    expect(session.interviewSession).toBeNull();
    const recorded = f.editing.recordInterview(session.id, "sdk-session-1", "claude", "claude-opus-5");
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
    editor.submit("compile");
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
    editor.submit("compile");
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
    editor.submit("compile");
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

describe("whether two readings found the same problems (D-128)", () => {
  const problem = (heading: string, difference: string, label = "Reword it.") => ({
    heading,
    difference,
    options: [{ label, detail: null, recommended: true }],
  });
  const one = problem("Criterion 1 and R1", "R1 asks for one email; criterion 1 promises two.");
  const two = problem("Criterion 2 and R2", "R2 asks for a retry; criterion 2 promises none.");

  it("compares the places and the differences as a set, and not the options or the order", () => {
    expect(sameProblems([one, two], [two, one])).toBe(true);
    // Worded afresh: the ways to close it are the model's each reading, and
    // a new wording of them is not a new problem.
    expect(sameProblems([one], [{ ...one, options: [{ label: "Drop it.", detail: "Or so", recommended: false }] }])).toBe(true);
    expect(sameProblems([], [])).toBe(true);
  });

  it("tells a different place, a different difference and a different count apart", () => {
    expect(sameProblems([one], [two])).toBe(false);
    expect(sameProblems([one], [{ ...one, difference: "R1 asks for one email; criterion 1 promises three." }])).toBe(false);
    expect(sameProblems([one], [{ ...one, heading: "Criterion 1 and R2" }])).toBe(false);
    expect(sameProblems([one, two], [one])).toBe(false);
    expect(sameProblems([one], [one, two])).toBe(false);
    // The same problem twice is one problem: what is compared is the set.
    expect(sameProblems([one, one], [one])).toBe(true);
  });
});

describe("a planning that holds nothing (D-129)", () => {
  // What `editingOpen {kind:"fresh"}` mints, which is the one shape that holds
  // nothing; each case below puts one thing into it.
  const born = (over: Record<string, unknown> = {}): EditingSession =>
    EditingSessionSchema.parse({
      version: 1,
      id: "20000000-0000-4000-8000-000000000001",
      repoId,
      key: null,
      digest: null,
      revision: 0,
      resumeNew: false,
      lastPane: null,
      confirmed: null, read: null, impact: null,
      named: null,
      drift: null,
      change: null,
      form: editingForm(models),
      phase: "editing",
      error: null,
      operation: null,
      interviewModel: null,
      ...over,
    });

  it("is what a planning opened fresh and left alone is", () => {
    expect(untouchedPlanning(born())).toBe(true);
  });

  it("is not a planning whose spec folder was written", () => {
    expect(untouchedPlanning(born({ specSlug: "have-a-dark-mode" }))).toBe(false);
  });

  it("is not a planning opened over a ticket", () => {
    expect(untouchedPlanning(born({ key: "PRB-421" }))).toBe(false);
  });

  it("is not a planning the person has said something to", () => {
    // `converse` leaves the revision alone deliberately, so a turn is visible
    // here and nowhere else.
    const talked = born({
      conversation: [{ n: 1, at: new Date().toISOString(), line: { kind: "turn", text: "add a dark mode" } }],
    });
    expect(talked.revision).toBe(0);
    expect(untouchedPlanning(talked)).toBe(false);
  });

  it("is not a planning anything was edited in", () => {
    expect(untouchedPlanning(born({ revision: 1 }))).toBe(false);
  });

  it("is not a planning with work in hand", () => {
    expect(untouchedPlanning(born({ phase: "working" }))).toBe(false);
    expect(
      untouchedPlanning(
        born({
          operation: {
            id: "20000000-0000-4000-8000-000000000002",
            intent: "compile",
            inputRevision: 0,
            jobId: null,
            state: "running",
            resultKey: null,
            error: null,
            reconciled: false,
          },
        }),
      ),
    ).toBe(false);
  });

  it("is not the session a new draft resumes", () => {
    expect(untouchedPlanning(born({ resumeNew: true }))).toBe(false);
  });

  it("is still a planning that was only looked around in", () => {
    expect(untouchedPlanning(born({ lastPane: "explorer" }))).toBe(true);
  });
});

describe("who named the spec (D-127)", () => {
  it("is nobody at birth, and a record without it is not a session", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    expect(session.named).toBeNull();
    const without: Record<string, unknown> = { ...session };
    delete without["named"];
    expect(EditingSessionSchema.safeParse(without).success).toBe(false);
  });

  it("keeps the person's title while the spec states it, and not once the Architect retitles it", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    f.editing.personTitled(session.id, "  Dark   mode ");
    const named = f.editing.read(session.id);
    expect(named.named).toEqual({ by: "person", title: "Dark mode" });
    expect(keepsPersonsTitle(named, "Dark mode")).toBe(true);
    // A title the spec no longer states is not the person's.
    expect(keepsPersonsTitle(named, "Theme switch")).toBe(false);
    expect(keepsPersonsTitle(named, null)).toBe(false);
    // A turn that ends on the person's own title changed nothing of it.
    f.editing.architectTitled(session.id, "Dark mode");
    expect(f.editing.read(session.id).named).toEqual({ by: "person", title: "Dark mode" });
    f.editing.architectTitled(session.id, "Theme switch");
    const retitled = f.editing.read(session.id);
    expect(retitled.named).toEqual({ by: "architect", title: "Theme switch" });
    expect(keepsPersonsTitle(retitled, "Theme switch")).toBe(false);
    // And the person naming it again is theirs again.
    f.editing.personTitled(session.id, "Night mode");
    expect(keepsPersonsTitle(f.editing.read(session.id), "Night mode")).toBe(true);
  });

  it("folds a title of any length to one line and keeps it whole, for admission to rename or refuse (D-127)", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    const words = Array.from({ length: 100 }, (_, n) => `word${n}`);
    const title = words.join(" \n ");
    const folded = words.join(" ");
    expect(folded.length).toBeGreaterThan(500);
    // The Architect's: recorded whole, and not the person's, so the plan is
    // drafted without --keep-title and the drafter's name replaces it.
    f.editing.architectTitled(session.id, title);
    const architect = EditingSessionSchema.parse(f.records().find((record) => record.id === session.id));
    expect(architect.named).toEqual({ by: "architect", title: folded });
    expect(keepsPersonsTitle(architect, title)).toBe(false);
    // The person's: recorded whole and kept, so the plan is drafted with
    // --keep-title, which refuses a name past the cap rather than cutting it
    // (admit.from-spec.test.ts, "refuses a title longer than a ticket's name may be").
    f.editing.personTitled(session.id, title);
    expect(f.editing.read(session.id).named).toEqual({ by: "person", title: folded });
    expect(keepsPersonsTitle(f.editing.read(session.id), title)).toBe(true);
    expect(keepsPersonsTitle(f.editing.read(session.id), `${folded.slice(0, 500)} changed`)).toBe(false);
    // A save that changes a long title past any column is a change.
    expect(titleChanged({ title: `${folded} a`, base: { title: `${folded} b` } })).toBe(true);
  });

  it("does not take a spec left with no title line for the Architect's title (D-118)", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    f.editing.recordSpec(session.id, "dark-mode");
    f.editing.architectTitled(session.id, "");
    f.editing.architectTitled(session.id, "  ");
    expect(f.editing.read(session.id).named).toBeNull();
  });
});

describe("the pane a planning was left at (D-130)", () => {
  it("is none at birth, and a record without one is not a session", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    expect(session.lastPane).toBeNull();
    const without: Record<string, unknown> = { ...session };
    delete without["lastPane"];
    expect(EditingSessionSchema.safeParse(without).success).toBe(false);
  });

  it("records the pane without moving the revision, so a save read before it still lands", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    const visited = f.editing.visit(session.id, "explorer");
    expect(visited.lastPane).toBe("explorer");
    expect(visited.revision).toBe(session.revision);
    expect(untouchedPlanning(visited)).toBe(true);
    expect(f.editing.read(session.id).lastPane).toBe("explorer");
    const saved = f.editing.save(session.id, session.revision, repoId, { ...session.form, draft: { ...session.form.draft, outcome: "Written" } });
    expect(saved.lastPane).toBe("explorer");
  });

  it("writes nothing for the pane it is already on, nor for a discarded planning", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    f.editing.visit(session.id, "impact");
    const writes = f.persist.mock.calls.length;
    f.editing.visit(session.id, "impact");
    expect(f.persist.mock.calls.length).toBe(writes);
    f.editing.discard(session.id);
    const discarded = f.persist.mock.calls.length;
    expect(f.editing.visit(session.id, "spec").lastPane).toBe("impact");
    expect(f.persist.mock.calls.length).toBe(discarded);
  });

  it("keeps what the impact check found and the state last read until a fresh draft replaces the plan they were of, and not through a compile (D-NEW-basic-and-epic-flows)", async () => {
    const f = await fixture();
    const opened = await f.editing.open({ kind: "ticket", repoId, key: "PRB-421" });
    f.editing.recordSpec(opened.id, "a-spec");
    f.editing.recordImpact(opened.id, 3);
    f.editing.recordRead(opened.id, "state-read");
    expect(f.editing.read(opened.id).impact).toBe(3);
    expect(f.editing.read(opened.id).read).toBe("state-read");
    const compiled = f.editing.read(opened.id);
    await f.editing.submit(opened.id, compiled.revision, crypto.randomUUID(), "compile");
    await f.editing.settled({ ...f.jobs[0]!, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(opened.id).impact).toBe(3);
    expect(f.editing.read(opened.id).read).toBe("state-read");
    const ready = await f.editing.open({ kind: "session", id: opened.id });
    await f.editing.submit(opened.id, ready.revision, crypto.randomUUID(), "startOver");
    await f.editing.settled({ ...f.jobs[1]!, state: "completed", resultKey: "PRB-421" });
    expect(f.editing.read(opened.id).impact).toBeNull();
    expect(f.editing.read(opened.id).read).toBeNull();
  });

  it("records the contract as the last pane with the state it was reached at, writes nothing twice, and records it again at a new state", async () => {
    const f = await fixture();
    const session = await f.editing.open({ kind: "fresh", repoId });
    expect(session.confirmed).toBeNull();
    f.editing.visit(session.id, "graph");
    const atContract = f.editing.visitContract(session.id, "state-1");
    expect(atContract).toMatchObject({ lastPane: "contract", confirmed: "state-1", revision: session.revision });
    const writes = f.persist.mock.calls.length;
    f.editing.visitContract(session.id, "state-1");
    expect(f.persist.mock.calls.length).toBe(writes);
    // Reached again once something moved: the new state is the one that holds.
    expect(f.editing.visitContract(session.id, "state-2").confirmed).toBe("state-2");
    // A pane reached after is the last place, and the state stays for the tab.
    expect(f.editing.visit(session.id, "graph")).toMatchObject({ lastPane: "graph", confirmed: "state-2" });
    f.editing.discard(session.id);
    expect(f.editing.visitContract(session.id, "state-3").confirmed).toBe("state-2");
  });
});
