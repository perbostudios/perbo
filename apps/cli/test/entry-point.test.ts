import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_NAMES } from "../src/command-line/names.js";
import { buildCli, removeStagedBundles, spawnBuilt } from "../src/test-support/built-cli.js";

/**
 * The CLI's command table, run as a program and asked rather than read off the
 * source: the six that work against a repository with nothing admitted, the
 * thirteen that build history across machines, and `index`, which reads the
 * repository's code.
 */

/** The six commands that work against a repository with nothing admitted, named here rather than imported from the code under test. */
const WITHOUT_ADMISSION = ["doctor", "baseline", "review", "inspect", "verdict", "run"] as const;

/** The thirteen that build history across machines, and `index`, likewise. */
const WITH_HISTORY = [
  "admit",
  "approve",
  "edit",
  "drift",
  "list",
  "sync",
  "serve",
  "mcp",
  "agent",
  "interview",
  "stops",
  "escapes",
  "principle",
  "index",
] as const;

let dist: string;
// A full `tsc` compile of `apps/cli`, timed against a machine that is also
// running a loop attempt and a second gate rather than an idle one (SCP-191);
// 180s is the margin already measured for that build elsewhere in this suite.
beforeAll(() => {
  dist = buildCli();
}, 180_000);

afterAll(removeStagedBundles);

function invoke(entry: "main.js", args: string[]) {
  const result = spawnBuilt([join(dist, entry), ...args], {
    // Nothing here reaches the store, but a command that tried would find the
    // package's own directory rather than a repository with records in it.
    cwd: dist,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Every command a help text offers, in the order it offers them.
 *
 * `perbo <name>` is how the help names a command, and the lookbehind keeps a
 * path — `<repo>/.perbo back`, `.perbo/state` — from reading as one.
 */
function offered(help: string): string[] {
  const names: string[] = [];
  for (const match of help.matchAll(/(?<![\w.])perbo\s+([a-z][a-z-]*)/g)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// Both tests below spawn against the one `dist` the `beforeAll` above
// compiled, so they are pinned to run one after another rather than left to
// whatever vitest's default would do to a describe block that shares it.
describe.sequential("the entry point", () => {
  it("names the same commands the code's full set carries, so neither drifts alone", () => {
    expect([...COMMAND_NAMES].sort()).toEqual([...WITHOUT_ADMISSION, ...WITH_HISTORY].sort());
  });


  // One cold spawn of the built binary per command, each individually bounded
  // by `spawnBuilt`'s own deadline, so a genuine hang fails there and this
  // budget only ever bounds how slowly twenty of them run together. Nineteen
  // take about a minute on the loaded machine SCP-191 measures against, so the
  // budget is that with room, and it grows as the table does.
  it("carries all twenty commands", () => {
    for (const command of [...WITHOUT_ADMISSION, ...WITH_HISTORY]) {
      const help = invoke("main.js", [command, "--help"]);
      expect(help.code, `${command} --help`).toBe(0);
      expect(help.stderr).not.toMatch(/unknown command/);
    }
  }, 150_000);

  it("offers the fourteen in its help", () => {
    const help = invoke("main.js", ["--help"]);
    expect(help.code).toBe(0);
    expect(offered(help.stderr)).toEqual(expect.arrayContaining([...WITH_HISTORY]));
  }, 60_000);
});
