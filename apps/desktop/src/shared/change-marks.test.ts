import { describe, expect, it } from "vitest";
import { ChangeMarks } from "./change-marks.js";
import type { Detail, EditingChange, EditingSession, InterviewEntry, SpecSections } from "./protocol.js";

/**
 * The change marks both hosts mark with (D-128, D-120): the pair read before
 * and after whatever may move it, and the change between them put on every
 * live planning over the same spec or ticket.
 */

type Planning = Pick<EditingSession, "id" | "repoId" | "key" | "specSlug" | "phase">;
const planning = (fields: Planning): EditingSession => fields as EditingSession;

const sections = (requirements: string): SpecSections => ({
  outcome: "The person can pick a theme.",
  requirements,
  no_gos: "",
  rabbit_holes: "",
  notes: "",
});
const contract = (criteria: [string, string][]): Detail["contract"] =>
  ({
    outcome: "Themes",
    acceptance_criteria: criteria.map(([id, text]) => ({ id, text })),
  }) as unknown as Detail["contract"];

function fixture(sessions: EditingSession[]) {
  const specs = new Map<string, SpecSections | Error>();
  const contracts = new Map<string, Detail["contract"]>();
  const recorded: { id: string; change: EditingChange }[] = [];
  const said: { id: string; line: InterviewEntry["line"] }[] = [];
  let refuse: string | null = null;
  const marks = new ChangeMarks<{ readonly id: string }>({
    read: (id) => {
      const session = sessions.find((each) => each.id === id);
      if (session === undefined) throw new Error(`${id} has gone`);
      return session;
    },
    sessions: () => sessions,
    repository: (id) => {
      if (id === "gone") throw new Error("no such repository");
      return { id };
    },
    spec: (repo, slug) => {
      const spec = specs.get(repo.id + ":" + slug);
      if (spec instanceof Error) throw spec;
      return spec ?? null;
    },
    contract: (repo, key) => {
      const found = contracts.get(repo.id + ":" + key);
      if (found === undefined) throw new Error(`${key} has no contract`);
      return found;
    },
    recordChange: (id, change) => {
      if (refuse !== null) throw new Error(refuse);
      recorded.push({ id, change });
    },
    say: (id, line) => said.push({ id, line }),
    redact: (text) => text.replaceAll("sk-secret", "[redacted]"),
  });
  return {
    marks,
    specs,
    contracts,
    recorded,
    said,
    refuse: (message: string) => {
      refuse = message;
    },
  };
}

