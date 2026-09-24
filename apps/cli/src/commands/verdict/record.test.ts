import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STOP_VERDICTS_SCHEMA_VERSION,
  summariseStops,
  type StopVerdict,
  type StopVerdicts,
} from "@perbo/contracts";
import {
  EMPTY_LOCAL_VERDICTS,
  LocalVerdictSchema,
  VerdictConflictError,
  activeVerdicts,
  mergeLocalVerdicts,
  recordVerdict,
  verdictFor,
  verdictKey,
  type LocalVerdict,
} from "./record.js";

/**
 * The local verdicts record (SCP-181): one decision per review and key, an
 * earlier decision kept when it is replaced, and the projection that lets
 * `perbo stops` count a decision taken here beside one read off a pull
 * request.
 */

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

const verdict = (over: Partial<LocalVerdict> = {}): LocalVerdict =>
  LocalVerdictSchema.parse({
    review: {
      reference: "AYO-7",
      ticket_id: "ticket_verdict0001",
      ticket_key: "AYO-7",
      pull_request_url: "https://github.com/o/r/pull/9",
    },
    finding_key: KEY_A,
    rule_id: "auth.token_never_expires",
    routing: "blocks",
    decision: "endorse",
    author: "Lian <lian@example.invalid>",
    decided_at: "2026-09-04T10:00:00.000Z",
    note: "the expiry is a product call",
    superseded_at: null,
    ...over,
  });

const stopsFile = (over: Partial<StopVerdicts> = {}): StopVerdicts => ({
  schema_version: STOP_VERDICTS_SCHEMA_VERSION,
  ticket_id: "ticket_verdict0001",
  ticket_key: "AYO-7",
  pull_request_url: "https://github.com/o/r/pull/9",
  stops: [],
  shown_to_person: false,
  first_seen_at: "2026-09-03T09:00:00.000Z",
  observed_at: "2026-09-03T09:00:00.000Z",
  ...over,
});

/** A stop as a sync writes it, where the tick carries no signature: a person's. */
const stop = (finding_key: string, answer: StopVerdict["answer"], at: string): StopVerdict => ({
  finding_key,
  rule_id: "auth.token_never_expires",
  routing: "blocks",
  answer,
  answered_at: answer === null ? null : at,
  answered_by: answer === null ? null : "person",
  first_seen_at: "2026-09-03T09:00:00.000Z",
});

