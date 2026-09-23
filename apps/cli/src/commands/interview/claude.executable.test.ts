import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../../usage-error.js";
import { resolveClaudeExecutable } from "./claude.js";

/**
 * Which Claude Code the interview runs.
 *
 * The packaged desktop ships the Agent SDK's JavaScript without the
 * per-platform Claude Code it carries as an optional dependency, so the session
 * runs the person's own — and the SDK is told which by path, because a bare
 * name is not something `spawn` resolves on Windows, where an npm-installed CLI
 * is a `.cmd` shim.
 */

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A directory holding each named file, executable unless `mode` says otherwise. */
function directoryWith(...names: string[]): string {
  return directoryWithMode(0o755, ...names);
}

function directoryWithMode(mode: number, ...names: string[]): string {
  const path = mkdtempSync(join(tmpdir(), "perbo path "));
  temporary.push(path);
  mkdirSync(path, { recursive: true });
  for (const name of names) {
    writeFileSync(join(path, name), "#!/bin/sh\n");
    chmodSync(join(path, name), mode);
  }
  return path;
}

/** A repository root that none of a case's `PATH` entries is inside. */
function unrelated(): string {
  return directoryWith();
}

describe("the Claude Code the interview runs", () => {
  it("answers the first entry on PATH that holds one", () => {
    const empty = directoryWith();
    const holding = directoryWith("claude");
    const second = directoryWith("claude");
    expect(
      resolveClaudeExecutable(unrelated(), { PATH: [empty, holding, second].join(delimiter) }, "linux"),
    ).toBe(join(holding, "claude"));
  });

  it("skips an entry that names no claude, rather than stopping there", () => {
    const empty = directoryWith("codex", "git");
    const holding = directoryWith("claude");
    expect(resolveClaudeExecutable(unrelated(), { PATH: [empty, holding].join(delimiter) }, "linux")).toBe(
      join(holding, "claude"),
    );
  });

  // Windows fixtures spell each extension the way PATHEXT does. Windows itself
  // finds a lowercase `claude.exe` under `.EXE`; a case-sensitive host running
  // these tests would not, so the two are written to agree.
  const PATHEXT = ".COM;.EXE;.BAT;.CMD";

  it("takes the native build's claude.exe under Windows", () => {
    const holding = directoryWith("claude.EXE");
    expect(resolveClaudeExecutable(unrelated(), { PATH: holding, PATHEXT }, "win32")).toBe(
      join(holding, "claude.EXE"),
    );
  });

  it("passes over npm's shim under Windows for a native build later on PATH", () => {
    // The Agent SDK starts the executable itself, with no shell, and Node
    // refuses to start a `.cmd` or `.bat` file that way.
    const shim = directoryWith("claude.CMD");
    const native = directoryWith("claude.EXE");
    expect(
      resolveClaudeExecutable(unrelated(), { PATH: [shim, native].join(delimiter), PATHEXT }, "win32"),
    ).toBe(join(native, "claude.EXE"));
  });

  it("names the native installer when npm's shim is all Windows has", () => {
    const shim = directoryWith("claude.CMD");
    let thrown: unknown;
    try {
      resolveClaudeExecutable(unrelated(), { PATH: shim, PATHEXT }, "win32");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toContain(join(shim, "claude.CMD"));
    expect((thrown as Error).message).toContain("native installer");
  });

  it("skips a PATH entry that is not absolute, which would name the repository", () => {
    // The CLI runs with the repository as its working directory, so `.` or
    // `bin` on PATH would find a `claude` the repository itself ships.
    const repository = directoryWith("claude");
    const holding = directoryWith("claude");
    const previous = process.cwd();
    process.chdir(repository);
    try {
      expect(
        resolveClaudeExecutable(unrelated(), { PATH: [".", "./", holding].join(delimiter) }, "linux"),
      ).toBe(join(holding, "claude"));
      expect(() => resolveClaudeExecutable(unrelated(), { PATH: "." }, "linux")).toThrow(UsageError);
    } finally {
      process.chdir(previous);
    }
  });

  it("passes over a claude that is not executable, for one later on PATH", () => {
    const plain = directoryWithMode(0o644, "claude");
    const holding = directoryWith("claude");
    expect(resolveClaudeExecutable(unrelated(), { PATH: [plain, holding].join(delimiter) }, "linux")).toBe(
      join(holding, "claude"),
    );
  });

  it("does not take a Windows shim for an answer on POSIX, where it is not what runs", () => {
    const holding = directoryWith("claude.CMD");
    expect(() => resolveClaudeExecutable(unrelated(), { PATH: holding }, "linux")).toThrow(UsageError);
  });

  it("says what to install when PATH holds none", () => {
    const empty = directoryWith("codex");
    let thrown: unknown;
    try {
      resolveClaudeExecutable(unrelated(), { PATH: empty }, "linux");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toContain("no `claude` is on PATH");
    expect((thrown as Error).message).toContain("@anthropic-ai/claude-code");
  });

  it("treats an unset PATH as holding none rather than reading the process's own", () => {
    expect(() => resolveClaudeExecutable(unrelated(), {}, "linux")).toThrow(UsageError);
  });

  it("skips a PATH entry inside the repository, where a package manager puts its scripts' binaries", () => {
    const repository = directoryWith("claude");
    const scripts = join(repository, "node_modules", ".bin");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "claude"), "#!/bin/sh\n");
    chmodSync(join(scripts, "claude"), 0o755);
    const holding = directoryWith("claude");
    const path = [scripts, repository, holding].join(delimiter);
    expect(resolveClaudeExecutable(repository, { PATH: path }, "linux")).toBe(join(holding, "claude"));
    const only = [scripts, repository].join(delimiter);
    expect(() => resolveClaudeExecutable(repository, { PATH: only }, "linux")).toThrow(UsageError);
  });

  it("skips an entry that reaches the repository through a symlink", () => {
    const repository = directoryWith("claude");
    const links = directoryWith();
    symlinkSync(repository, join(links, "checkout"));
    const holding = directoryWith("claude");
    const path = [join(links, "checkout"), holding].join(delimiter);
    expect(resolveClaudeExecutable(repository, { PATH: path }, "linux")).toBe(join(holding, "claude"));
  });

  it("takes the repository's parent, and a sibling whose name only begins with the repository's", () => {
    const parent = directoryWith("claude");
    const repository = join(parent, "repo");
    const sibling = join(parent, "repo-tools");
    mkdirSync(repository);
    mkdirSync(sibling);
    writeFileSync(join(sibling, "claude"), "#!/bin/sh\n");
    chmodSync(join(sibling, "claude"), 0o755);
    expect(resolveClaudeExecutable(repository, { PATH: sibling }, "linux")).toBe(join(sibling, "claude"));
    expect(resolveClaudeExecutable(repository, { PATH: parent }, "linux")).toBe(join(parent, "claude"));
  });

  it("ignores a directory named claude, which is not something to run", () => {
    const path = mkdtempSync(join(tmpdir(), "perbo path "));
    temporary.push(path);
    mkdirSync(join(path, "claude"), { recursive: true });
    expect(() => resolveClaudeExecutable(unrelated(), { PATH: path }, "linux")).toThrow(UsageError);
  });
});
