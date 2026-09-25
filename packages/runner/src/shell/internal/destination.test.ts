import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { judgeTarget } from "./destination.js";
import { resolveScope } from "./scope.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A write to a directory reaches everything under it, the worktree root
 * included. The allowed globs admit a directory whose whole contents they
 * cover and nothing inside it is prohibited; the prohibited globs refuse one
 * they cover, and one they name a place inside.
 */

const ROOT = realpathSync(scratch("perbo-destination-"));
mkdirSync(join(ROOT, "src", "secret"), { recursive: true });

const kind = (
  target: string,
  lists: { paths_allowed?: string[]; paths_prohibited?: string[]; spec_folder_writable?: boolean },
  cwd = ROOT,
) => judgeTarget(target, resolveScope({ root: ROOT, ...lists }), { path: cwd, unknown: false }, true);

describe("the worktree root as a write target", () => {
  const spellings = [".", "./", "src/..", ROOT];

  it("is outside a scope that does not admit the whole worktree", () => {
    for (const globs of [["src/**"], ["*"], ["**/*.ts"]]) {
      for (const target of spellings) {
        expect(
          kind(target, { paths_allowed: globs, spec_folder_writable: true }),
          `${target} ${globs}`,
        ).toMatchObject({
          kind: "outside_scope",
          at: ".",
        });
      }
    }
    expect(kind("..", { paths_allowed: ["src/**"], spec_folder_writable: true }, join(ROOT, "src")).kind).toBe(
      "outside_scope",
    );
  });

  it("is inside `**`, `**/**` and no scope at all where nothing is prohibited", () => {
    for (const globs of [["**"], ["src/**", "**"], ["**/**"], []]) {
      for (const target of spellings) {
        expect(
          kind(target, { paths_allowed: globs, spec_folder_writable: true }).kind,
          `${target} ${globs}`,
        ).toBe("inside");
      }
    }
  });

  it("is prohibited by every prohibited glob, each naming a place inside it", () => {
    for (const lists of [
      { paths_prohibited: ["src/secret/**"], spec_folder_writable: true },
      { paths_prohibited: [".perbo/**"], paths_allowed: ["**"] },
      { paths_prohibited: ["**/*.pem"], spec_folder_writable: true },
      { paths_prohibited: ["**"] },
      // The spec folder, prohibited with no contract behind it (D-103).
      { paths_allowed: ["**"] },
    ]) {
      for (const target of spellings) {
        expect(kind(target, lists), `${target} ${JSON.stringify(lists)}`).toMatchObject({
          kind: "prohibited_path",
          at: ".",
        });
      }
    }
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

describe("a directory with a prohibited path inside it", () => {
  const nested = { paths_allowed: ["src/**"], paths_prohibited: ["src/generated/**"] };

  it("is refused as prohibited, however it is spelled", () => {
    for (const target of ["src", "./src", "src/", "src/secret/.."]) {
      expect(kind(target, nested), target).toMatchObject({ kind: "prohibited_path", at: "src" });
    }
    // A wildcard after the segments that spell the directory still names a
    // place inside it.
    expect(kind("src", { ...nested, paths_prohibited: ["src/*/secret/**"] }).kind).toBe("prohibited_path");
  });

  it("leaves a sibling of the prohibited path admitted", () => {
    expect(kind("src/other", nested).kind).toBe("inside");
    expect(kind("src/generated.ts", nested).kind).toBe("inside");
  });

  it("is admitted whole where no prohibited glob reaches inside it", () => {
    expect(kind("src", { paths_allowed: ["src/**"], paths_prohibited: ["docs/generated/**"] }).kind).toBe(
      "inside",
    );
  });

  it("is not admitted whole where a wildcard glob can reach inside it", () => {
    for (const prohibited of ["**/*.pem", "*/generated/**"]) {
      expect(kind("src", { paths_allowed: ["src/**"], paths_prohibited: [prohibited] }), prohibited).toMatchObject({
        kind: "outside_scope",
        at: "src",
      });
    }
    // A file the allowed globs name directly stays admitted: the guard cannot
    // tell it from a directory, and the glob names no place inside it.
    expect(kind("src/a.ts", { paths_allowed: ["src/**"], paths_prohibited: ["**/*.pem"] }).kind).toBe("inside");
  });
});
