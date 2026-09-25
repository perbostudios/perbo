import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { EditingSessionSchema, SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import { editingForm } from "../../shared/contract-editing.js";
import { mintSpecFromTitle, saveSpec, specView, type SpecDeps } from "./spec.js";
import type { EditingSession, RequestOf, SpecSections } from "../../shared/protocol.js";
import type { RegisteredRepository } from "../profile/store.js";

const scratchDirectory = createScratch("perbo-spec-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const repoId = "80000000-0000-4000-8000-000000000001";
const sessionId = "80000000-0000-4000-8000-000000000002";
function repository(): RegisteredRepository {
  const root = scratchDirectory();
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
    drift: null,
    change: null,
    lastPane: null,
    confirmed: null, read: null, impact: null,
    specCut: null,
    named: null,
    interviewModel: null,
    ...over,
  });
/** The rest of the host, as this module sees it: one session, one repository, no contract. */
function deps(
  repo: RegisteredRepository,
  record: EditingSession,
): SpecDeps & { recorded: string[]; titled: string[] } {
  const recorded: string[] = [];
  const titled: string[] = [];
  let current = record;
  return {
    recorded,
    titled,
    editing: {
      // The session records the slug it was given, as the editing records do.
      read: () => current,
      recordSpec: (_id: string, slug: string) => {
        recorded.push(slug);
        current = { ...current, specSlug: slug };
        return current;
      },
      personTitled: (_id: string, title: string) => {
        titled.push(title);
      },
    },
    repository: () => repo,
    contract: () => ({ contract: { outcome: "P0" } as never }),
    marks: { markChangeOn: () => undefined },
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
    // The requirement keeps the id the file gives it, whoever last wrote it.
    expect(view.requirements[0]?.id).toBe("R1");
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

  it("records the person as naming the spec where the save changed the title it read (D-127)", () => {
    const repo = repository();
    const first = deps(repo, session());
    const written = saveSpec(first, repo, request());
    expect(first.titled).toEqual(["Retry a failed run"]);
    // A section saved under the title it read names nobody.
    const again = deps(repo, session({ specSlug: written.view.slug }));
    saveSpec(
      again,
      repo,
      request({
        sections: { ...sections, notes: "More" },
        base: { title: written.view.title, sections: written.view.sections },
      }),
    );
    expect(again.titled).toEqual([]);
    // Nor does a title only respaced.
    saveSpec(
      again,
      repo,
      request({ title: "  Retry  a failed   run ", base: { title: written.view.title, sections: written.view.sections } }),
    );
    expect(again.titled).toEqual([]);
  });

  it("gives each requirement an id, and lands none in a node before there is a plan", () => {
    const repo = repository();
    const written = saveSpec(
      deps(repo, session()),
      repo,
      request({
        title: "A light colour mode",
        sections: {
          ...sections,
          requirements:
            "- The person can choose Light, Dark or System without a restart.\n" +
            "- Text meets WCAG AA contrast against its background.",
          no_gos: "- Changing the brand colours.",
        },
      }),
    );
    expect(written.view.slug).toBe("a-light-colour-mode");
    expect(written.view.path).toBe("specs/a-light-colour-mode/spec.md");
    expect(written.view.requirements.map((each) => each.id)).toEqual(["R1", "R2"]);
    // Nothing is drafted yet, so no requirement has landed in a node.
    expect(written.view.requirements.every((each) => each.nodes.length === 0)).toBe(true);

    const file = readFileSync(join(repo.path, "specs", "a-light-colour-mode", "spec.md"), "utf8");
    expect(file).toContain("# A light colour mode");
    expect(file).toContain("- R1: The person can choose Light, Dark or System without a restart.");
    expect(file).toContain("## No-Gos");
  });

  it("refuses a planning that belongs to another repository", () => {
    const repo = repository();
    const other = { ...repo, id: "80000000-0000-4000-8000-00000000000f" };
    expect(() => saveSpec(deps(repo, session()), other, request())).toThrow(
      "This planning belongs to another repository.",
    );
  });

  it("refuses a specs folder spelled with a backslash or a `..`, as the CLI and the runner do", () => {
    for (const named of ["docs\\specs", "nope/../specs", "/specs"]) {
      const repo = repository();
      mkdirSync(join(repo.path, ".perbo"), { recursive: true });
      writeFileSync(join(repo.path, ".perbo", "config.json"), JSON.stringify({ specs: named }));
      expect(() => saveSpec(deps(repo, session()), repo, request()), named).toThrow(
        /repository-relative folder/,
      );
      // The refusal comes before anything is written, under either name.
      expect(existsSync(join(repo.path, "docs")), named).toBe(false);
      expect(existsSync(join(repo.path, "specs")), named).toBe(false);
    }
  });

  it("refuses a second spec whose title takes a slug the repository already holds", () => {
    const repo = repository();
    saveSpec(deps(repo, session()), repo, request({ title: "A light colour mode" }));
    expect(() =>
      saveSpec(deps(repo, session()), repo, request({ title: "A  light  colour  mode!" })),
    ).toThrow(/already exists/);
  });
});

/**
 * SCP-321: `spec.md` has three writers — the person in the Spec pane, the
 * interview and the Impact pane turning a warning into a No-Go — but only the
 * two panes' saves go through `saveSpec`; the interview writes the same file
 * through its own tools. Every save says what it read, and the check is on the
 * bytes at the moment of the write rather than on when anybody last looked
 * (D-102, D-103).
 */
describe("when the spec moved under a save", () => {
  /** One session's first save, and what it then holds as what it read. */
  const started = (): {
    repo: RegisteredRepository;
    wiring: SpecDeps;
    base: { title: string; sections: SpecSections };
    onDisk: () => string;
  } => {
    const repo = repository();
    const wiring = deps(repo, session());
    const first = saveSpec(wiring, repo, request());
    const path = join(repo.path, "specs", first.view.slug!, "spec.md");
    return {
      repo,
      wiring,
      base: { title: first.view.title, sections: first.view.sections },
      onDisk: () => readFileSync(path, "utf8"),
    };
  };

  it("names the section the other writer wrote, sends the file back, and writes nothing", () => {
    const { repo, wiring, base, onDisk } = started();
    // The interview writes the Outcome, reading and writing the file itself.
    saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, outcome: "The interview's sentence." },
      base,
    }));
    const before = onDisk();

    const reply = saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, outcome: "The person's sentence." },
      base,
    }));
    expect(reply.conflicting).toEqual(["outcome"]);
    // The file comes back with it, so the pane has the half it did not type.
    expect(reply.view.sections.outcome).toBe("The interview's sentence.");
    expect(onDisk()).toBe(before);
  });

  /**
   * The case above changes only the section that conflicts, so a half save of
   * the merged non-conflicting sections would leave the same bytes a refusal
   * should. Here the writer also changes a section the file did not, which a
   * half save would still write.
   */
  it("writes nothing at all when refused, not even a section the file itself did not touch", () => {
    const { repo, wiring, base, onDisk } = started();
    saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, outcome: "The interview's sentence." },
      base,
    }));
    const before = onDisk();

    const reply = saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, outcome: "The person's sentence.", notes: "The person's note." },
      base,
    }));
    expect(reply.conflicting).toEqual(["outcome"]);
    expect(onDisk()).toBe(before);
    // The section nobody else touched comes back as it was read, not as what
    // was sent.
    expect(reply.view.sections.notes).toBe(base.sections.notes);
  });

  it("refuses the other way round too: this writer saved first, and the file moved after", () => {
    const { repo, wiring, base, onDisk } = started();
    // The person saves, and keeps writing against what they had read.
    saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, notes: "The person's note." },
      base,
    }));
    const before = onDisk();
    const reply = saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, notes: "The interview's note." },
      base,
    }));
    expect(reply.conflicting).toEqual(["notes"]);
    expect(onDisk()).toBe(before);
  });

  it("writes a section nobody else touched and keeps the one somebody else wrote", () => {
    const { repo, wiring, base } = started();
    saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, no_gos: "- The interview's No-Go." },
      base,
    }));
    const reply = saveSpec(wiring, repo, request({
      title: base.title,
      sections: { ...base.sections, notes: "The person's note." },
      base,
    }));
    expect(reply.conflicting).toEqual([]);
    expect(reply.view.sections.notes).toBe("The person's note.");
    expect(reply.view.sections.no_gos).toBe("- The interview's No-Go.");
  });

  it("carries the file back as it stands, rather than what was sent", () => {
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
    expect(reply.conflicting).toEqual(["outcome"]);
    // The file is untouched, and the view carries what is actually in it.
    expect(readFileSync(path, "utf8")).toContain("The interview wrote this");
    expect(reply.view.sections.outcome).toBe("The interview wrote this");
  });
});

describe("the slug a session records", () => {
  it("is a path segment, so a record naming a folder outside the repository is not one", () => {
    // The slug is a path segment, so the record that carries it is held to the
    // shape it is minted in rather than to a length.
    for (const slug of [
      "",
      ".",
      "..",
      "../../outside",
      "../outside",
      "a-light-colour-mode/",
      "./a-light-colour-mode",
      "a-light-colour-mode/../..",
      "/a-light-colour-mode",
      "..\\outside",
      "C:\\outside",
      "a-light-colour-mode/nodes",
    ])
      expect(
        EditingSessionSchema.safeParse({ ...session(), specSlug: slug }).success,
        slug,
      ).toBe(false);
    expect(
      EditingSessionSchema.parse({ ...session(), specSlug: "a-light-colour-mode" }).specSlug,
    ).toBe("a-light-colour-mode");
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
