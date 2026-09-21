import { describe, expect, it } from "vitest";
import {
  changeSetFromDiff,
  changeSetFromNameStatus,
  parseNameStatus,
  parseUnifiedDiff,
} from "./changeset.js";

const modified = `diff --git a/packages/auth/signup.ts b/packages/auth/signup.ts
index 1111111..2222222 100644
--- a/packages/auth/signup.ts
+++ b/packages/auth/signup.ts
@@ -1,4 +1,5 @@
 export function signup() {
-  return null;
+  sendActivationEmail();
+  return null;
 }
`;

const added = `diff --git a/packages/auth/retry.ts b/packages/auth/retry.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/packages/auth/retry.ts
@@ -0,0 +1,2 @@
+export const retries = 3;
+
`;

const deleted = `diff --git a/packages/auth/old.ts b/packages/auth/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/packages/auth/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`;

const renamed = `diff --git a/packages/auth/a.ts b/packages/auth/b.ts
similarity index 92%
rename from packages/auth/a.ts
rename to packages/auth/b.ts
index 5555555..6666666 100644
--- a/packages/auth/a.ts
+++ b/packages/auth/b.ts
@@ -1,1 +1,1 @@
-export const name = "a";
+export const name = "b";
`;

describe("parseUnifiedDiff", () => {
  it("reads a modification with its line counts", () => {
    const [file] = parseUnifiedDiff(modified);
    expect(file).toMatchObject({
      path: "packages/auth/signup.ts",
      change_kind: "modified",
      additions: 2,
      deletions: 1,
      previous_path: null,
    });
  });

  it("distinguishes added, deleted and renamed files", () => {
    expect(parseUnifiedDiff(added)[0]).toMatchObject({
      path: "packages/auth/retry.ts",
      change_kind: "added",
    });
    expect(parseUnifiedDiff(deleted)[0]).toMatchObject({
      path: "packages/auth/old.ts",
      change_kind: "deleted",
    });
    expect(parseUnifiedDiff(renamed)[0]).toMatchObject({
      path: "packages/auth/b.ts",
      change_kind: "renamed",
      previous_path: "packages/auth/a.ts",
    });
  });

  it("reads several files from one diff", () => {
    const files = parseUnifiedDiff([modified, added, deleted].join(""));
    expect(files.map((file) => file.path)).toEqual([
      "packages/auth/signup.ts",
      "packages/auth/retry.ts",
      "packages/auth/old.ts",
    ]);
  });

  it("does not count the hunk header as an addition", () => {
    const [file] = parseUnifiedDiff(added);
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
  });

  it("keeps the file's patch text verbatim enough to quote", () => {
    const [file] = parseUnifiedDiff(modified);
    expect(file?.patch).toContain("+  sendActivationEmail();");
  });

  /**
   * D-107: a node's review is built by filtering `ChangeSet.files` and
   * rejoining their `patch`es (`buildContext`, `prompt.ts`). That depends on
   * each file's `patch` being its exact slice of the diff, in order, with
   * nothing dropped at a file boundary.
   */
  it("hands back each file's patch text verbatim, for a modification, a rename, a new file and a deleted one", () => {
    const combined = [modified, added, deleted, renamed].join("");
    const files = parseUnifiedDiff(combined);
    expect(files.map((file) => file.path)).toEqual([
      "packages/auth/signup.ts",
      "packages/auth/retry.ts",
      "packages/auth/old.ts",
      "packages/auth/b.ts",
    ]);
    expect(files[0]?.patch).toBe(modified.trimEnd());
    expect(files[1]?.patch).toBe(added.trimEnd());
    expect(files[2]?.patch).toBe(deleted.trimEnd());
    // The last file in the diff keeps the trailing newline `split`/`join`
    // would otherwise drop, which is what makes the round trip below exact.
    expect(files[3]?.patch).toBe(renamed);
  });

  it("joins a changeset's files back into the diff that built it", () => {
    const combined = [modified, added, deleted, renamed].join("");
    const changeset = changeSetFromDiff({ diff: combined, base_commit: "a1b2c3d" });
    const rejoined = changeset.files.map((file) => file.patch).join("\n");
    expect(rejoined).toBe(combined);
  });
});

