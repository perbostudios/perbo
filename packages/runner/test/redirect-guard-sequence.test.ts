import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { runAgent, type AgentResult } from "../src/adapter.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { buildPermissionProfile } from "../src/profile.js";
import { inspectCommandWithCwd } from "../src/prohibited.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The guard judges a command from where the executor's shell is (SCP-170).
 *
 * The Bash tool keeps one shell whose working directory persists between tool
 * calls. Judging every line from the worktree root reads a relative path
 * against a directory the shell left several calls ago, which refuses writes
 * that land inside the worktree and allows none that land outside it. The
 * probe table one file over judges one line at a time and cannot see this;
 * these are sequences of tool calls.
 */

/**
 * An executor that makes the given tool calls, as the transport reports them.
 * No command runs: the adapter judges each from the stream, which is the
 * surface that terminates an attempt.
 */
function toolCallExecutor(
  worktree: string,
  name: string,
  calls: ReadonlyArray<string | { tool: string; input: Record<string, unknown> }>,
): string {
  const binary = join(worktree, name);
  const lines = calls.map((call) => {
    const block =
      typeof call === "string"
        ? { type: "tool_use", name: "Bash", input: { command: call } }
        : { type: "tool_use", name: call.tool, input: call.input };
    return JSON.stringify({ type: "assistant", message: { content: [block], usage: {} } });
  });
  writeFileSync(binary, `#!/bin/sh\ncat <<'JSON'\n${lines.join("\n")}\nJSON\n`, { mode: 0o755 });
  return binary;
}

/** A worktree the executor's directories exist in. `runAgent` needs no repository. */
function worktreeFor(prefix: string): string {
  const worktree = scratch(prefix);
  mkdirSync(join(worktree, "packages", "evaluation"), { recursive: true });
  mkdirSync(join(worktree, "docs", "evaluation"), { recursive: true });
  return worktree;
}

let sequence = 0;

async function run(
  worktree: string,
  calls: ReadonlyArray<string | { tool: string; input: Record<string, unknown> }>,
): Promise<AgentResult> {
  sequence += 1;
  const binary = toolCallExecutor(worktree, `executor-${sequence}`, calls);
  return runAgent({
    binary,
    worktree,
    prompt: "irrelevant",
    model: "none",
    profile: buildPermissionProfile({ worktree }),
    ceilings: new AttemptCeilings(
      LimitsTableSchema.parse({ organisation: "test", limits: { attempt_wall_clock_ms: 600_000 } }),
    ),
    env: { PATH: process.env.PATH ?? "" },
  });
}

const outside = (result: AgentResult) =>
  result.prohibited.filter((hit) => hit.action === "write_outside_worktree");

const cwds = (result: AgentResult) => result.commands.map((command) => command.cwd);

/**
 * `run` above spawns a real process — `toolCallExecutor`'s shell script — for
 * every test that uses it, and its 600s ceiling is not what bounds a
 * well-behaved case: the script only `cat`s pre-written JSON and exits, so
 * what this bounds is a cold Node spawn on a machine also running a loop
 * attempt and a second gate (SCP-191), not the ceiling.
 */
const TOOL_SEQUENCE_TIMEOUT_MS = 60_000;

