import { describe, expect, it } from "vitest";
import { PREVIEW_BYTE_CAP, RequestSchema } from "../src/shared/protocol.js";

/**
 * The explorer's requests are closed (ADR-0023): a renderer names a repository
 * and, for one file, a repository-relative path. A field the schema does not
 * declare is refused at the boundary rather than reaching the host, so a second
 * path-shaped field cannot become a second filesystem target.
 */

const repoId = "80000000-0000-4000-8000-000000000001";
const session = "80000000-0000-4000-8000-000000000002";

describe("the explorer's protocol", () => {
  it("takes a repository id for a listing, and a path only for a read", () => {
    expect(RequestSchema.safeParse({ kind: "explorerList", repoId }).success).toBe(true);
    expect(
      RequestSchema.safeParse({ kind: "explorerRead", repoId, path: "src/index.ts" }).success,
    ).toBe(true);
  });

  it("refuses a path-shaped field it does not declare", () => {
    for (const request of [
      { kind: "explorerList", repoId, path: "src/index.ts" },
      { kind: "explorerList", repoId, cwd: "/etc" },
      { kind: "explorerRead", repoId, path: "src/index.ts", root: "/etc" },
      { kind: "explorerRead", repoId, path: "src/index.ts", command: "cat" },
      { kind: "explorerMark", id: session, revision: 0, path: "src/", mark: null, always: null, repoPath: "/etc" },
    ])
      expect(RequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  it("refuses a read with no path at all", () => {
    expect(RequestSchema.safeParse({ kind: "explorerRead", repoId }).success).toBe(false);
    expect(RequestSchema.safeParse({ kind: "explorerRead", repoId, path: "" }).success).toBe(false);
  });

  it("caps the preview at a size a spec or a source file fits in", () => {
    expect(PREVIEW_BYTE_CAP).toBe(256 * 1024);
  });
});
