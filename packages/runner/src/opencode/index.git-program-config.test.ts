import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import type { PreToolGuardState } from "../pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../profile.js";
import { opencodeDecision } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * An OpenCode command that has git run a program the line chooses: refused
 * by that rule, named as it, as on the other two paths.
 */

const root = realpathSync(scratch("perbo-opencode-program-config-"));
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

const execute = (command: string) =>
  opencodeDecision({ toolCallId: "t", kind: "execute", rawInput: { command, cwd: root } }, state);

describe("a program git runs that the line chooses, in an OpenCode command", () => {
  for (const [command, target] of [
    ["git -c core.fsmonitor=/tmp/x status", "core.fsmonitor"],
    ["GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/tmp/x'\" git status", "core.hooksPath"],
    ["GIT_EXTERNAL_DIFF=/tmp/x git diff", "GIT_EXTERNAL_DIFF"],
  ] as const) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(execute(command)).toMatchObject({ decision: "denied", rule: "git_program_config", target });
    });
  }

  it("judges `git -c core.pager=cat log` as it judges a `-c` that names no program", () => {
    const pager = execute("git -c core.pager=cat log");
    const color = execute("git -c color.ui=false log");
    const ruled = (decided: typeof pager) => [decided.decision, "rule" in decided ? decided.rule : null];
    expect(ruled(pager)).toEqual(ruled(color));
    expect(ruled(pager)[1]).not.toBe("git_program_config");
  });
});
