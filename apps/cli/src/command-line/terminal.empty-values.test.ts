import { describe, expect, it } from "vitest";
import { approveCommandLine, listCommandLine } from "../commands/admit.js";
import { editCommandLine } from "../commands/edit/index.js";
import { escapesCommandLine } from "../commands/escapes/index.js";
import { inspectCommandLine } from "../commands/inspect.js";
import { mcpCommandLine } from "../commands/mcp.js";
import { stopsCommandLine } from "../commands/stops.js";
import { storeDir, storeFor } from "../store/index.js";

/**
 * A flag given an empty value carries an empty value.
 *
 * `--repo ""` is what a script writes when the variable it interpolated was
 * unset, and `perbo list --repo "$REPO"` is that script. The line is read as
 * the line says: an empty repository is the directory the command was run in,
 * and an empty store is the store that directory holds — the same two places
 * the command works against when neither flag is given at all.
 *
 * The rule is the grammar's rule 7 — a flag takes the next token verbatim,
 * whatever it looks like — and an empty string is one of the things a token
 * can look like. A schema that refused it would refuse it in a sentence about
 * string lengths, for a person who wrote a line the command can act on.
 */

const CWD = "/Users/someone/Code/project";

describe("an empty --repo", () => {
  it("is the directory the command was run in, for every command that reads a store", () => {
    for (const read of [
      () => listCommandLine.read(["--repo", ""]).input.target,
      () => approveCommandLine.read(["PRB-1", "--repo", ""]).input.target,
      () => editCommandLine.read(["PRB-1", "--repo", ""]).input.target,
      () => inspectCommandLine.read(["PRB-1", "--repo", ""]).input.target,
      () => stopsCommandLine.read(["--repo", ""]).input.target,
      () => escapesCommandLine.read(["--repo", ""]).input.target,
      () => mcpCommandLine.read(["--repo", ""]).input.target,
    ]) {
      const target = read();
      expect(target).toEqual({ repo: "", store: null });
      expect(storeFor(CWD, target)).toBe(storeDir(CWD, null));
    }
  });
});

describe("an empty --store", () => {
  it("is the store the repository holds, for every command that reads one", () => {
    for (const read of [
      () => listCommandLine.read(["--store", ""]).input.target,
      () => approveCommandLine.read(["PRB-1", "--store", ""]).input.target,
      () => editCommandLine.read(["PRB-1", "--store", ""]).input.target,
      () => inspectCommandLine.read(["PRB-1", "--store", ""]).input.target,
      () => stopsCommandLine.read(["--store", ""]).input.target,
      () => escapesCommandLine.read(["--store", ""]).input.target,
      () => mcpCommandLine.read(["--store", ""]).input.target,
    ]) {
      const target = read();
      expect(target).toEqual({ repo: ".", store: "" });
      expect(storeFor(CWD, target)).toBe(storeDir(CWD, null));
    }
  });
});

describe("inspect's own empty values", () => {
  it("reads an empty key, attempt and verification as the store's answer to give", () => {
    expect(inspectCommandLine.read([""]).input).toEqual({
      target: { repo: ".", store: null },
      key: "",
      attempt: null,
      verify: null,
    });
    expect(inspectCommandLine.read(["PRB-1", "--attempt", ""]).input.attempt).toBe("");
    expect(inspectCommandLine.read(["PRB-1", "--verify", ""]).input.verify).toBe("");
  });
});

describe("a key nobody gave", () => {
  it("is refused by the command that needs one, in its own words", () => {
    expect(() => approveCommandLine.read([""])).toThrow(
      /approve requires a ticket key, e\.g\. PRB-1/,
    );
    expect(() => editCommandLine.read([""])).toThrow(/edit requires a ticket key, e\.g\. PRB-1/);
  });
});
