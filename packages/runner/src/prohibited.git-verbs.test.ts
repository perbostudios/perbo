import { describe, expect, it } from "vitest";
import { inspectCommand } from "./prohibited.js";

/**
 * SCP-243: a git rule names a verb, and a verb is a whole word.
 *
 * Every git rule is built from one helper whose pattern used to end the verb at
 * a word boundary. `-` is a boundary, so `merge` matched the front of
 * `merge-base` and `git merge-base --is-ancestor HEAD origin/main` — a
 * read-only ancestry check — was refused as `self_merge` and ended AYO-66's
 * attempt. The same boundary reaches `merge-tree`, `merge-file` and every
 * `<verb>-…` spelling of every other verb the helper is given.
 *
 * Both directions are asserted, because only the pair pins the boundary: a
 * helper that matched nothing would pass the first half, and the `\b` this
 * ticket removes passes the second.
 */

const actions = (command: string) => inspectCommand(command).map((hit) => hit.action);

describe("a git verb a prohibited verb is only the front of", () => {
  /**
   * The lines that carry `origin/main` or `origin/master`, which is what the
   * `self_merge` rule looks for after the verb: each of these was refused
   * before this ticket, and none of them merges anything.
   */
  for (const command of [
    "git merge-base --is-ancestor HEAD origin/main",
    "git merge-base HEAD origin/master",
    "git merge-tree --write-tree origin/main HEAD",
    "git --no-pager merge-base --fork-point origin/master",
  ]) {
    it(`does not refuse \`${command}\``, () => {
      expect(actions(command), command).toEqual([]);
    });
  }

  it("leaves `git merge-file`, which names no branch either", () => {
    expect(actions("git merge-file --diff3 ours.txt base.txt theirs.txt")).toEqual([]);
  });
});

describe("the verbs the rules do name, unchanged", () => {
  const cases: Array<[string, string]> = [
    ["git merge origin/main", "self_merge"],
    ["git merge --no-ff origin/master", "self_merge"],
    ["git -C sub merge origin/main", "self_merge"],
    ['git "merge" origin/main', "self_merge"],
    ["gh pr merge 12 --squash", "self_merge"],
    ["git push", "destructive_git"],
    ["git push --force origin main", "destructive_git"],
    ["git push origin ayo/x/y --force-with-lease", "destructive_git"],
    ["git push origin --delete ayo/x/y", "destructive_git"],
    ["git branch -D main", "destructive_git"],
    ["git reset --hard HEAD~3", "destructive_git"],
    ["git rebase --onto main HEAD~2", "destructive_git"],
    ["git filter-branch --tree-filter 'rm -f big' HEAD", "destructive_git"],
    ["git tag v1.2.3", "registry_publication"],
  ];

  for (const [command, action] of cases) {
    it(`still refuses \`${command}\` as ${action}`, () => {
      expect(actions(command), command).toContain(action);
    });
  }
});

/**
 * A termination has to read back to the line that caused it. The rule's own
 * sentence says what was refused; the segment says which command it was, which
 * is the half a person needs to find the line in a transcript.
 */
describe("what a matched rule records", () => {
  it("carries the matched command text beside the rule's sentence", () => {
    const [hit] = inspectCommand("git push --force origin main");
    expect(hit?.detail).toContain("force-push");
    expect(hit?.detail).toContain("git push --force origin main");
  });

  it("carries the segment that matched, not the whole line", () => {
    const hits = inspectCommand("pnpm test && git branch -D main");
    expect(hits.map((hit) => hit.action)).toContain("destructive_git");
    const detail = hits.map((hit) => hit.detail).join("\n");
    expect(detail).toContain("git branch -D main");
    expect(detail).not.toContain("pnpm test");
  });
});
