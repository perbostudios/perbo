// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { nameOfRoute, ticketsNoDraftStandsFor, titleOfDraft, unclaimedSpecs } from "./create.js";
import { openDrafts } from "../../shared/contract-editing.js";
import type { EditingSession, OpenDraft, Snapshot } from "../../shared/protocol.js";

type Named = Parameters<typeof titleOfDraft>[0];

it("names a planning by its spec, then by the plan's own shorter name, and Untitled before either", () => {
  const writing = { repoId: "repo-1", specSlug: "a-clock-app", key: null, outcome: "", title: "A clock app" } as OpenDraft;
  const held = { tasks: [], titles: {} } as unknown as Named;

  // During the interview there is no ticket: the spec's title.
  expect(titleOfDraft(held, writing)).toBe("A clock app");

  // Once a plan is drafted, its ticket's title — not the outcome, which is a
  // sentence stating what will be true and reads as a paragraph in a list.
  const planned = {
    titles: {},
    tasks: [{ repoId: "repo-1", ticket: { key: "PRB-2", title: "Clock app" } }],
  } as unknown as Named;
  expect(
    titleOfDraft(planned, {
      ...writing,
      key: "PRB-2",
      outcome: "A person can read the time on a clock that updates every second without a reload.",
    }),
  ).toBe("Clock app");

  // And before the spec is titled the planning is Untitled, whatever else it
  // holds: no outcome and no words of the person's stand in for a name.
  expect(titleOfDraft(held, { ...writing, title: null, outcome: "A person can read the time." })).toBe("Untitled");
});

describe("the title the drafts list carries (D-118)", () => {
  const session = (over: Partial<EditingSession> = {}) =>
    ({ id: "s-1", repoId: "repo-1", key: null, admitted: false, phase: "editing", nodes: 0, drift: null,
      specSlug: "dark-mode-toggle", named: null, lastPane: null, confirmed: null, read: null, impact: null,
      form: { draft: { outcome: "", criteria: [], paths: [], prohibited: [] } }, ...over }) as unknown as EditingSession;
  const titled = (title: string | null) => () => (title === null ? null : { title, sections: null });

  it("is the spec's title", () => {
    expect(openDrafts([session()], titled("Dark mode toggle"))[0]!.title).toBe("Dark mode toggle");
  });

  it("is none while the spec has no title line, as the first turn that named its folder leaves it", () => {
    expect(openDrafts([session()], titled(""))[0]!.title).toBeNull();
    expect(openDrafts([session()], titled("  "))[0]!.title).toBeNull();
    // And the spec's own the moment the Architect or the person titles it.
    expect(openDrafts([session()], titled("A dark mode for the store"))[0]!.title).toBe("A dark mode for the store");
  });

  it("is whatever the spec states, a title that is the word Untitled included: the word is the app's display, never a mark in the file", () => {
    expect(openDrafts([session()], titled("Untitled"))[0]!.title).toBe("Untitled");
  });

  it("is none with no spec, or a spec with no file to read", () => {
    expect(openDrafts([session({ specSlug: null })], titled("Anything"))[0]!.title).toBeNull();
    expect(openDrafts([session()], titled(null))[0]!.title).toBeNull();
  });
});

describe("the name in the top bar", () => {
  const workspace = {
    tasks: [{ repoId: "repo-1", ticket: { key: "PRB-2", title: "Clock app" } }],
    titles: { "repo-1:PRB-2": "Wall clock" },
    drafts: [
      { id: "s-1", repoId: "repo-1", key: null, title: null },
      { id: "s-2", repoId: "repo-1", key: null, title: "Dark mode" },
    ],
  } as unknown as Snapshot;

  it("is a planning's own on its panes, Untitled before it has one", () => {
    expect(nameOfRoute(workspace, { page: "planning", sessionId: "s-1", pane: "spec" })).toBe("Untitled");
    expect(nameOfRoute(workspace, { page: "planning", sessionId: "s-2", pane: "graph" })).toBe("Dark mode");
  });

  it("is none on a ticket's own pages, which name it themselves, and on a page about no one piece of work", () => {
    // The planning's contract tab is the contract page, which names it.
    expect(nameOfRoute(workspace, { page: "planning", sessionId: "s-2", pane: "contract" })).toBeNull();
    for (const view of ["contract", "loop", "stopped"] as const)
      expect(nameOfRoute(workspace, { page: "task", repoId: "repo-1", key: "PRB-2", view })).toBeNull();
    expect(nameOfRoute(workspace, { page: "home" })).toBeNull();
    expect(nameOfRoute(workspace, { page: "ask", repoId: "repo-1" })).toBeNull();
  });
});

