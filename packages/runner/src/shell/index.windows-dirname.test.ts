import type * as NodePath from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The resolver on a Windows host, where `node:path`'s `dirname` is Windows'.
 *
 * `win32.dirname("C:/Users")` is `C:/`, and a walk that climbed with it would
 * join its next component as `C://…`. The resolver holds `/` as its one
 * alphabet whatever the host, so it climbs with POSIX's `dirname`; this file
 * makes the host's the Windows one to hold that on any host.
 */
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>();
  return { ...actual, dirname: actual.win32.dirname, default: { ...actual, dirname: actual.win32.dirname } };
});

const { inspectWritePath, resolveScope } = await import("./index.js");

const ROOT = String.raw`C:\Users\a\wt`;

describe("a climb on a host whose dirname is Windows'", () => {
  const scope = resolveScope({ root: ROOT, paths_allowed: ["README.md"], semantics: "windows" });

  it("admits a climb that comes back inside the worktree", () => {
    expect(inspectWritePath(String.raw`C:\Users\..\Users\a\wt\README.md`, scope)).toBeNull();
  });

  it("stops a relative climb at the drive it started on", () => {
    expect(inspectWritePath(String.raw`..\..\..\..\..\notes.txt`, scope)?.resolved).toBe("C:/notes.txt");
  });
});
