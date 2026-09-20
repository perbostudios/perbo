import { ScopeSchema, type PlanLevel, type Scope } from "@perbo/contracts";
import { describe, expect, it } from "vitest";
import { chooseLevel, levelAdditions } from "./admit.js";
import { USAGE } from "../command-line/usage.js";

/**
 * What the CLI puts in front of a partner, read for identifiers only this
 * repository knows.
 *
 * The help is the first thing anybody reads, and a P2 or P3 contract's default
 * `rollout` is copied verbatim into the Rollout section of every pull request
 * the loop publishes. A `D-0nn` or `SCP-nnn` in either names a document the
 * reader cannot open, in the lines that tell them what the program does and
 * what merging waits on.
 */

const DECISION_ID = /\b(D-0\d\d|SCP-\d{3})\b/;

/** Every line carrying one, so a failure names all of them rather than the first. */
const offending = (text: string): string[] =>
  text.split("\n").filter((line) => DECISION_ID.test(line));

/** A scope declaring one path, which is all the level derivation reads. */
const scopeOver = (path: string): Scope =>
  ScopeSchema.parse({
    repository_id: "repo_acme_api",
    paths_allowed: [path],
    paths_prohibited: [],
    generated_paths: [],
    expansion_budget_files: 3,
  });

/** The two derivations that reach the fields under test: P2 from a security path, P3 from CI. */
const LEVELS: ReadonlyArray<[PlanLevel, string]> = [
  ["P2", "packages/auth/**"],
  ["P3", ".github/workflows/**"],
];

describe("the help the entry point writes", () => {
  it("carries no decision or ticket identifier", () => {
    expect(offending(USAGE)).toEqual([]);
  });
});

describe("the fields a level adds to a contract nobody has stated", () => {
  it("default to none", () => {
    const offences: string[] = [];
    for (const [level, path] of LEVELS) {
      const scope = scopeOver(path);
      const derivation = chooseLevel(scope, null).derivation;
      expect(derivation.level, path).toBe(level);
      // Every default at once: `rollout` is the sentence the pull request
      // prints, and a sibling field is read by the same person on the way to
      // it.
      for (const [field, value] of Object.entries(levelAdditions(level, scope, derivation))) {
        if (typeof value === "string" && DECISION_ID.test(value)) {
          offences.push(`${level} ${field}: ${value}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