describe("a `cd` in one tool call, and the call after it", () => {
  it("judges the AYO-16 pair from where the executor's shell was, and allows it", async () => {
    const worktree = worktreeFor("perbo-scp170-ayo16-");
    const result = await run(worktree, [
      `cd ${worktree}/packages/evaluation && git diff docs/evaluation/regression-suite.md`,
      "rm -rf ../../.perbo-tmp/perbo-corpus-bundle-* ../../.perbo-tmp/perbo-corpus-state " +
        "../../.perbo-tmp/perbo-base-test-* && ls ../../.perbo-tmp/",
    ]);

    expect(outside(result)).toEqual([]);
    expect(result.termination.reason).toBe("completed");
    expect(cwds(result)).toEqual([".", join("packages", "evaluation")]);
  }, TOOL_SEQUENCE_TIMEOUT_MS);

  it("carries a relative move into the next call", async () => {
    const worktree = worktreeFor("perbo-scp170-carried-");
    const result = await run(worktree, [
      "cd packages/evaluation",
      "rm -rf ../../.perbo-tmp/x",
    ]);

    expect(outside(result)).toEqual([]);
    expect(cwds(result)).toEqual([".", join("packages", "evaluation")]);
  }, TOOL_SEQUENCE_TIMEOUT_MS);

  it("refuses a relative write in the next call once the move left the worktree", async () => {
    const worktree = worktreeFor("perbo-scp170-left-");
    const result = await run(worktree, ["cd /tmp", "printf x > y"]);

    expect(outside(result).map((hit) => hit.detail).join("\n")).toMatch(
      /the redirect target y resolves to \S*\/tmp\/y, outside the worktree/,
    );
    expect(result.termination.reason).toBe("prohibited_action");
    expect(cwds(result)).toEqual([".", relative(realpathSync(worktree), realpathSync("/tmp"))]);
  }, TOOL_SEQUENCE_TIMEOUT_MS);

  it("allows an absolute write back into the worktree from outside it", async () => {
    const worktree = worktreeFor("perbo-scp170-absolute-");
    const result = await run(worktree, [
      "cd packages/evaluation",
      "cd /tmp",
      `printf x > ${worktree}/y`,
    ]);

    expect(outside(result)).toEqual([]);
    expect(result.termination.reason).toBe("completed");
  }, TOOL_SEQUENCE_TIMEOUT_MS);

  it("does not carry a move the shell made inside a subshell", async () => {
    const worktree = worktreeFor("perbo-scp170-subshell-");
    const result = await run(worktree, ["(cd packages/evaluation)", "rm -rf ../../.perbo-tmp/x"]);

    // The move died at the closing parenthesis, so the target is judged from
    // the root and lands two directories above it.
    expect(outside(result).map((hit) => hit.detail).join("\n")).toMatch(
      /the rm target \S*\.perbo-tmp\/x .*outside the worktree/,
    );
    expect(cwds(result)).toEqual([".", "."]);
  }, TOOL_SEQUENCE_TIMEOUT_MS);
});

describe("a move the guard cannot read", () => {
  it("refuses every later relative write by name, and records the directory as unknown", async () => {
    const worktree = worktreeFor("perbo-scp170-unknown-");
    const result = await run(worktree, ["cd $DIR", "printf x > y"]);

    expect(outside(result).map((hit) => hit.detail).join("\n")).toMatch(
      /the redirect target y cannot be resolved — the working directory is unknown/,
    );
    expect(cwds(result)).toEqual([".", "unknown"]);
  }, TOOL_SEQUENCE_TIMEOUT_MS);

  it("stays unknown through a later relative move, which resolves from nowhere", async () => {
    const worktree = worktreeFor("perbo-scp170-still-unknown-");
    const result = await run(worktree, ["cd $DIR", "cd packages/evaluation", "printf x > y"]);

    expect(cwds(result)).toEqual([".", "unknown", "unknown"]);
    expect(outside(result).map((hit) => hit.detail).join("\n")).toMatch(
      /the redirect target y cannot be resolved — the working directory is unknown/,
    );
  }, TOOL_SEQUENCE_TIMEOUT_MS);

  it("is reset by an absolute move, and the write after that is judged again", async () => {
    const worktree = worktreeFor("perbo-scp170-reset-");
    const result = await run(worktree, [
      "cd $DIR",
      `cd ${worktree}/packages/evaluation`,
      "printf x > y",
    ]);

    expect(cwds(result)).toEqual([".", "unknown", join("packages", "evaluation")]);
    // The only refusal is the unreadable move itself, on the first call.
    expect(outside(result)).toHaveLength(1);
    expect(outside(result)[0]?.detail).toMatch(/the working directory \$DIR cannot be resolved/);
  }, TOOL_SEQUENCE_TIMEOUT_MS);
});

/**
 * Out of scope, and stated rather than assumed: the runner inspects a command
 * from the stream and never sees its exit code, so a `cd` the real shell
 * rejected is applied by the tracker anyway. The resolver refuses a path it
 * cannot walk — a component under a plain file, or under a directory this
 * process may not read — but a directory that simply does not exist walks
 * cleanly, so this is where the tracked directory and the real shell part.
 */
