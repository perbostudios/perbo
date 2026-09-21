import { describe, expect, it } from "vitest";
import { admitCommandLine, approveCommandLine, listCommandLine } from "../commands/admit.js";
import { editCommandLine } from "../commands/edit/index.js";
import { inspectCommandLine } from "../commands/inspect.js";
import { mcpCommandLine } from "../commands/mcp.js";

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
