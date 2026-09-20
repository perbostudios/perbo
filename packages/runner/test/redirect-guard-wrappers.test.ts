import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectCommandWithCwd } from "../src/prohibited.js";
import { UNKNOWN_CWD } from "../src/shell/index.js";

/**
 * An option a wrapper's table does not know is an option, not a missing
 * command (SCP-186).
 *
 * The tables came from SCP-156 to stop the first `-flag` after a wrapper being
 * read as the program it runs. They were written to refuse what they did not
 * recognise, on the reasoning that skipping an option may skip the program
 * name with it — and `-v` is not in pnpm's. So `pnpm -v` was refused as
 * `write_outside_worktree`, a verdict about a destination for a line that
 * names no path at all.
 *
 * The distinction this file pins is whether the line has a command word for
 * the guard to lose. An invocation that is nothing but options runs no command
 * of the agent's, so it is judged on the wrapper itself, which writes nothing
 * by name. One that has an argument after the unknown option keeps the refusal,
 * because there the guard genuinely cannot tell the program from the option's
 * value.
 */

/** AYO-31's first command, as the executor sent it. Its 23rd, and the attempt died on it. */
const AYO31 = "ls node_modules/.bin | head && pnpm -v && node -v";

const root = mkdtempSync(join(tmpdir(), "perbo-scp186-"));
mkdirSync(join(root, "sub"), { recursive: true });

/** Every directory the executor's shell could be standing in when the line runs. */
const CWDS: Array<[string, string]> = [
  ["the worktree root", root],
  ["a directory inside it", join(root, "sub")],
  ["a directory outside it", "/tmp"],
  ["a directory the guard could not read", UNKNOWN_CWD],
];

const inspect = (command: string, cwd: string) =>
  inspectCommandWithCwd(command, { root, cwd, home: "/Users/nobody" });

const writeHits = (command: string, cwd: string) =>
  inspect(command, cwd).hits.filter((hit) => hit.action === "write_outside_worktree");

describe("AYO-31's first command", () => {
  for (const [where, cwd] of CWDS) {
    it(`is admitted from ${where}`, () => {
      expect(inspect(AYO31, cwd).hits, AYO31).toEqual([]);
    });
  }

  it("records the unread command word as a note on the segment, not as a hit", () => {
    const reading = inspect(AYO31, root);
    const segment = reading.segments.find((each) => each.text === "pnpm -v");
    expect(segment?.notes.join(" ")).toMatch(/not an option this guard knows for pnpm/);
    expect(segment?.mutating).toBe(false);
    expect(reading.writes).toEqual([]);
  });
});

/**
 * The forms an executor reaches for to find out what it is running. None of
 * them names a path, so none of them can land outside the worktree.
 */
const FLAG_ONLY = [
  "pnpm -v",
  "pnpm --version",
  "pnpm --help",
  "pnpm -w -v",
  "pnpm exec --help",
  "npm -v",
  "npm --version",
  "yarn --version",
  "bun --version",
  "npx --version",
  // Not a wrapper, and pinned so it stays that way.
  "node -v",
  "git --version",
];

describe("a version, help or flag-only invocation", () => {
  for (const command of FLAG_ONLY) {
    for (const [where, cwd] of CWDS) {
      it(`admits ${command} from ${where}`, () => {
        expect(inspect(command, cwd).hits, command).toEqual([]);
      });
    }
  }
});

/**
 * A redirect target is not the command the wrapper runs. It joins the word list
 * so the write verbs can judge it, and reading it as a candidate command word
 * would put the refusal back on exactly the line the executor writes:
 * `pnpm -v 2>&1`.
 */
describe("a flag-only wrapper with its output redirected", () => {
  it("admits the redirect that lands inside the worktree", () => {
    expect(inspect(`pnpm -v > ${root}/log.txt`, root).hits).toEqual([]);
    expect(inspect("pnpm -v > log.txt", root).hits).toEqual([]);
    expect(inspect("pnpm -v 2>&1", root).hits).toEqual([]);
    expect(inspect("pnpm -v > /dev/null", root).hits).toEqual([]);
    expect(inspect("pnpm -v | tee out.txt", root).hits).toEqual([]);
  });

  it("still refuses the redirect that lands outside it", () => {
    const found = writeHits("pnpm -v > /tmp/log.txt", root);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/log.txt");
  });
});

describe("a flag-only wrapper followed by a real write", () => {
  it("refuses the write, and names the path rather than the option", () => {
    const found = writeHits("pnpm -v && echo x > /tmp/y", root);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/y");
    expect(inspect("pnpm -v && echo x > /tmp/y", root).writes[0]?.target).toBe("/tmp/y");
  });

  it("refuses the write verb behind the same prefix", () => {
    const found = writeHits("pnpm --version && rm -rf /tmp/z", root);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("/tmp/z");
  });
});

/**
 * The reading kept from before this change: an unknown option with an argument
 * after it is refused, because the argument may be the option's value and the
 * program may be a word further on. `pnpm --frobnicate rm -rf /` is refused on
 * the option — not admitted, and not read as `rm -rf /` either.
 */
describe("an unknown option with a command word after it", () => {
  const KEPT = [
    "pnpm --frobnicate rm -rf /",
    "pnpm --nope exec cp a b",
    "pnpm exec --nope cp a b",
    "nice -Z cp a b",
    "sudo -Q cp a b",
    "xargs -Q cp a b",
    "npx --frobnicate rm -rf /",
    "env --frobnicate rm -rf /tmp/z",
  ];

  for (const command of KEPT) {
    it(`still refuses ${command}`, () => {
      const found = writeHits(command, root);
      expect(found, command).toHaveLength(1);
      expect(found[0]?.detail, command).toMatch(/is not an option this guard knows/);
    });
  }

  it("names the option the guard did not know", () => {
    expect(writeHits("pnpm --frobnicate rm -rf /", root)[0]?.detail).toContain("--frobnicate");
  });
});

describe("the refusal the guard no longer authors", () => {
  it("never says a wrapper's command cannot be found", () => {
    const lines = [...FLAG_ONLY, AYO31, "pnpm --frobnicate rm -rf /", "nice -Z cp a b"];
    for (const command of lines) {
      for (const hit of inspect(command, root).hits) {
        expect(hit.detail, command).not.toContain("cannot be found");
      }
    }
  });
});
