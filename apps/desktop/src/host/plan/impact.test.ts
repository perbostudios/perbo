import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { impactView, type ImpactDeps } from "./impact.js";
import { EditingSessionSchema, SettingsSchema, TaskModelsSchema } from "../../shared/protocol.js";
import { editingForm } from "../../shared/contract-editing.js";
import type { EditingSession } from "../../shared/protocol.js";
import type { Execute } from "../repository/git.js";
import type { RegisteredRepository } from "../profile/store.js";

const scratchDirectory = createScratch("perbo-impact-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const repoId = "80000000-0000-4000-8000-000000000001";
const sessionId = "80000000-0000-4000-8000-000000000002";
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(path, { recursive: true });
  return { id: repoId, name: "checkout", path };
}
function session(paths: string[], specSlug: string | null = null): EditingSession {
  const form = editingForm(TaskModelsSchema.strip().parse(SettingsSchema.parse({})));
  return EditingSessionSchema.parse({
    version: 1,
    id: sessionId,
    repoId,
    key: null,
    digest: null,
    revision: 0,
    resumeNew: true,
    specSlug,
    form: { ...form, draft: { ...form.draft, paths } },
    phase: "editing",
    error: null,
    operation: null,
    drift: null,
    change: null,
    lastPane: null,
    lastView: null,
    specCut: null,
    named: null,
    interviewModel: null,
  });
}
const index = {
  schema_version: 1,
  head_commit: "abc1234",
  working_tree: "clean",
  built_at: "2026-09-19T09:00:00.000Z",
  files: [
    {
      path: "src/main.ts",
      exports: [{ name: "start", kind: "function", line: 1 }],
      imports: [],
    },
    {
      path: "src/caller.ts",
      exports: [],
      imports: [{ specifier: "./main.js", resolved: "src/main.ts", external: false, line: 1 }],
    },
    {
      path: ".env",
      exports: [],
      imports: [{ specifier: "./src/main.js", resolved: "src/main.ts", external: false, line: 1 }],
    },
  ],
  skipped: [],
};
function deps(
  repo: RegisteredRepository,
  record: EditingSession,
  tracked = "src/main.ts\0src/caller.ts\0.env\0",
): ImpactDeps {
  return {
    editing: { read: () => record } as ImpactDeps["editing"],
    repository: () => repo,
    cli: {
      run: () =>
        Promise.resolve({ code: 0, stdout: JSON.stringify(index), stderr: "", cancelled: false }),
    },
    execute: (() =>
      Promise.resolve({ code: 0, stdout: tracked, stderr: "", cancelled: false })) as Execute,
  };
}

describe("impactView", () => {
  it("warns about a file outside the scope that imports one inside it", async () => {
    const repo = repository();
    const view = await impactView(deps(repo, session(["src/main.ts"])), sessionId);
    expect(view.warnings.map((warning) => warning.path)).toContain("src/caller.ts");
    expect(view.readAt).toBeTruthy();
    expect(view.index).toMatchObject({ read: true, commit: "abc1234" });
  });

  it("warns about nothing where the scope already covers the tree", async () => {
    const repo = repository();
    const view = await impactView(deps(repo, session(["src/**"])), sessionId);
    expect(view.warnings).toEqual([]);
  });

  it("names no path the explorer would withhold, whatever the index says about it", async () => {
    const repo = repository();
    // `perbo index` reads the whole tree and has no never-read filter of its
    // own, so this one is the host's: `.env` imports a file in scope.
    const view = await impactView(deps(repo, session(["src/main.ts"])), sessionId);
    expect(view.warnings.map((warning) => warning.path)).toEqual(["src/caller.ts"]);
    expect(JSON.stringify(view)).not.toContain(".env");
  });

  it("reads the spec the session names, and warns about what it mentions", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, "specs", "retry"), { recursive: true });
    writeFileSync(
      join(repo.path, "specs", "retry", "spec.md"),
      [
        "# Retry a failed run",
        "",
        "## Outcome",
        "",
        "The caller at `src/caller.ts` retries.",
        "",
      ].join("\n"),
    );
    const view = await impactView(deps(repo, session(["docs/**"], "retry")), sessionId);
    expect(view.warnings.map((warning) => warning.path)).toContain("src/caller.ts");
  });

  it("says the index could not be read where the repository is not one it describes", async () => {
    const repo = repository();
    const wiring = deps(repo, session(["src/main.ts"]));
    const view = await impactView(
      {
        ...wiring,
        cli: {
          run: () =>
            Promise.resolve({
              code: 0,
              stdout: JSON.stringify({ supported: false, reason: "no parser", languages_seen: ["ml"] }),
              stderr: "",
              cancelled: false,
            }),
        },
      },
      sessionId,
    );
    expect(view.index).toMatchObject({ read: false });
    expect(view.index.note).toContain("no parser");
  });

  it("reports an index that could not be built, rather than an empty answer", async () => {
    const repo = repository();
    const wiring = deps(repo, session(["src/main.ts"]));
    await expect(
      impactView(
        {
          ...wiring,
          cli: {
            run: () =>
              Promise.resolve({
                code: 2,
                stdout: "",
                stderr: "this checkout has no HEAD to read",
                cancelled: false,
              }),
          },
        },
        sessionId,
      ),
    ).rejects.toThrow(/this checkout has no HEAD to read/);
  });

  /**
   * A record a bare cast would carry into the report unnoticed: the first
   * builds a whole report the pane heads "against not a s", the second a note
   * reading "Nothing here reads imports: .".
   */
  it("refuses an index record the contract's schema does not admit, either shape", async () => {
    const repo = repository();
    const wiring = deps(repo, session(["src/main.ts"]));
    const answering = (stdout: string): ImpactDeps => ({
      ...wiring,
      cli: { run: () => Promise.resolve({ code: 0, stdout, stderr: "", cancelled: false }) },
    });
    await expect(
      impactView(answering(JSON.stringify({ ...index, head_commit: "not a sha" })), sessionId),
    ).rejects.toThrow(/a commit sha/);
    await expect(
      impactView(
        answering(JSON.stringify({ supported: false, reason: "", languages_seen: [".py"] })),
        sessionId,
      ),
    ).rejects.toThrow(/"path": \[\n\s*"reason"/);
  });
});
