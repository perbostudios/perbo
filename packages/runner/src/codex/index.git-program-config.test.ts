import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import type { PreToolGuardState } from "../pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../profile.js";
import { codexCommandDecision } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A Codex approval for a line that has git run a program the line chooses:
 * refused by that rule, named as it, ahead of the admitted set.
 */

const root = realpathSync(scratch("perbo-codex-program-config-"));
mkdirSync(join(root, ".perbo-tmp"), { recursive: true });

const state: PreToolGuardState = {
  root,
  tmpdir: join(root, ".perbo-tmp"),
  cwd: root,
  paths_allowed: [],
  paths_prohibited: [],
  allow_list: [...DEFAULT_COMMAND_ALLOW_LIST],
  deny_list: [...DEFAULT_COMMAND_DENY_LIST],
};

describe("a program git runs that the line chooses, in a Codex approval", () => {
  for (const [command, target] of [
    ["git -c core.fsmonitor=/tmp/x status", "core.fsmonitor"],
    ["GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/tmp/x'\" git status", "core.hooksPath"],
    ["GIT_EXTERNAL_DIFF=/tmp/x git diff", "GIT_EXTERNAL_DIFF"],
  ] as const) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(codexCommandDecision(command, root, state)).toMatchObject({
        decision: "denied",
        rule: "git_program_config",
        target,
      });
    });
  }

  it("judges `git -c core.pager=cat log` as it judges a `-c` that names no program", () => {
    const pager = codexCommandDecision("git -c core.pager=cat log", root, state);
    const color = codexCommandDecision("git -c color.ui=false log", root, state);
    expect([pager.decision, pager.rule]).toEqual([color.decision, color.rule]);
    expect(pager.rule).not.toBe("git_program_config");
  });
});
