import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Profile } from "./store.js";
import { SettingsSchema } from "../../shared/protocol.js";

/**
 * `scripts/migrate-workspace-round8.mjs` against profiles shaped as the two
 * builds before this one wrote them — `main`, and the round before this one —
 * run as it is run, a process started with argv, and then read by the
 * profile's own loader: what the migrated file has to pass is the schema
 * Perbo starts on, and a field the script leaves out stops Perbo starting.
 */
const SCRIPT = fileURLToPath(new URL("../../../../../scripts/migrate-workspace-round8.mjs", import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const settings = SettingsSchema.parse({});
const models = {
  executorProvider: settings.executorProvider,
  executorModel: settings.executorModel,
  reviewerProvider: settings.reviewerProvider,
  reviewerModel: settings.reviewerModel,
  draftingProvider: settings.draftingProvider,
  executorSkills: settings.executorSkills,
  executorEffort: null,
  reviewerEffort: null,
};
const REPO = "7c1c4a52-3b3e-4b8e-9f6e-2d8f3f0a9b11";
const promise = (last: string) => ({
  outcome: "New users receive one confirmation email.",
  criteria: [
    { id: "ac_1", text: "A signup queues one email." },
    { id: "ac_2", text: last },
  ],
});

/**
 * A basic ticket's planning as the round before this one saved it: its
 * contract last seen on the contract page, left on the Plan pane's
 * "criteria", its last change recorded with no author, and none of
 * `confirmed`, `read` or `impact`.
 */
function roundBefore(id: string) {
  return {
    version: 1,
    id,
    repoId: REPO,
    key: "PRB-1",
    admitted: true,
    digest: "a".repeat(64),
    revision: 4,
    resumeNew: false,
    specSlug: "signup-mail",
    specCut: null,
    named: { by: "person", title: "Signup mail" },
    asking: null,
    nodes: 0,
    drift: {
      open: [
        {
          heading: "The retry count",
          difference: "The spec asks for one retry; the plan retries twice.",
          options: [
            { label: "Retry once, as the spec says", detail: null, recommended: true },
            { label: "Retry twice, and say so in the spec", detail: null, recommended: false },
          ],
        },
      ],
      resolved: false,
    },
    change: {
      at: "2026-09-21T10:00:00.000Z",
      spec: null,
      plan: { before: promise("A failed send is retried."), after: promise("A failed send is retried twice.") },
    },
    lastPane: "criteria",
    lastView: "contract",
    form: {
      draft: {
        outcome: "New users receive one confirmation email.",
        criteria: [{ text: "A signup queues one email.", assertion: "signup.test.ts", kind: "test" }],
        paths: ["src/**"],
        prohibited: [],
      },
      models,
      editing: null,
      criterion: { text: "", assertion: "", kind: "test" },
      newPath: null,
    },
    phase: "ready",
    error: null,
    operation: {
      id: "0b8e4f0e-9a51-4d8e-8f1a-6c7d2e3f4a5b",
      intent: "generate",
      inputRevision: 3,
      jobId: "1c9f5a1f-0b62-4e9f-9a2b-7d8e3f4a5b6c",
      state: "completed",
      resultKey: "PRB-1",
      error: null,
      reconciled: true,
    },
    history: [],
    conversation: [
      { n: 1, at: "2026-09-21T09:58:00.000Z", line: { kind: "turn", text: "Send one confirmation email on signup." } },
      { n: 2, at: "2026-09-21T09:59:00.000Z", line: { kind: "note", text: "The spec is written." } },
    ],
    interviewSession: "a1b2c3",
    interviewProvider: "claude",
    interviewModel: null,
  };
}

/**
 * The same planning as `main` saved it: no `specCut` or `named` yet, and a
 * note in its conversation that offered the way on to the contract.
 */
function fromMain(id: string) {
  const before = roundBefore(id);
  const session: Partial<typeof before> = { ...before };
  delete session.specCut;
  delete session.named;
  return {
    ...session,
    conversation: [
      ...before.conversation,
      {
        n: 3,
        at: "2026-09-21T10:02:00.000Z",
        line: {
          kind: "note",
          text: "Every problem is resolved: the plan and the spec promise the same thing again.",
          offers: "contract",
        },
      },
    ],
  };
}

const job = {
  id: "2d0a6b2a-1c73-4fa0-8b3c-8e9f4a5b6c7d",
  repoId: REPO,
  key: "PRB-1",
  kind: "admit",
  label: "Draft a plan from the spec",
  state: "completed",
  startedAt: "2026-09-21T09:59:30.000Z",
  endedAt: "2026-09-21T10:00:00.000Z",
  log: "",
  error: null,
  resultKey: "PRB-1",
  result: null,
};

/** A profile directory holding `workspace.json` as written. */
function profile(state: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-profile-"));
  made.push(dir);
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(state, null, 2));
  return dir;
}

const migrate = (dir: string): string => execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });

describe("a profile from before, migrated, is one Perbo starts on", () => {
  const base = {
    version: 1,
    settings,
    repositories: [{ id: REPO, name: "webstore", path: "/Users/someone/webstore" }],
    jobs: [job],
    titles: {},
    taskModels: {},
    archived: [],
    asks: {},
  };

  it.each([
    ["the round before this one", { ...base, lastOpened: {}, editingSessions: [roundBefore("3e1b7c3b-2d84-4b1c-9c4d-9f0a5b6c7d8e")] }],
    ["main", { ...base, archivedSeeded: true, editingSessions: [fromMain("3e1b7c3b-2d84-4b1c-9c4d-9f0a5b6c7d8e")] }],
  ])("from %s", (_, state) => {
    const dir = profile(state);
    // Not as it was: the schema refuses it, naming the file.
    expect(() => Profile.open(dir)).toThrow(join(dir, "workspace.json"));
    migrate(dir);
    const opened = Profile.open(dir);
    const [session] = opened.state.editingSessions;
    expect(session).toMatchObject({ confirmed: null, read: null, impact: null, lastPane: null, change: null });
    expect(session).not.toHaveProperty("lastView");
    // What was already there is kept as it was.
    expect(session!.drift).toEqual(roundBefore("x").drift);
    expect(session!.form).toEqual(roundBefore("x").form);
    expect(opened.state.jobs).toEqual([job]);
    // And a second run finds nothing to change.
    const again = readFileSync(join(dir, "workspace.json"), "utf8");
    expect(migrate(dir).trim()).toBe(`${join(dir, "workspace.json")}: nothing to change`);
    expect(readFileSync(join(dir, "workspace.json"), "utf8")).toBe(again);
  });
});
