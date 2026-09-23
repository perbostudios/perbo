import { describe, expect, it } from "vitest";
import type { StandingProhibitedEntry } from "@perbo/contracts";
import { ContractEditing, markOf } from "./contract-editing.js";
import { TaskModelsSchema, type EditingSession } from "./protocol.js";

/**
 * The explorer's marks (SCP-318). A mark changes the draft's canonical scope —
 * `paths` and `prohibited`, which admission passes as `--path` and
 * `--prohibit` — and the always box writes the repository's standing list.
 * Every mark is one entry in the draft's history, with its author, and can be
 * undone.
 */

const repoId = "10000000-0000-4000-8000-000000000001";
const models = TaskModelsSchema.parse({ executorEffort: null, reviewerEffort: null });

function fixture(standing: StandingProhibitedEntry[] = []) {
  let records: EditingSession[] = [];
  let list = [...standing];
  const editing = new ContractEditing({
    records: () => records,
    persist: (next) => {
      records = structuredClone(next);
    },
    repository: () => undefined,
    defaults: () => models,
    detail: () => Promise.reject(new Error("no ticket here")),
    start: () => Promise.reject(new Error("nothing runs in this test")),
    stop: () => Promise.resolve(),
    id: () => crypto.randomUUID(),
    specFolder: () => "specs",
    standing: () => [...list],
    setStanding: (_repo, entries) => {
      list = [...entries];
    },
  });
  return { editing, standing: () => list };
}

const open = async (editing: ContractEditing): Promise<EditingSession> =>
  editing.open({ kind: "fresh", repoId });

describe("marking a path for a draft", () => {
  it("puts a directory in the draft's paths as a glob, and a file as itself", async () => {
    const { editing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "packages/auth/", "allowed", null);
    expect(session.form.draft.paths).toContain("packages/auth/**");
    session = editing.mark(session.id, session.revision, "src/theme.ts", "allowed", null);
    expect(session.form.draft.paths).toContain("src/theme.ts");
  });

  it("puts a prohibited path on the draft's prohibited list and off its allowed one", async () => {
    const { editing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "src/generated/", "allowed", null);
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", null);
    expect(session.form.draft.prohibited).toEqual(["src/generated/**"]);
    expect(session.form.draft.paths).not.toContain("src/generated/**");
    expect(markOf(session.form, "src/generated/**")).toBe("prohibited");
  });

  it("clears a mark, leaving the path on neither list", async () => {
    const { editing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", null);
    session = editing.mark(session.id, session.revision, "src/generated/", null, null);
    expect(session.form.draft.prohibited).toEqual([]);
    expect(markOf(session.form, "src/generated/**")).toBeNull();
  });

  it("records each mark with its author, and undoes it back to the mark before", async () => {
    const { editing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "src/generated/", "allowed", null);
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", null);
    expect(session.history.map((entry) => entry.summary)).toEqual([
      "Allow src/generated/**",
      "Prohibit src/generated/**",
    ]);
    expect(session.history.every((entry) => entry.author === "you")).toBe(true);
    session = editing.undo(session.id, session.revision, 2);
    expect(markOf(session.form, "src/generated/**")).toBe("allowed");
    expect(session.history[1]?.undone).toBe(true);
    session = editing.undo(session.id, session.revision, 1);
    expect(markOf(session.form, "src/generated/**")).toBeNull();
  });

  it("refuses an undo a later mark on the same path is in front of", async () => {
    const { editing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "src/generated/", "allowed", null);
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", null);
    expect(() => editing.undo(session.id, session.revision, 1)).toThrow(/Undo edit 2 first/);
  });

  it("records nothing where the mark is the one already there", async () => {
    const { editing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", null);
    const revision = session.revision;
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", null);
    expect(session.history).toHaveLength(1);
    expect(session.revision).toBe(revision);
  });
});

describe("always prohibiting a path in this repository", () => {
  it("writes the standing list with the draft that added it, and no confirmation step", async () => {
    const { editing, standing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", true);
    expect(standing()).toEqual([
      {
        path: "src/generated/**",
        draft: session.id,
        source: "this draft",
        added_at: expect.any(String) as unknown as string,
      },
    ]);
    expect(session.history.at(-1)?.summary).toBe(
      "Always prohibit src/generated/** in this repository",
    );
  });

  it("takes the entry this draft added back off the list on undo", async () => {
    const { editing, standing } = fixture();
    let session = await open(editing);
    session = editing.mark(session.id, session.revision, "src/generated/", "prohibited", true);
    session = editing.undo(session.id, session.revision, session.history.at(-1)!.n);
    expect(standing()).toEqual([]);
    expect(markOf(session.form, "src/generated/**")).toBeNull();
  });

  it("refuses to change an entry another draft or a person put there", async () => {
    const locked: StandingProhibitedEntry = {
      path: "specs/**",
      draft: null,
      source: "written in .perbo/config.json",
      added_at: null,
    };
    const { editing, standing } = fixture([locked]);
    const session = await open(editing);
    expect(() => editing.mark(session.id, session.revision, "specs/", "prohibited", false)).toThrow(
      /standing list/,
    );
    expect(standing()).toEqual([locked]);
  });
});
