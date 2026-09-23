import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { judgePreToolCall, type PreToolGuardState } from "../pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../profile.js";
import { codexCommandDecision } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * Two executors, one write guard. Claude Code's hook and Codex's approval
 * callback both read a command line through the same shell module, so a
 * destination one of them refuses is one the other refuses — an attempt that
 * cannot write outside its worktree under one provider and can under the other
 * is a guard that holds only where the runner happened to be pointed.
 */

const root = scratch("perbo-codex-write-guard-");
mkdirSync(join(root, "sub"), { recursive: true });

const state = (): PreToolGuardState => ({
  root,
  tmpdir: null,
  cwd: root,
  paths_allowed: [],
  paths_prohibited: [],
  allow_list: [...DEFAULT_COMMAND_ALLOW_LIST],
  deny_list: [...DEFAULT_COMMAND_DENY_LIST],
  agent_roles: [],
});

/** Destinations that arrive on `xargs`' standard input, on both paths. */
const FROM_STANDARD_INPUT = [
  "echo /etc/x | xargs touch",
  "xargs -0 rm -rf < list.txt",
  "find . -name '*.log' | xargs rm -f",
  "xargs cp a",
];

/** Destinations `xargs` substitutes for its placeholder, on both paths. */
const SUBSTITUTED_FOR_THE_DESTINATION = [
  "echo /etc/passwd | xargs -I{} rm {}",
  "xargs -I{} touch {}",
  "xargs -i rm {}",
];

/**
 * The same wrapper where the line spells the destination, and a `#` read as a
 * character, on both paths.
 */
const DESTINATION_ON_THE_LINE = [
  "xargs -I{} cp {} sub",
  "xargs -0 -n1 cp -t sub",
  "cp a b#c '#' sub",
];

/** Writes outside the worktree that a misreading of the line would hide, on both paths. */
const MISREAD = [
  // A comment's words read as operands: `-t sub` would make `/etc/x` a source.
  "cp a /etc/x # -t sub",
  // A `#` both shells read as a character, read as a comment hiding the `cp`.
  "echo ${x:-a #}; cp a /etc/x",
  "cat <(true)#x; cp a /etc/x",
  "(( 1 #)); cp a /etc/x",
  // A `#` bash and zsh disagree on.
  "cp a /etc/x ${x:+{a} #} -t sub",
  // A `"` inside an expansion inside double quotes, read as closing them.
  'echo "$(echo " #")"; cp a /etc/x',
  `cp a "$(echo '"')/../../etc" #' b'`,
  'echo "$(echo " <<EOF")"\ncp a /etc/x',
  // An ANSI-C quote's escaped `'`, read as the quote's end.
  "echo $'\\''; cp a /etc/x",
  // A `find -exec` terminator read as the end of a writer's operands.
  "cp a sub + /etc",
  "cp a sub ';' /etc",
];

/**
 * A placeholder `xargs` substitutes, or a path `find` finds, in a line a nested
 * shell runs, on both paths.
 */
const SUBSTITUTED_INTO_A_NESTED_COMMAND = [
  "echo /etc/passwd | xargs -I{} sh -c 'rm {}'",
  "echo 'rm /etc/x' | xargs -J % sh -c %",
  "find . -exec sh -c 'rm {}' \\;",
];

/** Writes under a `find` starting point outside the worktree, on both paths. */
const UNDER_A_FIND_START = [
  "find /etc -name x -delete",
  "find /etc -name x -exec rm {} +",
  // `-execdir` runs the body on the starting point itself from the directory above it.
  "find sub -execdir cp a ../x \\;",
  "find sub -okdir cp a ../x \\;",
  // A starting point after `--`, or in a file.
  "find -- /etc -name x -delete",
  "find -files0-from list -delete",
  // A starting point and an action arriving on standard input.
  "echo /etc/x -delete | xargs find",
];

/** An `xargs` behind another whose placeholder the inner one's command carries, on both paths. */
const BEHIND_ANOTHER_WRAPPER = ["xargs -I{} xargs -a list -I@ cp a @ {}"];

/**
 * Destinations outside the writer table, on both paths. `sudo -D` is left to
 * the shell module's own tests: the deny list refuses `sudo` before the write
 * guard reads it.
 */
const BEYOND_THE_WRITER_TABLE = [
  "echo /etc/x | xargs ln -s a",
  "echo /etc | xargs -J % git -C % clean -fdx",
  "time -o /etc/x ls",
];

describe("a write neither executor can see the destination of", () => {
  for (const command of [
    ...FROM_STANDARD_INPUT,
    ...SUBSTITUTED_FOR_THE_DESTINATION,
    ...MISREAD,
    ...SUBSTITUTED_INTO_A_NESTED_COMMAND,
    ...BEYOND_THE_WRITER_TABLE,
    ...BEHIND_ANOTHER_WRAPPER,
    ...UNDER_A_FIND_START,
  ]) {
    it(`is refused by the hook and by Codex — ${command}`, () => {
      const hook = judgePreToolCall(
        { tool_name: "Bash", tool_input: { command }, tool_use_id: "hook" },
        state(),
        new Date(),
      ).decision;
      const codex = codexCommandDecision(command, root, state());

      expect(hook.decision, command).toBe("denied");
      expect(hook.rule, command).toBe("write_outside_worktree");
      expect(codex.decision, command).toBe("denied");
      expect(codex.rule, command).toBe("write_outside_worktree");
    });
  }
});

describe("a write both executors can see the destination of", () => {
  for (const command of DESTINATION_ON_THE_LINE) {
    it(`is allowed by the hook and by Codex — ${command}`, () => {
      const hook = judgePreToolCall(
        { tool_name: "Bash", tool_input: { command }, tool_use_id: "hook" },
        state(),
        new Date(),
      ).decision;

      expect(hook.decision, command).not.toBe("denied");
      expect(codexCommandDecision(command, root, state()).decision, command).not.toBe("denied");
    });
  }
});

describe("a shell moved to the filesystem root", () => {
  it("is placed at / rather than at a directory nothing names", () => {
    const judged = judgePreToolCall(
      { tool_name: "Bash", tool_input: { command: "cd /" }, tool_use_id: "hook" },
      state(),
      new Date(),
    );
    // An empty answer here is written into the agent's own file, which reads
    // back as holding no directory and refuses every call the agent makes after
    // it.
    expect(judged.next_cwd).toBe("/");
    expect(codexCommandDecision("cd /", root, state()).decision).not.toBe("denied");
  });
});
