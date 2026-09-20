import { describe, expect, it } from "vitest";
import { archiveExport, ticketExport } from "./export.js";
import type { RequestOf, Snapshot, TaskRow } from "../../shared/protocol.js";

const alpha = "80000000-0000-4000-8000-000000000001";
const beta = "80000000-0000-4000-8000-000000000002";
const ticket = {
  key: "PRB-1",
  ticket_id: "ticket_1",
  title: "A task",
  state: "merged",
  updated_at: "2026-09-19T09:00:00.000Z",
  delivery: { pull_request_url: null, pull_request_number: null },
} as unknown as TaskRow["ticket"];
const row = (over: {
  repoId?: string;
  repository?: string;
  ticket?: Partial<TaskRow["ticket"]>;
}): TaskRow =>
  ({
    repoId: alpha,
    repository: "alpha",
    ...over,
    ticket: { ...ticket, ...over.ticket },
  }) as TaskRow;
function snapshot(rows: TaskRow[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    tasks: rows,
    titles: {},
    archived: rows.map((entry) => entry.repoId + ":" + entry.ticket.key),
    ...over,
  } as Snapshot;
}
const filter = (over: Partial<RequestOf<"exportArchive">> = {}): RequestOf<"exportArchive"> => ({
  kind: "exportArchive",
  repoId: null,
  search: "",
  outcome: "all",
  sort: "title",
  ...over,
});

describe("archiveExport", () => {
  it("is offered as one file, whatever it holds", () => {
    expect(archiveExport(snapshot([]), filter()).name).toBe("perbo-archive.csv");
  });

  it("quotes a title holding a comma, and disarms one a spreadsheet would run", () => {
    const { content } = archiveExport(
      snapshot([
        row({ ticket: { key: "PRB-1", title: "Fix, with commas" } }),
        row({ repoId: beta, repository: "beta", ticket: { key: "PRB-2", state: "closed", title: "=HYPERLINK(unsafe)" } }),
      ]),
      filter(),
    );
    expect(content).toContain('"Fix, with commas"');
    expect(content).toContain("\"'=HYPERLINK(unsafe)\"");
    expect(content).toContain('"beta","closed"');
  });

  it("carries only what has been filed, so a finished ticket still on Home is not in it", () => {
    const rows = [
      row({ ticket: { key: "PRB-1", title: "Filed" } }),
      row({ ticket: { key: "PRB-3", state: "executing", title: "Still running" } }),
      row({ ticket: { key: "PRB-4", title: "Finished but on Home" } }),
    ];
    const { content } = archiveExport(
      snapshot(rows, { archived: [alpha + ":PRB-1"] }),
      filter(),
    );
    expect(content).toContain("Filed");
    expect(content).not.toContain("Still running");
    expect(content).not.toContain("Finished but on Home");
  });

  it("narrows to one repository when the person asked for one", () => {
    const rows = [
      row({ ticket: { key: "PRB-1", title: "From alpha" } }),
      row({ repoId: beta, repository: "beta", ticket: { key: "PRB-2", title: "From beta" } }),
    ];
    expect(archiveExport(snapshot(rows), filter({ repoId: alpha })).content).not.toContain("beta");
    expect(archiveExport(snapshot(rows), filter()).content).toContain("beta");
  });

  it("prefers the title the person gave a ticket", () => {
    const { content } = archiveExport(
      snapshot([row({ ticket: { key: "PRB-1", title: "As the CLI named it" } })], {
        titles: { [alpha + ":PRB-1"]: "As the person renamed it" },
      }),
      filter(),
    );
    expect(content).toContain("As the person renamed it");
    expect(content).not.toContain("As the CLI named it");
  });

  it("redacts a credential that reached a title", () => {
    const { content } = archiveExport(
      snapshot([
        row({ ticket: { key: "PRB-1", title: "Rotate sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz" } }),
      ]),
      filter(),
    );
    expect(content).not.toContain("sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz");
    expect(content).toContain("PRB-1");
  });
});

describe("ticketExport", () => {
  it("names the file after the task, and writes its record as readable JSON", () => {
    const { name, content } = ticketExport("PRB-1", { ticket: { key: "PRB-1" } });
    expect(name).toBe("perbo-PRB-1.json");
    expect(JSON.parse(content)).toEqual({ ticket: { key: "PRB-1" } });
    expect(content).toContain("\n  ");
  });

  it("names it after the repository where a whole repository is exported", () => {
    expect(ticketExport("repository with spaces", []).name).toBe(
      "perbo-repository with spaces.json",
    );
  });

  it("redacts a credential in the record it writes", () => {
    const { content } = ticketExport("PRB-1", {
      log: "ANTHROPIC_API_KEY=sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz",
    });
    expect(content).not.toContain("sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz");
  });
});