describe("a move the real shell would have rejected", () => {
  it("is tracked anyway, because the runner does not see exit codes", async () => {
    const worktree = worktreeFor("perbo-scp170-nonexistent-");
    const result = await run(worktree, ["cd no-such-directory", "printf x > y"]);

    expect(cwds(result)).toEqual([".", "no-such-directory"]);
    expect(outside(result)).toEqual([]);
  }, TOOL_SEQUENCE_TIMEOUT_MS);
});

/**
 * A file tool is judged before it runs (SCP-177).
 *
 * The executor below is a real binary that announces a `Write` or an `Edit` the
 * way the transport does and only then touches the file — so what the
 * assertions read is whether the file on disk changed, not whether a function
 * was called.
 *
 * ## Why it waits on a file rather than on a clock
 *
 * The order these tests are about is: the runner reads the announcement, judges
 * it and terminates the process group *before* the executor's write. Written as
 * a sleep, that order is a race the test wins on an idle machine and loses on a
 * loaded one. Written as a handshake it is not a race at all: the executor
 * blocks until a release file appears, and the release file is created by the
 * test **after** the attempt has ended. The executor is therefore invited to
 * write at a moment when only a process the runner failed to stop could take
 * the invitation — so a file on disk afterwards is a guard that did not hold,
 * and no schedule can turn one verdict into the other.
 *
 * A guard that never refused leaves the executor blocked; the attempt's
 * wall-clock ceiling ends it, and the assertion on the termination reason fails
 * rather than hanging.
 */
function writingExecutor(
  worktree: string,
  name: string,
  call: {
    tool: string;
    input: Record<string, unknown>;
    writes: string;
    contents: string;
    /** Where the executor waits for its release; absent means it writes at once. */
    release?: string;
    /** Written once the announcement is out and before the wait begins. */
    announced?: string;
  },
): string {
  const binary = join(worktree, name);
  const block = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: call.tool, input: call.input }], usage: {} },
  });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });
  /**
   * The tool's result, as the transport reports it.
   *
   * The runner holds a hit read from a `tool_use` block until an event that can
   * only follow the tool, because the pre-execution hook may have refused the
   * same call and terminating an attempt for a write that never happened is the
   * false positive SCP-156 exists to have stopped (SCP-177). In a run that
   * event is the tool result arriving as a `user` message, so the executor
   * emits one: without it the second reading settles only when the attempt's
   * clock runs out, which is a schedule rather than a judgement.
   */
  const returned = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: "" }] },
  });
  const source = `#!/usr/bin/env node
"use strict";
const { existsSync, mkdirSync, writeFileSync, writeSync } = require("node:fs");
const { dirname } = require("node:path");

// The runner fingerprints the binary before it runs it; answering the version
// is not the invocation, and must not write anything.
if (process.argv.includes("--version")) {
  process.stdout.write("writing-executor 1.0.0\\n");
  process.exit(0);
}

// Written to the descriptor rather than through the stream, so the runner has
// the announcement before this process stops to wait.
writeSync(1, ${JSON.stringify(`${block}\n`)});
const announced = ${JSON.stringify(call.announced ?? null)};
if (announced !== null) writeFileSync(announced, "announced");
writeSync(1, ${JSON.stringify(`${returned}\n`)});
const release = ${JSON.stringify(call.release ?? null)};
if (release !== null) {
  // Blocked until the test says the attempt is over. The cap is longer than any
  // ceiling the test sets, so it is the ceiling that ends a run nobody stopped.
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 120_000;
  while (!existsSync(release) && Date.now() < until) Atomics.wait(idle, 0, 0, 25);
}
mkdirSync(dirname(${JSON.stringify(call.writes)}), { recursive: true });
writeFileSync(${JSON.stringify(call.writes)}, ${JSON.stringify(call.contents)});
writeSync(1, ${JSON.stringify(`${result}\n`)});
`;
  writeFileSync(binary, source, { mode: 0o755 });
  return binary;
}

