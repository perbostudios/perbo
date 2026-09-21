import { describe, expect, it } from "vitest";
import { TURBO_FORCE_FLAG, runsTurboWithoutForce, withTurboForce } from "../src/checks/index.js";

/**
 * The argv half of running a check uncached: which commands are a turbo
 * invocation the runner can see, and where the flag goes on them.
 *
 * The environment covers a turbo nested under a package script, which no argv
 * shows. This covers the other direction — a command that reaches turbo with an
 * environment the runner does not own — and it is also what `doctor` reads to
 * say a configured check is missing the flag.
 */

describe("a command that runs turbo", () => {
  it("takes the flag when it has none", () => {
    expect(withTurboForce(["turbo", "run", "test"])).toEqual(["turbo", "run", "test", TURBO_FORCE_FLAG]);
    expect(withTurboForce(["pnpm", "exec", "turbo", "run", "typecheck"])).toEqual([
      "pnpm",
      "exec",
      "turbo",
      "run",
      "typecheck",
      TURBO_FORCE_FLAG,
    ]);
    // An absolute path to the binary is the same invocation.
    expect(withTurboForce(["/tmp/node_modules/.bin/turbo", "run", "lint"])).toEqual([
      "/tmp/node_modules/.bin/turbo",
      "run",
      "lint",
      TURBO_FORCE_FLAG,
    ]);
  });

  it("keeps the flag ahead of arguments meant for the task, not after them", () => {
    // Everything after a bare `--` belongs to the task turbo runs, so a flag
    // appended past it would be handed to the test runner instead of to turbo.
    expect(withTurboForce(["turbo", "run", "test", "--", "--reporter=dot"])).toEqual([
      "turbo",
      "run",
      "test",
      TURBO_FORCE_FLAG,
      "--",
      "--reporter=dot",
    ]);
  });

  it("is left alone when it already says so", () => {
    for (const argv of [
      ["turbo", "run", "test", "--force"],
      ["turbo", "run", "test", "--force=true"],
      ["pnpm", "exec", "turbo", "run", "test", "--force"],
    ]) {
      expect(withTurboForce(argv)).toEqual(argv);
      expect(runsTurboWithoutForce(argv)).toBe(false);
    }
  });

  it("is named as missing the flag while it is", () => {
    expect(runsTurboWithoutForce(["pnpm", "exec", "turbo", "run", "test"])).toBe(true);
    expect(runsTurboWithoutForce(["turbo", "run", "build", "typecheck"])).toBe(true);
  });
});

describe("a command that runs something else", () => {
  it("is passed through untouched, and is never named", () => {
    for (const argv of [
      ["python3", "scripts/validate_docs.py"],
      ["pnpm", "run", "test"],
      ["node", "--test", "tooling/package/stage.test.mjs"],
      // A turbo that is an argument rather than the program: nothing here is
      // going to guess what a wrapper does with it.
      ["node", "scripts/run.mjs", "turbo", "run", "test"],
    ]) {
      expect(withTurboForce(argv)).toEqual(argv);
      expect(runsTurboWithoutForce(argv)).toBe(false);
    }
  });
});
