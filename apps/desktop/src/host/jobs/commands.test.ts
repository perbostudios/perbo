import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { createScratch } from "@perbo/test-support";
import { SettingsSchema } from "../../shared/protocol.js";
import {
  admitDraftArgs,
  admitFromSpecArgs,
  approveArgs,
  assertEditable,
  assertResumable,
  doctorArgs,
  doctorConfig,
  draftArgs,
  editArgs,
  graphEditArgs,
  principleArgs,
  runArgs,
  runConfig,
  syncArgs,
  verdictArgs,
  writePrivate,
} from "./commands.js";
import type { Detail, Draft, RequestOf } from "../../shared/protocol.js";
import type { PlanContract } from "@perbo/contracts";
import type { LimitsTableSchema } from "@perbo/contracts";
import type { z } from "zod";

const scratchDirectory = createScratch("perbo-commands-");
afterEach(() => {
  scratchDirectory.removeAll();
});
const settings = SettingsSchema.parse({});
const draft: Draft = {
  outcome: "Make errors actionable",
  criteria: [
    { text: "The user can retry", assertion: "The retry button is visible", kind: "test" },
  ],
  paths: ["src/**", "test/**"],
  prohibited: [],
};
const limits = { organisation: "local", limits: {} } as z.infer<typeof LimitsTableSchema>;

describe("draftArgs", () => {
  it("carries the outcome, each criterion, each path and each prohibition", () => {
    expect(draftArgs({ ...draft, prohibited: ["infra/**"] })).toEqual([
      "--outcome",
      "Make errors actionable",
      "--criterion",
      "The user can retry :: The retry button is visible :: test",
      "--path",
      "src/**",
      "--path",
      "test/**",
      "--prohibit",
      "infra/**",
      "--json",
    ]);
  });

  it("keeps a shell's own punctuation inside one argument", () => {
    const args = draftArgs({ ...draft, outcome: "Make errors actionable $(touch x) `whoami`" });
    expect(args[1]).toBe("Make errors actionable $(touch x) `whoami`");
    expect(args.filter((arg) => arg.includes("touch x"))).toHaveLength(1);
  });

  it("refuses the verification separator inside a criterion", () => {
    for (const criterion of [
      { text: "a :: b", assertion: "c", kind: "test" as const },
      { text: "a", assertion: "b :: c", kind: "test" as const },
    ])
      expect(() => draftArgs({ ...draft, criteria: [criterion] })).toThrow(
        "The CLI reserves a double colon for its verification separator.",
      );
  });
});

describe("graphEditArgs", () => {
  const edit = { kind: "add_node", node: { id: "n1" } } as unknown as RequestOf<"graphEdit">["edit"];
  it("sends the edit as JSON, authored by the person", () => {
    expect(
      graphEditArgs("PRB-1", {
        kind: "graphEdit",
        repoId: "r",
        key: "PRB-1",
        edit,
      } as RequestOf<"graphEdit">),
    ).toEqual([
      "edit",
      "PRB-1",
      "--graph-edit",
      JSON.stringify(edit),
      "--author",
      "you",
      "--json",
    ]);
  });

  it("undoes by the edit's number, as a string", () => {
    expect(
      graphEditArgs("PRB-1", {
        kind: "graphUndo",
        repoId: "r",
        key: "PRB-1",
        edit: 3,
      } as RequestOf<"graphUndo">),
    ).toEqual(["edit", "PRB-1", "--undo", "3", "--author", "you", "--json"]);
  });
});

describe("the admission commands", () => {
  it("prefixes every ticket it admits", () => {
    expect(admitFromSpecArgs("specs/a/spec.md", null, "claude-cli", "opus")).toEqual([
      "admit",
      "--prefix",
      "PRB",
      "--from-spec",
      "specs/a/spec.md",
      "--provider",
      "claude-cli",
      "--model",
      "opus",
      "--json",
    ]);
    expect(admitDraftArgs(draft).slice(0, 3)).toEqual(["admit", "--prefix", "PRB"]);
  });

  it("starts over only where a ticket is being replaced", () => {
    expect(admitFromSpecArgs("specs/a/spec.md", "PRB-1", "claude-cli", "opus")).toContain(
      "--start-over",
    );
    expect(admitFromSpecArgs("specs/a/spec.md", null, "claude-cli", "opus")).not.toContain(
      "--start-over",
    );
  });

  it("edits a ticket by its key and the draft's own fields", () => {
    const held = { ...draft, prohibited: ["infra/**"] };
    expect(editArgs("PRB-1", held).slice(0, 2)).toEqual(["edit", "PRB-1"]);
    expect(editArgs("PRB-1", held).slice(2)).toEqual(draftArgs(held));
  });

  // An empty list and an absent flag are the same on a command line, and the
  // edit replaces only what it is given: without the flag, unmarking the last
  // prohibited path is written and then quietly ignored.
  it("says 'none' out loud when the last prohibition has been taken back", () => {
    expect(editArgs("PRB-1", { ...draft, prohibited: [] })).toContain("--no-prohibit");
    expect(editArgs("PRB-1", { ...draft, prohibited: ["infra/**"] })).not.toContain(
      "--no-prohibit",
    );
    // Admission writes the whole scope rather than replacing part of one, so
    // it needs no such flag.
    expect(admitDraftArgs({ ...draft, prohibited: [] })).not.toContain("--no-prohibit");
  });
});

