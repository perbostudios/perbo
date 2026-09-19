import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExperimentConfigSchema, renderExperiment, runExperiment } from "../src/experiment.js";
import { git } from "./support.js";

/**
 * The ADR-0025 measurement times a cold and a warm start up to the
 * repository's own suite, green. A repository whose verification is
 * `git status --porcelain` has no such suite, so it is not measured: timing
 * that command would report a start the suite never proved.
 *
 * Nothing here imports a symbol the change adds, so this file loads at the
 * commit before it and fails on the behaviour it is about.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-experiment-"));

/** A one-commit checkout holding exactly the files it is given. */
function checkout(name: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

describe("the materialization measurement", () => {
  it("does not measure a repository with no suite a worktree can run", async () => {
    const dir = checkout("static-site", {
      "package.json": `${JSON.stringify({ name: "fixture", private: true, scripts: { deploy: "wrangler deploy" } })}\n`,
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const results = await runExperiment(
      ExperimentConfigSchema.parse({
        scratch: mkdtempSync(join(scratch, "run-")),
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
    const dir = checkout("python", {
      "pyproject.toml": '[project]\nname = "fixture"\nversion = "0.1.0"\n',
      "uv.lock": "version = 1\n",
    });

    const results = await runExperiment(
      ExperimentConfigSchema.parse({
        scratch: mkdtempSync(join(scratch, "run-")),
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
});
