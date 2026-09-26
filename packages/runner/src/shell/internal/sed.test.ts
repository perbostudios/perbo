import { describe, expect, it } from "vitest";
import { readSedScript } from "./sed.js";

/**
 * A `sed` script read far enough to find what it writes and what it runs. Both
 * bracket readings are asked, since BSD reads a delimiter inside a bracket
 * expression as part of the regex and GNU ends the regex there.
 */
const read = (script: string, brackets = true) => readSedScript(script, brackets);
const files = (script: string, brackets = true) => read(script, brackets).writes.map(({ file }) => file);

describe("readSedScript", () => {
  it("finds the file a w or W command writes, to the end of its line", () => {
    expect(files("1w /tmp/x")).toEqual(["/tmp/x"]);
    expect(files("w /tmp/x; p")).toEqual(["/tmp/x; p"]);
    expect(files("$W out.txt")).toEqual(["out.txt"]);
    expect(files("/a/,/b/w out.txt")).toEqual(["out.txt"]);
    expect(files("1{w /tmp/x\n}")).toEqual(["/tmp/x"]);
    expect(files("0~3!w /tmp/x")).toEqual(["/tmp/x"]);
  });

  it("finds the file an s command's w flag writes, after its other flags", () => {
    expect(files("s/a/b/w src/keys/z.pem")).toEqual(["src/keys/z.pem"]);
    expect(files("s|a|b|gw /tmp/x")).toEqual(["/tmp/x"]);
    expect(files("s/a/b/2pw /tmp/x")).toEqual(["/tmp/x"]);
  });

  it("finds a command after a label, a y command and a branch", () => {
    expect(files(":a;w /tmp/x")).toEqual(["/tmp/x"]);
    expect(files("y/abc/xyz/;w /tmp/x")).toEqual(["/tmp/x"]);
    expect(files("b end;w /tmp/x")).toEqual(["/tmp/x"]);
    expect(files("s/a/b/;w /tmp/x")).toEqual(["/tmp/x"]);
  });

  it("finds an e command and an s command's e flag", () => {
    expect(read("1e touch /tmp/pwn").runs).toBe(true);
    expect(read("e").runs).toBe(true);
    expect(read("s/a/touch \\/tmp\\/pwn/e").runs).toBe(true);
    expect(read("s/(a)/\\1/Ie").runs).toBe(true);
  });

  it("reads text, a read and an ordinary edit as neither", () => {
    for (const script of [
      "1,5p",
      "s/a/b/",
      "s/x/y/g",
      "1a foo; w /tmp/x",
      "1i\\\nw /tmp/x",
      "r /etc/hosts",
      "R /etc/hosts",
      "s/e/w/",
      "y/ew/we/",
      "/w/d",
      "\\,w,d",
      "$!N;P;D",
      "# w /tmp/x\np",
      "",
    ]) {
      const acts = read(script);
      expect(acts, script).toMatchObject({ writes: [], runs: false, error: null });
    }
  });

  it("reads a delimiter inside a bracket expression as BSD and as GNU read it", () => {
    expect(read("s/[^/]*$//", true)).toMatchObject({ writes: [], error: null });
    expect(read("s/[^/]*$//", false).error).not.toBeNull();
    expect(files("s/[/]/x/w /tmp/y", true)).toEqual(["/tmp/y"]);
    expect(files("s/[/]/w /tmp/y", false)).toEqual(["/tmp/y"]);
  });

  it("says where a script it cannot read stops", () => {
    for (const script of [".bak", "s/a/b", "1", "/a", "s/a/b/?", "k"]) {
      expect(read(script).error, script).not.toBeNull();
    }
  });
});
