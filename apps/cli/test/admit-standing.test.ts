import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseAdmitArgs, runAdmitCommand, type Streams } from "../src/admit.js";
import { readContract, storeDir } from "../src/tickets.js";

/**
 * D-105: the standing prohibited list is a repository agreement, so every
 * ticket admitted here starts with it, whatever scope the admission named.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-standing-admit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function repository(name: string, config?: unknown): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "base"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (config !== undefined) {
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    writeFileSync(join(dir, ".perbo", "config.json"), JSON.stringify(config, null, 2));
  }
  return dir;
}

const streams = (): Streams => ({
  stdout: () => undefined,
  stderr: () => undefined,
  isTTY: false,
});

const admit = (repo: string, ...extra: string[]): number | Promise<number> =>
  runAdmitCommand({
    args: parseAdmitArgs([
      "--repo",
      repo,
      "--outcome",
      "Activation email goes out within 60 seconds.",
      "--criterion",
      "A signup queues exactly one email. :: one message on the queue",
      "--path",
      "packages/auth/**",
      ...extra,
    ]),
    streams: streams(),
    cwd: repo,
  });

const prohibitedOf = (repo: string): string[] =>
  readContract(storeDir(repo, null), "PRB-1").scope.paths_prohibited;

describe("admission folds the repository's standing prohibited list into every ticket", () => {
  it("adds each entry to paths_prohibited beside the defaults", () => {
    const repo = repository("standing-entries", {
      paths_prohibited: [
        {
          path: "packages/app/src/generated/**",
          draft: "b7b0f3e2-0000-4000-8000-000000000001",
          source: "PRB-9",
          added_at: "2026-09-12T10:00:00.000Z",
        },
        "specs/**",
      ],
    });
    expect(admit(repo)).toBe(0);
    const prohibited = prohibitedOf(repo);
    expect(prohibited).toContain("packages/app/src/generated/**");
    expect(prohibited).toContain("specs/**");
    // The defaults every admission starts with are still there.
    expect(prohibited).toContain(".github/**");
  });

  it("names a standing path once, however it also arrived", () => {
    const repo = repository("standing-duplicate", { paths_prohibited: ["infra/**"] });
    expect(admit(repo, "--prohibit", "infra/**")).toBe(0);
    expect(prohibitedOf(repo).filter((path) => path === "infra/**")).toHaveLength(1);
  });

  it("admits a repository with no standing list unchanged", () => {
    const repo = repository("standing-absent", { checks: [] });
    expect(admit(repo)).toBe(0);
    expect(prohibitedOf(repo)).toEqual([".github/**", "infra/**", "**/*.pem", "**/.env*", "specs/**"]);
  });
});
