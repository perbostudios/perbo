/**
 * Which criteria are proven differently now from how the draft proposed.
 *
 * A criterion says what must be proven and, in its `expected_verification`, how.
 * The two are edited separately and mean different things: rewriting the text
 * restates the claim, while rewriting the assertion changes the evidence that
 * will be taken for it. A criterion whose assertion has moved still reads
 * exactly as it did — the claim is untouched — so nothing on the page shows
 * that what will be accepted as proof is no longer what was proposed.
 *
 * Approval is where that matters, because approval freezes the criteria and
 * their verification and starts the loop (D-100). This is read there so a
 * person's eye goes to what moved rather than over all of them evenly.
 *
 * It reports and decides nothing. An assertion a person changed on purpose is
 * the ordinary case — tightening what a test asserts is work, not a defect —
 * and the mark is an invitation to read one line, not a warning.
 */

/**
 * One edit as the draft snapshot records it, narrowed to what this reads.
 *
 * `before` alone, and not the `keys` the record also carries: the two are
 * written from one walk and say the same thing, and a criterion this edit
 * created has a key with no `before` — which is exactly the entry to pass over,
 * so reading the keys would only be a longer way to the same answer.
 */
export interface AssertionEdit {
  before: Record<string, unknown>;
  undone: boolean;
  replaced: boolean;
  /** The edit this one undid, by its number, or null for an edit of its own. */
  undoes: number | null;
}

/** A criterion as the contract holds it, narrowed to what this reads. */
export interface AssertionCriterion {
  id: string;
  expected_verification: { assertion: string };
}

/**
 * The assertion inside a recorded entity, or null where the record does not
 * hold one.
 *
 * The entity is `unknown` and may be `null`, so every step is checked rather than cast.
 */
function assertionOf(entity: unknown): string | null {
  if (entity === null || typeof entity !== "object") return null;
  const verification = (entity as Record<string, unknown>)["expected_verification"];
  if (verification === null || typeof verification !== "object") return null;
  const assertion = (verification as Record<string, unknown>)["assertion"];
  return typeof assertion === "string" ? assertion : null;
}

/**
 * The ids of the criteria whose assertion differs from the one the draft
 * proposed.
 *
 * The drafted assertion is the `before` of the **earliest edit still in force**
 * that touched the criterion: an edit's `before` is the state just ahead of it,
 * so the first one is what the drafter wrote. Undone, replaced and undo edits
 * are passed over — an undone edit's `before` is a state that was put back, a
 * replaced one belonged to a contract that no longer exists (D-103), and an
 * undo's `before` is the edited state it reversed, never the drafted one — so
 * a criterion only ever edited and then un-edited is not marked, which is
 * right: its assertion is the drafted one.
 *
 * A criterion no edit touched is never marked, and neither is one added by an
 * edit: nothing drafted it, so there is no proposal to have moved away from.
 */
export function assertionsChangedSinceDraft(
  edits: readonly AssertionEdit[],
  criteria: readonly AssertionCriterion[],
): string[] {
  // The earliest edit in force is each criterion's baseline, kept even where
  // it holds no readable assertion (null): the recorder writes `null` for a
  // key an edit created, and letting the next edit's `before` stand in for it
  // would mark a criterion written by hand as having moved from a proposal
  // that never existed.
  const drafted = new Map<string, string | null>();
  for (const edit of edits) {
    if (edit.undone || edit.replaced || edit.undoes !== null) continue;
    for (const [key, entity] of Object.entries(edit.before)) {
      if (key.startsWith("criterion:") && !drafted.has(key)) drafted.set(key, assertionOf(entity));
    }
  }
  return criteria.flatMap((criterion) => {
    const was = drafted.get(`criterion:${criterion.id}`);
    return typeof was === "string" && was !== criterion.expected_verification.assertion
      ? [criterion.id]
      : [];
  });
}
