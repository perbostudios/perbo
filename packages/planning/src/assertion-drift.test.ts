import { describe, expect, it } from "vitest";
import { assertionsChangedSinceDraft } from "./assertion-drift.js";

/** One criterion as the contract holds it. */
const criterion = (id: string, assertion: string) => ({
  id,
  expected_verification: { assertion },
});

/** One recorded edit, in the draft snapshot's own shape. */
const edit = (
  keys: Record<string, { before: unknown; after: unknown }>,
  flags: { undone?: boolean; replaced?: boolean } = {},
) => ({
  before: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.before])),
  undone: flags.undone ?? false,
  replaced: flags.replaced ?? false,
});

/** A recorded criterion entity, as `difference` writes it into before/after. */
const held = (id: string, assertion: string) => ({
  id,
  text: "The dock resizes.",
  expected_verification: { kind: "test", assertion },
});

describe("which criteria are proven differently from how the draft proposed", () => {
  it("marks one whose assertion an edit moved", () => {
    const edits = [
      edit({ "criterion:ac_1": { before: held("ac_1", "status === 200"), after: held("ac_1", "status === 201") } }),
    ];
    expect(
      assertionsChangedSinceDraft(edits, [criterion("ac_1", "status === 201")]),
    ).toEqual(["ac_1"]);
  });

  it("leaves one no edit ever touched", () => {
    expect(assertionsChangedSinceDraft([], [criterion("ac_1", "status === 200")])).toEqual([]);
  });

  it("compares against the drafted assertion, not the one before the last edit", () => {
    // Edited twice. The proposal is what the drafter wrote, so the second
    // edit's `before` is not the baseline — the first edit's is.
    const edits = [
      edit({ "criterion:ac_1": { before: held("ac_1", "drafted"), after: held("ac_1", "second") } }),
      edit({ "criterion:ac_1": { before: held("ac_1", "second"), after: held("ac_1", "drafted") } }),
    ];
    // Back where it started: nothing moved from the proposal.
    expect(assertionsChangedSinceDraft(edits, [criterion("ac_1", "drafted")])).toEqual([]);
  });

  it("takes its baseline from the earliest edit IN FORCE, passing over an undone one before it", () => {
    // Discriminating on purpose: the undone edit's `before` already holds what
    // the criterion says now, so reading it as the baseline would report
    // nothing moved. The edit still in force is the one that says what the
    // drafter wrote. Count the undone edit and this goes quiet.
    const edits = [
      edit(
        { "criterion:ac_1": { before: held("ac_1", "status === 201"), after: held("ac_1", "scratch") } },
        { undone: true },
      ),
      edit({ "criterion:ac_1": { before: held("ac_1", "status === 200"), after: held("ac_1", "status === 201") } }),
    ];
    expect(assertionsChangedSinceDraft(edits, [criterion("ac_1", "status === 201")])).toEqual(["ac_1"]);
  });

  it("passes over an edit a re-draft replaced, whose contract no longer exists", () => {
    // The replaced edit's `before` belongs to a plan that is gone (D-103), and
    // reading it as the baseline would mark a freshly drafted criterion as
    // moved on the strength of a contract nobody holds.
    const edits = [
      edit(
        { "criterion:ac_1": { before: held("ac_1", "from the old plan"), after: held("ac_1", "also old") } },
        { replaced: true },
      ),
    ];
    expect(assertionsChangedSinceDraft(edits, [criterion("ac_1", "freshly drafted")])).toEqual([]);
  });

  it("does not mark a criterion an edit created, then edited", () => {
    // `add_node` writes a new criterion, and the recorder writes `null` for its
    // key — not `undefined`. A later edit to the same criterion must not become
    // its baseline: nothing drafted it, so there is no proposal to have moved
    // away from, however many times it is changed afterwards.
    const edits = [
      edit({ "criterion:ac_9": { before: null, after: held("ac_9", "written by hand") } }),
      edit({ "criterion:ac_9": { before: held("ac_9", "written by hand"), after: held("ac_9", "tightened") } }),
    ];
    expect(assertionsChangedSinceDraft(edits, [criterion("ac_9", "tightened")])).toEqual([]);
  });

  it("ignores keys that are not criteria", () => {
    const edits = [
      edit({ "node:node_1": { before: { id: "node_1", title: "A" }, after: { id: "node_1", title: "B" } } }),
    ];
    expect(assertionsChangedSinceDraft(edits, [criterion("ac_1", "unchanged")])).toEqual([]);
  });

  it("says nothing of a record it cannot read, rather than throwing on the page that approves", () => {
    const edits = [
      edit({ "criterion:ac_1": { before: { expected_verification: null }, after: held("ac_1", "x") } }),
      edit({ "criterion:ac_2": { before: "not an object", after: held("ac_2", "y") } }),
    ];
    expect(
      assertionsChangedSinceDraft(edits, [criterion("ac_1", "x"), criterion("ac_2", "y")]),
    ).toEqual([]);
  });

  it("marks several, in the order the contract holds them", () => {
    const edits = [
      edit({
        "criterion:ac_2": { before: held("ac_2", "was b"), after: held("ac_2", "now b") },
        "criterion:ac_1": { before: held("ac_1", "was a"), after: held("ac_1", "now a") },
      }),
    ];
    expect(
      assertionsChangedSinceDraft(edits, [
        criterion("ac_1", "now a"),
        criterion("ac_2", "now b"),
        criterion("ac_3", "untouched"),
      ]),
    ).toEqual(["ac_1", "ac_2"]);
  });
});
