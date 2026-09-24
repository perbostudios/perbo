import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRepository, scratchDirectories, type Repository } from "@perbo/test-support";
import { ExperimentConfigSchema, renderExperiment, runExperiment } from "./experiment.js";

/**
 * The ADR-0025 measurement times a cold and a warm start up to the
 * repository's own suite, green. A repository whose verification is
 * `git status --porcelain` has no such suite, so it is not measured: timing
 * that command would report a start the suite never proved.
 *
 * Nothing here imports a symbol the change adds, so this file loads at the
 * commit before it and fails on the behaviour it is about.
 */

const scratch = scratchDirectories("perbo-experiment-");
const scratchRoot = scratch();

/** A one-commit checkout holding exactly the files it is given. */
function checkout(name: string, files: Record<string, string>): Repository {
  return initRepository(mkdtempSync(join(scratchRoot, `${name}-`)), { files, message: "base" });
}

describe("the materialization measurement", () => {
  it("does not measure a repository with no suite a worktree can run", async () => {
    const { dir } = checkout("static-site", {
      "package.json": `${JSON.stringify({ name: "fixture", private: true, scripts: { deploy: "wrangler deploy" } })}\n`,
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const results = await runExperiment(
      ExperimentConfigSchema.parse({
        scratch: mkdtempSync(join(scratchRoot, "run-")),
        repositories: [{ name: "static-site", repository_id: "repo_static", source: dir, clone: "none" }],
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.cold).toBeNull();
    expect(results[0]!.warm).toBeNull();
    // The reason is carried in the result, in the diagnostic's own words.
    expect(results[0]!.diagnostic_findings.map((finding) => finding.reason)).toContain(
      "no_verification_command",
    );
    expect(renderExperiment(results)).toContain("not measured");
  }, 120_000);

  it("runs the install a spec names where the proposal installs nothing", async () => {
    // uv: nothing is proposed for the install, so the spec gives one, and a
    // verification that passes only where that install ran.
    const { dir } = checkout("python", {
      "pyproject.toml": '[project]\nname = "fixture"\nversion = "0.1.0"\n',
      "uv.lock": "version = 1\n",
    });

    const results = await runExperiment(
      ExperimentConfigSchema.parse({
        scratch: mkdtempSync(join(scratchRoot, "run-")),
        repositories: [
          {
            name: "python",
            repository_id: "repo_python",
            source: dir,
            clone: "none",
            install_command: ["node", "-e", "require('node:fs').writeFileSync('installed', '1')"],
            verify_command: ["node", "-e", "process.exit(require('node:fs').existsSync('installed') ? 0 : 1)"],
          },
        ],
      }),
    );

    expect(results[0]!.cold?.verified).toBe(true);
    expect(results[0]!.cold?.failure).toBeNull();
  }, 120_000);

  it("refuses a count of workspace packages read from a listing git cut short", async () => {
    // More package manifests than the half-megabyte a listing may say can name.
    const stem = "p".repeat(230);
    const files: Record<string, string> = {
      "package.json": `${JSON.stringify({ name: "fixture", private: true })}\n`,
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    };
    for (let index = 0; index < 2200; index += 1) {
      files[`packages/${stem}-${index}/package.json`] = "{}\n";
    }
    const { dir } = checkout("monorepo", files);

    await expect(
      runExperiment(
        ExperimentConfigSchema.parse({
          scratch: mkdtempSync(join(scratchRoot, "run-")),
          repositories: [
            {
              name: "monorepo",
              repository_id: "repo_monorepo",
              source: dir,
              clone: "none",
              install_command: ["node", "-e", "0"],
              verify_command: ["node", "-e", "0"],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/workspace packages/);
  }, 120_000);
});
