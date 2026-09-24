// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ticketsNoDraftStandsFor, titleOfDraft, unclaimedSpecs } from "./create.js";
import type { OpenDraft, Snapshot } from "../../shared/protocol.js";

it("names a planning by its spec, then by the plan's own shorter name", () => {
  const spec = { repoId: "repo-1", slug: "a-clock-app", title: "A clock app" };
  const writing = { repoId: "repo-1", specSlug: "a-clock-app", key: null, outcome: "" } as OpenDraft;
  const held = { specs: [spec], tasks: [], titles: {} } as unknown as Parameters<typeof titleOfDraft>[0];

  // During the interview there is no outcome and no ticket, and "Untitled
  // work" would stand beside a spec the person has already titled.
  expect(titleOfDraft(held, writing)).toBe("A clock app");

  // Once a plan is drafted, its ticket's title — not the outcome, which is a
  // sentence stating what will be true and reads as a paragraph in a list.
  const planned = {
    specs: [spec],
    titles: {},
    tasks: [{ repoId: "repo-1", ticket: { key: "PRB-2", title: "Clock app" } }],
  } as unknown as Parameters<typeof titleOfDraft>[0];
  expect(
    titleOfDraft(planned, {
      ...writing,
      key: "PRB-2",
      outcome: "A person can read the time on a clock that updates every second without a reload.",
    }),
  ).toBe("Clock app");

  // And with none of them, the row still says something.
  expect(titleOfDraft({ specs: [], tasks: [], titles: {} } as unknown as Parameters<typeof titleOfDraft>[0], writing)).toBe(
    "Untitled work",
  );
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
