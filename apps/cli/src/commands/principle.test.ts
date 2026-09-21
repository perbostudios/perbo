import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Streams } from "../streams.js";
import { principleCommandLine, principlesPath } from "./principle.js";
import { runCommandLine } from "../command-line/terminal.js";

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

const add = (repo: string, text: string) =>
  runCommandLine(principleCommandLine, {
    argv: ["add", text, "--repo", repo],
    streams: capture(),
    cwd: repo,
  });

describe("perbo principle (D-065's ratchet)", () => {
  it("records an answer once and appends the next beneath it", () => {
    const repo = mkdtempSync(join(tmpdir(), "perbo-principles-"));
    add(repo, "perbo list shows open tickets by default.");
    add(repo, "Header detection is generic, never enumerated.");
    const text = readFileSync(principlesPath(repo, { repo: ".", store: null }), "utf8");
    expect(text).toContain("# Product principles");
    expect(text).toContain("perbo list shows open tickets by default.");
    expect(text).toContain("Header detection is generic, never enumerated.");
  });

  it("prints what is recorded, and says so where nothing is", () => {
    const repo = mkdtempSync(join(tmpdir(), "perbo-principles-list-"));
    const empty = capture();
    expect(runCommandLine(principleCommandLine, { argv: ["list", "--repo", repo], streams: empty, cwd: repo })).toBe(0);
    expect(empty.out.join("")).toBe("");
    expect(empty.err.join("")).toContain("no principles recorded");

    add(repo, "A refusal is preferred to a guess.");
    const listed = capture();
    runCommandLine(principleCommandLine, { argv: ["list", "--repo", repo], streams: listed, cwd: repo });
    expect(listed.out.join("")).toContain("A refusal is preferred to a guess.");
  });

  it("refuses an add with no text", () => {
    expect(() => principleCommandLine.read(["add"])).toThrow(/text/);
    expect(() => principleCommandLine.read(["add", "   "])).toThrow(/text/);
  });

  it("refuses a verb it does not have, naming the two it does", () => {
    expect(() => principleCommandLine.read(["remove", "x"])).toThrow(
      /usage: perbo principle add .* \| perbo principle list/,
    );
    expect(() => principleCommandLine.read([])).toThrow(/usage: perbo principle add/);
  });

  it("takes the text as one argument, after -- where it starts with a dash", () => {
    expect(principleCommandLine.read(["add", "--", "--all is how settled work is listed."]).input).toEqual({
      verb: "add",
      target: { repo: ".", store: null },
      text: "--all is how settled work is listed.",
    });
    // Two words after `--` are two arguments, and the text is one.
    expect(() => principleCommandLine.read(["add", "--", "--all", "is one flag"])).toThrow(
      /principle add needs the principle's text as its one argument/,
    );
  });

  it("writes into the ticket store directory", () => {
    expect(principlesPath("/tmp/cwd", { repo: "/tmp/some-repo", store: null })).toBe(
      "/tmp/some-repo/.perbo/principles.md",
    );
  });
});
