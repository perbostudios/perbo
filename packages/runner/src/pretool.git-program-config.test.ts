import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "./profile.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A program git runs that the line chooses, at Claude Code's hook: each of
 * these runs `/tmp/x` through a verb that only reads, and Claude Code's own
 * layer is the only other thing standing in front of it.
 */

const root = realpathSync(resolve(scratch("perbo-pretool-program-config-")));
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

const judge = (command: string) =>
  judgePreToolCall(
    { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command } },
    state,
    new Date("2026-09-03T00:00:00.000Z"),
  ).decision;

describe("a program git runs that the line chooses, at Claude Code's hook", () => {
  for (const [command, target] of [
    ["git -c core.fsmonitor=/tmp/x status", "core.fsmonitor"],
    ["GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/tmp/x'\" git status", "core.hooksPath"],
    ["GIT_EXTERNAL_DIFF=/tmp/x git diff", "GIT_EXTERNAL_DIFF"],
  ] as const) {
    it(`denies ${JSON.stringify(command)}`, () => {
      const decision = judge(command);
      expect(decision).toMatchObject({ answer: "deny", rule: "git_program_config", target });
      expect(decision.reason).toContain("a program the line chooses");
    });
  }

  it("leaves `git -c core.pager=cat log` to the agent's layer, as it leaves `git log`", () => {
    expect(judge("git -c core.pager=cat log")).toMatchObject({ answer: "defer", decision: "allowed", rule: null });
    expect(judge("git log")).toMatchObject({ answer: "defer", decision: "allowed", rule: null });
  });
});
