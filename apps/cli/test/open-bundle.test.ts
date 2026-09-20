import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleBuild, buildCli, removeStagedBundles, type Bundle } from "../src/test-support/open-build.js";

/**
 * What the shipped binary links against.
 *
 * The subject is the artefact, not the source: `tooling/package/bundle.mjs`
 * runs esbuild over `apps/cli/dist/main.js`, and what these read is esbuild's
 * own record of every module it resolved plus the bytes it emitted. A module
 * that reaches the bundle through an import nobody thought about is in that
 * record, and a string search over the output would not find one that carries
 * its address in a variable.
 *
 * Everything that runs on one machine is open (D-075), so nothing here is about
 * a package being withheld. What is asserted is the property that outlives that
 * decision: the binary talks to the model provider the user pays for, and to
 * nothing of ours.
 */

/** A module of ours, as opposed to a bundled third-party dependency. */
const firstParty = (bundle: Bundle) =>
  bundle.modules.filter((path) => !path.includes("node_modules/"));

/** The workspace package a first-party module belongs to. */
const packageOf = (path: string) => path.split("/").slice(0, 2).join("/");

/** Every http(s) host the bundle's bytes name. */
function hosts(bundle: Bundle): string[] {
  const found = new Set<string>();
  for (const match of bundle.text.matchAll(/https?:\/\/([A-Za-z0-9.$*{}_-]+)/g)) {
    found.add(match[1]!.toLowerCase());
  }
  return [...found].sort();
}

/** Every host of ours the bundle's bytes name, which is one too many. */
const perboHosts = (bundle: Bundle): string[] =>
  hosts(bundle).filter((host) => /perbo/.test(host));

let shipped: Bundle;

beforeAll(async () => {
  buildCli();
  shipped = await bundleBuild();
}, 300_000);

afterAll(removeStagedBundles);

describe("the shipped bundle's module graph", () => {
  it("links only against packages this workspace holds", () => {
    // esbuild resolved each of these from a path on disk, so a package name
    // here that is not a directory in the tree is a module reaching the binary
    // from somewhere nobody wrote down.
    const linked = [...new Set(firstParty(shipped).map(packageOf))].sort();
    expect(linked.length).toBeGreaterThan(0);
    for (const name of linked) {
      expect(name, `${name} is not a workspace project`).toMatch(/^(?:apps|packages)\/[a-z-]+$/);
    }
    expect(linked).toContain("apps/cli");
  });

  it("carries every command, and the ticket store behind them", () => {
    // Read from the module graph rather than from the help: the graph is what
    // the artefact carries, and the help is what it says it carries.
    const modules = firstParty(shipped).filter((path) => path.startsWith("apps/cli/"));
    const carried = [
      "commands/admit.js",
      "store/tickets.js",
      "commands/sync.js",
      "commands/serve/index.js",
      "main.js",
    ];
    for (const module of carried) {
      expect(modules, module).toContain(`apps/cli/dist/${module}`);
    }
  });

  it("carries no test and no fake", () => {
    // Two things keep them out — `tsconfig.build.json` compiles neither into
    // `dist/`, and the lint rule refuses the import that would reach one — and
    // this is the assertion over the artefact that fails if either stops
    // holding.
    const shipping = shipped.modules.filter((path) =>
      /\.test\.js$|\/test-support\//.test(path),
    );
    expect(shipping).toEqual([]);
  });
});

describe("what the shipped bundle leaves outside itself", () => {
  it("does not inline the Claude Agent SDK, which the interview imports when a session starts", () => {
    // `perbo interview` runs the person's session through it, and imports it
    // only when a session starts, so it is required from the installation
    // beside this file rather than carried inside it (`tooling/package/bundle.mjs`).
    const sdk = "@anthropic-ai/claude-agent-sdk";
    expect(shipped.modules.filter((path) => path.includes(sdk))).toEqual([]);
    expect(shipped.text).toContain(`import("${sdk}")`);
  });
});

describe("what the shipped bundle talks to", () => {
  it("names the provider endpoint the user's own key is spent at, and no host of ours", () => {
    // The bundled reviewer SDK and the runner's egress profile both name
    // `api.anthropic.com`, which is where a bring-your-own-key reviewer spends
    // the user's own key (D-009), so it is asserted present rather than merely
    // tolerated. An address of ours would be a service this binary reports to,
    // and there is none.
    expect(hosts(shipped)).toContain("api.anthropic.com");
    expect(perboHosts(shipped)).toEqual([]);
  });
});
