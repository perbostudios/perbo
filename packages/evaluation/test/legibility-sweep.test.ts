import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assessLegibility } from "@perbo/review";
import { defaultCacheDir } from "../src/corpus.js";
import { corpus, describeCorpus } from "./corpus-present.js";

/**
 * A new deterministic blocking rule, measured against the corpus before it is
 * trusted — the same pass the generated-path rule (D-062) and the credential
 * detector were held to.
 *
 * `legibility.*` always blocks and has no confidence term, so a false positive
 * is not a noisy finding: it stops a correct change with no way to argue. The
 * corpus is 100 real diffs, and none of them should trip it.
 */

describeCorpus("the legibility rule on the whole corpus (SCP-114)", () => {

  const diffs = corpus.flatMap((entry) => {
    const local = join(entry.dir, "change.diff");
    const cached = join(defaultCacheDir(), entry.fixture.id, "change.diff");
    const path = existsSync(local) ? local : existsSync(cached) ? cached : null;
    if (!path) return [];
    const generated = entry.fixture.pinned_repository
      ? []
      : (entry.contract.scope?.generated_paths ?? []);
    return [{ id: entry.fixture.id, diff: readFileSync(path, "utf8"), generated }];
  });

  /**
   * Authored fixtures carry `change.diff` in the repository; pinned ones only
   * have a diff once `prepare` has cloned them, and CI has no cache. Asserting
   * on the combined count passed locally at 95 and failed CI at 72 — the same
   * shape as the defect the dogfood run recorded, where this repository could
   * not pass its own unit check because a worktree has no corpus cache.
   *
   * So the floor is the authored count, which is always present, and pinned
   * diffs are swept as a bonus wherever the cache happens to exist.
   */
  const authored = corpus.filter((entry) => !entry.fixture.pinned_repository).length;

  it("sweeps at least every authored fixture, cache or no cache", () => {
    expect(authored).toBeGreaterThan(60);
    expect(diffs.length).toBeGreaterThanOrEqual(authored);
  });

  it("fires on none of them", () => {
    const fired = diffs
      .map((entry) => ({ id: entry.id, result: assessLegibility(entry.diff, entry.generated) }))
      .filter((entry) => entry.result.findings.length > 0)
      .map((entry) => `${entry.id}: ${entry.result.findings.map((f) => f.rule_id).join(", ")}`);
    expect(
      fired,
      "legibility.* always blocks and carries no confidence term, so a false positive here stops " +
        "a correct change with nothing to argue against. Fix the rule, not this test.",
    ).toEqual([]);
  });
});