describe("change-set identity", () => {
  const base = "a1b2c3d";

  it("is stable for the same diff, so a re-run reviews the same target", () => {
    const first = changeSetFromDiff({ diff: modified, base_commit: base });
    const second = changeSetFromDiff({ diff: modified, base_commit: base });
    expect(first.changeset_id).toBe(second.changeset_id);
    expect(first.head_commit).toBe(second.head_commit);
  });

  it("moves when the change moves, which is what supersedes a prior verdict", () => {
    const first = changeSetFromDiff({ diff: modified, base_commit: base });
    const second = changeSetFromDiff({ diff: modified + added, base_commit: base });
    expect(first.head_commit).not.toBe(second.head_commit);
    expect(first.changeset_id).not.toBe(second.changeset_id);
  });

  it("moves when the base moves, so a rebase is a different target", () => {
    const first = changeSetFromDiff({ diff: modified, base_commit: "a1b2c3d" });
    const second = changeSetFromDiff({ diff: modified, base_commit: "9999999" });
    expect(first.changeset_id).not.toBe(second.changeset_id);
  });

  it("records whether the head is a real commit or a digest of the diff", () => {
    expect(changeSetFromDiff({ diff: modified, base_commit: base }).head_commit_source).toBe(
      "diff_digest",
    );
    expect(
      changeSetFromDiff({ diff: modified, base_commit: base, head_commit: "7f4e91c" })
        .head_commit_source,
    ).toBe("recorded");
  });

  it("is not truncated when it was parsed from a diff it was handed whole", () => {
    const changeset = changeSetFromDiff({ diff: modified, base_commit: base });
    expect(changeset.truncated).toBe(false);
    expect(changeset.diff_bytes).toBe(Buffer.byteLength(modified, "utf8"));
  });
});

describe("parseNameStatus", () => {
  it("reads every kind of entry from NUL-separated output", () => {
    const output = ["M", "a/mod.ts", "A", "a/new.ts", "D", "a/old.ts", "R092", "a/from.ts", "a/to.ts", "T", "a/type.ts", ""].join("\0");
    expect(parseNameStatus(output)).toMatchObject([
      { path: "a/mod.ts", change_kind: "modified", previous_path: null },
      { path: "a/new.ts", change_kind: "added" },
      { path: "a/old.ts", change_kind: "deleted" },
      { path: "a/to.ts", change_kind: "renamed", previous_path: "a/from.ts" },
      { path: "a/type.ts", change_kind: "modified" },
    ]);
  });

  it("reads nothing from empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("a sealed change set", () => {
  const files = parseNameStatus(["M", "packages/auth/signup.ts", "A", "packages/auth/retry.ts", ""].join("\0"));

  it("takes its file list from name-status and its patches from the diff", () => {
    // The diff reached only one of the two files; the other keeps its entry.
    const changeset = changeSetFromNameStatus({
      files,
      diff: modified,
      diff_bytes: Buffer.byteLength(modified, "utf8"),
      base_commit: "a1b2c3d",
      head_commit: "7f4e91c",
    });
    expect(changeset.files.map((file) => file.path)).toEqual([
      "packages/auth/signup.ts",
      "packages/auth/retry.ts",
    ]);
    expect(changeset.files[0]?.patch).toContain("+  sendActivationEmail();");
    expect(changeset.files[1]?.patch).toBe("");
    expect(changeset.truncated).toBe(false);
  });

  it("keeps the complete file list and marks itself truncated when the diff was withheld", () => {
    const changeset = changeSetFromNameStatus({
      files,
      diff: null,
      diff_bytes: 9_000_000,
      base_commit: "a1b2c3d",
      head_commit: "7f4e91c",
    });
    expect(changeset.truncated).toBe(true);
    expect(changeset.diff_bytes).toBe(9_000_000);
    expect(changeset.files.map((file) => file.path)).toEqual([
      "packages/auth/signup.ts",
      "packages/auth/retry.ts",
    ]);
    expect(changeset.files.every((file) => file.patch === "")).toBe(true);
  });
});
