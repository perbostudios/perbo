import { describe, expect, it } from "vitest";
import { COMMANDS } from "./table.js";
import { COMMAND_NAMES, type CommandName } from "./names.js";
import { USAGE } from "./usage.js";

/**
 * The help and the table say the same thing about which commands exist and
 * which flags each takes.
 *
 * `USAGE` is authored prose, because what a flag *means* is the product's
 * documentation and nothing generates that. What it must not do is drift: a
 * flag renamed in a grammar while the help still offers the old spelling is a
 * promise the program breaks, and a flag a command takes that the help never
 * names is one nobody can find.
 *
 * So the one fact the table owns — which flags exist — is checked against the
 * help both ways. A flag written inside quotes is an example of what a person
 * types, not a flag of the command: `perbo principle add "… need --all."`
 * documents `list`, and the quotes are how the help says so.
 */

/** A synopsis line: `  perbo <command> …` at the help's own indent, and nothing else. */
const SYNOPSIS = /^ {2}perbo ([a-z][a-z-]*)/;

/** Every `--flag` a line writes, with the examples inside quotes left out. */
const flagsIn = (text: string): string[] => [
  ...new Set([...text.replace(/"[^"]*"/g, "").matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0])),
];

/** The help's synopsis lines, by the command each is for, in the order it offers them. */
function synopses(): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of USAGE.split("\n")) {
    const match = SYNOPSIS.exec(line);
    if (match === null) continue;
    const name = match[1]!;
    found.set(name, `${found.get(name) ?? ""}${line}\n`);
  }
  return found;
}

/**
 * Everything the help says about one command: its synopsis lines, the prose
 * under them, and every flag section whose heading names it.
 *
 * The help documents the flags of `run` and `doctor` under one heading, and
 * `admit`'s and `review`'s under three each, so which commands a section is
 * about is read from the heading rather than assumed from where it sits. A
 * heading that names none of them — the streams, the exit codes, the
 * credentials — is about the binary and belongs to no command.
 */
function blocks(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (names: readonly string[], line: string): void => {
    for (const name of names) found.set(name, `${found.get(name) ?? ""}${line}\n`);
  };
  let open: readonly string[] = [];
  for (const line of USAGE.split("\n")) {
    const match = SYNOPSIS.exec(line);
    if (match !== null) open = [match[1]!];
    else if (/^[A-Za-z]/.test(line)) {
      open = COMMAND_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(line));
    }
    add(open, line);
  }
  return found;
}

/** Every flag one command declares, over every grammar it reads a line by, hidden ones left out. */
function declared(name: CommandName): string[] {
  return [
    ...new Set(
      COMMANDS[name].grammars.flatMap((grammar) =>
        Object.entries(grammar.flags)
          .filter(([, spec]) => !spec.hidden)
          .map(([flag]) => flag),
      ),
    ),
  ];
}

const SYNOPSES = synopses();
const BLOCKS = blocks();

describe("the help and the table", () => {
  it("offer the same commands", () => {
    expect([...SYNOPSES.keys()].sort()).toEqual([...COMMAND_NAMES].sort());
    expect(Object.keys(COMMANDS).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it("agree on which command each entry of the table is", () => {
    for (const name of COMMAND_NAMES) expect(COMMANDS[name].name).toBe(name);
  });

  it("offer no flag the command does not take", () => {
    const promised: string[] = [];
    for (const name of COMMAND_NAMES) {
      const takes = new Set(declared(name));
      for (const flag of flagsIn(SYNOPSES.get(name) ?? "")) {
        if (!takes.has(flag)) promised.push(`${name} ${flag}`);
      }
    }
    expect(promised).toEqual([]);
  });

  it("name every flag the command does take", () => {
    const unnamed: string[] = [];
    for (const name of COMMAND_NAMES) {
      const said = BLOCKS.get(name) ?? "";
      for (const flag of declared(name)) {
        if (!said.includes(flag)) unnamed.push(`${name} ${flag}`);
      }
    }
    expect(unnamed).toEqual([]);
  });
});
