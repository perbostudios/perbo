import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { interviewArgv, interviewProvider } from "./argv.js";
import { editingForm } from "../../shared/contract-editing.js";
import {
  EditingSessionSchema,
  SettingsSchema,
  TaskModelsSchema,
} from "../../shared/protocol.js";
import { configPath } from "../repository/layout.js";
import type { EditingSession } from "../../shared/protocol.js";
import type { RegisteredRepository } from "../profile/store.js";

const scratchDirectory = createScratch("perbo-interview-argv-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const repoId = "80000000-0000-4000-8000-000000000001";
function repository(config?: Record<string, unknown>): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(path, { recursive: true });
  const repo = { id: repoId, name: "checkout", path };
  if (config) {
    mkdirSync(join(path, ".perbo"), { recursive: true });
    writeFileSync(configPath(repo), JSON.stringify(config, null, 2) + "\n");
  }
  return repo;
}
const models = TaskModelsSchema.strip().parse(SettingsSchema.parse({}));
const session = (over: Record<string, unknown> = {}): EditingSession =>
  EditingSessionSchema.parse({
    version: 1,
    id: "80000000-0000-4000-8000-000000000002",
    repoId,
    key: null,
    digest: null,
    revision: 0,
    resumeNew: true,
    form: editingForm(models),
    phase: "editing",
    error: null,
    operation: null,
    specSlug: "activation-email",
    drift: null,
    change: null,
    lastPane: null,
    confirmed: null, read: null, impact: null,
    specCut: null,
    named: null,
    interviewModel: null,
    ...over,
  });
/** The same session, drafting with Codex rather than with Claude. */
const onCodex = (over: Record<string, unknown> = {}): EditingSession =>
  session({
    form: editingForm({ ...models, draftingProvider: "codex-cli" }),
    ...over,
  });

describe("interviewArgv", () => {
  it("is built from the repository's spec folder and the session's own records", () => {
    // The repository is named by the CLI wrapper, which is the one place the
    // path this host registered reaches a command line.
    expect(interviewArgv(repository(), session(), "claude-opus-5-5")).toEqual([
      "interview",
      "--spec",
      "specs/activation-email",
      "--model",
      "claude-opus-5-5",
      "--provider",
      "claude",
    ]);
  });

  it("continues nothing until an interview has reported a session", () => {
    expect(interviewArgv(repository(), session(), "opus")).not.toContain("--session");
    const argv = interviewArgv(
      repository(),
      session({ interviewSession: "sdk-session-1", interviewProvider: "claude" }),
      "opus",
    );
    expect(argv.slice(argv.indexOf("--session"), argv.indexOf("--session") + 2)).toEqual([
      "--session",
      "sdk-session-1",
    ]);
  });

  it("runs on the session this planning drafts with", () => {
    const argv = interviewArgv(repository(), onCodex(), "opus");
    expect(argv.slice(argv.indexOf("--provider"), argv.indexOf("--provider") + 2)).toEqual([
      "--provider",
      "codex",
    ]);
    expect(interviewProvider(onCodex())).toBe("codex");
    expect(interviewProvider(session())).toBe("claude");
    // A session id belongs to the provider that reported it, so a planning
    // whose drafting choice has changed starts its own rather than asking the
    // other to continue a conversation it has never had.
    expect(
      interviewArgv(
        repository(),
        onCodex({ interviewSession: "sdk-1", interviewProvider: "claude" }),
        "opus",
      ),
    ).not.toContain("--session");
  });

  it("takes the spec folder from the repository's configuration", () => {
    expect(interviewArgv(repository({ specs: "docs/specs" }), session(), "opus")).toContain(
      "docs/specs/activation-email",
    );
  });

  it("refuses a planning whose spec has no name yet", () => {
    expect(() => interviewArgv(repository(), session({ specSlug: null }), "opus")).toThrow(
      /spec title first/,
    );
  });

  /**
   * Resolve, then judge: the folder is checked where it lands rather than as
   * it is spelled, and the string checked is the one the command is given.
   */
  it("refuses a spec folder reached through a link, before there is an argv", () => {
    const repo = repository();
    const elsewhere = join(repo.path, "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(repo.path, "specs"));
    expect(() => interviewArgv(repo, session(), "opus")).toThrow(/symlink/);
  });
});
