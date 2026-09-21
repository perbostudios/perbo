import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carriedApprovals } from "../src/merge.js";
import { git, runnerRepository } from "../src/test-support/repository.js";
import { SPAWN_TEST_TIMEOUT_MS, scratch } from "./support.js";

/**
 * SCP-227: whether an approval of an earlier head still describes the head
 * that is about to merge.
 *
 * The question is settled by hashing each head's diff against the base and
 * comparing the two, so what is hashed has to be the whole diff. A capture
 * keeps a tail, and two branches that differ only before that tail hash the
 * same — which reads as "the content a person approved is the content
 * merging" for a change that person never saw. So the ceiling here is the
 * size of a diff rather than the size of output nobody parses, and a diff
 * past it carries no approval at all.
 */

/** Longer than the capture's default ceiling, so the tail cannot hold it. */
const BIG_BYTES = 700 * 1024;

/**
 * A branch whose two heads' diffs against the base share their last bytes and
 * differ before them.
 *
 * `zzz.txt` sorts last, so its hunk is where both diffs end, and it is written
 * once and never touched again. `aaa.txt` sorts first and is the only
 * difference between the two heads — a change a review that named the first
 * head never read.
 */
function branchWithTwoHeads(dir: string): { approved: string; head: string } {
  git(dir, "checkout", "-q", "-b", "prb/SCP227/carried");
  writeFileSync(join(dir, "zzz.txt"), `${"z".repeat(BIG_BYTES)}\n`);
  writeFileSync(join(dir, "aaa.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the head a review approved");
  const approved = git(dir, "rev-parse", "HEAD").trim();

  writeFileSync(join(dir, "aaa.txt"), "two\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "what the branch says now");
  return { approved, head: git(dir, "rev-parse", "HEAD").trim() };
}

describe("an approval carried across a re-level", () => {
  it(
    "reports content that differs before the last bytes of the diff as different",
    async () => {
      const repo = runnerRepository(scratch);
      const { approved, head } = branchWithTwoHeads(repo.dir);

      const carried = await carriedApprovals({
        repository_root: repo.dir,
        base_ref: "main",
        head,
        approved: [approved],
      });

      expect(carried.map((one) => one.head)).toEqual([approved]);
      expect(carried[0]?.content_equal).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "carries nothing where the diff is larger than the ceiling",
    async () => {
      const repo = runnerRepository(scratch);
      const { approved, head } = branchWithTwoHeads(repo.dir);

      const carried = await carriedApprovals({
        repository_root: repo.dir,
        base_ref: "main",
        head,
        approved: [approved],
        max_diff_bytes: 1024,
      });

      expect(carried).toEqual([]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "reports an unchanged head as the same content",
    async () => {
      const repo = runnerRepository(scratch);
      repo.git("checkout", "-q", "-b", "prb/SCP227/same");
      writeFileSync(join(repo.dir, "aaa.txt"), "one\n");
      repo.git("add", "-A");
      repo.git("commit", "-qm", "the only commit");
      const approved = repo.git("rev-parse", "HEAD").trim();
      repo.git("commit", "-q", "--allow-empty", "-m", "a commit that changes nothing");
      const head = repo.git("rev-parse", "HEAD").trim();

      const carried = await carriedApprovals({
        repository_root: repo.dir,
        base_ref: "main",
        head,
        approved: [approved],
      });

      expect(carried[0]?.content_equal).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