describe("the run and doctor configurations", () => {
  it("names the binary the executor's provider runs as", () => {
    expect(doctorConfig({ ...settings, executorProvider: "codex-cli" })).toMatchObject({
      agent_binary: "codex",
      agent_provider: "codex-cli",
    });
    expect(doctorConfig({ ...settings, executorProvider: "claude-cli" })).toMatchObject({
      agent_binary: "claude",
    });
    expect(runConfig({ ...settings, executorProvider: "codex-cli" }, limits, false)).toMatchObject({
      agent_binary: "codex",
    });
  });

  it("carries person-only merge on every run, and publishes only when asked", () => {
    expect(runConfig(settings, limits, true)).toMatchObject({ merge: "person", publish: true });
    expect(runConfig(settings, limits, false)).toMatchObject({ merge: "person", publish: false });
  });

  it("carries the skills and the limits the run is given", () => {
    expect(
      runConfig({ ...settings, executorSkills: ["diagnosing-bugs"] }, limits, false),
    ).toMatchObject({ executor_skills: ["diagnosing-bugs"], limits });
  });

  it("carries how hard each role's model thinks", () => {
    expect(
      runConfig({ ...settings, executorEffort: "high", reviewerEffort: "low" }, limits, false),
    ).toMatchObject({ effort: "high", reviewer_effort: "low" });
    expect(runConfig(settings, limits, false)).toMatchObject({ effort: null, reviewer_effort: null });
  });

  it("asks the doctor to write the configuration only where the person did", () => {
    expect(doctorArgs("/profile/doctor-1.json", false)).toEqual([
      "doctor",
      "--json",
      "--config",
      "/profile/doctor-1.json",
    ]);
    expect(doctorArgs("/profile/doctor-1.json", true)).toContain("--write-config");
  });

  it("resumes only where a bundle was named", () => {
    expect(runArgs("PRB-1", "/profile/run-1.json", null)).toEqual([
      "run",
      "--ticket",
      "PRB-1",
      "--config",
      "/profile/run-1.json",
      "--json",
    ]);
    expect(runArgs("PRB-1", "/profile/run-1.json", "bundle_1").slice(-2)).toEqual([
      "--resume-from",
      "bundle_1",
    ]);
  });
});

describe("the short commands", () => {
  it("names the ticket, the finding, the note and the author of a verdict", () => {
    expect(
      verdictArgs(
        {
          kind: "verdict",
          repoId: "r",
          key: "PRB-1",
          decision: "accept",
          findingKey: "finding_1",
          note: "Agreed",
        } as RequestOf<"verdict">,
        "Lian",
      ),
    ).toEqual([
      "verdict",
      "PRB-1",
      "--accept",
      "finding_1",
      "--note",
      "Agreed",
      "--author",
      "Lian",
      "--json",
    ]);
  });

  it("records a principle, approves and syncs by name", () => {
    expect(principleArgs("Ship it")).toEqual(["principle", "add", "Ship it"]);
    expect(approveArgs("PRB-1")).toEqual(["approve", "PRB-1", "--json"]);
    expect(syncArgs("PRB-1")).toEqual(["sync", "PRB-1"]);
  });
});

describe("the guards a job runs before it starts", () => {
  it("sends a contract with named manual reviewers to the CLI", () => {
    const manual = {
      acceptance_criteria: [
        { id: "c1", expected_verification: { kind: "manual", manual_reviewer: "Lian" } },
      ],
    } as unknown as PlanContract;
    expect(() => assertEditable(manual)).toThrow("This contract has named manual reviewers.");
  });

  it("allows a contract whose criteria are all checked by a test", () => {
    const automated = {
      acceptance_criteria: [{ id: "c1", expected_verification: { kind: "test" } }],
    } as unknown as PlanContract;
    expect(() => assertEditable(automated)).not.toThrow();
    expect(() => assertEditable({ outcome: "P0" } as unknown as PlanContract)).not.toThrow();
  });

  it("resumes only from an execution bundle this task's attempts sealed", () => {
    const detail = {
      attempts: [
        {
          bundles: [
            { bundle_id: "bundle_1", kind: "execution" },
            { bundle_id: "bundle_2", kind: "review" },
          ],
        },
      ],
    } as Detail;
    expect(() => assertResumable(detail, "bundle_1")).not.toThrow();
    for (const id of ["bundle_2", "bundle_elsewhere"])
      expect(() => assertResumable(detail, id)).toThrow(
        "The recovery bundle does not belong to this task.",
      );
  });
});

describe("writePrivate", () => {
  it("writes the file readable only by its owner, and refuses to write over one", () => {
    const directory = scratchDirectory();
    const path = writePrivate(directory, "run-1.json", '{"merge":"person"}');
    expect(readFileSync(path, "utf8")).toBe('{"merge":"person"}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writePrivate(directory, "run-1.json", "{}")).toThrow();
  });
});
