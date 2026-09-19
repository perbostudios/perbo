import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandSegments, inspectCommand, inspectCommandWithCwd } from "../src/prohibited.js";

/**
 * A heredoc body is the command's input, not more of the command line (SCP-174).
 *
 * The fixture beside this file is the tool call AYO-26's executor was killed
 * on: an append to a test file inside its own worktree, by absolute path, with
 * 158 lines of TypeScript between the operator and the terminator. The target
 * was inside all along — it was the body that was read as shell.
 */

const AYO26_ROOT =
  "/Users/nobody/.perbo/worktrees/perbo-adversarial-review-7eea98-0a500fe1e40b/att_064fd34d7d54861c";
const HOME = "/Users/nobody";
const AYO26_TARGET = `${AYO26_ROOT}/packages/runner/test/loop.test.ts`;
const AYO26 = readFileSync(
  new URL("./fixtures/ayo-26-heredoc-append.txt", import.meta.url),
  "utf8",
);

/**
 * A worktree that exists on disk, so a target inside it resolves as one. The
 * root is the resolved spelling, which is what the guard reports.
 */
function worktree(prefix: string): { root: string; home: string } {
  return { root: realpathSync(mkdtempSync(join(tmpdir(), prefix))), home: HOME };
}

const outsideHits = (command: string, scope: { root: string; home: string; cwd?: string }) =>
  inspectCommand(command, scope).filter((hit) => hit.action === "write_outside_worktree");

describe("the command AYO-26 was killed on", () => {
  const scope = { root: AYO26_ROOT, home: HOME };

  it("is the append the ticket describes, terminator and all", () => {
    expect(AYO26.startsWith(`cat >> ${AYO26_TARGET} <<'TESTS'\n`)).toBe(true);
    expect(AYO26.split("\n")).toHaveLength(158);
    expect(AYO26.endsWith("\nTESTS\necho appended")).toBe(true);
  });

  it("is admitted from the worktree root", () => {
    expect(inspectCommand(AYO26, scope)).toEqual([]);
  });

  it("is admitted from the package the executor was standing in", () => {
    expect(inspectCommand(AYO26, { ...scope, cwd: `${AYO26_ROOT}/packages/runner` })).toEqual([]);
  });

  it("is still refused, naming the path, when the target is outside", () => {
    const found = outsideHits(AYO26.replace(AYO26_TARGET, "/tmp/loop.test.ts"), scope);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/loop.test.ts");
  });
});

describe("the lines of a body", () => {
  const scope = worktree("perbo-scp174-body-");
  const body = ["> /etc/passwd", "cd /tmp", "rm -rf /"];
  const command = [`cat > ${scope.root}/notes.txt <<'EOF'`, ...body, "EOF"].join("\n");

  it("write nothing, move nothing and remove nothing", () => {
    expect(inspectCommand(command, scope)).toEqual([]);
  });

  it("leave the shell where they found it", () => {
    expect(inspectCommandWithCwd(command, scope).cwd).toMatchObject({
      path: scope.root,
      unknown: false,
      relative: ".",
    });
  });

  it("are not commands of their own", () => {
    expect(commandSegments([command, "echo done"].join("\n"))).toEqual([
      `cat > ${scope.root}/notes.txt <<'EOF'`,
      "echo done",
    ]);
  });

  it("do not decide the verdict, which is the redirect target's as before", () => {
    const outside = ["cat > /tmp/notes.txt <<'EOF'", ...body, "EOF"].join("\n");
    const found = outsideHits(outside, scope);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/notes.txt");
  });
});

describe("two heredocs opened by one command", () => {
  const scope = worktree("perbo-scp174-two-");
  const lines = (target: string) =>
    [`cat <<A > ${target} <<B`, "> /etc/passwd", "A", "cd /tmp", "B"].join("\n");

  it("take their bodies in order, and the line is judged on its redirect", () => {
    expect(inspectCommand(lines(`${scope.root}/x`), scope)).toEqual([]);
  });

  it("still answer for a redirect that lands outside", () => {
    const found = outsideHits(lines("/tmp/x"), scope);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/x");
  });
});

describe("what the command goes on to do after a body", () => {
  const scope = worktree("perbo-scp174-after-");

  it("moves the shell, and the write after the move is judged from there", () => {
    const command = [
      `cat > ${scope.root}/a.txt <<'EOF' && cd /tmp && echo hi > y`,
      "note",
      "EOF",
    ].join("\n");
    const found = outsideHits(command, scope);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toMatch(/the redirect target y resolves to .*\/y, outside/);
  });

  it("does the same when the move is written after the terminator", () => {
    const command = [
      `cat > ${scope.root}/a.txt <<'EOF'`,
      "note",
      "EOF",
      "cd /tmp && echo hi > y",
    ].join("\n");
    const found = outsideHits(command, scope);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toMatch(/the redirect target y resolves to .*\/y, outside/);
  });
});

describe("`<<-`, whose body and terminator may be indented with tabs", () => {
  const scope = worktree("perbo-scp174-dash-");

  it("consumes the indented body up to the indented terminator", () => {
    const command = [`cat > ${scope.root}/a.txt <<-EOF`, "\t> /etc/passwd", "\tEOF"].join("\n");
    expect(inspectCommand(command, scope)).toEqual([]);
  });

  it("ends there: the command after the terminator is judged", () => {
    const command = [
      `cat > ${scope.root}/a.txt <<-EOF`,
      "\t> /etc/passwd",
      "\tEOF",
      "echo x > /tmp/after.txt",
    ].join("\n");
    const found = outsideHits(command, scope);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/after.txt");
  });

  it("is the only form that strips them: a plain `<<` reads an indented tag as body", () => {
    const command = [
      `cat > ${scope.root}/a.txt <<EOF`,
      "\tEOF",
      "echo x > /tmp/after.txt",
      "EOF",
    ].join("\n");
    expect(inspectCommand(command, scope)).toEqual([]);
  });
});

describe("a heredoc whose terminator never comes", () => {
  const scope = worktree("perbo-scp174-open-");

  it("runs to the end of the text, so nothing after the operator is judged", () => {
    const command = [
      `cat > ${scope.root}/a.txt <<'EOF'`,
      "> /etc/passwd",
      "cd /tmp",
      "rm -rf /",
    ].join("\n");
    expect(inspectCommand(command, scope)).toEqual([]);
  });
});

describe("`<<<`, which is a here-string and not a heredoc", () => {
  const scope = worktree("perbo-scp174-string-");

  it("keeps its word on the line, and the redirect beside it is judged", () => {
    const found = outsideHits("cat <<<EOF > /tmp/x", scope);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/x");
  });

  it("consumes no lines after it", () => {
    const found = outsideHits(
      `cat <<<EOF > ${scope.root}/x\necho y > /tmp/after`,
      scope,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/after");
  });
});
