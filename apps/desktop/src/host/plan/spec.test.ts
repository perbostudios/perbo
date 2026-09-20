import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditingSessionSchema, SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import { editingForm } from "../../shared/contract-editing.js";
import { mintSpecFromTitle, saveSpec, specView, type SpecDeps } from "./spec.js";
import type { EditingSession, RequestOf, SpecSections } from "../../shared/protocol.js";
import type { RegisteredRepository } from "../profile/store.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const repoId = "80000000-0000-4000-8000-000000000001";
const sessionId = "80000000-0000-4000-8000-000000000002";
function repository(): RegisteredRepository {
  const root = mkdtempSync(join(tmpdir(), "perbo-spec-"));
  temporary.push(root);
  const path = join(root, "checkout");
  mkdirSync(path, { recursive: true });
  return { id: repoId, name: "checkout", path };
}
const session = (over: Record<string, unknown> = {}): EditingSession =>
  EditingSessionSchema.parse({
    version: 1,
    id: sessionId,
    repoId,
    key: null,
    digest: null,
    revision: 0,
    resumeNew: true,
    form: editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({}))),
    phase: "editing",
    error: null,
    operation: null,
    ...over,
  });
/** The rest of the host, as this module sees it: one session, one repository, no contract. */
function deps(
  repo: RegisteredRepository,
  record: EditingSession,
): SpecDeps & { recorded: string[] } {
  const recorded: string[] = [];
  let current = record;
  return {
    recorded,
    editing: {
      // The session records the slug it was given, as the editing records do.
      read: () => current,
      recordSpec: (_id: string, slug: string) => {
        recorded.push(slug);
        current = { ...current, specSlug: slug };
        return current;
      },
    },
    repository: () => repo,
    contract: () => ({ contract: { outcome: "P0" } as never }),
  };
}
const sections: SpecSections = {
  outcome: "A person can retry",
  requirements: "- The retry button is visible\n",
  no_gos: "",
  rabbit_holes: "",
  notes: "",
};
const request = (over: Partial<RequestOf<"specSave">> = {}): RequestOf<"specSave"> =>
  ({
    kind: "specSave",
    id: sessionId,
    repoId,
    title: "Retry a failed run",
    sections,
    base: { title: "", sections: { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" } },
    ...over,
  }) as RequestOf<"specSave">;

describe("specView", () => {
  it("is empty for a planning that has not named its spec", () => {
    const repo = repository();
    const view = specView(deps(repo, session()), sessionId);
    expect(view).toEqual({
      slug: null,
      path: null,
      title: "",
      sections: { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" },
      requirements: [],
    });
  });

  it("reads the file the repository holds, under the folder it names", () => {
    const repo = repository();
    const written = saveSpec(deps(repo, session()), repo, request());
    const record = session({ specSlug: written.view.slug });
    expect(written.view.path).toBe("specs/retry-a-failed-run/spec.md");
    const view = specView(deps(repo, record), sessionId);
    expect(view.title).toBe("Retry a failed run");
    expect(view.sections.outcome).toBe("A person can retry");
    expect(view.requirements.map((each) => each.text)).toEqual(["The retry button is visible"]);
  });

  it("shows what a writer outside the app wrote, because the file is what it reads", () => {
    const repo = repository();
    const written = saveSpec(deps(repo, session()), repo, request());
    const path = join(repo.path, "specs", written.view.slug!, "spec.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("A person can retry", "Edited by hand"));
    const view = specView(deps(repo, session({ specSlug: written.view.slug })), sessionId);
    expect(view.sections.outcome).toBe("Edited by hand");
  });
});

describe("saveSpec", () => {
  it("writes the spec, records its slug and answers with the file as written", () => {
    const repo = repository();
    const wiring = deps(repo, session());
    const reply = saveSpec(wiring, repo, request());
    expect(wiring.recorded).toEqual(["retry-a-failed-run"]);
    expect(reply.conflicting).toEqual([]);
    expect(reply.view.title).toBe("Retry a failed run");
    expect(readFileSync(join(repo.path, "specs", "retry-a-failed-run", "spec.md"), "utf8")).toContain(
      "A person can retry",
    );
  });

  it("refuses a planning that belongs to another repository", () => {
    const repo = repository();
    const other = { ...repo, id: "80000000-0000-4000-8000-00000000000f" };
    expect(() => saveSpec(deps(repo, session()), other, request())).toThrow(
      "This planning belongs to another repository.",
    );
  });

  it("writes nothing where another writer moved a section first, and says which", () => {
    const repo = repository();
    const first = saveSpec(deps(repo, session()), repo, request());
    const slug = first.view.slug!;
    const path = join(repo.path, "specs", slug, "spec.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("A person can retry", "The interview wrote this"));
    const record = session({ specSlug: slug });
    const reply = saveSpec(deps(repo, record), repo, request({
      sections: { ...sections, outcome: "The pane writes that" },
      base: { title: "Retry a failed run", sections },
    }));
    expect(reply.conflicting.length).toBeGreaterThan(0);
    // The file is untouched, and the view carries what is actually in it.
    expect(readFileSync(path, "utf8")).toContain("The interview wrote this");
    expect(reply.view.sections.outcome).toBe("The interview wrote this");
  });
});

describe("mintSpecFromTitle", () => {
  it("mints a folder from the title, with an otherwise empty spec", () => {
    const repo = repository();
    const written = mintSpecFromTitle(repo, "Retry a failed run");
    expect(written.slug).toBe("retry-a-failed-run");
    expect(written.folder).toBe("specs/retry-a-failed-run");
    const text = readFileSync(join(repo.path, written.folder, "spec.md"), "utf8");
    expect(text).toContain("Retry a failed run");
  });

  it("writes into the folder the repository's configuration names", () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo"), { recursive: true });
    writeFileSync(join(repo.path, ".perbo", "config.json"), JSON.stringify({ specs: "docs/specs" }));
    expect(mintSpecFromTitle(repo, "Retry a failed run").folder).toBe("docs/specs/retry-a-failed-run");
  });
});