describe("the local verdicts record", () => {
  it("refuses a stop answer that carries no routing, which nothing could project", () => {
    expect(() => verdict({ routing: null })).toThrow(/routing/);
    // A finding that stopped nothing is judged, never endorsed.
    expect(verdict({ routing: null, decision: "reject" }).routing).toBeNull();
  });

  it("appends the first decision on a key", () => {
    const file = recordVerdict({ previous: null, verdict: verdict(), replace: false });
    expect(file.verdicts).toHaveLength(1);
    expect(verdictFor(file.verdicts, "ticket_verdict0001", KEY_A)?.decision).toBe("endorse");
  });

  it("refuses a second decision on a decided key, naming the one that stands", () => {
    const first = recordVerdict({ previous: null, verdict: verdict(), replace: false });
    let thrown: unknown;
    try {
      recordVerdict({ previous: first, verdict: verdict({ decision: "override" }), replace: false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VerdictConflictError);
    expect((thrown as VerdictConflictError).existing.decision).toBe("endorse");
    expect((thrown as VerdictConflictError).message).toContain("Lian <lian@example.invalid>");
  });

  it("keeps the earlier decision on the record when one replaces it", () => {
    const first = recordVerdict({ previous: null, verdict: verdict(), replace: false });
    const second = recordVerdict({
      previous: first,
      verdict: verdict({ decision: "override", decided_at: "2026-09-05T08:00:00.000Z", note: null }),
      replace: true,
    });
    expect(second.verdicts).toHaveLength(2);
    expect(second.verdicts[0]).toMatchObject({
      decision: "endorse",
      note: "the expiry is a product call",
      superseded_at: "2026-09-05T08:00:00.000Z",
    });
    expect(activeVerdicts(second.verdicts)).toHaveLength(1);
    expect(activeVerdicts(second.verdicts)[0]?.decision).toBe("override");
  });

  it("keys a decision by its review and finding, joined by one U+0000", () => {
    const row = verdict();
    const key = verdictKey(row);
    // The separator is a character neither part can hold, so no pair of
    // (review, finding) can collide with another by running together.
    expect(key.split("\u0000")).toEqual([row.review.ticket_id, row.finding_key]);
    expect([...key].filter((character) => character === "\u0000")).toHaveLength(1);
  });

  it("spells that separator as an escape, never as a byte in the source", () => {
    // A raw 0x00 in the file makes git call it binary and the review that
    // reads the diff never runs. The key above is the same either way; the
    // source has to stay printable.
    const source = readFileSync(new URL("./record.ts", import.meta.url));
    expect(source.indexOf(0)).toBe(-1);
  });

  it("replaces the record whole, since `perbo inspect` reads it while a run is live", () => {
    const writer = /export function writeLocalVerdicts[\s\S]*?\n\}/.exec(
      readFileSync(new URL("./record.ts", import.meta.url), "utf8"),
    )?.[0];
    expect(writer).toMatch(/replaceFile\(verdictsPath\(dir\)/);
    expect(writer).not.toMatch(/writeFileSync/);
  });

  it("keeps decisions on different keys and different reviews apart", () => {
    const one = recordVerdict({ previous: null, verdict: verdict(), replace: false });
    const two = recordVerdict({ previous: one, verdict: verdict({ finding_key: KEY_B }), replace: false });
    const three = recordVerdict({
      previous: two,
      verdict: verdict({
        review: {
          reference: "AYO-8",
          ticket_id: "ticket_verdict0002",
          ticket_key: "AYO-8",
          pull_request_url: null,
        },
      }),
      replace: false,
    });
    expect(activeVerdicts(three.verdicts)).toHaveLength(3);
  });
});

describe("the record says who decided", () => {
  const ADA = { name: "Ada Lovelace", email: "ada@example.invalid" };

  it("carries the pair the repository named, typed rather than run together into prose", () => {
    const row = verdict({ author: "Ada Lovelace <ada@example.invalid>", decided_by: ADA });
    expect(row.decided_by).toEqual(ADA);
    // The two halves stay apart, so a reader never has to split a string to
    // find out which is the name and which is the address.
    expect(row.decided_by?.name).toBe("Ada Lovelace");
    expect(row.decided_by?.email).toBe("ada@example.invalid");
  });

  it("parses a record written before the field existed, and leaves it without one", () => {
    // The fixture is exactly what this store wrote yesterday: an author line
    // and nothing else about who. It parses, it keeps its place on the record,
    // and it gains no field it was not written with — an existing store keeps
    // being read rather than being migrated.
    const before = verdict();
    expect(before.decided_by).toBeUndefined();
    expect(Object.keys(before)).not.toContain("decided_by");

    const file = recordVerdict({ previous: null, verdict: before, replace: false });
    expect(file.verdicts[0]).toEqual(before);
    expect(JSON.stringify(file)).not.toContain("decided_by");

    // And the two kinds of row sit in one file: nothing about reading the old
    // one depends on the new one being absent.
    const both = recordVerdict({
      previous: file,
      verdict: verdict({ finding_key: KEY_B, decided_by: ADA }),
      replace: false,
    });
    expect(both.verdicts.map((row) => row.decided_by)).toEqual([undefined, ADA]);
  });

  it("refuses half of one: a name with no address, an address with no name, either empty", () => {
    for (const decided_by of [
      { name: "Ada Lovelace" },
      { email: "ada@example.invalid" },
      { name: "", email: "ada@example.invalid" },
      { name: "Ada Lovelace", email: "" },
      { ...ADA, account: "ada" },
    ]) {
      expect(() => verdict({ decided_by } as Partial<LocalVerdict>)).toThrow();
    }
  });
});

describe("local decisions and pull-request answers are one population", () => {
  it("builds the whole record from decisions where no pull request was ever read", () => {
    const local = mergeLocalVerdicts([], [verdict(), verdict({ finding_key: KEY_B, decision: "override" })]);
    const fromPullRequest = [
      stopsFile({
        stops: [stop(KEY_A, "endorse", "2026-09-04T10:00:00.000Z"), stop(KEY_B, "override", "2026-09-04T10:00:00.000Z")],
        shown_to_person: true,
        first_seen_at: "2026-09-04T10:00:00.000Z",
        observed_at: "2026-09-04T10:00:00.000Z",
      }),
    ];
    expect(summariseStops(local)).toEqual(summariseStops(fromPullRequest));
    expect(summariseStops(local).precision.point).toBe(1);
  });

  it("answers a stop the pull request left unticked, matched by the checkbox's key", () => {
    const merged = mergeLocalVerdicts(
      [stopsFile({ stops: [stop(KEY_A, null, ""), stop(KEY_B, null, "")], shown_to_person: true })],
      [verdict({ decision: "override" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.stops.find((one) => one.finding_key === KEY_A)).toMatchObject({
      answer: "override",
      answered_at: "2026-09-04T10:00:00.000Z",
    });
    expect(merged[0]?.stops.find((one) => one.finding_key === KEY_B)?.answer).toBeNull();
    expect(summariseStops(merged).unanswered_stops).toBe(1);
  });

  it("adds a stop the pull request never listed rather than dropping the decision", () => {
    const merged = mergeLocalVerdicts(
      [stopsFile({ stops: [stop(KEY_A, "endorse", "2026-09-03T09:00:00.000Z")], shown_to_person: true })],
      [verdict({ finding_key: KEY_B, decision: "override" })],
    );
    expect(merged[0]?.stops.map((one) => one.finding_key)).toEqual([KEY_A, KEY_B]);
    expect(summariseStops(merged).stops).toBe(2);
  });

  it("lets the later of a tick and a local decision stand", () => {
    const ticked = stopsFile({
      stops: [stop(KEY_A, "endorse", "2026-09-06T09:00:00.000Z")],
      shown_to_person: true,
    });
    expect(mergeLocalVerdicts([ticked], [verdict({ decision: "override" })])[0]?.stops[0]?.answer).toBe(
      "endorse",
    );
    expect(
      mergeLocalVerdicts([ticked], [verdict({ decision: "override", decided_at: "2026-09-07T09:00:00.000Z" })])[0]
        ?.stops[0]?.answer,
    ).toBe("override");
  });

  it("leaves a superseded decision, and one that judges a finding, out of the count", () => {
    const superseded = verdict({ superseded_at: "2026-09-05T08:00:00.000Z" });
    const judged = verdict({ finding_key: KEY_B, decision: "reject", routing: null });
    expect(mergeLocalVerdicts([], [superseded, judged])).toEqual([]);
    expect(summariseStops(mergeLocalVerdicts([], [superseded, judged]))).toEqual(
      summariseStops([]),
    );
  });

  it("is the identity on a store with no decisions in it", () => {
    const files = [stopsFile({ stops: [stop(KEY_A, "endorse", "2026-09-03T09:00:00.000Z")] })];
    expect(mergeLocalVerdicts(files, EMPTY_LOCAL_VERDICTS.verdicts)).toEqual(files);
  });

  it("SCP-189: marks shown_to_person once a decision merges, whatever the file said before", () => {
    // A decision existing for the ticket is what being shown means, whether it
    // matches a stop already on the file, adds one, or — this file's
    // `shown_to_person: false` and empty `stops` — the file had recorded
    // nothing at all yet.
    const merged = mergeLocalVerdicts(
      [stopsFile({ stops: [], shown_to_person: false })],
      [verdict()],
    );
    expect(merged[0]?.shown_to_person).toBe(true);
  });
});
