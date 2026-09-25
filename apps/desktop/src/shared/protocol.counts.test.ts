import { describe, expect, it } from "vitest";
import {
  DraftSchema,
  EditingFormSchema,
  EditingSessionSchema,
  InterviewEditSchema,
  ManifestEditorSchema,
  ModelCatalogSchema,
  RequestSchema,
  SettingsSchema,
  TaskModelsSchema,
} from "./protocol.js";
import { editingForm } from "./contract-editing.js";

/**
 * A record Perbo writes is read whole however many items it holds: a count
 * one reader capped would refuse what another writer produced, and the record
 * would be unreadable where it was needed.
 */

const repoId = "80000000-0000-4000-8000-000000000001";
const many = <T>(count: number, make: (at: number) => T): T[] => Array.from({ length: count }, (_, at) => make(at));
const globs = (count: number): string[] => many(count, (at) => `packages/p${at}/**`);
const criterion = { text: "A signup queues one email.", assertion: "one message is queued", kind: "test" as const };

describe("the counts a record holds", () => {
  it("reads a draft with as many allowed and prohibited paths as the plan has", () => {
    const draft = DraftSchema.parse({ outcome: "o", criteria: [criterion], paths: globs(60), prohibited: globs(60) });
    expect(draft.paths).toHaveLength(60);
    expect(draft.prohibited).toHaveLength(60);
  });

  it("reads the form the plan is edited in with as many paths as the plan has", () => {
    const form = editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({})));
    const parsed = EditingFormSchema.parse({ ...form, draft: { ...form.draft, paths: globs(60), prohibited: globs(60) } });
    expect(parsed.draft.paths).toHaveLength(60);
    expect(parsed.draft.prohibited).toHaveLength(60);
  });

  it("reads the form while it edits a criterion past the twentieth", () => {
    const form = editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({})));
    const criteria = many(25, () => criterion);
    const parsed = EditingFormSchema.parse({ ...form, draft: { ...form.draft, criteria }, editing: 24 });
    expect(parsed.editing).toBe(24);
  });

  it("reads an edit that changed more entities than a screen shows", () => {
    const keys = many(250, (at) => `criterion:ac_${at}`);
    const edit = InterviewEditSchema.parse({ n: 1, author: "interview", summary: "s", undone: false, undoes: null, before: keys, after: keys });
    expect(edit.before).toHaveLength(250);
    expect(edit.after).toHaveLength(250);
  });

  it("reads a planning with every edit it has had", () => {
    const history = many(600, (at) => ({
      n: at + 1,
      at: "2026-01-01T00:00:00.000Z",
      author: "you" as const,
      summary: `Marked packages/p${at}/ allowed`,
      undone: false,
      change: { kind: "mark" as const, glob: `packages/p${at}/**`, before: null, after: "allowed" as const, standing: null },
    }));
    const session = EditingSessionSchema.parse({
      version: 1, id: "80000000-0000-4000-8000-000000000002", repoId, key: null, digest: null, revision: 0,
      resumeNew: false, lastPane: null, confirmed: null, read: null, impact: null, specCut: null, named: null, drift: null, change: null,
      form: editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({}))), phase: "editing", error: null,
      operation: null, interviewModel: null, history,
    });
    expect(session.history).toHaveLength(600);
  });

  it("reads a manifest with as many entries and off-limits paths as the repository declares", () => {
    const entries = many(150, (at) => ({
      path: `config/local-${at}.json`,
      kind: "file" as const,
      source_path: `config/local-${at}.json`,
      strategy: "copy" as const,
      secret: false,
      required: false,
      reason: "local settings",
    }));
    const manifest = ManifestEditorSchema.parse({ entries, offLimits: globs(150) });
    expect(manifest.entries).toHaveLength(150);
    expect(manifest.offLimits).toHaveLength(150);
  });

  it("reads a model catalog with every model and effort a provider reports", () => {
    const catalog = ModelCatalogSchema.parse({
      provider: "anthropic",
      source: "anthropic-api",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      models: many(1500, (at) => ({
        id: `model-${at}`,
        label: `Model ${at}`,
        description: "",
        isDefault: at === 0,
        efforts: many(12, (each) => (["low", "medium", "high", "xhigh", "max", "ultra"] as const)[each % 6]!),
      })),
    });
    expect(catalog.models).toHaveLength(1500);
    expect(catalog.models[0]!.efforts).toHaveLength(12);
  });

  it("archives as many tickets as are chosen at once", () => {
    const keys = many(1500, (at) => `PRB-${at + 1}`);
    const request = RequestSchema.parse({ kind: "archive", repoId, keys, archived: true });
    expect(request.kind === "archive" && request.keys).toHaveLength(1500);
  });
});

describe("a ticket's name as a person gives it (D-127)", () => {
  const rename = (title: string) =>
    RequestSchema.safeParse({ kind: "rename", repoId, key: "PRB-1", title });

  it("takes sixty characters and refuses sixty-one", () => {
    expect(rename("n".repeat(60)).success).toBe(true);
    expect(rename("n".repeat(61)).success).toBe(false);
  });
});
