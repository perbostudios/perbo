import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMISSION_RULES } from "../src/admission.js";
import { TicketRunConfigSchema, guardProhibitedPaths } from "../src/loop.js";
import { judgePreToolCall, type PreToolGuardState } from "../src/pretool.js";
import { buildPermissionProfile } from "../src/profile.js";
import { scratch } from "./support.js";

/**
 * D-105: the repository's standing prohibited list is read at run time, beside
 * the contract's own. A path put on the list after a ticket was admitted still
 * binds that ticket's runs, because nothing here reads the contract alone.
 */

const root = realpathSync(resolve(scratch("perbo-standing-")));
mkdirSync(join(root, "packages", "app", "src", "generated"), { recursive: true });
const tmp = join(root, ".perbo-tmp");
mkdirSync(tmp, { recursive: true });
const profile = buildPermissionProfile({ worktree: root });
const at = new Date("2026-09-12T00:00:00.000Z");

const config = (paths_prohibited: unknown) =>
  TicketRunConfigSchema.parse({
    ticket_key: "PRB-1",
    repository_root: root,
    worktree_root: root,
    bundle_root: root,
    quarantine_root: tmp,
    state_root: root,
    paths_prohibited,
  });

describe("the standing prohibited list reaches the write guard", () => {
  it("is read from the run configuration, entries and bare globs alike", () => {
    const parsed = config([
      { path: "packages/app/src/generated/**", source: "PRB-9" },
      "specs/**",
    ]);
    expect(parsed.paths_prohibited.map((entry) => entry.path)).toEqual([
      "packages/app/src/generated/**",
      "specs/**",
    ]);
    expect(parsed.paths_prohibited[1]?.draft).toBeNull();
  });

  it("joins the contract's own prohibitions, each named once", () => {
    expect(guardProhibitedPaths(["infra/**"], config(["infra/**", "specs/**"]))).toEqual([
      "infra/**",
      "specs/**",
    ]);
  });

  it("refuses a write to a standing path the contract never named", () => {
    const state: PreToolGuardState = {
      root,
      tmpdir: tmp,
      cwd: root,
      paths_allowed: ["packages/app/**"],
      paths_prohibited: guardProhibitedPaths([], config(["packages/app/src/generated/**"])),
      allow_list: [...profile.command_allow_list],
      deny_list: [...profile.command_deny_list],
    };
    const decision = judgePreToolCall(
      {
        tool_name: "Write",
        tool_use_id: "toolu_standing",
        tool_input: { file_path: "packages/app/src/generated/api.ts" },
      },
      state,
      at,
    ).decision;
    expect(decision.answer).toBe("deny");
    expect(decision.rule).toBe(ADMISSION_RULES.prohibited_path);
    expect(decision.reason).toContain("packages/app/src/generated/**");
    // The rest of the allowed paths are untouched by the list.
    expect(
      judgePreToolCall(
        { tool_name: "Write", tool_use_id: "toolu_ok", tool_input: { file_path: "packages/app/src/theme.ts" } },
        state,
        at,
      ).decision.decision,
    ).toBe("allowed");
  });

  it("leaves a repository that declares no list with the contract's own", () => {
    expect(guardProhibitedPaths(["infra/**"], config(undefined))).toEqual(["infra/**"]);
  });
});
