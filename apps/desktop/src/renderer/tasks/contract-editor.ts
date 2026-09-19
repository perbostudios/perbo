import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { EditingSessionSchema, LegacyEditingSchema, TaskModelsSchema } from "../../shared/protocol.js";
import type { DesktopBridge, Detail, EditingForm, EditingOperation, EditingSession, EditingTarget, LegacyEditing, TaskModels } from "../../shared/protocol.js";
import { editingForm } from "../../shared/contract-editing.js";
import { bridge } from "../data.js";

const saving = new Set<Promise<void>>();
const unsaved = new Set<ContractEditor>();
const editors = new WeakMap<QueryClient, Map<string, ContractEditor>>();
export async function flushContractEditors(): Promise<void> {
  while (saving.size) await Promise.all([...saving]);
  if (unsaved.size) throw new Error("Some contract edits could not be saved. Return to the editor to keep or retry them before closing.");
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
type EditorView = {
  session: EditingSession | null;
  form: EditingForm;
  repoId: string;
  record: Detail | undefined;
  loading: boolean;
  saving: boolean;
  submitting: boolean;
  error: string | null;
};

function legacyEditing(models: TaskModels): LegacyEditing | undefined {
  try {
    const draft: unknown = JSON.parse(sessionStorage.getItem("perbo:composer") ?? "null");
    if (!draft) return undefined;
    const saved: unknown = JSON.parse(sessionStorage.getItem("perbo:composer-record") ?? "null");
    const record = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
    return LegacyEditingSchema.parse({
      repoId: record.repoId ?? sessionStorage.getItem("perbo:composer-repo"),
      key: record.key ?? null, digest: record.digest ?? null,
      form: { ...editingForm(models), draft, step: sessionStorage.getItem("perbo:composer-step") === "2" ? 2 : 1 },
      pending: sessionStorage.getItem("perbo:composer-job") !== null,
    });
  } catch { return undefined; }
}

/** A session's binding across screens. Saves and unsaved text outlive navigation. */
export class ContractEditor {
  private readonly connection: DesktopBridge;
  private readonly target: EditingTarget;
  private readonly listeners = new Set<() => void>();
  private value: EditorView;
  private saved: EditingSession | null = null;
  private tail: Promise<void> = Promise.resolve();
  private changes = 0;
  private generation = 0;
  private failedSave = false;
  private unsubscribe: (() => void) | undefined;
  private reading: Promise<void> | null = null;
  private refreshRevision = 0;
  private connected = false;
  private readers = 0;
  private submission: { cancelled: boolean } | null = null;
  private readonly identified: (session: EditingSession) => void;

  constructor(connection: DesktopBridge, target: EditingTarget, models: TaskModels, detail?: Detail, identified: (session: EditingSession) => void = () => undefined) {
    this.connection = connection;
    this.target = target;
    this.identified = identified;
    this.value = { session: null, form: editingForm(models, detail), repoId: "repoId" in target ? target.repoId : "", record: detail, loading: true, saving: false, submitting: false, error: null };
  }
  getSnapshot = (): EditorView => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<EditorView>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  /**
   * Bind a screen to this session and return its release. Counted, because one
   * session is bound by more than one screen at a time — planning mode holds it
   * while the pane inside it does — and the first screen to leave must not take
   * the other's subscription with it.
   */
  connect = (): (() => void) => {
    this.readers++;
    this.open();
    return this.release;
  };
  private open = (): void => {
    // A session outlives its screen, including unsaved text after a failed write.
    if (this.connected) return;
    this.connected = true;
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = this.connection.subscribe((change) => {
      if ((change.kind === "editing" && change.sessionId === this.saved?.id) ||
        (change.kind === "records" && (change.repoId === null || change.repoId === this.saved?.repoId))) void this.refresh();
    });
    if (this.failedSave || this.value.saving || this.value.submitting) return;
    const legacy = this.target.kind === "new" ? legacyEditing(this.value.form.models) : undefined;
    const changes = this.changes;
    void this.connection.request({ kind: "editingOpen", target: this.saved ? { kind: "session", id: this.saved.id } : this.target, ...(legacy ? { legacy } : {}) })
      .then(async (result) => {
        if (generation !== this.generation || changes !== this.changes || this.value.saving || this.value.submitting) return;
        this.accept(result);
        if (legacy) for (const key of ["composer", "composer-record", "composer-repo", "composer-step", "composer-job"])
          sessionStorage.removeItem("perbo:" + key);
        await this.loadRecord(result, generation);
      })
      .catch((error) => { if (generation === this.generation) this.publish({ loading: false, error: message(error) }); });
  };
  private release = (): void => {
    if (--this.readers > 0) return;
    this.close();
  };
  private close = (): void => {
    this.connected = false;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  };
  private accept(result: EditingSession): void {
    const session = EditingSessionSchema.parse(result);
    this.saved = session;
    this.identified(session);
    this.publish({ session, form: session.form, repoId: session.repoId, loading: false, error: session.error });
  }
  private async loadRecord(session: EditingSession, generation: number): Promise<void> {
    if (!session.key) return;
    try {
      const record = await this.connection.request({ kind: "detail", repoId: session.repoId, key: session.key });
      if (generation === this.generation && this.saved?.id === session.id && this.saved.digest === session.digest)
        this.publish({ record });
    } catch (error) {
      if (generation === this.generation) this.publish({ error: message(error) });
    }
  }
  private refresh(): Promise<void> {
    this.refreshRevision++;
    if (this.reading) return this.reading;
    if (!this.saved || this.value.saving || this.value.submitting || this.failedSave) return Promise.resolve();
    const id = this.saved.id, changes = this.changes, generation = this.generation;
    this.reading = (async () => {
      for (;;) {
        const revision = this.refreshRevision;
        let session: EditingSession;
        try { session = await this.connection.request({ kind: "editingRead", id }); } catch (error) {
          if (revision !== this.refreshRevision) continue;
          throw error;
        }
        if (changes !== this.changes || generation !== this.generation || this.value.saving || this.value.submitting) return;
        if (revision !== this.refreshRevision) continue;
        if (session.revision < (this.saved?.revision ?? 0)) return;
        const oldDigest = this.saved?.digest;
        this.accept(session);
        if (session.digest !== oldDigest) await this.loadRecord(session, generation);
        if (revision !== this.refreshRevision) continue;
        return;
      }
    })().catch((error) => { if (generation === this.generation) this.publish({ error: message(error) }); }).finally(() => { this.reading = null; });
    return this.reading;
  }
  update = (patch: Partial<EditingForm>, repoId = this.value.repoId): void => {
    if (!this.saved || this.value.submitting || this.saved.phase === "working" || this.saved.phase === "discarded") return;
    const form = { ...this.value.form, ...patch }, change = ++this.changes;
    this.publish({ form, repoId, saving: true });
    const work = this.tail.then(async () => {
      if (!this.saved || this.failedSave) return;
      try {
        const session = await this.connection.request({ kind: "editingSave", id: this.saved.id, revision: this.saved.revision, repoId, form });
        this.saved = EditingSessionSchema.parse(session);
        if (change === this.changes) {
          this.accept(this.saved);
          this.publish({ saving: false });
          unsaved.delete(this);
        }
      } catch (error) {
        this.failedSave = true;
        unsaved.add(this);
        this.publish({ saving: true, error: message(error) });
      }
    });
    this.tail = work;
    saving.add(work);
    void work.finally(() => saving.delete(work));
  };
  submit = (intent: EditingOperation["intent"]): void => {
    if (this.value.submitting) return;
    this.publish({ submitting: true, error: null });
    const operationId = crypto.randomUUID();
    const submission = { cancelled: false };
    this.submission = submission;
    const work = this.tail.then(async () => {
      if (submission.cancelled) return;
      if (!this.saved || this.failedSave) throw new Error("Save the current edits before submitting.");
      const session = await this.connection.request({ kind: "editingSubmit", id: this.saved.id, revision: this.saved.revision, operationId, intent });
      this.accept(session);
      if (submission.cancelled) this.accept(await this.connection.request({ kind: "editingStop", id: session.id }));
    }).catch((error) => { this.publish({ error: message(error) }); }).finally(() => {
      this.publish({ submitting: false });
      this.submission = null;
      void this.refresh();
    });
    saving.add(work);
    void work.finally(() => saving.delete(work));
  };
  stop = (): void => {
    if (this.submission) { this.submission.cancelled = true; return; }
    if (!this.saved) return;
    void this.connection.request({ kind: "editingStop", id: this.saved.id }).then((session) => this.accept(session))
      .catch((error) => { this.publish({ error: message(error) }); });
  };
  discard = async (): Promise<boolean> => {
    await this.tail;
    if (!this.saved) return false;
    try {
      const current = await this.connection.request({ kind: "editingRead", id: this.saved.id });
      this.accept(await this.connection.request({ kind: "editingDiscard", id: current.id, revision: current.revision }));
      this.failedSave = false;
      this.publish({ saving: false });
      unsaved.delete(this);
      return true;
    } catch (error) {
      this.publish({ error: message(error) });
      return false;
    }
  };
  retry = async (): Promise<void> => {
    if (!this.saved) { this.close(); this.open(); return; }
    try {
      if (!this.failedSave) {
        this.accept(await this.connection.request({ kind: "editingOpen", target: { kind: "session", id: this.saved.id } }));
        await this.loadRecord(this.saved, this.generation);
        return;
      }
      const current = await this.connection.request({ kind: "editingRead", id: this.saved.id });
      if (current.revision !== this.saved.revision && JSON.stringify(current.form) !== JSON.stringify(this.value.form))
        throw new Error("The saved edits changed. Your text is preserved; open the current task to compare before replacing it.");
      this.saved = current;
      this.failedSave = false;
      this.update({ ...this.value.form });
      await this.tail;
    } catch (error) { this.publish({ error: message(error) }); }
  };
}

export function useContractEditing(target: EditingTarget, defaults: TaskModels, detail?: Detail) {
  const client = useQueryClient();
  const identity = target.kind === "new" ? "new" : JSON.stringify(target);
  const controller = useMemo(() => {
    let cache = editors.get(client);
    if (!cache) { cache = new Map(); editors.set(client, cache); }
    const cached = cache.get(identity), state = cached?.getSnapshot();
    if (cached && (state?.saving || (state?.session?.phase !== "discarded" &&
      (target.kind !== "new" || !state?.session || state.session.resumeNew)))) return cached;
    const created = new ContractEditor(bridge, target, TaskModelsSchema.strip().parse(defaults), detail, (session) => {
      cache!.set(JSON.stringify({ kind: "session", id: session.id }), created);
      if (session.key) cache!.set(JSON.stringify({ kind: "ticket", repoId: session.repoId, key: session.key }), created);
    });
    cache.set(identity, created);
    return created;
  }, [client, identity]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(controller.connect, [controller]);
  return { ...view, update: controller.update, submit: controller.submit, stop: controller.stop, discard: controller.discard, retry: controller.retry };
}