async function runWriting(
  worktree: string,
  call: Parameters<typeof writingExecutor>[2],
): Promise<AgentResult> {
  sequence += 1;
  const binary = writingExecutor(worktree, `writer-${sequence}`, call);
  return runAgent({
    binary,
    worktree,
    prompt: "irrelevant",
    model: "none",
    profile: buildPermissionProfile({ worktree }),
    ceilings: new AttemptCeilings(
      // Short enough that a guard which refuses nothing ends the attempt on the
      // clock instead of hanging the suite, and is caught by its own reason.
      LimitsTableSchema.parse({ organisation: "test", limits: { attempt_wall_clock_ms: 30_000 } }),
    ),
    env: { PATH: process.env.PATH ?? "" },
  });
}

/**
 * Run an executor that is held at the announcement, and release it once the
 * attempt is over. What the assertions then read is the disk after a process
 * that was told to write was given every chance to.
 */
async function runHeld(
  worktree: string,
  call: Omit<Parameters<typeof writingExecutor>[2], "release" | "announced">,
): Promise<{ result: AgentResult; announced: boolean }> {
  // One worktree per test, so these two names are free.
  const release = join(worktree, "release");
  const announced = join(worktree, "announced");
  const result = await runWriting(worktree, { ...call, release, announced });
  const reached = existsSync(announced);
  writeFileSync(release, "go");
  // Forty poll intervals: a process still able to write would have.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return { result, announced: reached };
}

/**
 * `runWriting`'s own ceiling is 30s, chosen so a guard that refuses nothing
 * ends the attempt on the clock rather than hanging the suite; `runHeld` adds
 * the release write and a 1s poll on top. 60s doubles the ceiling, which is
 * margin for the guard's SIGTERM-then-SIGKILL teardown and a cold spawn under
 * the loaded-machine load SCP-191 measures, not slack for a hang — a guard
 * that never fires is still caught by the ceiling inside it.
 */
const WRITE_GUARD_TIMEOUT_MS = 60_000;

describe("a file tool whose destination resolves outside the worktree", () => {
  it("refuses the Write before the file is created, as a shell writer is refused", async () => {
    const worktree = worktreeFor("perbo-scp177-write-");
    const elsewhere = scratch("perbo-scp177-elsewhere-");
    const target = join(elsewhere, "escape.txt");

    const { result, announced } = await runHeld(worktree, {
      tool: "Write",
      input: { file_path: target, content: "exfiltrated" },
      writes: target,
      contents: "exfiltrated",
    });

    // The executor got as far as announcing the call, so the file's absence is
    // a write that was stopped rather than one that was never attempted.
    expect(announced).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(result.termination.reason).toBe("prohibited_action");
    expect(outside(result).map((hit) => hit.detail).join("\n")).toContain(target);
    // The same action a `printf x > <outside>` earns, from the same resolver.
    expect(outside(result)[0]?.action).toBe(
      inspectCommandWithCwd(`printf x > ${target}`, { root: worktree }).hits[0]?.action,
    );
  }, WRITE_GUARD_TIMEOUT_MS);

  it("refuses the Edit before the file is modified", async () => {
    const worktree = worktreeFor("perbo-scp177-edit-");
    const elsewhere = scratch("perbo-scp177-edited-");
    const target = join(elsewhere, "notes.md");
    writeFileSync(target, "original\n");

    const { result, announced } = await runHeld(worktree, {
      tool: "Edit",
      input: { file_path: target, old_string: "original", new_string: "replaced" },
      writes: target,
      contents: "replaced\n",
    });

    expect(announced).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(result.termination.reason).toBe("prohibited_action");
    expect(outside(result)[0]?.action).toBe("write_outside_worktree");
    expect(outside(result)[0]?.detail).toContain("Edit");
  }, WRITE_GUARD_TIMEOUT_MS);

  it("refuses a path that reaches outside through a symlink inside the worktree", async () => {
    const worktree = worktreeFor("perbo-scp177-symlink-");
    const elsewhere = scratch("perbo-scp177-linked-");
    symlinkSync(elsewhere, join(worktree, "hatch"));
    const target = join(worktree, "hatch", "escape.txt");

    const { result, announced } = await runHeld(worktree, {
      tool: "Write",
      input: { file_path: target, content: "x" },
      writes: target,
      contents: "x",
    });

    expect(announced).toBe(true);
    expect(existsSync(join(elsewhere, "escape.txt"))).toBe(false);
    expect(result.termination.reason).toBe("prohibited_action");
    expect(outside(result)).toHaveLength(1);
  }, WRITE_GUARD_TIMEOUT_MS);

  it("lets a Write inside the worktree proceed, and the file is there", async () => {
    const worktree = worktreeFor("perbo-scp177-inside-");
    const target = join(worktree, "src", "generated.ts");

    const result = await runWriting(worktree, {
      tool: "Write",
      input: { file_path: target, content: "export const a = 1;\n" },
      writes: target,
      contents: "export const a = 1;\n",
    });

    expect(readFileSync(target, "utf8")).toBe("export const a = 1;\n");
    expect(result.prohibited).toEqual([]);
    expect(result.termination.reason).toBe("completed");
  }, WRITE_GUARD_TIMEOUT_MS);
});

