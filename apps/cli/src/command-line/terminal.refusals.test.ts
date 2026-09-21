import { describe, expect, it } from "vitest";
import { admitCommandLine, approveCommandLine, listCommandLine } from "../commands/admit.js";
import { editCommandLine } from "../commands/edit/index.js";
import { inspectCommandLine } from "../commands/inspect.js";
import { mcpCommandLine } from "../commands/mcp.js";
import { principleCommandLine } from "../commands/principle.js";
import { doctorCommandLine, executeCommandLine } from "../commands/run/index.js";

/**
 * What a command says to a line it cannot act on.
 *
 * Every refusal here is the command's own sentence, naming the command and
 * what it takes. That is grammar rule 5 for a flag nothing offers and rule 9
 * for a count of ticket keys the command has no room for — one rule each,
 * rather than one command answering for another because it borrowed its
 * reader.
 */

describe("a word the command has no room for", () => {
  it("is refused by the command it was typed at, naming what that command takes", () => {
    expect(() => editCommandLine.read(["PRB-1", "extra"])).toThrow(
      /^edit requires a ticket key, e\.g\. PRB-1$/,
    );
    expect(() => approveCommandLine.read(["PRB-1", "extra"])).toThrow(
      /^approve requires a ticket key, e\.g\. PRB-1$/,
    );
    expect(() => inspectCommandLine.read(["PRB-1", "extra"])).toThrow(
      /^inspect takes exactly one ticket key, e\.g\. perbo inspect PRB-1$/,
    );
    expect(() => listCommandLine.read(["extra"])).toThrow(
      /^list takes no ticket key: it prints the admitted work, e\.g\. perbo list --all$/,
    );
    expect(() => admitCommandLine.read(["Search results paginate"])).toThrow(
      /^admit takes no positional argument: what is admitted is given as flags/,
    );
    // The verb's own grammar answers, so the count a verb has room for is the
    // verb's: `add` takes one word and `list` takes none.
    expect(() => principleCommandLine.read(["list", "extra"])).toThrow(
      /^principle list takes no argument: it prints what is recorded/,
    );
  });
});

describe("a flag the command does not offer", () => {
  it("is refused naming that command, whichever reader is behind it", () => {
    expect(() => approveCommandLine.read(["PRB-1", "--all"])).toThrow(
      /unknown flag '--all' for approve/,
    );
    expect(() => mcpCommandLine.read(["--all"])).toThrow(/unknown flag '--all' for mcp/);
    expect(() => listCommandLine.read(["--drafter"])).toThrow(
      /unknown flag '--drafter' for list/,
    );
  });
});

describe("the diagnostic and the run", () => {
  it("each refuses the other's flags rather than reading a line it cannot answer", () => {
    // `doctor` answers whether this repository can be materialized at all. A
    // ticket, a contract, a bundle to resume or a re-level is a run being
    // asked for, and a diagnostic that took the word and looked at the
    // repository anyway answered a question nobody typed.
    for (const flag of ["--ticket", "--contract", "--resume-from", "--outcome", "--pr"]) {
      expect(() => doctorCommandLine.read([flag, "x"])).toThrow(
        new RegExp(`unknown flag '\\${flag}' for doctor`),
      );
    }
    for (const flag of ["--relevel", "--quiet", "--criterion", "--path"]) {
      expect(() => doctorCommandLine.read([flag, "x"])).toThrow(
        new RegExp(`unknown flag '\\${flag}' for doctor`),
      );
    }
    // And the other way: `--probe` and `--write-config` ask about the machine
    // and about a file that does not exist yet, which a run does neither of.
    for (const flag of ["--probe", "--write-config", "--worktree-root"]) {
      expect(() => executeCommandLine.read([flag])).toThrow(
        new RegExp(`unknown flag '\\${flag}' for run`),
      );
    }
  });

  it("refuses a word where each takes none, naming what it takes instead", () => {
    expect(() => doctorCommandLine.read(["."])).toThrow(
      /^doctor takes no positional argument: the repository it reads is --repo/,
    );
    expect(() => executeCommandLine.read(["PRB-1"])).toThrow(
      /^run takes no positional argument: what it runs is named by a flag/,
    );
  });
});
