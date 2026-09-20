import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listTickets, readTicket, readTicketForDisplay } from "./tickets.js";

/**
 * A ticket file outlives the version that wrote it.
 *
 * `--from-file` used to record `kind: "none"` with the file's absolute path in
 * the reference. `none` now means a null reference, so that record no longer
 * parses — and because every command that touches the store parses through
 * here, an unmigrated store would have taken `list`, `inspect`, `run` and
 * `admit` down with it. The store reads it as the `file` source it always was.
 *
 * Written into a temporary store rather than read from this repository's own:
 * the shape being asserted is one nothing writes any more, so a test that went
 * looking for it on disk would pass by finding nothing.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const LEGACY_PATH = "/repo/inbox/SCP-169.md";

const record = (key: string, source: Record<string, unknown>) => ({
  schema_version: 1,
  ticket_id: `ticket_${key.toLowerCase().replace("-", "")}0000`,
  key,
  title: "New users receive an activation email within 60 seconds of signing up.",
  state: "plan_review",
  priority: "normal",
  labels: [],
  depends_on: [],
  source,
  repository_root: "/repo",
  plan_id: "plan_01abcdef",
  plan_version: 1,
  approved_at: null,
  admitted_at: "2026-08-28T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
  admission: { elapsed_ms: 4200, criteria_source: "file", criteria_count: 3 },
  history: [{ at: "2026-08-28T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" }],
});

/** A store holding exactly the three source shapes a previous version wrote. */
function legacyStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-store-legacy-"));
  scratch.push(dir);
  mkdirSync(join(dir, "tickets"), { recursive: true });
  const write = (key: string, source: Record<string, unknown>) =>
    writeFileSync(
      join(dir, "tickets", `${key}.json`),
      `${JSON.stringify(record(key, source), null, 2)}\n`,
    );
  write("AYO-1", {
    kind: "none",
    reference: LEGACY_PATH,
    url: null,
    title_at_admission: "A pasted issue",
  });
  write("AYO-2", { kind: "none", reference: null, url: null, title_at_admission: null });
  write("AYO-3", {
    kind: "github",
    reference: "example/repo#273",
    url: "https://github.com/example/repo/issues/273",
    title_at_admission: "A ticket admitted from a file",
  });
  return dir;
}

describe("the ticket store, reading a record written before `file` was a kind", () => {
  it("reads a `none` that carries a path as the file source it always was", () => {
    const ticket = readTicket(legacyStore(), "AYO-1");
    expect(ticket.source).toEqual({
      kind: "file",
      reference: LEGACY_PATH,
      url: null,
      title_at_admission: "A pasted issue",
    });
  });

  it("reads it the same way for display, so `inspect` names it as a file", () => {
    const ticket = readTicketForDisplay(legacyStore(), "AYO-1");
    expect(ticket.source).toMatchObject({ kind: "file", reference: LEGACY_PATH });
  });

  it("keeps the whole store readable rather than skipping the record", () => {
    // The failure this prevents is not one ticket: `listTickets` steps over a
    // file it cannot parse, so an unmigrated store would have quietly shrunk.
    const tickets = listTickets(legacyStore());
    expect(tickets.map((ticket) => ticket.key)).toEqual(["AYO-1", "AYO-2", "AYO-3"]);
    expect(tickets.map((ticket) => ticket.source.kind)).toEqual(["file", "none", "github"]);
  });

  it("leaves the shapes that are still legal exactly as written", () => {
    const dir = legacyStore();
    expect(readTicket(dir, "AYO-2").source).toEqual({
      kind: "none",
      reference: null,
      url: null,
      title_at_admission: null,
    });
    expect(readTicket(dir, "AYO-3").source).toMatchObject({
      kind: "github",
      reference: "example/repo#273",
    });
  });
});
