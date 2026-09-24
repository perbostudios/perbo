import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { IgnoredPathsUnavailableError, ignoredPaths } from "./diagnostic.js";
import { workspaceRepository } from "./test-support/repository.js";

const scratch = scratchDirectories("perbo-ignored-");

/**
 * The ignored files are the manifest's entries, so a listing git did not finish
 * saying is refused rather than read as the whole of them: the entries it cut
 * off are the ones a worktree would then be missing.
 */
describe("the ignored files a checkout holds", () => {
  it("refuses a listing longer than the answer git is allowed to give", async () => {
    const { dir } = workspaceRepository(scratch);
    // More than the half-megabyte a listing may say, in names git lists one by one.
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    const stem = "x".repeat(240);
    for (let index = 0; index < 2400; index += 1) {
      writeFileSync(join(dir, `${stem}-${index}.log`), "");
    }

    await expect(ignoredPaths(dir)).rejects.toThrow(IgnoredPathsUnavailableError);
  });
});
