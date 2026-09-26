import { describe, expect, it } from "vitest";
import { openDrafts, readingState, readingStateOf, type SpecReader } from "./contract-editing.js";
import type { EditingSession, SpecSections } from "./protocol.js";

/**
 * The state a reading of the plan against its spec is of (D-128), which a
 * basic ticket's Confirm contract compares with the last reading's
 * (D-NEW-basic-and-epic-flows).
 */

describe("the state a reading is of", () => {
  const promise = { outcome: "Signups get one email.", criteria: [{ text: "One email is queued." }, { text: "It is sent within a minute." }] };
  it("is the spec's sections and the plan's promise, by their words, and nothing of their order", () => {
    const at = readingState("0011223344556677", promise);
    expect(readingState("0011223344556677", { ...promise, criteria: [...promise.criteria].reverse() })).toBe(at);
    expect(readingState("0011223344556677", { outcome: " Signups get one email. ", criteria: promise.criteria })).toBe(at);
    expect(readingState("ffeeddccbbaa9988", promise)).not.toBe(at);
    expect(readingState(null, promise)).not.toBe(at);
    expect(readingState("0011223344556677", { ...promise, outcome: "Signups get two emails." })).not.toBe(at);
    expect(
      readingState("0011223344556677", { ...promise, criteria: [{ text: "One email is queued." }, { text: "It is sent within an hour." }] }),
    ).not.toBe(at);
    expect(readingState("0011223344556677", { ...promise, criteria: promise.criteria.slice(0, 1) })).not.toBe(at);
  });

  it("of a planning's record is what the confirm compares: the drafts list's spec and the plan the session holds", () => {
    // A host records the state of a reading it asked for itself with this, and
    // the confirm compares `read` with the same two things read off the drafts
    // list and the session, so the two must agree to the character.
    const sections: SpecSections = {
      outcome: "Signups get one email.",
      requirements: "- R1: One email is queued.",
      no_gos: "",
      rabbit_holes: "",
      notes: "",
    };
    const spec: SpecReader = () => ({ title: "Signup mail", sections });
    const record = {
      id: "s-1",
      repoId: "r-1",
      key: "PRB-1",
      admitted: true,
      phase: "ready",
      nodes: 0,
      drift: null,
      specSlug: "signup-mail",
      specCut: null,
      lastPane: null,
      confirmed: null,
      read: null,
      impact: null,
      form: { draft: { outcome: promise.outcome, criteria: promise.criteria, paths: [], prohibited: [] } },
    } as unknown as EditingSession;
    const listed = openDrafts([record], spec)[0]!;
    expect(readingStateOf(record, spec)).toBe(readingState(listed.spec, record.form.draft));
    // And it moves with either: a criterion reworded, or the spec's words.
    const reworded = {
      ...record,
      form: { draft: { ...record.form.draft, criteria: [{ text: "Two emails are queued." }, promise.criteria[1]] } },
    } as unknown as EditingSession;
    expect(readingStateOf(reworded, spec)).not.toBe(readingStateOf(record, spec));
    const edited: SpecReader = () => ({ title: "Signup mail", sections: { ...sections, outcome: "Signups get two emails." } });
    expect(readingStateOf(record, edited)).not.toBe(readingStateOf(record, spec));
    // A planning with no spec to read is a state of its own, never another's.
    expect(readingStateOf(record, () => null)).toBe(readingState(null, record.form.draft));
  });
});