describe("the change marks both hosts record (D-128)", () => {
  it("records a removed criterion on the plan's before and not its after, so the pane strikes it", () => {
    const { marks, contracts, recorded } = fixture([
      planning({ id: "p1", repoId: "r1", key: "PER-1", specSlug: null, phase: "editing" }),
    ]);
    contracts.set("r1:PER-1", contract([["C1", "Light and dark"], ["C2", "Follows the system"]]));
    const before = marks.promiseAt({ id: "r1" }, "PER-1");
    contracts.set("r1:PER-1", contract([["C1", "Light and dark"]]));
    marks.recordPlanChange({ id: "r1" }, "PER-1", before, "person");
    expect(recorded).toHaveLength(1);
    // Recorded as the person's, which the panes mark nowhere.
    expect(recorded[0]!.change.by).toBe("person");
    const plan = recorded[0]!.change.plan!;
    expect(plan.before.criteria.map((each) => each.text)).toContain("Follows the system");
    expect(plan.after.criteria.map((each) => each.text)).not.toContain("Follows the system");
    expect(recorded[0]!.change.spec).toBeNull();
  });

  it("marks a plan change on every live planning over the same ticket in the same repository, and no other", () => {
    const { marks, contracts, recorded } = fixture([
      planning({ id: "same", repoId: "r1", key: "PER-1", specSlug: null, phase: "editing" }),
      planning({ id: "also", repoId: "r1", key: "PER-1", specSlug: null, phase: "ready" }),
      planning({ id: "discarded", repoId: "r1", key: "PER-1", specSlug: null, phase: "discarded" }),
      planning({ id: "other-repo", repoId: "r2", key: "PER-1", specSlug: null, phase: "editing" }),
      planning({ id: "other-ticket", repoId: "r1", key: "PER-2", specSlug: null, phase: "editing" }),
    ]);
    contracts.set("r1:PER-1", contract([["C1", "Light and dark"]]));
    const before = marks.promiseAt({ id: "r1" }, "PER-1");
    contracts.set("r1:PER-1", contract([["C1", "Light, dark and system"]]));
    marks.recordPlanChange({ id: "r1" }, "PER-1", before, "person");
    expect(recorded.map((each) => each.id)).toEqual(["same", "also"]);
  });

  it("marks nothing where the promise did not move, or either reading could not be made", () => {
    const { marks, contracts, recorded } = fixture([
      planning({ id: "p1", repoId: "r1", key: "PER-1", specSlug: null, phase: "editing" }),
    ]);
    contracts.set("r1:PER-1", contract([["C1", "Light and dark"]]));
    marks.recordPlanChange({ id: "r1" }, "PER-1", marks.promiseAt({ id: "r1" }, "PER-1"), "person");
    marks.recordPlanChange({ id: "r1" }, "PER-1", null, "chat");
    expect(marks.promiseAt({ id: "r1" }, "PER-9")).toBeNull();
    const before = marks.promiseAt({ id: "r1" }, "PER-1");
    contracts.delete("r1:PER-1");
    marks.recordPlanChange({ id: "r1" }, "PER-1", before, "person");
    expect(recorded).toEqual([]);
  });

  it("records what a turn changed of the spec since the pair it began with", () => {
    const { marks, specs, recorded } = fixture([
      planning({ id: "p1", repoId: "r1", key: null, specSlug: "themes", phase: "editing" }),
    ]);
    specs.set("r1:themes", sections("- Light and dark."));
    const before = marks.pairOf("p1");
    expect(before).toEqual({ spec: sections("- Light and dark."), plan: null });
    specs.set("r1:themes", sections("- Light, dark and system."));
    marks.recordChangeSince("p1", before);
    expect(recorded).toHaveLength(1);
    // A turn's change is the chat's, which the panes mark.
    expect(recorded[0]!.change.by).toBe("chat");
    expect(recorded[0]!.change.spec).toEqual({
      before: sections("- Light and dark."),
      after: sections("- Light, dark and system."),
    });
    marks.recordChangeSince("p1", null);
    marks.recordChangeSince("p1", undefined);
    marks.recordChangeSince("p1", marks.pairOf("p1"));
    expect(recorded).toHaveLength(1);
  });

  it("reads the pair in the repository a running interview names, and not at all where it cannot", () => {
    const { marks, specs } = fixture([
      planning({ id: "p1", repoId: "r1", key: null, specSlug: "themes", phase: "editing" }),
    ]);
    specs.set("r2:themes", sections("- In the other repository."));
    expect(marks.pairOf("p1", "r2")?.spec).toEqual(sections("- In the other repository."));
    expect(marks.pairOf("p1")).toEqual({ spec: null, plan: null });
    expect(marks.pairOf("p1", "gone")).toBeNull();
    expect(marks.pairOf("nobody")).toBeNull();
    specs.set("r1:themes", new Error("will not read"));
    expect(marks.pairOf("p1")).toBeNull();
  });

  it("marks a spec save on the plannings writing that spec, and says a refused record in the chat, redacted", () => {
    const { marks, recorded, said, refuse } = fixture([
      planning({ id: "p1", repoId: "r1", key: null, specSlug: "themes", phase: "editing" }),
      planning({ id: "p2", repoId: "r1", key: null, specSlug: "other", phase: "editing" }),
    ]);
    const on = (session: EditingSession): boolean => session.specSlug === "themes";
    marks.markChangeOn(
      { spec: sections("- Light."), plan: null },
      { spec: sections("- Light and dark."), plan: null },
      on,
      "person",
    );
    expect(recorded.map((each) => each.id)).toEqual(["p1"]);
    expect(recorded[0]!.change.by).toBe("person");
    refuse("the record is full: sk-secret");
    expect(() =>
      marks.markChangeOn(
        { spec: sections("- Light and dark."), plan: null },
        { spec: sections("- Dark."), plan: null },
        on,
        "person",
      ),
    ).not.toThrow();
    expect(said).toEqual([
      {
        id: "p1",
        line: { kind: "note", text: "The change could not be marked on the panes: the record is full: [redacted]" },
      },
    ]);
  });

  it("says why a change could not be marked whole, however long the reason", () => {
    // Nothing a person reads is cut short to fit: the chat's own note is
    // where a line the record will not hold is said.
    const sessions = [planning({ id: "p1", repoId: "r1", key: null, specSlug: "themes", phase: "editing" })];
    const { marks, refuse, said } = fixture(sessions);
    const reason = "The record will not hold this section. ".repeat(400).trim();
    refuse(reason);
    marks.markChangeOn(
      { spec: sections("- Light."), plan: null },
      { spec: sections("- Dark."), plan: null },
      (session) => session.specSlug === "themes",
      "chat",
    );
    expect(said).toEqual([{ id: "p1", line: { kind: "note", text: `The change could not be marked on the panes: ${reason}` } }]);
    expect(reason.length).toBeGreaterThan(12_000);
  });
});
