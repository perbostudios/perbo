import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import type { PreToolGuardState } from "../pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../profile.js";
import { opencodeDecision } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * An OpenCode command judged with a line continuation in it: the shell takes a
 * backslash and a newline out and reads what stands either side as one word,
 * and so does the guard, on this path as on the other two.
 */

const root = realpathSync(scratch("perbo-opencode-continuation-"));
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

describe("a line continuation in an OpenCode command", () => {
  it("refuses a destination a continuation splits, read as the one path the shell writes", () => {
    expect(execute("cp a.txt /tm\\\np/x")).toMatchObject({
      decision: "denied",
      rule: "write_outside_worktree",
      target: "/tmp/x",
    });
  });

  it("refuses a HOME a continuation splits as the repository redirect it is", () => {
    expect(execute("HO\\\nME=/tmp/h git status")).toMatchObject({
      decision: "denied",
      rule: "git_repository_redirect",
    });
  });

  it("refuses a GIT_CONFIG_GLOBAL a continuation splits as the alias it can define", () => {
    expect(execute("GIT_CONFIG_GL\\\nOBAL=/tmp/cfg git status")).toMatchObject({
      decision: "denied",
      rule: "git_alias_defined",
    });
  });

  it("refuses a line whose ANSI-C quote a continuation after a heredoc's body spells", () => {
    // A body holding a `'` keeps `$\<newline>'` apart until the text after the
    // body is joined afresh into `$'\''`, whose escaped quote ends it for the
    // readers here and not for the shell, which runs the `cp`.
    expect(execute("cat <<EOF\n'\nEOF\necho $\\\n'\\'' ; cp a.txt /tmp/x ; echo '\\'")).toMatchObject({
      decision: "denied",
      rule: "write_outside_worktree",
    });
  });

  it("refuses a line whose backslash before CR LF stands after a heredoc's body", () => {
    // A body holding a `'` keeps the backslash before CR LF inside a quote in
    // the line as first joined; the text after the body, joined afresh, holds
    // it. bash copies to `sub/..` + CR, and a shell that reads CR LF as a line
    // end copies to `sub/../../x`, outside the worktree.
    expect(execute("cat <<EOF\n'\nEOF\ncp a.txt sub/..\\\r\n/../x")).toMatchObject({
      decision: "denied",
      rule: "write_outside_worktree",
    });
  });

  it("refuses a continuation the join and the segment reader place in different quotes", () => {
    // The join reads the backtick pair inside `"…"` whole, as bash does, and
    // keeps the continuation inside the `'…'` after it; ksh ends the `"` at the
    // backtick pair's own `"`, and copies to `../o/x`.
    expect(execute("echo \"`echo \"'\"`\" ' && cp a.txt .\\\n./o/x ; echo '")).toMatchObject({
      decision: "denied",
      rule: "write_outside_worktree",
    });
  });

  it("admits a continued line that writes nowhere outside", () => {
    expect(execute("git status \\\n --short")).toEqual({ decision: "allowed" });
    expect(execute("echo a \\\n b > out.txt")).toEqual({ decision: "allowed" });
  });
});
