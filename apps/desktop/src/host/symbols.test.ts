import { describe, expect, it } from "vitest";
import { exportedNames, readSymbolIndex } from "./symbols.js";
import { WorkspaceReads } from "./workspace-reads.js";
import type { Cli } from "./cli.js";
import type { Execute } from "./repository/git.js";
import type { ProcessResult } from "./process.js";
import type { RegisteredRepository } from "./profile/store.js";

const repo: RegisteredRepository = {
  id: "80000000-0000-4000-8000-000000000001",
  name: "checkout",
  path: "/checkout",
};
const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "", cancelled: false });
const exported = (name: string, kind = "function"): Record<string, unknown> => ({
  name,
  kind,
  line: 1,
});
const index = {
  schema_version: 1,
  head_commit: "abc1234",
  working_tree: "clean",
  built_at: "2026-09-19T09:00:00.000Z",
  files: [
    { path: "src/main.ts", exports: [exported("start"), exported("*", "re-export")], imports: [] },
    { path: ".env", exports: [exported("SECRET", "variable")], imports: [] },
    { path: "src/gone.ts", exports: [exported("gone")], imports: [] },
  ],
  skipped: [],
};
/** A CLI whose `index` answers with the record, and Git listing two tracked files. */
function wiring(stdout: string, tracked = "src/main.ts\0.env\0"): {
  cli: Pick<Cli, "run">;
  reads: WorkspaceReads;
  execute: Execute;
  runs: string[];
} {
  const runs: string[] = [];
  return {
    runs,
    reads: new WorkspaceReads(),
    cli: {
      run: (args) => {
        runs.push(args.join(" "));
        return Promise.resolve(ok(stdout));
      },
    },
    execute: () => Promise.resolve(ok(tracked)),
  };
}

describe("readSymbolIndex", () => {
  it("reads the index the command wrote", async () => {
    const w = wiring(JSON.stringify(index));
    const read = await readSymbolIndex(w.cli, repo);
    expect("supported" in read).toBe(false);
    expect(w.runs).toEqual(["index --json"]);
  });

  it("keeps a repository the indexer cannot describe as its own answer", async () => {
    const w = wiring(JSON.stringify({ supported: false, reason: "no parser", languages_seen: ["ml"] }));
    const read = await readSymbolIndex(w.cli, repo);
    expect(read).toMatchObject({ supported: false, reason: "no parser" });
  });

  it("refuses a record that is neither shape", async () => {
    await expect(readSymbolIndex(wiring(JSON.stringify({ files: "not a list" })).cli, repo)).rejects.toThrow();
    await expect(
      readSymbolIndex(wiring(JSON.stringify({ supported: false })).cli, repo),
    ).rejects.toThrow();
  });
});

describe("exportedNames", () => {
  it("offers a name from a tracked file the explorer would list", async () => {
    const w = wiring(JSON.stringify(index));
    const view = await exportedNames(w, repo);
    expect(view).toMatchObject({ supported: true, headCommit: "abc1234", workingTree: "clean" });
    expect(view.supported && view.names).toEqual([
      { name: "start", kind: "function", path: "src/main.ts" },
    ]);
  });

  it("offers nothing from a path no surface reads, name or path", async () => {
    const view = await exportedNames(wiring(JSON.stringify(index)), repo);
    const names = view.supported ? view.names : [];
    expect(names.some((each) => each.name === "SECRET")).toBe(false);
    expect(names.some((each) => each.path === ".env")).toBe(false);
    // Not in a path either, which is the half a filter on names alone misses.
    expect(JSON.stringify(view)).not.toContain(".env");
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("offers nothing from a file Git no longer tracks", async () => {
    const view = await exportedNames(wiring(JSON.stringify(index)), repo);
    const names = view.supported ? view.names : [];
    expect(names.some((each) => each.path === "src/gone.ts")).toBe(false);
  });

  it("never offers `*`, which is not a name a spec can refer to", async () => {
    const view = await exportedNames(wiring(JSON.stringify(index)), repo);
    const names = view.supported ? view.names : [];
    expect(names.some((each) => each.name === "*")).toBe(false);
  });

  it("carries the indexer's own answer where it cannot describe the repository", async () => {
    const view = await exportedNames(
      wiring(JSON.stringify({ supported: false, reason: "no parser", languages_seen: ["ml"] })),
      repo,
    );
    expect(view).toEqual({ supported: false, reason: "no parser", languages: ["ml"] });
  });

  it("runs one index for the sections asking at once", async () => {
    const w = wiring(JSON.stringify(index));
    await Promise.all([exportedNames(w, repo), exportedNames(w, repo)]);
    expect(w.runs).toEqual(["index --json"]);
  });
});
