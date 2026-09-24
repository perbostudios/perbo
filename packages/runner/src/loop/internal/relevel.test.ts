import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { RunRefusedError } from "../../refusal.js";
import { git, runnerRepository } from "../../test-support/repository.js";
import { TicketRunConfigSchema } from "./config.js";
import { resetToPullRequest } from "./relevel.js";
import { workspace } from "./test-support/fakes.js";

const scratch = scratchDirectories("perbo-runner-");

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

/** A `git` first on PATH that refuses `log` and runs every other verb as the real one does. */
function gitRefusingLog(): string {
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = scratch("perbo-relevel-bin-");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = "log" ]; then echo "fatal: log refused" >&2; exit 128; fi\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * A branch whose checkout carries one commit of the loop's own past what its
 * pull request has — the shape a re-level resets over.
 */
function branchAheadOfItsPullRequest() {
  const repo = runnerRepository(scratch);
  const branch = "ayo/fixture/relevel";
  const tip = repo.git("rev-parse", "HEAD").trim();
  const root = scratch("perbo-relevel-root-");
  const path = join(root, "worktree");
  repo.git("worktree", "add", "-q", "-b", branch, path, tip);
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "index.ts"), "export const version = 2;\n");
  git(path, "commit", "-qam", "seal\n\nAttempt: att_0000000000000009");
  const local = git(path, "rev-parse", "HEAD").trim();
  repo.git("update-ref", `refs/remotes/origin/${branch}`, tip);
  const config = TicketRunConfigSchema.parse({
    ticket_key: "AYO-1",
    repository_root: repo.dir,
    worktree_root: root,
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
  });
  return {
    repo,
    branch,
    local,
    config,
    workspace: workspace({ repository_root: repo.dir, branch, path }),
  };
}

describe("a re-level's reset to what the pull request has", () => {
  it("refuses the reset where the log of what the branch carries could not be read", async () => {
    const fixture = branchAheadOfItsPullRequest();
    process.env.PATH = `${gitRefusingLog()}:${originalPath ?? ""}`;

    const reset = resetToPullRequest({
      config: fixture.config,
      workspace: fixture.workspace,
      onRecord: new Set(["att_0000000000000009"]),
      sealedBy: () => null,
      progress: () => undefined,
    });

    await expect(reset).rejects.toThrow(RunRefusedError);
    await expect(reset).rejects.toThrow(/could not be listed/);
    process.env.PATH = originalPath;
    // The commit the log could not name is still the branch's.
    expect(fixture.repo.git("rev-parse", fixture.branch).trim()).toBe(fixture.local);
  });

  it("resets over a commit of the loop's own where the log reads whole", async () => {
    const fixture = branchAheadOfItsPullRequest();
    const tip = fixture.repo.git("rev-parse", `refs/remotes/origin/${fixture.branch}`).trim();

    await resetToPullRequest({
      config: fixture.config,
      workspace: fixture.workspace,
      onRecord: new Set(["att_0000000000000009"]),
      sealedBy: () => null,
      progress: () => undefined,
    });

    expect(fixture.repo.git("rev-parse", fixture.branch).trim()).toBe(tip);
  });
});
