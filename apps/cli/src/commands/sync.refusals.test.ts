import { describe, expect, it } from "vitest";
import { syncCommandLine } from "./sync.js";

/**
 * What `sync` says to a line that asks for two of its three reads at once.
 *
 * These four sentences are the command's own, not the grammar's: the line
 * parses, and what it asks for is the thing that cannot be done. `SyncInput`
 * has no state for any of them, so nothing downstream can be asked whether
 * they are refused — only this can.
 */

describe("a sync that asks for two reads at once", () => {
  it("is refused naming the read each flag belongs to", () => {
    expect(() => syncCommandLine.read(["--all-merged", "--merge"])).toThrow(
      /^--merge takes one ticket: --all-merged is a read across the store/,
    );
    expect(() => syncCommandLine.read(["--all-merged", "PRB-1"])).toThrow(
      /^sync --all-merged takes no ticket key: it reads every merged ticket in the store/,
    );
    expect(() => syncCommandLine.read(["--merge"])).toThrow(
      /^--merge takes one ticket: a sweep over the local runs is a read/,
    );
    expect(() => syncCommandLine.read(["PRB-1", "--force"])).toThrow(
      /^--force belongs to --all-merged/,
    );
  });
});

describe("a sync that asks for one", () => {
  it("reads the three modes the command has", () => {
    expect(syncCommandLine.read([]).input).toEqual({
      mode: "sweep",
      target: { repo: ".", store: null },
    });
    expect(syncCommandLine.read(["--all-merged"]).input).toEqual({
      mode: "all-merged",
      target: { repo: ".", store: null },
      force: false,
    });
    expect(syncCommandLine.read(["PRB-1", "--merge"]).input).toEqual({
      mode: "ticket",
      target: { repo: ".", store: null },
      key: "PRB-1",
      merge: true,
    });
  });
});
