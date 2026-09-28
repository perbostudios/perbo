import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "./profile.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A backslash before a newline is taken out with it, and the shell reads what
 * stands either side as one word: `/tm\<newline>p/x` is `/tmp/x`, and
 * `HO\<newline>ME=` assigns `HOME`. Read as a space instead, each of these was
 * two harmless words to the hook while the shell wrote outside the worktree or
 * pointed git at a repository the line picks.
 */

const root = realpathSync(resolve(scratch("perbo-pretool-continuation-")));
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

describe("a line continuation at Claude Code's hook", () => {
  it("refuses a destination a continuation splits, read as the one path the shell writes", () => {
    const decision = judge("cp a.txt /tm\\\np/x");
    expect(decision).toMatchObject({ answer: "deny", rule: "write_outside_worktree", target: "/tmp/x" });
  });

  it("refuses a HOME a continuation splits as the repository redirect it is", () => {
    const decision = judge("HO\\\nME=/tmp/h git status");
    expect(decision).toMatchObject({ answer: "deny", rule: "git_repository_redirect" });
    expect(decision.reason).toContain("HOME");
  });

  it("refuses a GIT_CONFIG_GLOBAL a continuation splits as the alias it can define", () => {
    const decision = judge("GIT_CONFIG_GL\\\nOBAL=/tmp/cfg git status");
    expect(decision).toMatchObject({ answer: "deny", rule: "git_alias_defined" });
    expect(decision.reason).toContain("GIT_CONFIG_GLOBAL");
  });

  it("refuses a line whose ANSI-C quote a continuation after a heredoc's body spells", () => {
    // A body holding a `'` keeps `$\<newline>'` apart until the text after the
    // body is joined afresh into `$'\''`, whose escaped quote ends it for the
    // readers here and not for the shell, which runs the `cp`.
    expect(judge("cat <<EOF\n'\nEOF\necho $\\\n'\\'' ; cp a.txt /tmp/x ; echo '\\'")).toMatchObject({
      answer: "deny",
      rule: "write_outside_worktree",
    });
  });

  it("refuses a line whose backslash before CR LF stands after a heredoc's body", () => {
    // A body holding a `'` keeps the backslash before CR LF inside a quote in
    // the line as first joined; the text after the body, joined afresh, holds
    // it. bash copies to `sub/..` + CR, and a shell that reads CR LF as a line
    // end copies to `sub/../../x`, outside the worktree.
    expect(judge("cat <<EOF\n'\nEOF\ncp a.txt sub/..\\\r\n/../x")).toMatchObject({
      answer: "deny",
      rule: "write_outside_worktree",
    });
  });

  it("refuses a continuation the join and the segment reader place in different quotes", () => {
    // The join reads the backtick pair inside `"…"` whole, as bash does, and
    // keeps the continuation inside the `'…'` after it; ksh ends the `"` at the
    // backtick pair's own `"`, and copies to `../o/x`.
    expect(judge("echo \"`echo \"'\"`\" ' && cp a.txt .\\\n./o/x ; echo '")).toMatchObject({
      answer: "deny",
      rule: "write_outside_worktree",
    });
  });

  it("admits a continued line that writes nowhere outside", () => {
    expect(judge("git status \\\n --short")).toMatchObject({ decision: "allowed", rule: null });
    expect(judge("echo a \\\n b > out.txt")).toMatchObject({ answer: "allow", decision: "allowed", rule: null });
  });
});
