import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { judgeInto, judgeTarget } from "./destination.js";
import type { Word } from "./lexer.js";
import { resolveScope } from "./scope.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A write to a directory reaches everything under it, the worktree root
 * included. The allowed globs admit a directory whose whole contents they
 * cover and nothing inside it is prohibited; the prohibited globs refuse one
 * they cover, and one they name a place inside.
 */

const ROOT = realpathSync(scratch("perbo-destination-"));
for (const directory of ["src/secret", "src/keys", "src/other", "src/generated", "packages/app/generated"]) {
  mkdirSync(join(ROOT, directory), { recursive: true });
}
writeFileSync(join(ROOT, "src/keys/k.pem"), "key\n");
writeFileSync(join(ROOT, "src/other/a.ts"), "source\n");

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

  it("is not admitted whole where a wildcard glob can reach inside it and it is not there yet", () => {
    for (const prohibited of ["**/*.pem", "*/generated/**"]) {
      expect(kind("lib", { paths_allowed: ["lib/**"], paths_prohibited: [prohibited] }), prohibited).toMatchObject({
        kind: "outside_scope",
        at: "lib",
      });
    }
    // A file the allowed globs name directly stays admitted: the guard cannot
    // tell it from a directory, and the glob names no place inside it.
    expect(kind("src/a.ts", { paths_allowed: ["src/**"], paths_prohibited: ["**/*.pem"] }).kind).toBe("inside");
  });
});

describe("a directory on disk a wildcard prohibited glob can reach inside", () => {
  it("is refused as prohibited where something on disk under it matches, inside the allowed globs or named by them", () => {
    for (const [target, allowed, prohibited] of [
      ["src/keys", "src/**", "**/*.pem"],
      ["src", "**", "**/*.pem"],
      ["src", "src/**", "**/*.pem"],
      ["packages/app", "packages/**", "packages/*/generated/**"],
      ["src", "**", "*/generated/**"],
      ["src/keys/", "src/**", "**/*.pem"],
    ] as const) {
      expect(kind(target, { paths_allowed: [allowed], paths_prohibited: [prohibited] }), target).toMatchObject({
        kind: "prohibited_path",
      });
    }
  });

  it("is admitted where nothing on disk under it matches, and whole where the allowed globs cover it", () => {
    for (const target of ["src/other", "src/secret", "src/generated"]) {
      expect(kind(target, { paths_allowed: ["src/**"], paths_prohibited: ["**/*.pem"] }).kind, target).toBe("inside");
    }
    expect(
      kind("packages/app", { paths_allowed: ["packages/app/**"], paths_prohibited: ["**/*.pem", "**/.env*"] }).kind,
    ).toBe("inside");
  });

  it("is admitted where no prohibited glob can reach inside it", () => {
    expect(kind("src/other", { paths_allowed: ["src/**"], paths_prohibited: ["src/generated/**"] }).kind).toBe(
      "inside",
    );
    expect(kind("src/keys", { paths_allowed: ["src/**"] }).kind).toBe("inside");
    expect(kind("src", { paths_allowed: ["**"], paths_prohibited: ["docs/**/*.pem"] }).kind).toBe("inside");
  });

  it("is left alone as the directory a command works in", () => {
    const scope = resolveScope({ root: ROOT, paths_allowed: ["src/**"], paths_prohibited: ["**/*.pem"] });
    expect(judgeTarget("src/keys", scope, { path: ROOT, unknown: false }, true, "place").kind).toBe("inside");
  });

  it("is judged by what a copy or a move puts there, as well as by what it holds", () => {
    const scope = resolveScope({ root: ROOT, paths_allowed: ["src/**"], paths_prohibited: ["**/*.pem"] });
    const here = { path: ROOT, unknown: false };
    for (const target of ["src/new", "src/other"]) {
      expect(judgeTarget(target, scope, here, true, "whole", [join(ROOT, "src/keys")]), target).toMatchObject({
        kind: "prohibited_path",
        at: target,
      });
      expect(judgeTarget(target, scope, here, true, "whole", [join(ROOT, "src/secret")]).kind, target).toBe("inside");
    }
  });
});

/**
 * A copy, move or link into a directory on disk writes each source under its
 * own name there, so that path is judged and the directory only as a place.
 */
describe("a directory on disk a command writes its sources into", () => {
  writeFileSync(join(ROOT, "src/a.ts"), "source\n");
  writeFileSync(join(ROOT, "x.pem"), "key\n");
  const word = (value: string): Word => ({ raw: value, value, substitutions: [], variable: false });
  const scope = resolveScope({ root: ROOT, paths_allowed: ["**"], paths_prohibited: ["**/*.pem"] });
  const into = (directory: string, ...sources: string[]) =>
    judgeInto(word(directory), sources.map(word), scope, { path: ROOT, unknown: false });

  it("judges each source's path there, a file by its name", () => {
    const entries = into("src/other/", "src/a.ts");
    expect(entries?.map(({ word, destination }) => [word.value, destination.kind])).toEqual([
      ["src/other/", "inside"],
      ["src/other/a.ts", "inside"],
    ]);
    expect(into("src/other", "x.pem")?.[1]).toMatchObject({
      word: { value: "src/other/x.pem" },
      destination: { kind: "prohibited_path", at: "src/other/x.pem" },
    });
  });

  it("judges a directory source as a directory under its name holding what the source holds", () => {
    expect(into("src/other", "src/keys")?.[1]).toMatchObject({
      word: { value: "src/other/keys" },
      destination: { kind: "prohibited_path", at: "src/other/keys" },
    });
    for (const source of ["src/secret", "bin"]) {
      expect(into("src/other", source)?.[1]?.destination.kind, source).toBe("inside");
    }
  });

  it("still refuses the directory itself where the contract prohibits it", () => {
    const covered = resolveScope({ root: ROOT, paths_allowed: ["**"], paths_prohibited: ["src/keys/**"] });
    const entries = judgeInto(word("src/keys"), [word("src/a.ts")], covered, { path: ROOT, unknown: false });
    expect(entries?.[0]?.destination).toMatchObject({ kind: "prohibited_path", at: "src/keys" });
  });

  it("gives no reading where the destination is not a directory on disk or a source's name is not on the line", () => {
    expect(into("src/new", "src/a.ts")).toBeNull();
    expect(into("src/a.ts", "x.pem")).toBeNull();
    for (const source of ["src/keys/", "src/*", ".", "src/..", "~", "/etc/hosts"]) {
      expect(into("src/other", source), source).toBeNull();
    }
    const built: Word = { raw: "$X", value: "$X", substitutions: [], variable: true };
    expect(judgeInto(word("src/other"), [built], scope, { path: ROOT, unknown: false })).toBeNull();
  });
});
