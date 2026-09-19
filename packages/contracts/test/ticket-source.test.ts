import { describe, expect, it } from "vitest";
import {
  TICKET_SCHEMA_VERSION,
  TICKET_SOURCE_KINDS,
  TicketSchema,
  TicketSourceSchema,
  ticketSourceLabel,
} from "../src/ticket.js";

/**
 * Where the work came from, as the record says it.
 *
 * `--from-file` used to write `kind: "none"` with the file's path in the
 * reference, which made two things untrue at once: a pasted file looked like
 * work that started here, and `none` — the kind that means "nothing to point
 * at" — pointed at something. Both are unrepresentable now, and this is where
 * that is asserted rather than assumed.
 */

const source = (overrides: Record<string, unknown>) => ({
  reference: null,
  url: null,
  title_at_admission: null,
  ...overrides,
});

describe("a ticket's source", () => {
  it("admits a file with an absolute path as its reference", () => {
    const parsed = TicketSourceSchema.parse(
      source({ kind: "file", reference: "/abs/path/issue.md" }),
    );
    expect(parsed).toEqual({
      kind: "file",
      reference: "/abs/path/issue.md",
      url: null,
      title_at_admission: null,
    });
    // A Windows-shaped absolute path is a path too: the record travels with the
    // repository and is read on whatever platform opens it next.
    expect(
      TicketSourceSchema.parse(source({ kind: "file", reference: "C:\\work\\issue.md" })).reference,
    ).toBe("C:\\work\\issue.md");
  });

  it("refuses a file source whose reference is relative, empty or missing", () => {
    for (const reference of ["issue.md", "./notes/issue.md", "", null]) {
      expect(
        TicketSourceSchema.safeParse(source({ kind: "file", reference })).success,
        `file reference ${JSON.stringify(reference)}`,
      ).toBe(false);
    }
  });

  it("refuses `none` paired with any reference at all", () => {
    expect(TicketSourceSchema.safeParse(source({ kind: "none", reference: "anything" })).success).toBe(
      false,
    );
    // Including the one shape that used to be written: a path.
    expect(
      TicketSourceSchema.safeParse(source({ kind: "none", reference: "/abs/path/issue.md" })).success,
    ).toBe(false);
    expect(TicketSourceSchema.parse(source({ kind: "none", reference: null })).reference).toBeNull();
  });

  it("refuses a tracker source with nothing to point at", () => {
    expect(TicketSourceSchema.safeParse(source({ kind: "github", reference: null })).success).toBe(false);
    expect(TicketSourceSchema.safeParse(source({ kind: "jira", reference: "" })).success).toBe(false);
    expect(
      TicketSourceSchema.parse(source({ kind: "linear", reference: "PROJ-88" })).reference,
    ).toBe("PROJ-88");
  });

  it("has no kind outside the five it names", () => {
    expect([...TICKET_SOURCE_KINDS]).toEqual(["github", "jira", "linear", "file", "none"]);
    expect(TicketSourceSchema.safeParse(source({ kind: "slack", reference: "x" })).success).toBe(false);
  });

  it("labels a source by its kind, and says nothing when there is nothing to say", () => {
    expect(ticketSourceLabel(TicketSourceSchema.parse(source({ kind: "file", reference: "/a/b.md" })))).toBe(
      "file /a/b.md",
    );
    expect(
      ticketSourceLabel(TicketSourceSchema.parse(source({ kind: "github", reference: "o/r#1" }))),
    ).toBe("github o/r#1");
    expect(ticketSourceLabel(TicketSourceSchema.parse(source({ kind: "none" })))).toBeNull();
    // A `none` that still carries a link says so rather than losing it.
    expect(
      ticketSourceLabel(
        TicketSourceSchema.parse(source({ kind: "none", url: "https://example.com/x" })),
      ),
    ).toBe("link https://example.com/x");
  });
});


/**
 * The shapes admission has ever written, as whole ticket records: ac_2's claim
 * is about stored tickets, and a source only reaches the store inside one.
 *
 * Fixed here rather than read from `.perbo/tickets`, which would make the
 * assertion depend on which tickets happen to be admitted the day it runs —
 * green because nobody has yet written the shape it is looking for, and silent
 * about the shape it never saw.
 */
const storedTicket = (source: Record<string, unknown>) => ({
  schema_version: TICKET_SCHEMA_VERSION,
  ticket_id: "ticket_01abcdef",
  key: "AYO-1",
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
  admission: { elapsed_ms: 4200, criteria_source: "typed", criteria_count: 3 },
  history: [{ at: "2026-08-28T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" }],
});

describe("a ticket written before `file` existed", () => {
  it("parses when its source is a tracker with a reference", () => {
    const parsed = TicketSchema.parse(
      storedTicket({
        kind: "github",
        reference: "example/repo#273",
        url: "https://github.com/example/repo/issues/273",
        title_at_admission: "A ticket admitted from a file has a source kind of its own",
      }),
    );
    expect(parsed.source).toMatchObject({ kind: "github", reference: "example/repo#273" });
  });

  it("parses when its source is `none` with a null reference", () => {
    const parsed = TicketSchema.parse(
      storedTicket({ kind: "none", reference: null, url: null, title_at_admission: null }),
    );
    expect(parsed.source).toEqual({
      kind: "none",
      reference: null,
      url: null,
      title_at_admission: null,
    });
  });

  it("does not parse when its source is the `none`-with-a-path `--from-file` used to write", () => {
    // The one shape the schema deliberately stopped admitting. It is not left
    // to fail at the reader: the ticket store normalises it to the `file`
    // source it always was before it validates
    // (`apps/cli/test/ticket-store-source.test.ts`).
    expect(
      TicketSchema.safeParse(
        storedTicket({
          kind: "none",
          reference: "/repo/inbox/SCP-169.md",
          url: null,
          title_at_admission: "A pasted issue",
        }),
      ).success,
    ).toBe(false);
  });
});
