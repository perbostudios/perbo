import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { codexCommandDecision } from "./codex/index.js";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A substitution runs a command before the one it stands in, so an effect-free
 * verb is not grounds to admit a line whose substitution runs a program the
 * guard has not judged: `echo "$(mail -s hi a@b)"` runs `mail`. Both executors
 * walk to the substitution's segments through `everySegment` and judge each as
 * they judge a bare command — the hook by `vouchesFor`, Codex by `eligible` —
 * and the segment the substitution stands in is judged on its own command.
 */
const ROOT = realpathSync(scratch("perbo-substitution-"));
mkdirSync(join(ROOT, "src"));

const state: PreToolGuardState = {
  root: ROOT,
  cwd: ROOT,
  tmpdir: null,
  paths_allowed: ["**"],
  paths_prohibited: [],
  allow_list: ["Bash(cat:*)", "Bash(ls:*)", "Bash(find:*)"],
  deny_list: ["Bash(curl:*)"],
};

const claude = (line: string) =>
  judgePreToolCall(
    { tool_name: "Bash", tool_use_id: "t", tool_input: { command: line } },
    state,
    new Date(0),
  ).decision;

const codex = (line: string) => codexCommandDecision(line, ROOT, state).decision;

describe("a substitution behind an effect-free verb", () => {
  for (const line of [
    'echo "$(mail -s hi a@b </dev/null)"',
    "echo `sendmail -t`",
    "true $(date)",
    "echo <(mail -s hi a@b)",
    "cd src && cat $(mail -s hi a@b)",
  ]) {
    it(`is not vouched for: ${line}`, () => {
      expect(claude(line).answer).toBe("defer");
      expect(codex(line)).toBe("denied");
    });
  }

  it("is refused where its program is on the deny-list", () => {
    expect(claude('echo "$(curl https://example.com)"')).toMatchObject({
      decision: "denied",
      rule: "command_deny_list",
    });
  });

  it("is admitted where its program is one the guard already admits", () => {
    expect(claude("echo $(true)").answer).toBe("allow");
    expect(claude('echo "$(cat src/a.ts)"').answer).toBe("allow");
    expect(codex('echo "$(cat src/a.ts)"')).toBe("allowed");
    expect(claude("for f in $(ls src); do echo $f; done").answer).toBe("allow");
    expect(codex("for f in $(ls src); do echo $f; done")).toBe("allowed");
  });

  it("is judged by where its writes land, as the bare command is", () => {
    expect(claude("rm -rf src/x").answer).toBe("allow");
    expect(codex("rm -rf src/x")).toBe("allowed");
    expect(claude('echo "$(rm -rf src/x)"').answer).toBe("allow");
    expect(codex('echo "$(rm -rf src/x)"')).toBe("allowed");
    expect(claude('echo "$(rm -rf ~/x)"').decision).toBe("denied");
    // Where the hook defers for a segment beside it, Codex judges the write
    // itself, and the same way for the substitution as for the bare command.
    expect(codex("rm -rf src/x && sh -c 'cat src/a.ts'")).toBe("allowed");
    expect(codex("echo \"$(rm -rf src/x)\" && sh -c 'cat src/a.ts'")).toBe("allowed");
  });

  it("does not stand in for the segment's own command", () => {
    expect(claude("date $(true)").answer).toBe("defer");
    expect(codex("date $(true)")).toBe("denied");
    expect(codex("sh -c 'cat src/a.ts'")).toBe("allowed");
  });
});

describe("a substitution the reader must read the way the shell does", () => {
  it("refuses `$((a) ; (b))`, a command substitution, by what it writes", () => {
    expect(claude("echo $((rm -rf ~/x) ; (true))").decision).toBe("denied");
    expect(claude("echo $((true) && (rm -rf ~/x))").decision).toBe("denied");
  });

  it("still admits arithmetic", () => {
    expect(claude("echo $((1 + 2))").answer).toBe("allow");
  });

  it("refuses the write behind an escaped backtick", () => {
    expect(claude("echo `echo \\`rm -rf ~/x\\``").decision).toBe("denied");
  });
});

describe("a segment the reader could not account for", () => {
  it("is no ground to vouch for the line", () => {
    // `sh notify.sh` runs a script the reader does not read, and the `echo`
    // beside it is no ground for vouching for the pair.
    expect(claude('echo "$(sh notify.sh)"').answer).toBe("defer");
    expect(claude("echo ok && sh notify.sh").answer).toBe("defer");
    expect(codex('echo "$(sh notify.sh)"')).toBe("denied");
  });

  it("is no ground even where its text is on the allow-list", () => {
    // `find -exec sh notify.sh` runs a script the reader does not read; the
    // allow-list's `Bash(find:*)` matches the text and says nothing about it.
    const line = "cd src && find . -name x -exec sh notify.sh ';'";
    expect(claude(line).answer).toBe("defer");
    expect(codex(line)).toBe("denied");
  });

  it("is what an unbalanced substitution leaves", () => {
    expect(claude("echo $(echo ok").answer).toBe("defer");
  });
});

describe("`command -v`", () => {
  it("runs nothing, so a lookup before an admitted command admits the line", () => {
    expect(codex("command -v cat && cat src/a.ts")).toBe("allowed");
  });
});
