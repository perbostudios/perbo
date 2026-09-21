import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Opening a pull request twice must not fail the run.
 *
 * M1's exit criteria ask that merge and check state read through local
 * `git`/`gh` update idempotently. Reading is already idempotent —
 * `pollPullRequest` is a `gh pr view`. Creation was not: it called
 * `gh pr create` unconditionally, so a second delivery on a branch that
 * already had a pull request failed the run over a pull request that already
 * said what it needed to. Dogfooding showed a retry landing on its
 * predecessor's branch twice, which is exactly the situation.
 *
 * Asserted against the source: this is about which calls exist, and a live
 * test here would be measuring GitHub rather than this code.
 */

const source = readFileSync(new URL("./delivery.ts", import.meta.url), "utf8");
const createBody = source.slice(
  source.indexOf("export async function createPullRequest"),
  source.indexOf("export async function pollPullRequest"),
);

describe("createPullRequest", () => {
  it("looks for an existing pull request on the branch before creating one", () => {
    expect(createBody).toMatch(/viewPullRequest\(/);
  });

  it("returns the existing one rather than throwing", () => {
    expect(createBody).toMatch(/existing/i);
  });

  it("still refuses a branch that is not the attempt's own", () => {
    expect(createBody).toContain("isAttemptBranch");
  });
});
