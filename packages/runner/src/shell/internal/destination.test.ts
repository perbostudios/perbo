import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { judgeTarget } from "./destination.js";
import { resolveScope } from "./scope.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A write to a directory reaches everything under it, the worktree root
 * included, so both of the contract's lists judge a directory by whether a
 * glob covers its whole contents.
 */

const ROOT = realpathSync(scratch("perbo-destination-"));
mkdirSync(join(ROOT, "src", "secret"), { recursive: true });

const kind = (
  target: string,
  lists: { paths_allowed?: string[]; paths_prohibited?: string[] },
  cwd = ROOT,
) => judgeTarget(target, resolveScope({ root: ROOT, ...lists }), { path: cwd, unknown: false }, true);

describe("the worktree root as a write target", () => {
  const spellings = [".", "./", "src/..", ROOT];

  it("is outside a scope that does not admit the whole worktree", () => {
    for (const globs of [["src/**"], ["*"], ["**/*.ts"]]) {
      for (const target of spellings) {
        expect(kind(target, { paths_allowed: globs }), `${target} ${globs}`).toMatchObject({
          kind: "outside_scope",
          at: ".",
        });
      }
    }
    expect(kind("..", { paths_allowed: ["src/**"] }, join(ROOT, "src")).kind).toBe("outside_scope");
  });

  it("is inside `**`, `**/**` and no scope at all", () => {
    for (const globs of [["**"], ["src/**", "**"], ["**/**"], []]) {
      for (const target of spellings) {
        expect(kind(target, { paths_allowed: globs }).kind, `${target} ${globs}`).toBe("inside");
      }
    }
  });

  it("is prohibited only by a glob that covers the whole worktree", () => {
    expect(kind(".", { paths_prohibited: ["src/secret/**"] }).kind).toBe("inside");
    expect(kind(".", { paths_prohibited: ["**"] })).toMatchObject({ kind: "prohibited_path", at: "." });
  });
});

describe("a directory whose contents a glob names", () => {
  it("is prohibited by `<dir>/**`, however it is spelled", () => {
    for (const [target, prohibited] of [
      ["src/secret", "src/secret/**"],
      ["src/secret/", "src/secret/**"],
      ["./src/secret", "src/secret/**"],
      [".perbo", ".perbo/**"],
      ["pkg/.perbo", "**/.perbo/**"],
    ] as const) {
      expect(kind(target, { paths_prohibited: [prohibited] }), target).toMatchObject({
        kind: "prohibited_path",
      });
    }
    // The spec folder is prohibited with no contract behind it (D-103).
    expect(kind("specs", {})).toMatchObject({ kind: "prohibited_path", at: "specs" });
  });

  it("is admitted by `<dir>/**` and by nothing narrower", () => {
    expect(kind("src", { paths_allowed: ["src/**"] }).kind).toBe("inside");
    expect(kind("src/lib", { paths_allowed: ["src/lib/**"] }).kind).toBe("inside");
    expect(kind("src", { paths_allowed: ["src/lib/**"] }).kind).toBe("outside_scope");
    // `src/*` admits the files directly under `src`, not everything below it.
    expect(kind("src", { paths_allowed: ["src/*"] }).kind).toBe("outside_scope");
  });

  it("leaves a sibling that shares the name's prefix alone", () => {
    expect(kind("src/secrets", { paths_prohibited: ["src/secret/**"] }).kind).toBe("inside");
    expect(kind("srcs", { paths_allowed: ["src/**"] }).kind).toBe("outside_scope");
  });
});
