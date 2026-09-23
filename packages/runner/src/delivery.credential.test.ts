import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pushAttemptBranch } from "./delivery.js";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { initBareRepository, initRepository } from "@perbo/test-support";

const scratch = scratchDirectories("perbo-runner-");

/**
 * What the runner's own push presents to GitHub (SCP-020, SCP-200).
 *
 * A machine whose GitHub credential is `GH_TOKEN` in the environment rather
 * than a stored `gh auth login` is one the product supports: `githubCredential`
 * names that path and `requireGithubCredential` takes it at its word without
 * asking `gh` anything. Over an HTTPS remote git asks a credential helper for
 * the password, and the helper `gh auth setup-git` writes — `gh auth
 * git-credential` — reads the token out of the environment git started it in.
 * A push whose environment carries no token has nothing to present on such a
 * machine, and fails with the attempt already sealed and reviewed.
 *
 * So what is pinned here is the environment the two commands that reach GitHub
 * are started in, recorded by a `git` on PATH that writes down what it was
 * given and then runs the real one. The local reads beside them are a
 * different question and carry nothing: the credential goes where GitHub is.
 */

const BRANCH = "ayo/fixture/credential";
const GH_TOKEN = "gh-token-for-the-fixture";
const GITHUB_TOKEN = "github-token-for-the-fixture";
/** A secret that is not the GitHub credential, to see that nothing else rides along. */
const NPM_TOKEN = "npm-token-for-the-fixture";

const original = { ...process.env };
afterEach(() => {
  for (const name of ["PATH", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"]) {
    const was = original[name];
    if (was === undefined) delete process.env[name];
    else process.env[name] = was;
  }
});

/** A worktree on `BRANCH` with one commit, and a bare `origin` without it. */
function fixture(): { work: string } {
  const origin = initBareRepository(scratch("perbo-credential-origin-"));
  const repository = initRepository(scratch("perbo-credential-work-"), {
    files: { "first.txt": "first\n" },
    message: "first",
  });
  repository.git("remote", "add", "origin", origin);
  repository.git("push", "-q", "origin", "main");
  repository.git("checkout", "-q", "-b", BRANCH);
  repository.commit({ "mine.txt": "mine\n" }, "mine");
  return { work: repository.dir };
}

const quoted = (value: string) => JSON.stringify(value);

/**
 * A `git` first on PATH that records the environment of the commands that
 * reach GitHub and then runs the real one, so the push and the listing are the
 * shipped ones and only what they were given is under test.
 *
 * `${NAME-<unset>}` tells a name the runner never set from one it set empty:
 * an empty `GH_TOKEN` is a credential `gh` would read as none, so the
 * difference is the answer rather than a detail of it.
 */
function recordingGit(): { bin: string; environmentOf: (subcommand: string) => string[] } {
  const dir = scratch("perbo-credential-git-");
  const log = join(dir, "environment.log");
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    "  push|ls-remote)",
    "    printf '%s GH_TOKEN=%s GITHUB_TOKEN=%s NPM_TOKEN=%s\\n' \\",
    '      "$1" "${GH_TOKEN-<unset>}" "${GITHUB_TOKEN-<unset>}" "${NPM_TOKEN-<unset>}" \\',
    `      >> ${quoted(log)}`,
    "    ;;",
    "esac",
    `exec ${quoted(real)} "$@"`,
    "",
  ].join("\n");
  const binary = join(dir, "git");
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return {
    bin: dir,
    environmentOf: (subcommand) =>
      (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []).filter((line) =>
        line.startsWith(`${subcommand} `),
      ),
  };
}

describe("the credential the runner's push and remote listing carry", () => {
  it("hands both of them the token this machine's GitHub credential is, and nothing else", async () => {
    const repo = fixture();
    const recorder = recordingGit();
    process.env.GH_TOKEN = GH_TOKEN;
    process.env.GITHUB_TOKEN = GITHUB_TOKEN;
    process.env.NPM_TOKEN = NPM_TOKEN;
    process.env.PATH = `${recorder.bin}:${original.PATH ?? ""}`;

    const result = await pushAttemptBranch({ worktree: repo.work, branch: BRANCH });

    expect(result.pushed).toBe(true);
    const carried = `GH_TOKEN=${GH_TOKEN} GITHUB_TOKEN=${GITHUB_TOKEN} NPM_TOKEN=<unset>`;
    expect(recorder.environmentOf("push")).toEqual([`push ${carried}`]);
    expect(recorder.environmentOf("ls-remote")).toEqual([`ls-remote ${carried}`]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("leaves a token this machine does not set unset rather than empty", async () => {
    const repo = fixture();
    const recorder = recordingGit();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.NPM_TOKEN;
    process.env.PATH = `${recorder.bin}:${original.PATH ?? ""}`;

    await pushAttemptBranch({ worktree: repo.work, branch: BRANCH });

    const none = "GH_TOKEN=<unset> GITHUB_TOKEN=<unset> NPM_TOKEN=<unset>";
    expect(recorder.environmentOf("push")).toEqual([`push ${none}`]);
    expect(recorder.environmentOf("ls-remote")).toEqual([`ls-remote ${none}`]);
  }, SPAWN_TEST_TIMEOUT_MS);
});