describe("a tool call that is not a shell line", () => {
  it("is judged from the root and records no directory, because it moves no shell", async () => {
    const worktree = worktreeFor("perbo-scp170-file-tool-");
    const result = await run(worktree, [
      "cd /tmp",
      { tool: "Write", input: { file_path: join(worktree, "src", "a.ts") } },
      "printf x > y",
    ]);

    expect(cwds(result)).toEqual([
      ".",
      null,
      relative(realpathSync(worktree), realpathSync("/tmp")),
    ]);
    // The file tool neither moved the shell nor was judged from it.
    expect(outside(result)).toHaveLength(1);
  }, TOOL_SEQUENCE_TIMEOUT_MS);
});

/**
 * What the adapter carries forward, read directly: the directory one line
 * leaves the shell in, by the same rules SCP-162 uses to judge the rest of that
 * line.
 */
describe("the directory a line reports leaving the shell in", () => {
  const root = scratch("perbo-scp170-unit-");
  mkdirSync(join(root, "packages", "evaluation"), { recursive: true });
  const at = (command: string) =>
    inspectCommandWithCwd(command, { root, home: "/Users/nobody" }).cwd.relative;

  it("reports a move the calling shell keeps", () => {
    expect(at("cd packages/evaluation")).toBe(join("packages", "evaluation"));
    expect(at("cd packages && cd evaluation")).toBe(join("packages", "evaluation"));
    expect(at("pushd packages/evaluation")).toBe(join("packages", "evaluation"));
    expect(at("git status && cd packages/evaluation")).toBe(join("packages", "evaluation"));
  });

  it("reports the root where the line moved nothing", () => {
    expect(at("git status")).toBe(".");
    expect(at("pnpm test > log.txt")).toBe(".");
  });

  it("reports no move the shell made somewhere it does not keep", () => {
    expect(at("(cd packages/evaluation)")).toBe(".");
    expect(at("cd packages/evaluation | cat")).toBe(".");
    expect(at("cd packages/evaluation &")).toBe(".");
    expect(at("sh -c 'cd packages/evaluation'")).toBe(".");
  });

  it("reports the move `eval` made, because eval runs in this shell", () => {
    expect(at("eval cd packages/evaluation")).toBe(join("packages", "evaluation"));
  });

  it("reports unknown after a move it cannot read", () => {
    for (const command of [
      "cd $DIR",
      "cd $(mktemp -d)",
      "cd -",
      "cd ~someone",
      "popd",
      "eval cd $DIR",
    ]) {
      expect(at(command), command).toBe("unknown");
    }
  });

  it("starts where the caller says the shell is", () => {
    const scope = { root, cwd: join(root, "packages", "evaluation"), home: "/Users/nobody" };
    expect(inspectCommandWithCwd("git status", scope).cwd.relative).toBe(
      join("packages", "evaluation"),
    );
    expect(inspectCommandWithCwd("cd ..", scope).cwd.relative).toBe("packages");
    expect(inspectCommandWithCwd("rm -rf ../../.perbo-tmp/x", scope).hits).toEqual([]);
  });

  it("defaults to the root, so a caller that names no directory reads as before", () => {
    expect(inspectCommandWithCwd("rm -rf ../../.perbo-tmp/x", { root }).hits).toHaveLength(1);
    expect(inspectCommandWithCwd("git status", { root }).cwd.relative).toBe(".");
  });
});