it("lists a drafted plan once, under the planning that is writing its spec", () => {
  // A plan the interview drafted leaves the session holding the spec, so
  // listing the planning and the ticket would be two rows for one piece of
  // work: deleting either would leave the other standing under the same
  // title, and opening the ticket would start a second planning beside the
  // first (D-101, D-103).
  const ticket = (key: string, slug: string | null) => ({
    repoId: "repo-1",
    ticket: {
      key,
      admission: slug === null ? null : { spec: { path: `specs/${slug}/spec.md` } },
    },
  });
  const writing = { id: "a", repoId: "repo-1", specSlug: "a-clock-app", key: null } as OpenDraft;
  expect(ticketsNoDraftStandsFor([ticket("PRB-2", "a-clock-app")], [writing])).toEqual([]);
  // Still covered once the session does hold the ticket, by the key.
  const holding = { ...writing, key: "PRB-2" } as OpenDraft;
  expect(ticketsNoDraftStandsFor([ticket("PRB-2", "a-clock-app")], [holding])).toEqual([]);

  // And a ticket no planning is writing keeps its own row, which is the way
  // into a plan the command line admitted.
  expect(
    ticketsNoDraftStandsFor([ticket("PRB-3", "another-spec")], [writing]).map(
      (row) => row.ticket.key,
    ),
  ).toEqual(["PRB-3"]);
  expect(
    ticketsNoDraftStandsFor([ticket("PRB-4", null)], [writing]).map((row) => row.ticket.key),
  ).toEqual(["PRB-4"]);
  // A planning with no spec stands for nothing: matching on the missing slug
  // would hide every ticket the command line admitted with no spec at all.
  const nameless = { id: "c", repoId: "repo-1", specSlug: null, key: null } as OpenDraft;
  expect(
    ticketsNoDraftStandsFor([ticket("PRB-4", null)], [nameless]).map((row) => row.ticket.key),
  ).toEqual(["PRB-4"]);
  // And a spec of the same name in another repository is another spec.
  const elsewhere = { ...writing, repoId: "repo-2" } as OpenDraft;
  expect(
    ticketsNoDraftStandsFor([ticket("PRB-2", "a-clock-app")], [elsewhere]).map(
      (row) => row.ticket.key,
    ),
  ).toEqual(["PRB-2"]);
});

describe("which specs the picker offers", () => {
  const spec = { repoId: "repo-1", slug: "have-a-dark-mode", title: "Have a dark mode" };
  const ticketFor = (path: string | null) =>
    ({
      repoId: "repo-1",
      repository: "test",
      ticket: { key: "PRB-1", admission: { spec: path === null ? null : { path } } },
    }) as unknown as Snapshot["tasks"][number];

  it("offers one no planning and no ticket names", () => {
    expect(unclaimedSpecs({ specs: [spec], tasks: [] }, [])).toEqual([spec]);
  });

  it("does not offer one a planning is writing", () => {
    const draft = { repoId: "repo-1", specSlug: "have-a-dark-mode" } as OpenDraft;
    expect(unclaimedSpecs({ specs: [spec], tasks: [] }, [draft])).toEqual([]);
  });

  it("does not offer one a ticket was drafted from, which is the only claim a CLI admission leaves", () => {
    // No session at all: this arm is what a ticket the command line admitted
    // is read through, and reading only the sessions would offer a spec whose
    // plan is already on the board.
    const tasks = [ticketFor("specs/have-a-dark-mode/spec.md")];
    expect(unclaimedSpecs({ specs: [spec], tasks }, [])).toEqual([]);
  });

  it("reads the slug from the folder, whatever folder the repository keeps specs in", () => {
    const tasks = [ticketFor("docs/specs/have-a-dark-mode/spec.md")];
    expect(unclaimedSpecs({ specs: [spec], tasks }, [])).toEqual([]);
  });

  it("keeps a spec apart from one of the same name in another repository", () => {
    const draft = { repoId: "repo-2", specSlug: "have-a-dark-mode" } as OpenDraft;
    expect(unclaimedSpecs({ specs: [spec], tasks: [] }, [draft])).toEqual([spec]);
  });

  it("is unbothered by a ticket that was never drafted from a spec", () => {
    expect(unclaimedSpecs({ specs: [spec], tasks: [ticketFor(null)] }, [])).toEqual([spec]);
  });
});
